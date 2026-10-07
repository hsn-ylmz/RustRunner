import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const site = require('./docs-site.js');

const REPO = path.resolve(__dirname, '..', '..');
const lib = site.loadLibrary();

describe('docs site generator', () => {
  it('lists every tool and every template of the app, by name', () => {
    const html: string = site.renderLibrary(lib);
    for (const t of lib.catalog.tools) expect(html).toContain(`id="tool-${t.id}"`);
    for (const t of lib.templates) expect(html).toContain(`id="template-${t.id}"`);
    expect(html).toContain(`${lib.catalog.tools.length} tools`);
    expect(html).toContain(`${lib.templates.length} templates`);
  });

  it('puts the counts and version of the app on the home page', () => {
    const html: string = site.renderIndex(lib);
    expect(html).toContain(`${lib.catalog.tools.length}-tool catalog`);
    expect(html).toContain(`${lib.templates.length} ready-made templates`);
    expect(html).toContain(lib.version);
    expect(html).toContain('Open beta');
  });

  it('shows the real defaults of the Ribo-seq template settings', () => {
    const html: string = site.renderRibo(lib);
    expect(html).toContain('AAAAAAAAAACAAAAAAAAAAGATCGGAAGAGCACACGTCTGAACTCCAGTCAC');
    expect(html).toContain("5' end (the start of the read)");
  });

  it('escapes text from the data', () => {
    expect(site.esc('<a href="x">&</a>')).toBe('&lt;a href=&quot;x&quot;&gt;&amp;&lt;/a&gt;');
  });

  it('calls only a beta version the open beta', () => {
    expect(site.isBeta('1.0.0-beta.1')).toBe(true);
    expect(site.isBeta('1.0.0')).toBe(false);
    expect(site.isBeta('1.0.0-rc.1')).toBe(false);
  });

  it('loads nothing from another site and links only to files that exist', () => {
    const scratch = path.join(REPO, '.sandbox', 'tmp');
    fs.mkdirSync(scratch, { recursive: true });
    const out = fs.mkdtempSync(path.join(scratch, 'docs-site-'));
    try {
      const written: string[] = site.build(out, lib);
      expect(written.sort()).toEqual(['index.html', 'library.html', 'ribo-seq.html']);
      expect(fs.existsSync(path.join(out, '.nojekyll'))).toBe(true);
      for (const name of written) {
        const html = fs.readFileSync(path.join(out, name), 'utf8');
        expect(html).not.toMatch(/<script/i);
        expect(html).not.toMatch(/(src|href)="https?:\/\/[^"]*\.(js|css|woff2?)"/i);
        expect(html).toMatch(/<meta name="viewport"/);
        for (const m of html.matchAll(/(?:src|href)="([^"#:]+)(?:#[^"]*)?"/g)) {
          const target = m[1];
          if (target.startsWith('http')) continue;
          const real = path.join(REPO, 'docs', target);
          expect(fs.existsSync(real), `${name} links to ${target}`).toBe(true);
        }
      }
    } finally {
      fs.rmSync(out, { recursive: true, force: true });
    }
  });
});
