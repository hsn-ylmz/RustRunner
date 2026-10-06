/**
 * Panel and Section: the two containers that give the app its structure.
 *
 *   Panel    a side or bottom surface with a title: properties, tool catalog
 *   Section  a titled group of related controls inside a panel or dialog
 *   CollapsibleSection  a Section whose header folds it away and, while folded,
 *            says what is inside in one line
 */

import { useId, type HTMLAttributes, type ReactNode } from 'react';
import { cx } from './cx';
import { Icon } from './Icon';

export function Panel({
  title,
  actions,
  className,
  children,
  ...rest
}: Omit<HTMLAttributes<HTMLDivElement>, 'title'> & {
  title?: ReactNode;
  /** Buttons at the right end of the header. */
  actions?: ReactNode;
}) {
  return (
    <div className={cx('panel', className)} {...rest}>
      {(title || actions) && (
        <div className="panel-header">
          {title && <h3 className="panel-title">{title}</h3>}
          {actions}
        </div>
      )}
      <div className="panel-body">{children}</div>
    </div>
  );
}

export function Section({
  title,
  description,
  card = false,
  className,
  children,
  ...rest
}: Omit<HTMLAttributes<HTMLElement>, 'title'> & {
  title: ReactNode;
  /** One short line under the title. */
  description?: ReactNode;
  /** Draw it as a bordered card (for a block that stands apart, like tool options). */
  card?: boolean;
}) {
  const id = useId();
  return (
    <section
      className={cx('section', card && 'section-card', className)}
      aria-labelledby={id}
      {...rest}
    >
      <h4 className="section-title" id={id}>
        {title}
      </h4>
      {description && <p className="section-description">{description}</p>}
      <div className="section-body">{children}</div>
    </section>
  );
}

/**
 * A section the person can fold. The header is a button (`aria-expanded`,
 * `aria-controls`) so the keyboard and screen readers get the same control as
 * the mouse. The body is not rendered while folded. `summary` shows under the
 * title while folded, so a closed section still tells what is set; `attention`
 * (for example "1 problem") shows in any state, so a fold never hides an error.
 */
export function CollapsibleSection({
  title,
  summary,
  attention,
  open,
  onToggle,
  className,
  children,
  'data-testid': testId,
  ...rest
}: Omit<HTMLAttributes<HTMLElement>, 'title' | 'onToggle'> & {
  title: ReactNode;
  /** One short line shown while folded. */
  summary?: ReactNode;
  /** A problem count or short warning, always visible. */
  attention?: ReactNode;
  open: boolean;
  onToggle: (open: boolean) => void;
  'data-testid'?: string;
}) {
  const id = useId();
  const bodyId = `${id}-body`;
  return (
    <section
      className={cx('section', 'section-collapsible', open && 'is-open', className)}
      aria-labelledby={id}
      data-testid={testId}
      {...rest}
    >
      <h4 className="section-title" id={id}>
        <button
          type="button"
          className="section-toggle"
          aria-expanded={open}
          aria-controls={bodyId}
          data-testid={testId ? `${testId}-toggle` : undefined}
          onClick={() => onToggle(!open)}
        >
          <Icon name="chevron-down" size={14} className="section-chevron" />
          <span className="section-toggle-title">{title}</span>
          {attention ? (
            <span className="section-attention">
              <Icon name="alert" size={12} />
              {attention}
            </span>
          ) : null}
          {!open && summary ? <span className="section-summary">{summary}</span> : null}
        </button>
      </h4>
      {open && (
        <div className="section-body" id={bodyId}>
          {children}
        </div>
      )}
    </section>
  );
}
