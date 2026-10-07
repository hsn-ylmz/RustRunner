import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  MAX_TEMPLATE_BYTES,
  deleteUserTemplate,
  listUserTemplates,
  renameUserTemplate,
  saveUserTemplate,
  templatesDir,
} from './userTemplates';

let home: string;
let dir: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-templates-'));
  dir = templatesDir(home);
});
afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

const sample = (over: Record<string, unknown> = {}) => ({ id: 'my-qc', name: 'My QC', steps: [], ...over });

describe('user template storage', () => {
  it('keeps templates under <home>/.rustrunner/templates', () => {
    expect(dir).toBe(path.join(home, '.rustrunner', 'templates'));
  });

  it('lists nothing when the folder does not exist yet', () => {
    expect(listUserTemplates(dir)).toEqual([]);
  });

  it('saves a template and lists it back unchanged', () => {
    expect(saveUserTemplate(dir, sample())).toEqual({ ok: true });
    expect(listUserTemplates(dir)).toEqual([{ id: 'my-qc', raw: sample() }]);
    expect(fs.existsSync(path.join(dir, 'my-qc.json'))).toBe(true);
  });

  it('never replaces an existing template', () => {
    saveUserTemplate(dir, sample());
    const again = saveUserTemplate(dir, sample({ name: 'Other' }));
    expect(again.ok).toBe(false);
    expect((listUserTemplates(dir)[0].raw as any).name).toBe('My QC');
  });

  it('refuses ids that could name a path', () => {
    for (const id of ['../evil', 'a/b', 'A', '', '.hidden', 'x'.repeat(65), 7]) {
      expect(saveUserTemplate(dir, sample({ id })).ok).toBe(false);
    }
    expect(saveUserTemplate(dir, 'text').ok).toBe(false);
    expect(fs.existsSync(dir) ? fs.readdirSync(dir) : []).toEqual([]);
  });

  it('refuses a template that is too large', () => {
    const big = sample({ details: 'x'.repeat(MAX_TEMPLATE_BYTES) });
    expect(saveUserTemplate(dir, big).ok).toBe(false);
  });

  it('reports a damaged file instead of failing the list', () => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'broken.json'), '{ not json');
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'ignored');
    fs.writeFileSync(path.join(dir, 'Bad Name.json'), '{}');
    saveUserTemplate(dir, sample());
    const list = listUserTemplates(dir);
    expect(list.map((t) => t.id)).toEqual(['broken', 'my-qc']);
    expect(list[0].error).toMatch(/not valid JSON/);
    expect(list[1].raw).toBeDefined();
  });

  it('renames by changing only the name', () => {
    saveUserTemplate(dir, sample({ description: 'keep me' }));
    expect(renameUserTemplate(dir, 'my-qc', '  Better name ')).toEqual({ ok: true });
    expect(listUserTemplates(dir)[0].raw).toEqual(sample({ name: 'Better name', description: 'keep me' }));
    expect(fs.readdirSync(dir)).toEqual(['my-qc.json']);
  });

  it('rejects empty and over-long names and unknown templates', () => {
    saveUserTemplate(dir, sample());
    expect(renameUserTemplate(dir, 'my-qc', '   ').ok).toBe(false);
    expect(renameUserTemplate(dir, 'my-qc', 'x'.repeat(81)).ok).toBe(false);
    expect(renameUserTemplate(dir, 'missing', 'Name').ok).toBe(false);
    expect(renameUserTemplate(dir, '../x', 'Name').ok).toBe(false);
  });

  it('deletes a template, and deleting twice is fine', () => {
    saveUserTemplate(dir, sample());
    expect(deleteUserTemplate(dir, 'my-qc')).toEqual({ ok: true });
    expect(listUserTemplates(dir)).toEqual([]);
    expect(deleteUserTemplate(dir, 'my-qc')).toEqual({ ok: true });
    expect(deleteUserTemplate(dir, '../etc').ok).toBe(false);
  });
});
