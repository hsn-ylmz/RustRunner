/**
 * A short explanation attached to a control. Opens on pointer hover (after a
 * moment) and on keyboard focus, closes on leave, blur and Escape, and is wired
 * to the control with aria-describedby so a screen reader reads it too.
 *
 * Use it for what a control does or why it is unavailable. Do not put anything
 * in a tooltip that a person needs in order to finish the task: it is
 * secondary. A visible hint under the control is the right place for that.
 */

import {
  cloneElement,
  isValidElement,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react';
import { cx } from './cx';

/** Pointer hover waits this long so passing over a control does not flash. */
export const TOOLTIP_HOVER_DELAY_MS = 350;

export type TooltipPlacement = 'top' | 'bottom' | 'right';

export function Tooltip({
  content,
  children,
  placement = 'bottom',
  block = false,
}: {
  content?: ReactNode;
  /** One element that can take aria-describedby (a button, a field). */
  children: ReactElement;
  placement?: TooltipPlacement;
  /** Stretch the anchor to its container (for full-width buttons). */
  block?: boolean;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>();

  const clear = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = undefined;
  };
  useEffect(() => clear, []);

  if (!content || !isValidElement(children)) return children;

  const showSoon = () => {
    clear();
    timer.current = setTimeout(() => setOpen(true), TOOLTIP_HOVER_DELAY_MS);
  };
  const showNow = () => {
    clear();
    setOpen(true);
  };
  const hide = () => {
    clear();
    setOpen(false);
  };

  const existing = (children.props as { 'aria-describedby'?: string })['aria-describedby'];
  const control = cloneElement(children as ReactElement<any>, {
    'aria-describedby': cx(existing, open && id) || undefined,
  });

  return (
    <span
      className={cx('tooltip-anchor', block && 'tooltip-anchor-block')}
      onMouseEnter={showSoon}
      onMouseLeave={hide}
      onFocus={(e) => {
        // Keyboard focus only: a mouse click also focuses a button, and the
        // tooltip should not pop open on every click.
        if ((e.target as HTMLElement).matches?.(':focus-visible')) showNow();
      }}
      onBlur={hide}
      onMouseDown={hide}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && open) {
          // Close the tooltip without also closing a dialog around it.
          e.stopPropagation();
          hide();
        }
      }}
    >
      {control}
      {open && (
        <span role="tooltip" id={id} className={cx('tooltip', `tooltip-${placement}`)}>
          {content}
        </span>
      )}
    </span>
  );
}
