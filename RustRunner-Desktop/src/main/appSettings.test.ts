import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  MAX_FAVOURITES,
  MAX_RECENT,
  readSettings,
  sanitizeSettings,
  writeSettings,
} from './appSettings';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-settings-'));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('app settings', () => {
  it('gives the defaults for anything that is not an object', () => {
    for (const raw of [null, undefined, 3, 'x', [], { palette: 5 }]) {
      expect(sanitizeSettings(raw)).toEqual({ palette: { favourites: [], recent: [] } });
    }
  });

  it('keeps plain tool ids, drops everything else, removes repeats', () => {
    const s = sanitizeSettings({
      palette: {
        favourites: ['fastqc', 'fastqc', 'bwa-mem', 7, '../etc', 'a b', '', 'x'.repeat(65)],
        recent: ['samtools-sort', null],
      },
    });
    expect(s.palette.favourites).toEqual(['fastqc', 'bwa-mem']);
    expect(s.palette.recent).toEqual(['samtools-sort']);
  });

  it('caps the lists', () => {
    const many = Array.from({ length: 300 }, (_, i) => `tool-${i}`);
    const s = sanitizeSettings({ palette: { favourites: many, recent: many } });
    expect(s.palette.favourites).toHaveLength(MAX_FAVOURITES);
    expect(s.palette.recent).toHaveLength(MAX_RECENT);
  });

  it('reads defaults from a missing or damaged file', () => {
    const file = path.join(dir, 'settings.json');
    expect(readSettings(file).palette.favourites).toEqual([]);
    fs.writeFileSync(file, '{ not json');
    expect(readSettings(file).palette.recent).toEqual([]);
  });

  it('writes, creates the folder, and reads back what it wrote', () => {
    const file = path.join(dir, 'nested', 'settings.json');
    const saved = writeSettings(file, { palette: { favourites: ['fastp'], recent: ['fastqc', 'fastp'] } });
    expect(saved.palette.recent).toEqual(['fastqc', 'fastp']);
    expect(readSettings(file)).toEqual(saved);
    expect(fs.readdirSync(path.dirname(file))).toEqual(['settings.json']);
  });
});
