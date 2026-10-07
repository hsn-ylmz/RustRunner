/**
 * The person's own workflow templates, one JSON file each in
 * `<home>/.rustrunner/templates/<id>.json` (the same folder tree the engine
 * keeps its tools in). Kept free of Electron imports so it can be unit-tested;
 * the caller passes the folder.
 *
 * This module only stores files. Whether a file is a sound template (known
 * tools, slots that fit) is decided in the renderer against the tool catalog,
 * so a template written by hand or by a newer version still shows up, with a
 * reason when it cannot be used. What is checked here is what protects the
 * disk: ids are plain names (no path can be built from one), files are
 * size-capped, and writes go through a temp file and a rename.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';

/** A template id: lowercase letters, digits and dashes. The file is `<id>.json`. */
export const TEMPLATE_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** Largest template file read or written, in bytes. */
export const MAX_TEMPLATE_BYTES = 256 * 1024;

/** Most template files listed; further ones are ignored. */
export const MAX_TEMPLATES = 200;

/** Longest name a rename accepts, matching the format in the renderer. */
export const MAX_NAME_LENGTH = 80;

/** Where the person's templates live for the user whose home is `home`. */
export function templatesDir(home: string = os.homedir()): string {
  return path.join(home, '.rustrunner', 'templates');
}

export interface StoredTemplate {
  id: string;
  /** The parsed file, not yet checked as a template. Absent when the file cannot be read. */
  raw?: unknown;
  /** Why the file cannot be read at all (too big, not JSON). */
  error?: string;
}

export type StoreResult = { ok: true } | { ok: false; error: string };

const fileFor = (dir: string, id: string) => path.join(dir, `${id}.json`);

/** Every `<id>.json` in the folder, sorted by id. A missing folder is an empty list. */
export function listUserTemplates(dir: string): StoredTemplate[] {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const out: StoredTemplate[] = [];
  for (const name of names.sort()) {
    const id = name.replace(/\.json$/, '');
    if (!name.endsWith('.json') || !TEMPLATE_ID.test(id)) continue;
    if (out.length >= MAX_TEMPLATES) break;
    try {
      const file = fileFor(dir, id);
      if (fs.statSync(file).size > MAX_TEMPLATE_BYTES) {
        out.push({ id, error: 'The file is too large to be a template.' });
        continue;
      }
      out.push({ id, raw: JSON.parse(fs.readFileSync(file, 'utf8')) });
    } catch {
      out.push({ id, error: 'The file is not valid JSON.' });
    }
  }
  return out;
}

function writeAtomic(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, text, 'utf8');
  fs.renameSync(temp, file);
}

/** The id a template object carries, when it is a plain object with a usable one. */
function idOf(raw: unknown): string | null {
  const id = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>).id : undefined;
  return typeof id === 'string' && TEMPLATE_ID.test(id) ? id : null;
}

/** Saves a new template under its own id. An existing one is never replaced. */
export function saveUserTemplate(dir: string, raw: unknown): StoreResult {
  const id = idOf(raw);
  if (!id) return { ok: false, error: 'The template needs an id of lowercase letters, digits and dashes.' };
  const text = JSON.stringify(raw, null, 2);
  if (Buffer.byteLength(text) > MAX_TEMPLATE_BYTES) return { ok: false, error: 'The template is too large.' };
  if (fs.existsSync(fileFor(dir, id))) return { ok: false, error: 'A template with this id already exists.' };
  try {
    writeAtomic(fileFor(dir, id), text);
    return { ok: true };
  } catch {
    return { ok: false, error: 'The templates folder could not be written to.' };
  }
}

/** Removes a template file. A file already gone counts as removed. */
export function deleteUserTemplate(dir: string, id: string): StoreResult {
  if (!TEMPLATE_ID.test(id)) return { ok: false, error: 'Not a template id.' };
  try {
    fs.rmSync(fileFor(dir, id), { force: true });
    return { ok: true };
  } catch {
    return { ok: false, error: 'The template could not be deleted.' };
  }
}

/** Changes the `name` inside a template file; everything else stays as it was. */
export function renameUserTemplate(dir: string, id: string, name: string): StoreResult {
  if (!TEMPLATE_ID.test(id)) return { ok: false, error: 'Not a template id.' };
  const clean = name.trim();
  if (clean === '' || clean.length > MAX_NAME_LENGTH) {
    return { ok: false, error: `Use a name of 1 to ${MAX_NAME_LENGTH} characters.` };
  }
  try {
    const file = fileFor(dir, id);
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      return { ok: false, error: 'The file is not a template.' };
    }
    writeAtomic(file, JSON.stringify({ ...raw, name: clean }, null, 2));
    return { ok: true };
  } catch {
    return { ok: false, error: 'The template could not be renamed.' };
  }
}
