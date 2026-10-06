/**
 * An inline message about the thing next to it: a missing required option, a
 * note that a command was edited by hand, a mocked step. Always has text and an
 * icon, never colour alone. For a message about one field use the field's own
 * `error` slot instead.
 */

import type { HTMLAttributes, ReactNode } from 'react';
import { cx } from './cx';
import { Icon, type IconName } from './Icon';

export type CalloutTone = 'info' | 'success' | 'warning' | 'danger';

const DEFAULT_ICON: Record<CalloutTone, IconName> = {
  info: 'info',
  success: 'check',
  warning: 'alert',
  danger: 'alert',
};

export function Callout({
  tone = 'info',
  icon,
  className,
  children,
  ...rest
}: Omit<HTMLAttributes<HTMLDivElement>, 'className'> & {
  tone?: CalloutTone;
  icon?: IconName;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={cx('callout', `callout-${tone}`, className)} {...rest}>
      <Icon name={icon ?? DEFAULT_ICON[tone]} size={14} className="callout-icon" />
      <div className="callout-body">{children}</div>
    </div>
  );
}
