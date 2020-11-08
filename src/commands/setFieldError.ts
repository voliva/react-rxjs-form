import { ErrorResult, FormRef, getControlState } from '../internal/formRef';
import { KeySelector } from '../internal/path';

export const setFieldError = <TValues>(
  formRef: FormRef<TValues>,
  keySelector: KeySelector<TValues, any>,
  error: ErrorResult
) => {
  try {
    getControlState(formRef, keySelector)
      .getChild('manualError')
      .getValue()
      .next(error);
  } catch (ex) {
    console.warn("Can't set error: Field not registered", ex);
  }
};
