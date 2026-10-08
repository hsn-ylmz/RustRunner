/**
 * A small label for a state or a tag: "MOCK", "3 failed", "Unsaved". The tone
 * says what kind of thing it is; the text and the optional icon always say it
 * too, so colour is never the only signal.
 */

import type { HTMLAttributes, ReactNode } from 'react';
import { cx } from './cx';
import { Icon, type IconName } from './Icon';

export type BadgeTone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger' | 'info';
export type BadgeVariant = 'subtle' | 'solid' | 'outline' | 'dashed';

export function Badge({
  tone = 'neutral',
  variant = 'subtle',
  icon,
  className,
  children,
  ...rest
}: Omit<HTMLAttributes<HTMLSpanElement>, 'className'> & {
  tone?: BadgeTone;
  /** subtle: tinted. solid: filled, white text. outline / dashed: border only. */
  variant?: BadgeVariant;
  icon?: IconName;
  className?: string;
  children?: ReactNode;
}) {
  return (
    <span className={cx('badge', `badge-${tone}`, `badge-${variant}`, className)} {...rest}>
      {icon && <Icon name={icon} size={12} />}
      {children}
    </span>
  );
}
