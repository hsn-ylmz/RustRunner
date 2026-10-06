/**
 * Keyboard shortcuts of the editor: which key does what, and the table shown in
 * the help dialog. Pure, so the matching rules (modifier per platform, nothing
 * fires while typing) are unit-tested.
 */

export type ShortcutAction =
  | 'save'
  | 'open'
  | 'run'
  | 'palette'
  | 'undo'
  | 'redo'
  | 'delete'
  | 'escape'
  | 'help';

export interface KeyInput {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

export interface Shortcut {
  action: ShortcutAction;
  /** What it does, as shown in the help dialog. */
  label: string;
  /** Keys, as shown. `Mod` is Cmd on a Mac and Ctrl elsewhere. */
  keys: string;
}

export const SHORTCUTS: Shortcut[] = [
  { action: 'run', label: 'Run the workflow', keys: 'Mod+Enter' },
  { action: 'save', label: 'Save', keys: 'Mod+S' },
  { action: 'open', label: 'Open a workflow', keys: 'Mod+O' },
  { action: 'palette', label: 'Open the tool catalog', keys: 'Mod+K' },
  { action: 'undo', label: 'Undo', keys: 'Mod+Z' },
  { action: 'redo', label: 'Redo', keys: 'Shift+Mod+Z' },
  { action: 'delete', label: 'Delete the selected step or connection', keys: 'Delete' },
  { action: 'escape', label: 'Close the catalog or a dialog, or deselect', keys: 'Esc' },
  { action: 'help', label: 'Show these shortcuts', keys: '?' },
];

/** `Mod` spelled for the platform: "Cmd+S" on a Mac, "Ctrl+S" elsewhere. */
export function formatKeys(keys: string, isMac: boolean): string {
  return keys.replace(/Mod/g, isMac ? 'Cmd' : 'Ctrl');
}

/** True when the key press would type into the focused element. */
export function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || typeof el.tagName !== 'string') return false;
  if (el.isContentEditable) return true;
  const tag = el.tagName;
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag !== 'INPUT') return false;
  // Checkboxes and buttons take no text; shortcuts should still work there.
  const type = (el as HTMLInputElement).type;
  return !['checkbox', 'radio', 'button', 'submit', 'reset', 'range', 'color', 'file'].includes(type);
}

/**
 * The action for a key press, or null. While typing, only the shortcuts with a
 * command key (save, open, run, catalog) stay active; the rest (undo, delete,
 * Escape, ?) belong to the text field.
 */
export function matchShortcut(
  e: KeyInput,
  { isMac, typing }: { isMac: boolean; typing: boolean }
): ShortcutAction | null {
  const mod = isMac ? e.metaKey : e.ctrlKey;
  const otherMod = isMac ? e.ctrlKey : e.metaKey;
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;

  if (mod && !otherMod && !e.altKey) {
    if (!e.shiftKey) {
      if (key === 's') return 'save';
      if (key === 'o') return 'open';
      if (key === 'k') return 'palette';
      if (key === 'Enter') return 'run';
      if (key === 'z') return typing ? null : 'undo';
    } else if (key === 'z') {
      return typing ? null : 'redo';
    }
    return null;
  }
  if (mod || otherMod || e.altKey || typing) return null;

  if (key === 'Delete' || key === 'Backspace') return 'delete';
  if (key === 'Escape') return 'escape';
  if (key === '?') return 'help';
  return null;
}
