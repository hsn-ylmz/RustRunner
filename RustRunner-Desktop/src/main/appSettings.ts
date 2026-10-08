/**
 * App settings kept per person in the app's own data folder (`settings.json`):
 * for now the tool palette's favourites and recently used tools. Kept free of
 * Electron imports so it can be unit-tested; the caller passes the file path.
 *
 * The file is read as untrusted input (hand edits, damage): anything that is
 * not a plain tool id is dropped, lists are capped, and a missing or broken
 * file gives the defaults instead of an error.
 */

import fs from 'fs';
import path from 'path';

export interface PalettePrefs {
  favourites: string[];
  /** Newest first. */
  recent: string[];
}

export interface AppSettings {
  palette: PalettePrefs;
}

export const MAX_FAVOURITES = 100;
export const MAX_RECENT = 8;

/** A catalog tool id: letters, digits, dots, dashes and underscores. */
const TOOL_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function idList(value: unknown, max: number): string[] {
  if (!Array.isArray(value)) return [];
  const ids = value.filter((v): v is string => typeof v === 'string' && TOOL_ID.test(v));
  return [...new Set(ids)].slice(0, max);
}

/** The settings for any parsed JSON value. */
export function sanitizeSettings(raw: unknown): AppSettings {
  const root = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
  const palette =
    typeof root.palette === 'object' && root.palette !== null
      ? (root.palette as Record<string, unknown>)
      : {};
  return {
    palette: {
      favourites: idList(palette.favourites, MAX_FAVOURITES),
      recent: idList(palette.recent, MAX_RECENT),
    },
  };
}

/** The saved settings, or the defaults when the file is missing or damaged. */
export function readSettings(file: string): AppSettings {
  try {
    return sanitizeSettings(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch {
    return sanitizeSettings(null);
  }
}

/**
 * Saves the settings. The file is written next to its final place and renamed,
 * so a crash cannot leave half a file behind.
 */
export function writeSettings(file: string, settings: AppSettings): AppSettings {
  const clean = sanitizeSettings(settings);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(clean, null, 2), 'utf8');
  fs.renameSync(temp, file);
  return clean;
}
