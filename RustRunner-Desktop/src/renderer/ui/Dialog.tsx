/**
 * A modal dialog: named by its title, closes on Escape, keeps Tab inside, and
 * puts focus back on the control that opened it. A click on the dim area only
 * closes it while nothing has been typed (`dirty` false), so a stray click does
 * not throw work away.
 */

import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { FOCUSABLE_SELECTOR, trapTarget } from './focus';

export function Dialog({
  title,
  onClose,
  dirty = false,
  footer,
  children,
  testId,
}: {
  title: string;
  onClose: () => void;
  /** True when closing would discard typed input. */
  dirty?: boolean;
  footer?: ReactNode;
  children: ReactNode;
  testId?: string;
}) {
  const titleId = useId();
  const boxRef = useRef<HTMLDivElement>(null);
  // Read while rendering: by the time effects run, an autoFocus field has
  // already taken focus and the opener would be lost.
  const [opener] = useState(() =>
    typeof document === 'undefined' ? null : (document.activeElement as HTMLElement | null)
  );

  // Remember what had focus, move focus in, and hand it back on close.
  useEffect(() => {
    const box = boxRef.current;
    if (box && !box.contains(document.activeElement)) {
      (box.querySelector<HTMLElement>(FOCUSABLE_SELECTOR) ?? box).focus();
    }
    return () => {
      if (opener && document.contains(opener)) opener.focus();
    };
  }, [opener]);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      onClose();
      return;
    }
    if (e.key !== 'Tab' || !boxRef.current) return;
    const stops = Array.from(boxRef.current.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
    const target = trapTarget(stops.length, stops.indexOf(document.activeElement as HTMLElement), e.shiftKey);
    if (target !== null) {
      e.preventDefault();
      stops[target]?.focus();
    }
  };

  return (
    <div
      className="dialog-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !dirty) onClose();
      }}
    >
      <div
        className="dialog-box"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        data-testid={testId}
        ref={boxRef}
        onKeyDown={onKeyDown}
      >
        <h3 className="dialog-title" id={titleId}>
          {title}
        </h3>
        <div className="dialog-body">{children}</div>
        {footer && <div className="dialog-footer">{footer}</div>}
      </div>
    </div>
  );
}
