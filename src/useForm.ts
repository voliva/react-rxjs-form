import { useEffect, useRef, useState } from 'react';
import {
  BehaviorSubject,
  concat,
  EMPTY,
  merge,
  Observable,
  of,
  Subject,
  Subscription,
} from 'rxjs';
import {
  mergeMap,
  skip,
  map,
  switchMap,
  scan,
  filter,
  distinctUntilChanged,
  startWith,
  exhaustMap,
  switchAll,
  mergeAll,
} from 'rxjs/operators';
import {
  buildObject,
  getKey,
  getKeys,
  KeySelector,
  KeysSelector,
} from './path';
import { Validator } from './validators';

export interface FormRef<T extends Record<string, any>> {
  registeredControls$: BehaviorSubject<
    Map<
      string,
      {
        subject: BehaviorSubject<any>;
        error$: Observable<boolean | string[] | 'pending'>;
        subscriptions: Set<Subscription>;
      }
    >
  >;
  registeredValidators$: BehaviorSubject<
    Map<
      string,
      {
        error$: Observable<boolean | string[] | 'pending'>;
        subscriptions: Set<Subscription>;
      }
    >
  >;
}

export const useForm = <
  T extends Record<string, any> = Record<string, any>
>() => {
  const ref = useRef<FormRef<T> | null>(null);
  if (!ref.current) {
    ref.current = {
      registeredControls$: new BehaviorSubject(new Map()),
      registeredValidators$: new BehaviorSubject(new Map()),
    };
  }
  return ref.current!;
};

export interface ControlOptions<TValues, T> {
  key: KeySelector<TValues, T>;
  initialValue: T;
  validator?: Validator<T, TValues>;
}

const noopValidator: Validator<any> = () => true;
export const useControl = <TValues, T>(
  formRef: FormRef<TValues>,
  options: ControlOptions<TValues, T>
) => {
  const key = getKey(options.key);
  const {
    initialValue,
    validator = noopValidator as Validator<T, TValues>,
  } = options;
  const latestValidator = useLatestRef(validator);
  const registeredControls = formRef.registeredControls$.getValue();

  if (!registeredControls.has(key)) {
    const subject = new BehaviorSubject(initialValue);
    const dependency$ = new Subject<BehaviorSubject<any>>();

    const error$ = merge(
      dependency$.pipe(
        filterSeenValues(),
        mergeMap(subject => subject.pipe(skip(1))),
        map(() => subject.getValue())
      ),
      subject
    ).pipe(
      switchMap(value => {
        const result = latestValidator.current(value, keySelector => {
          const key = getKey(keySelector);
          const targetControl = formRef.registeredControls$.getValue().get(key);
          if (!targetControl) {
            throw new Error(`Control "${key}" hasn't been registered yet`);
          }
          dependency$.next(targetControl.subject);
          return targetControl.subject.getValue();
        });
        if (typeof result === 'boolean' || Array.isArray(result)) {
          return of(result);
        }
        return concat(of('pending' as const), result);
      })
    );
    registeredControls.set(key, {
      subject,
      error$,
      subscriptions: new Set(),
    });
    formRef.registeredControls$.next(registeredControls);
  }
  const control = registeredControls.get(key)!;

  return {
    setValue: (value: T) => control.subject.next(value),
    subscribe: (cb: (value: T) => void) => {
      const subscription = control.subject.subscribe(cb);
      control.subscriptions.add(subscription);
      return () => {
        subscription.unsubscribe();
        control.subscriptions.delete(subscription);
      };
    },
  };
};

export const useInput = <TValues, T>(
  formRef: FormRef<TValues>,
  options: ControlOptions<TValues, T> & {
    elementProp?: string;
    eventType?: 'input' | 'onChange';
  }
) => {
  const { eventType = 'input', elementProp = 'value' } = options;
  const { setValue, subscribe } = useControl(formRef, options);
  const ref = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    const element = ref.current;
    if (!element) {
      return;
    }
    const listener = (event: any) => setValue(event.target[elementProp]);
    const unsubscribe = subscribe(
      value => ((element as any)[elementProp] = value)
    );
    element.addEventListener(eventType, listener);
    return () => {
      unsubscribe();
      element.removeEventListener(eventType, listener);
    };
  });

  return ref;
};

export const readForm = <T>(formRef: FormRef<T>): T => {
  const controls = formRef.registeredControls$.getValue();
  const propValues = Object.fromEntries(
    Array.from(controls.entries()).map(
      ([key, control]) => [key, control.subject.getValue()] as const
    )
  );
  return buildObject(propValues);
};

export function useWatch<TValues, T>(
  formRef: FormRef<TValues>,
  key: KeySelector<TValues, T>
): T | undefined;
export function useWatch<TValues, T>(
  formRef: FormRef<TValues>,
  key: KeySelector<TValues, T>,
  defaultValue: T
): T;
export function useWatch<TValues, T>(
  formRef: FormRef<TValues>,
  keySelector: KeySelector<TValues, T>,
  defaultValue?: T
): T | undefined {
  const [value, setValue] = useState<T | typeof empty>(empty);
  const key = getKey(keySelector);

  useEffect(() => {
    const sub = formRef.registeredControls$
      .pipe(
        filter(controls => controls.has(key)),
        exhaustMap(controls => controls.get(key)!.subject)
      )
      .subscribe(setValue);

    return () => sub.unsubscribe();
  }, [key]);

  return value !== empty ? (value as T) : defaultValue;
}

export const useValidation = <TValues>(
  formRef: FormRef<TValues>,
  key: string,
  validator: (
    getValues: (keys?: KeysSelector<TValues>) => Record<string, any>
  ) => boolean | string[] | Promise<boolean | string[]>
) =>
  useEffect(() => {
    const registeredValidators = formRef.registeredValidators$.getValue();
    if (registeredValidators.has(key)) {
      throw new Error(`global validator "${key}" already registered`);
    }

    const dependency$ = new Subject<BehaviorSubject<any> | 'all'>();

    const error$ = dependency$.pipe(
      switchMap(v => {
        if (v === 'all') {
          return formRef.registeredControls$.pipe(
            switchAll(),
            map(([, control]) => control.subject)
          );
        }
        return of(v);
      }),
      filterSeenValues(),
      mergeMap(subject => subject.pipe(skip(1))),
      startWith(null),
      switchMap(() => {
        const result = validator(keysSelector => {
          const controls = formRef.registeredControls$.getValue();
          if (!keysSelector) {
            dependency$.next('all');
            return Object.fromEntries(
              Array.from(controls.entries()).map(
                ([key, control]) => [key, control.subject.getValue()] as const
              )
            );
          }
          const keys = getKeys(keysSelector);
          keys.forEach(key => {
            const targetControl = controls.get(key);
            if (!targetControl) {
              // TODO wait for it somehow?
              return;
            }
            dependency$.next(targetControl.subject);
          });
          return Object.fromEntries(
            keys.map(key => {
              const targetControl = controls.get(key);
              if (!targetControl) return [key, undefined];
              return [key, targetControl.subject.getValue()];
            })
          );
        });
        if (typeof result === 'boolean' || Array.isArray(result)) {
          return of(result);
        }
        return concat(of('pending' as const), result);
      })
    );
    registeredValidators.set(key, {
      error$,
      subscriptions: new Set(),
    });
    formRef.registeredValidators$.next(registeredValidators);
    return () => {
      registeredValidators.delete(key);
      formRef.registeredValidators$.next(registeredValidators);
    };
  }, [key, formRef, validator]);
// TODO validate in `useErrorCb`

const ALL_KEYS = Symbol('all');
const useErrorCb = <TValues>(
  formRef: FormRef<TValues>,
  onErrors: (errors: Record<string, 'pending' | string[]>) => void,
  keysSelector?: KeysSelector<TValues>
) => {
  const keys = keysSelector ? getKeys(keysSelector) : [ALL_KEYS];

  useEffect(() => {
    // TODO updates on registeredControl$
    const controls = formRef.registeredControls$.getValue();
    const keysToSubscribe =
      keys[0] === ALL_KEYS
        ? Array.from(controls.keys())
        : keys.filter(key => controls.has(key));
    const result$ = merge(
      ...keysToSubscribe.map(key =>
        controls.get(key)!.error$.pipe(
          map(errorResult => ({
            key,
            errorResult,
          }))
        )
      )
    ).pipe(
      scan((prevErrors, { key, errorResult }) => {
        switch (errorResult) {
          case true:
            if (key in prevErrors) {
              const { [key]: _, ...newErrors } = prevErrors;
              return newErrors;
            }
            return prevErrors;
          case 'pending':
            return {
              ...prevErrors,
              [key]: 'pending',
            };
        }
        if (
          !(key in prevErrors) ||
          prevErrors[key] === 'pending' ||
          (typeof errorResult === 'object' &&
            !arrayEquals(prevErrors[key] as string[], errorResult))
        ) {
          const errorValue =
            typeof errorResult === 'boolean' ? [] : errorResult;
          return {
            ...prevErrors,
            [key]: errorValue,
          };
        }
        return prevErrors;
      }, {} as Record<string, 'pending' | string[]>),
      distinctUntilChanged()
    );
    const subscription = result$.subscribe(onErrors);
    return () => subscription.unsubscribe();
  }, keys);
};
const useGlobalErrorCb = <TValues>(
  formRef: FormRef<TValues>,
  onErrors: (errors: Record<string, 'pending' | string[]>) => void,
  keys: string[]
) => {
  const keys_: any[] = keys || [ALL_KEYS];

  useEffect(() => {
    const activeValidator$ = formRef.registeredValidators$.pipe(
      map(validators => {
        const keysToSubscribe =
          keys_[0] === ALL_KEYS
            ? Array.from(validators.keys())
            : keys.filter(key => validators.has(key));
        return keysToSubscribe.map(key =>
          validators.get(key)!.error$.pipe(
            map(errorResult => ({
              key,
              errorResult,
            }))
          )
        );
      })
    );
    const result$ = activeValidator$.pipe(
      switchAll(),
      mergeAll(),
      scan((prevErrors, { key, errorResult }) => {
        switch (errorResult) {
          case true:
            if (key in prevErrors) {
              const { [key]: _, ...newErrors } = prevErrors;
              return newErrors;
            }
            return prevErrors;
          case 'pending':
            return {
              ...prevErrors,
              [key]: 'pending' as const,
            };
        }
        if (
          !(key in prevErrors) ||
          prevErrors[key] === 'pending' ||
          (typeof errorResult === 'object' &&
            !arrayEquals(prevErrors[key] as string[], errorResult))
        ) {
          const errorValue =
            typeof errorResult === 'boolean' ? [] : errorResult;
          return {
            ...prevErrors,
            [key]: errorValue,
          };
        }
        return prevErrors;
      }, {} as Record<string, 'pending' | string[]>),
      distinctUntilChanged()
    );
    const subscription = result$.subscribe(onErrors);
    return () => subscription.unsubscribe();
  }, keys_);
};
export const useErrors = <TValues>(
  formRef: FormRef<TValues>,
  keysSelector?: KeysSelector<TValues>
) => {
  const [errors, setErrors] = useState<Record<string, 'pending' | string[]>>(
    {}
  );
  useErrorCb(formRef, setErrors, keysSelector);

  return errors;
};

export const useIsValid = <TValues>(
  formRef: FormRef<TValues>,
  keysSelector?: KeysSelector<TValues>
) => {
  const [isValid, setIsValid] = useState<boolean | 'pending'>(true);

  useErrorCb(
    formRef,
    errors => {
      const errorValues = Object.values(errors);
      let hasPending = false;
      const hasError = errorValues.some(error => {
        if (error === 'pending') {
          hasPending = true;
          return false;
        }
        return true;
      });
      setIsValid(hasError ? false : hasPending ? 'pending' : true);
    },
    keysSelector
  );

  return isValid;
};

/** TODO
 * pristine
 *  -> useIsPristine For a specific field (?... is it useful?), or for all of them. Returns true/false
 *  -> formRef.markPristine()
 * reset: resets each field to its initial value
 *  -> formRef.reset()
 * If I'm moving on this API, then maybe readForm should become formRef.read()
 *
 * Speaking of initial values... think on how to make changing initial values. The example of ADSS:
 * - Select Monthly or Quaterly
 * - User can select the next 12 months from a split [Month] Select and [Year] Select
 * - Quaterly can only choose specific months
 *
 * TODO -> Ability to remove fields. react-hook-form cleans up when a field gets unmounted,
 * I don't want to do that. Cleanup on demand
 *
 * TODO -> Ability to change values, externally (setValue(form, key, value)) and internally (useDerivedValue(form, (getValue, setValue) => {}))
 */

const empty = Symbol('empty');
const filterSeenValues = () => <T>(source$: Observable<T>) =>
  source$.pipe(
    scan(
      (acc, value) => {
        if (acc.seen.has(value)) {
          return {
            seen: acc.seen,
            lastValue: empty as typeof empty,
          };
        }
        acc.seen.add(value);
        return {
          seen: acc.seen,
          lastValue: value,
        };
      },
      {
        seen: new Set<T>(),
        lastValue: empty as T | typeof empty,
      }
    ),
    filter(v => v.lastValue !== empty),
    map(v => v.lastValue as T)
  );

const useLatestRef = <T>(value: T) => {
  const ref = useRef(value);
  ref.current = value;
  return ref;
};

const arrayEquals = <T>(a: T[], b: T[]) =>
  a.length === b.length && a.every((v, i) => b[i] === v);
