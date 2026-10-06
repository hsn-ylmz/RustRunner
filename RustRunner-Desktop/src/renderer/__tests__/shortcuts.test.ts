import { describe, expect, it } from 'vitest';
import { SHORTCUTS, formatKeys, isTypingTarget, matchShortcut, type KeyInput } from '../shortcuts';

const key = (k: string, mods: Partial<KeyInput> = {}): KeyInput => ({
  key: k,
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  ...mods,
});
const mac = { isMac: true, typing: false };
const pc = { isMac: false, typing: false };

describe('matchShortcut', () => {
  it('uses Cmd on a Mac and Ctrl elsewhere', () => {
    expect(matchShortcut(key('s', { metaKey: true }), mac)).toBe('save');
    expect(matchShortcut(key('s', { ctrlKey: true }), mac)).toBeNull();
    expect(matchShortcut(key('s', { ctrlKey: true }), pc)).toBe('save');
    expect(matchShortcut(key('s', { metaKey: true }), pc)).toBeNull();
  });

  it('maps the command-key shortcuts', () => {
    const cmd = { metaKey: true };
    expect(matchShortcut(key('o', cmd), mac)).toBe('open');
    expect(matchShortcut(key('k', cmd), mac)).toBe('palette');
    expect(matchShortcut(key('K', cmd), mac)).toBe('palette');
    expect(matchShortcut(key('Enter', cmd), mac)).toBe('run');
    expect(matchShortcut(key('z', cmd), mac)).toBe('undo');
    expect(matchShortcut(key('z', { ...cmd, shiftKey: true }), mac)).toBe('redo');
    expect(matchShortcut(key('Z', { ...cmd, shiftKey: true }), mac)).toBe('redo');
  });

  it('ignores a command key with Alt or another command shortcut it does not know', () => {
    expect(matchShortcut(key('s', { metaKey: true, altKey: true }), mac)).toBeNull();
    expect(matchShortcut(key('q', { metaKey: true }), mac)).toBeNull();
    expect(matchShortcut(key('s', { metaKey: true, shiftKey: true }), mac)).toBeNull();
  });

  it('maps Delete, Backspace, Escape and ? only without modifiers', () => {
    expect(matchShortcut(key('Delete'), mac)).toBe('delete');
    expect(matchShortcut(key('Backspace'), pc)).toBe('delete');
    expect(matchShortcut(key('Escape'), pc)).toBe('escape');
    expect(matchShortcut(key('?', { shiftKey: true }), pc)).toBe('help');
    expect(matchShortcut(key('Delete', { ctrlKey: true }), pc)).toBeNull();
    expect(matchShortcut(key('a'), pc)).toBeNull();
  });

  it('keeps editing keys for the text field while typing', () => {
    const typing = { isMac: true, typing: true };
    expect(matchShortcut(key('Delete'), typing)).toBeNull();
    expect(matchShortcut(key('Backspace'), typing)).toBeNull();
    expect(matchShortcut(key('Escape'), typing)).toBeNull();
    expect(matchShortcut(key('?', { shiftKey: true }), typing)).toBeNull();
    expect(matchShortcut(key('z', { metaKey: true }), typing)).toBeNull();
    expect(matchShortcut(key('z', { metaKey: true, shiftKey: true }), typing)).toBeNull();
    // Save, open, run and the catalog still work from a field.
    expect(matchShortcut(key('s', { metaKey: true }), typing)).toBe('save');
    expect(matchShortcut(key('Enter', { metaKey: true }), typing)).toBe('run');
    expect(matchShortcut(key('k', { metaKey: true }), typing)).toBe('palette');
  });
});

describe('isTypingTarget', () => {
  const el = (tagName: string, extra: Record<string, unknown> = {}) =>
    ({ tagName, isContentEditable: false, ...extra }) as unknown as EventTarget;

  it('is true for text controls and editable content', () => {
    expect(isTypingTarget(el('INPUT', { type: 'text' }))).toBe(true);
    expect(isTypingTarget(el('INPUT', { type: 'number' }))).toBe(true);
    expect(isTypingTarget(el('TEXTAREA'))).toBe(true);
    expect(isTypingTarget(el('SELECT'))).toBe(true);
    expect(isTypingTarget(el('DIV', { isContentEditable: true }))).toBe(true);
  });

  it('is false for checkboxes, buttons, the page and nothing', () => {
    expect(isTypingTarget(el('INPUT', { type: 'checkbox' }))).toBe(false);
    expect(isTypingTarget(el('BUTTON'))).toBe(false);
    expect(isTypingTarget(el('DIV'))).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
  });
});

describe('help table', () => {
  it('spells Mod for the platform', () => {
    expect(formatKeys('Shift+Mod+Z', true)).toBe('Shift+Cmd+Z');
    expect(formatKeys('Mod+S', false)).toBe('Ctrl+S');
    expect(formatKeys('Esc', true)).toBe('Esc');
  });

  it('lists every action once', () => {
    const actions = SHORTCUTS.map((s) => s.action);
    expect(new Set(actions).size).toBe(actions.length);
    expect(actions).toEqual(
      expect.arrayContaining(['save', 'open', 'run', 'palette', 'undo', 'redo', 'delete', 'escape', 'help'])
    );
  });
});
