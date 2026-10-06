/**
 * Makes sure the domain files stay a complete, consistent set. It runs no
 * tool: it loads every `chains/<domain>.tools.ts` in collect-only mode and
 * checks that every catalog tool is exercised by some domain, that domain names
 * match their files, and that chains only cover catalog tools and only name
 * catalog tools in their nodes. Then it writes the results table.
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { CATALOG } from '../src/renderer/tools/catalog';
import { ENABLED, registeredDomains, setCollectOnly, writeReport } from './harness';

const CHAIN_DIR = path.join(__dirname, 'chains');

describe.skipIf(!ENABLED)('real-tool suite layout', () => {
  setCollectOnly(true);
  const files = fs.readdirSync(CHAIN_DIR).filter((f) => f.endsWith('.tools.ts')).sort();

  it('loads every domain file', async () => {
    for (const file of files) await import(path.join(CHAIN_DIR, file));
    setCollectOnly(false);
    expect(registeredDomains().length).toBe(files.length);
  });

  it('names each domain like its file', () => {
    const names = registeredDomains().map((d) => d.domain).sort();
    expect(names).toEqual(files.map((f) => f.replace(/\.tools\.ts$/, '')).sort());
  });

  it('exercises every catalog tool in at least one domain', () => {
    const covered = new Set(registeredDomains().flatMap((d) => d.covers));
    const missing = CATALOG.tools.map((t) => t.id).filter((id) => !covered.has(id));
    expect(missing, 'catalog tools no domain covers: add a chain for them').toEqual([]);
    const unknown = [...covered].filter((id) => !CATALOG.tools.some((t) => t.id === id));
    expect(unknown, 'domains cover tools the catalog does not have').toEqual([]);
  });

  it('has a chain that uses each tool its domain claims to cover', () => {
    for (const domain of registeredDomains()) {
      const used = new Set(domain.chains.flatMap((c) => c.nodes.map((n) => n.catalog).filter(Boolean)));
      for (const id of domain.covers) expect(used.has(id), `${domain.domain} covers ${id} but no chain uses it`).toBe(true);
      for (const id of used) expect(CATALOG.tools.some((t) => t.id === id), `${domain.domain} uses unknown tool ${id}`).toBe(true);
    }
  });

  it('has unique chain names across domains', () => {
    const names = registeredDomains().flatMap((d) => d.chains.map((c) => c.name));
    expect(new Set(names).size).toBe(names.length);
  });

  it('writes the results table of what has been run so far', () => {
    const table = writeReport();
    expect(table).toContain('| Tool |');
  });
});
