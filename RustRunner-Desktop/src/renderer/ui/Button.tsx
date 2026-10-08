/**
 * Buttons.
 *
 *   primary    the one thing to do next on a screen (Run, Create, Save)
 *   secondary  every other action; the default
 *   ghost      low-emphasis, for toolbars and dense rows
 *   danger     a destructive action that is about to happen (Stop, Delete for good)
 *
 * A button can be unavailable in three ways. `disabled` is the plain native
 * state. `disabledReason` is the same, but keeps the button focusable and
 * says why in a tooltip, which is what a first-time user needs ("Add a step to
 * run"). `loading` shows a spinner while the action is under way and keeps
 * focus where it was.
 */

import { forwardRef, type ButtonHTMLAttributes, type ReactElement, type ReactNode } from 'react';
import { cx } from './cx';
import { Icon, type IconName } from './Icon';
import { Tooltip, type TooltipPlacement } from './Tooltip';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md' | 'lg';

export interface ButtonStyleOptions {
  variant?: ButtonVariant;
  size?: ButtonSize;
  fullWidth?: boolean;
  iconOnly?: boolean;
  pressed?: boolean;
  className?: string;
}

/** The class list for a button, shared by Button, IconButton and link-like buttons. */
export function buttonClassName({
  variant = 'secondary',
  size = 'md',
  fullWidth = false,
  iconOnly = false,
  pressed = false,
  className,
}: ButtonStyleOptions = {}): string {
  return cx(
    'btn',
    `btn-${variant}`,
    `btn-${size}`,
    fullWidth && 'btn-block',
    iconOnly && 'btn-icon',
    pressed && 'is-pressed',
    className
  );
}

export interface ButtonProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'className'>,
    ButtonStyleOptions {
  icon?: IconName;
  /** Show a spinner and ignore clicks while an action is under way. */
  loading?: boolean;
  /** Unavailable, and why. Keeps the button focusable so the reason can be reached. */
  disabledReason?: string;
  /** Extra explanation shown on hover and keyboard focus. */
  tooltip?: ReactNode;
  tooltipPlacement?: TooltipPlacement;
  children?: ReactNode;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant,
    size,
    fullWidth,
    pressed,
    className,
    icon,
    loading = false,
    disabledReason,
    tooltip,
    tooltipPlacement,
    disabled,
    type = 'button',
    onClick,
    children,
    ...rest
  },
  ref
) {
  // Loading and a stated reason use aria-disabled so the button keeps focus.
  const soft = loading || Boolean(disabledReason);
  const button: ReactElement = (
    <button
      ref={ref}
      type={type}
      className={buttonClassName({ variant, size, fullWidth, pressed, className })}
      disabled={disabled && !soft}
      aria-disabled={soft || undefined}
      aria-busy={loading || undefined}
      onClick={soft ? undefined : onClick}
      {...rest}
    >
      {loading ? <Icon name="spinner" spin /> : icon ? <Icon name={icon} /> : null}
      {children != null && children !== false && <span className="btn-label">{children}</span>}
    </button>
  );
  const note = loading ? undefined : (disabledReason ?? tooltip);
  return note ? (
    <Tooltip content={note} block={fullWidth} placement={tooltipPlacement}>
      {button}
    </Tooltip>
  ) : (
    button
  );
});

export interface IconButtonProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'className' | 'aria-label'> {
  /** What the button does. Required: it is the button's only text. */
  label: string;
  icon: IconName;
  variant?: ButtonVariant;
  size?: ButtonSize;
  pressed?: boolean;
  className?: string;
}

/** A button with only an icon. The label becomes its accessible name and its tooltip. */
export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, icon, variant = 'ghost', size = 'md', pressed, className, type = 'button', ...rest },
  ref
) {
  return (
    <Tooltip content={label}>
      <button
        ref={ref}
        type={type}
        aria-label={label}
        aria-pressed={pressed}
        className={buttonClassName({ variant, size, iconOnly: true, pressed, className })}
        {...rest}
      >
        <Icon name={icon} />
      </button>
    </Tooltip>
  );
});
