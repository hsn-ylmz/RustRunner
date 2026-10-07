import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import { spawnSync } from 'child_process';
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

  it('reads only regular files: a folder or a pipe named like a template is reported, never read', () => {
    fs.mkdirSync(path.join(dir, 'folder.json'), { recursive: true });
    if (process.platform !== 'win32') {
      // Reading a pipe would block until something writes to it: the list must not hang.
      expect(spawnSync('mkfifo', [path.join(dir, 'pipe.json')]).status).toBe(0);
    }
    saveUserTemplate(dir, sample());
    const list = listUserTemplates(dir);
    expect(list.find((t) => t.id === 'folder')?.error).toMatch(/not a regular file/);
    if (process.platform !== 'win32') expect(list.find((t) => t.id === 'pipe')?.error).toMatch(/not a regular file/);
    expect(list.find((t) => t.id === 'my-qc')?.raw).toEqual(sample());
    expect(renameUserTemplate(dir, 'folder', 'Name').ok).toBe(false);
  });

  it('follows a link to a template file, and reports one that points nowhere', () => {
    const elsewhere = path.join(home, 'shared.json');
    fs.writeFileSync(elsewhere, JSON.stringify(sample({ id: 'linked' })));
    fs.mkdirSync(dir, { recursive: true });
    fs.symlinkSync(elsewhere, path.join(dir, 'linked.json'));
    fs.symlinkSync(path.join(home, 'gone.json'), path.join(dir, 'dangling.json'));
    const list = listUserTemplates(dir);
    expect(list.find((t) => t.id === 'linked')?.raw).toEqual(sample({ id: 'linked' }));
    expect(list.find((t) => t.id === 'dangling')?.error).toMatch(/cannot be read/);
  });

  it('reports a file that is too large without reading it, and will not rename it', () => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'huge.json'), JSON.stringify(sample({ id: 'huge', details: 'x'.repeat(MAX_TEMPLATE_BYTES) })));
    expect(listUserTemplates(dir)).toEqual([{ id: 'huge', error: 'The file is too large to be a template.' }]);
    expect(renameUserTemplate(dir, 'huge', 'Name')).toEqual({ ok: false, error: 'The file is too large to be a template.' });
  });

  it('leaves no temporary files behind', () => {
    saveUserTemplate(dir, sample());
    saveUserTemplate(dir, sample({ name: 'Taken' }));
    renameUserTemplate(dir, 'my-qc', 'New name');
    expect(fs.readdirSync(dir)).toEqual(['my-qc.json']);
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
