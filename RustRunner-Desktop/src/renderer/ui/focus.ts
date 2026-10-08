/** Elements a keyboard user can reach with Tab. */
export const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

/**
 * Where Tab or Shift+Tab should move focus inside a trap of `count` stops, or
 * null to let the browser move it normally. Wraps at both ends; if focus is
 * somewhere outside the trap (-1) it comes back in.
 */
export function trapTarget(count: number, current: number, backwards: boolean): number | null {
  if (count === 0) return null;
  if (current < 0) return backwards ? count - 1 : 0;
  if (backwards && current === 0) return count - 1;
  if (!backwards && current === count - 1) return 0;
  return null;
}
