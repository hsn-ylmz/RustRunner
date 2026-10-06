/**
 * Form controls. Each one owns its label, hint and error, wired together with
 * ids so that the label names the control (and clicking it focuses the
 * control) and a screen reader reads the hint and the error with it.
 *
 *   label   what the field is, in plain words; always visible
 *   hint    one or two short lines that help someone fill it in
 *   error   what is wrong and what to do; shown instead of nothing, never
 *           only as a colour
 *
 * Extra props (data-testid, min, max, disabled, ...) go to the control itself.
 */

import {
  useId,
  type InputHTMLAttributes,
  type Ref,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react';
import { cx } from './cx';
import { Icon } from './Icon';

export interface FieldChrome {
  label: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  /** Adds "(required)" to the label. */
  required?: boolean;
  /** Adds "(optional)" to the label. */
  optional?: boolean;
  /** Overrides the generated id (the label's htmlFor). */
  id?: string;
  /** Keep the label for screen readers but do not draw it (the control must say what it is). */
  hideLabel?: boolean;
}

/** The props a control receives from its field. */
export interface ControlProps {
  id: string;
  'aria-describedby'?: string;
  'aria-invalid'?: true;
}

export interface FieldIds {
  id: string;
  hintId: string;
  errorId: string;
}

/** Ids for one field: the control, its hint and its error. */
export function fieldIds(base: string): FieldIds {
  return { id: base, hintId: `${base}-hint`, errorId: `${base}-error` };
}

/** The aria-describedby value for a field: the error first, then the hint. */
export function describedBy(
  ids: FieldIds,
  { hint, error, extra }: { hint?: ReactNode; error?: ReactNode; extra?: string }
): string | undefined {
  const parts = [error ? ids.errorId : '', hint ? ids.hintId : '', extra ?? ''].filter(Boolean);
  return parts.length > 0 ? parts.join(' ') : undefined;
}

function useFieldIds(id?: string): FieldIds {
  const generated = useId();
  return fieldIds(id ?? `field-${generated.replace(/:/g, '')}`);
}

export function FieldMessage({ ids, hint, error }: { ids: FieldIds; hint?: ReactNode; error?: ReactNode }) {
  return (
    <>
      {error ? (
        <div className="field-error" id={ids.errorId}>
          <Icon name="alert" size={14} />
          <span>{error}</span>
        </div>
      ) : null}
      {hint ? (
        <div className="field-hint" id={ids.hintId}>
          {hint}
        </div>
      ) : null}
    </>
  );
}

/** Label, control slot, hint and error. The control comes from `children`. */
export function Field({
  label,
  hint,
  error,
  required,
  optional,
  id,
  hideLabel,
  className,
  extraDescribedBy,
  children,
}: FieldChrome & {
  className?: string;
  extraDescribedBy?: string;
  children: (control: ControlProps) => ReactNode;
}) {
  const ids = useFieldIds(id);
  const control: ControlProps = {
    id: ids.id,
    'aria-describedby': describedBy(ids, { hint, error, extra: extraDescribedBy }),
    'aria-invalid': error ? true : undefined,
  };
  return (
    <div className={cx('field', error && 'has-error', className)}>
      <label className={cx('field-label', hideLabel && 'visually-hidden')} htmlFor={ids.id}>
        {label}
        {required && <span className="field-flag"> (required)</span>}
        {optional && <span className="field-flag"> (optional)</span>}
      </label>
      {children(control)}
      <FieldMessage ids={ids} hint={hint} error={error} />
    </div>
  );
}

type InputExtras = Omit<InputHTMLAttributes<HTMLInputElement>, 'id'>;

export function TextField({
  label,
  hint,
  error,
  required,
  optional,
  id,
  hideLabel,
  className,
  mono,
  inputRef,
  ...input
}: FieldChrome & InputExtras & { mono?: boolean; inputRef?: Ref<HTMLInputElement> }) {
  return (
    <Field
      label={label}
      hint={hint}
      error={error}
      required={required}
      optional={optional}
      id={id}
      hideLabel={hideLabel}
    >
      {(control) => (
        <input
          type="text"
          ref={inputRef}
          {...input}
          {...control}
          className={cx('control', mono && 'control-mono', className)}
        />
      )}
    </Field>
  );
}

/** A number input with an optional unit shown after it ("seconds"). */
export function NumberField({
  label,
  hint,
  error,
  required,
  optional,
  id,
  hideLabel,
  className,
  unit,
  ...input
}: FieldChrome & InputExtras & { unit?: string }) {
  const ids = useFieldIds(id);
  const unitId = `${ids.id}-unit`;
  return (
    <Field
      label={label}
      hint={hint}
      error={error}
      required={required}
      optional={optional}
      id={ids.id}
      hideLabel={hideLabel}
      extraDescribedBy={unit ? unitId : undefined}
    >
      {(control) => (
        <div className="control-with-unit">
          <input
            inputMode="numeric"
            {...input}
            {...control}
            type="number"
            className={cx('control', className)}
          />
          {unit && (
            <span className="control-unit" id={unitId}>
              {unit}
            </span>
          )}
        </div>
      )}
    </Field>
  );
}

export function TextArea({
  label,
  hint,
  error,
  required,
  optional,
  id,
  hideLabel,
  className,
  mono,
  ...input
}: FieldChrome &
  Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'id'> & { mono?: boolean }) {
  return (
    <Field
      label={label}
      hint={hint}
      error={error}
      required={required}
      optional={optional}
      id={id}
      hideLabel={hideLabel}
    >
      {(control) => (
        <textarea
          {...input}
          {...control}
          className={cx('control', 'control-area', mono && 'control-mono', className)}
        />
      )}
    </Field>
  );
}

export function Select({
  label,
  hint,
  error,
  required,
  optional,
  id,
  hideLabel,
  className,
  children,
  ...select
}: FieldChrome & Omit<SelectHTMLAttributes<HTMLSelectElement>, 'id'>) {
  return (
    <Field
      label={label}
      hint={hint}
      error={error}
      required={required}
      optional={optional}
      id={id}
      hideLabel={hideLabel}
    >
      {(control) => (
        <select {...select} {...control} className={cx('control', 'control-select', className)}>
          {children}
        </select>
      )}
    </Field>
  );
}

/** A checkbox with its label to the right, and a hint or error underneath. */
export function Checkbox({
  label,
  hint,
  error,
  id,
  className,
  ...input
}: Omit<FieldChrome, 'required' | 'optional'> & Omit<InputHTMLAttributes<HTMLInputElement>, 'id' | 'type'>) {
  const ids = useFieldIds(id);
  return (
    <div className={cx('check', input.disabled && 'is-disabled', error && 'has-error', className)}>
      <label className="check-row" htmlFor={ids.id}>
        <input
          {...input}
          type="checkbox"
          id={ids.id}
          aria-describedby={describedBy(ids, { hint, error })}
          aria-invalid={error ? true : undefined}
        />
        <span className="check-label">{label}</span>
      </label>
      <FieldMessage ids={ids} hint={hint} error={error} />
    </div>
  );
}
