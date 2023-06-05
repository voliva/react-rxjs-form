/* eslint-disable @typescript-eslint/no-non-null-assertion */
import { render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import React from "react";
import { useForm } from "../hooks/useForm";
import { useInput } from "../hooks/useInput";
import { useIsValid } from "../hooks/useIsValid";
import { getFormValue } from "./getFormValue";
import { setFieldValue, setFormValue } from "./setFieldValue";

const Form = ({ onSubmit, initialValue, validator }: any) => {
  const form = useForm({
    initialValue,
  });
  const isValid = useIsValid(form);

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit(getFormValue(form));
      }}
    >
      <input
        type="text"
        name="value"
        ref={useInput(form, "value", { validator })}
      />
      <input
        type="text"
        name="nested.value"
        ref={useInput(form, "nested.value")}
      />
      <div data-testid="isValid">{String(isValid)}</div>
      <input type="submit" value="Submit" />
      <button
        data-testid="setFieldValue"
        type="button"
        onClick={() => setFieldValue(form, "value", "value set")}
      ></button>
      <button
        data-testid="setMultiple"
        type="button"
        onClick={() =>
          setFormValue(form, {
            nested: {
              value: "multiple set 0",
            },
            value: "multiple set 1",
          })
        }
      ></button>
      <button
        data-testid="setMultipleIgnore"
        type="button"
        onClick={() =>
          setFormValue(form, {
            nested: {
              value: "ignoring some",
            },
          })
        }
      ></button>
    </form>
  );
};

describe("setFieldValue", () => {
  it("sets the value of individual fields", async () => {
    const onSubmit = jest.fn();
    const { container, getByTestId } = render(<Form onSubmit={onSubmit} />);
    await userEvent.click(container.querySelector('input[type="submit"]')!);
    expect(onSubmit).toHaveBeenCalledWith({
      nested: {
        value: "",
      },
      value: "",
    });

    await userEvent.click(getByTestId("setFieldValue"));
    await userEvent.click(container.querySelector('input[type="submit"]')!);
    expect(onSubmit).toHaveBeenCalledWith({
      nested: {
        value: "",
      },
      value: "value set",
    });
  });

  it("sets the value of multiple fields", async () => {
    const onSubmit = jest.fn();
    const { container, getByTestId } = render(<Form onSubmit={onSubmit} />);
    await userEvent.click(getByTestId("setMultiple"));
    await userEvent.click(container.querySelector('input[type="submit"]')!);
    expect(onSubmit).toHaveBeenCalledWith({
      nested: {
        value: "multiple set 0",
      },
      value: "multiple set 1",
    });
  });

  it("ignores fields not explicitely passed in", async () => {
    const onSubmit = jest.fn();
    const { container, getByTestId } = render(<Form onSubmit={onSubmit} />);
    await userEvent.click(getByTestId("setMultipleIgnore"));
    await userEvent.type(
      container.querySelector('input[name="value"]')!,
      "typed in value"
    );
    await userEvent.click(container.querySelector('input[type="submit"]')!);
    expect(onSubmit).toHaveBeenCalledWith({
      nested: {
        value: "ignoring some",
      },
      value: "typed in value",
    });
  });
});
