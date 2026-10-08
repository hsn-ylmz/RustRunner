/**
 * Toasts: short, non-blocking messages about something that just happened
 * (saved, could not open a file). They never take focus and go away by
 * themselves; an error stays longer. The container is a polite live region, so
 * a screen reader announces them without interrupting. Anything the person must
 * act on belongs in a Callout or a dialog instead.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  TOAST_ICON,
  addToast,
  removeToast,
  toastDuration,
  type Toast,
  type ToastAction,
  type ToastTone,
} from '../toastState';
import { Button, IconButton } from './Button';
import { Icon } from './Icon';
import { cx } from './cx';

export type Notify = (tone: ToastTone, message: string, action?: ToastAction) => void;

/** The toasts on screen and a function to show one. */
export function useToasts(): { toasts: Toast[]; notify: Notify; dismiss: (id: number) => void } {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);

  const dismiss = useCallback((id: number) => setToasts((list) => removeToast(list, id)), []);
  const notify = useCallback<Notify>((tone, message, action) => {
    const toast: Toast = { id: nextId.current++, tone, message, action };
    setToasts((list) => addToast(list, toast));
  }, []);

  return { toasts, notify, dismiss };
}

function ToastItem({ toast, onDismiss }: { toast: Toast; onDismiss: (id: number) => void }) {
  // The timer restarts when the same message is shown again (a new id).
  useEffect(() => {
    const timer = setTimeout(() => onDismiss(toast.id), toastDuration(toast));
    return () => clearTimeout(timer);
  }, [toast, onDismiss]);

  return (
    <div className={cx('toast', `toast-${toast.tone}`)} data-testid="toast" data-tone={toast.tone}>
      <Icon name={TOAST_ICON[toast.tone]} size={16} className="toast-icon" />
      <span className="toast-message">{toast.message}</span>
      {toast.action && (
        <Button
          size="sm"
          variant="ghost"
          data-testid="toast-action"
          onClick={() => {
            toast.action?.onClick();
            onDismiss(toast.id);
          }}
        >
          {toast.action.label}
        </Button>
      )}
      <IconButton
        icon="x"
        size="sm"
        label="Dismiss message"
        data-testid="toast-dismiss"
        onClick={() => onDismiss(toast.id)}
      />
    </div>
  );
}

export function ToastHost({
  toasts,
  onDismiss,
}: {
  toasts: Toast[];
  onDismiss: (id: number) => void;
}) {
  return (
    <div className="toast-host" role="status" aria-live="polite" data-testid="toast-host">
      {toasts.map((t) => (
        <ToastItem key={t.id} toast={t} onDismiss={onDismiss} />
      ))}
    </div>
  );
}
