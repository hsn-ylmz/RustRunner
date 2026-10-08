/** The list of toasts on screen, as pure functions so the rules can be unit-tested. */

import type { IconName } from './ui/Icon';

export type ToastTone = 'info' | 'success' | 'warning' | 'danger';

export interface ToastAction {
  label: string;
  onClick: () => void;
}

export interface Toast {
  id: number;
  tone: ToastTone;
  message: string;
  action?: ToastAction;
}

/** More than this at once is noise: the oldest goes first. */
export const MAX_TOASTS = 3;

/** How long a toast stays: errors and toasts with an action stay longer. */
export function toastDuration(toast: Pick<Toast, 'tone' | 'action'>): number {
  if (toast.tone === 'danger') return 10_000;
  if (toast.action) return 8_000;
  return 5_000;
}

export const TOAST_ICON: Record<ToastTone, IconName> = {
  info: 'info',
  success: 'check',
  warning: 'alert',
  danger: 'alert',
};

/**
 * Adds a toast. The same message again replaces the earlier one (saving twice
 * does not stack two "Saved"), and the list is capped at MAX_TOASTS.
 */
export function addToast(list: readonly Toast[], toast: Toast): Toast[] {
  const rest = list.filter((t) => !(t.message === toast.message && t.tone === toast.tone));
  return [...rest, toast].slice(-MAX_TOASTS);
}

export function removeToast(list: readonly Toast[], id: number): Toast[] {
  return list.filter((t) => t.id !== id);
}
