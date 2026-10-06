import { describe, expect, it } from 'vitest';
import { MAX_TOASTS, addToast, removeToast, toastDuration, type Toast } from '../toastState';

const toast = (id: number, message = `m${id}`, tone: Toast['tone'] = 'info'): Toast => ({ id, tone, message });

describe('toast list', () => {
  it('keeps at most MAX_TOASTS, dropping the oldest', () => {
    let list: Toast[] = [];
    for (let i = 1; i <= MAX_TOASTS + 2; i++) list = addToast(list, toast(i));
    expect(list.map((t) => t.id)).toEqual([3, 4, 5]);
  });

  it('replaces the same message instead of stacking it', () => {
    let list = addToast([], toast(1, 'Saved', 'success'));
    list = addToast(list, toast(2, 'Saved', 'success'));
    expect(list.map((t) => t.id)).toEqual([2]);
    list = addToast(list, toast(3, 'Saved', 'danger'));
    expect(list).toHaveLength(2);
  });

  it('removes by id', () => {
    expect(removeToast([toast(1), toast(2)], 1).map((t) => t.id)).toEqual([2]);
    expect(removeToast([toast(1)], 9)).toHaveLength(1);
  });

  it('keeps errors and actions on screen longer', () => {
    const base = toastDuration({ tone: 'info' });
    expect(toastDuration({ tone: 'danger' })).toBeGreaterThan(base);
    expect(toastDuration({ tone: 'success', action: { label: 'x', onClick: () => {} } })).toBeGreaterThan(base);
  });
});
