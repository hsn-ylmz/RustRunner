/**
 * A row of colour swatches that behaves as one radio group: Tab enters it at
 * the chosen swatch, the arrow keys (and Home/End) move and choose, and each
 * swatch has its colour's name, so the choice never depends on seeing colour.
 */

import { useRef, type KeyboardEvent } from 'react';
import { cx } from './cx';

export interface Swatch {
  id: string;
  /** Spoken and shown in the tooltip ("Rose"). */
  label: string;
  /** A CSS colour, normally `var(--node-rose)`. */
  color: string;
}

export function SwatchPicker({
  label,
  swatches,
  value,
  onChange,
  className,
  'data-testid': testId,
}: {
  label: string;
  swatches: readonly Swatch[];
  value: string;
  onChange: (id: string) => void;
  className?: string;
  'data-testid'?: string;
}) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const current = Math.max(
    0,
    swatches.findIndex((s) => s.id === value)
  );

  const move = (e: KeyboardEvent, index: number) => {
    const last = swatches.length - 1;
    const next =
      e.key === 'ArrowRight' || e.key === 'ArrowDown'
        ? index === last ? 0 : index + 1
        : e.key === 'ArrowLeft' || e.key === 'ArrowUp'
          ? index === 0 ? last : index - 1
          : e.key === 'Home'
            ? 0
            : e.key === 'End'
              ? last
              : null;
    if (next === null) return;
    e.preventDefault();
    onChange(swatches[next].id);
    refs.current[next]?.focus();
  };

  return (
    <div
      className={cx('swatch-picker', className)}
      role="radiogroup"
      aria-label={label}
      data-testid={testId}
    >
      {swatches.map((swatch, index) => {
        const checked = index === current;
        return (
          <button
            key={swatch.id}
            ref={(el) => {
              refs.current[index] = el;
            }}
            type="button"
            role="radio"
            aria-checked={checked}
            aria-label={swatch.label}
            title={swatch.label}
            tabIndex={checked ? 0 : -1}
            className={cx('swatch', checked && 'is-checked')}
            style={{ backgroundColor: swatch.color }}
            onClick={() => onChange(swatch.id)}
            onKeyDown={(e) => move(e, index)}
            data-testid={testId ? `${testId}-${swatch.id}` : undefined}
          />
        );
      })}
    </div>
  );
}
