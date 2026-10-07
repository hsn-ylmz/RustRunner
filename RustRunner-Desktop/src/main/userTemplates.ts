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
 * disk: ids are plain names (no path can be built from one), only regular
 * files are read (a pipe or device named `x.json` would block the read), files
 * are size-capped, writes go through a temp file and a rename, and a new
 * template never replaces an existing file, even one created a moment earlier.
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
    const read = readTemplateFile(fileFor(dir, id));
    out.push(read.ok === false ? { id, error: read.error } : { id, raw: read.raw });
  }
  return out;
}

/**
 * The parsed contents of one template file. Only a regular file (or a link to
 * one) of at most MAX_TEMPLATE_BYTES is read.
 */
function readTemplateFile(file: string): { ok: true; raw: unknown } | { ok: false; error: string } {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch {
    return { ok: false, error: 'The file cannot be read.' };
  }
  if (!stat.isFile()) return { ok: false, error: 'This is not a regular file.' };
  if (stat.size > MAX_TEMPLATE_BYTES) return { ok: false, error: 'The file is too large to be a template.' };
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return { ok: false, error: 'The file cannot be read.' };
  }
  // The size may have changed since the check; the cap holds for what was read.
  if (Buffer.byteLength(text) > MAX_TEMPLATE_BYTES) return { ok: false, error: 'The file is too large to be a template.' };
  try {
    return { ok: true, raw: JSON.parse(text) };
  } catch {
    return { ok: false, error: 'The file is not valid JSON.' };
  }
}

function tempFor(file: string): string {
  return `${file}.${process.pid}.${Date.now().toString(36)}.tmp`;
}

function writeAtomic(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = tempFor(file);
  try {
    fs.writeFileSync(temp, text, { encoding: 'utf8', flag: 'wx' });
    fs.renameSync(temp, file);
  } finally {
    fs.rmSync(temp, { force: true });
  }
}

/**
 * Writes a new file in one step without ever replacing an existing one: the
 * text goes to a temp file, which is then hard-linked under the final name
 * (linking fails when the name is taken). On a file system without hard links
 * (exFAT, some network shares) the file is created exclusively instead, which
 * also never replaces one. False when the name was taken.
 */
function writeNew(file: string, text: string): boolean {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = tempFor(file);
  try {
    fs.writeFileSync(temp, text, { encoding: 'utf8', flag: 'wx' });
    try {
      fs.linkSync(temp, file);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    }
    try {
      fs.writeFileSync(file, text, { encoding: 'utf8', flag: 'wx' });
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
      throw error;
    }
  } finally {
    fs.rmSync(temp, { force: true });
  }
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
  try {
    if (!writeNew(fileFor(dir, id), text)) return { ok: false, error: 'A template with this id already exists.' };
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
  const file = fileFor(dir, id);
  const read = readTemplateFile(file);
  if (read.ok === false) return { ok: false, error: read.error };
  const raw = read.raw;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, error: 'The file is not a template.' };
  }
  const text = JSON.stringify({ ...raw, name: clean }, null, 2);
  if (Buffer.byteLength(text) > MAX_TEMPLATE_BYTES) return { ok: false, error: 'The template is too large.' };
  try {
    writeAtomic(file, text);
    return { ok: true };
  } catch {
    return { ok: false, error: 'The template could not be renamed.' };
  }
}
