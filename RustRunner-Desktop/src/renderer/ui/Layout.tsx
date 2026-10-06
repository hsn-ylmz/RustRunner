/**
 * Panel and Section: the two containers that give the app its structure.
 *
 *   Panel    a side or bottom surface with a title: properties, tool catalog
 *   Section  a titled group of related controls inside a panel or dialog
 */

import { useId, type HTMLAttributes, type ReactNode } from 'react';
import { cx } from './cx';

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
