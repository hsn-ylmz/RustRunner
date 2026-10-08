import { describe, expect, it } from 'vitest';
import { CATALOG, findTool, outputTypesOf, inputTypesOf } from '../tools/catalog';
import {
  EMPTY_PREFS,
  MAX_RECENT,
  browseOrder,
  cleanPrefs,
  fitsAfter,
  groupTools,
  moveIndex,
  rankTools,
  recordRecent,
  sharedTypes,
  toggleFavourite,
  toolsFittingAfter,
} from '../toolBrowser';

const ids = (tools: Array<{ id: string }>) => tools.map((t) => t.id);
const tool = (id: string) => {
  const t = findTool(id);
  if (!t) throw new Error(`no tool ${id}`);
  return t;
};

describe('ranked search', () => {
  it('keeps the catalog order for an empty query', () => {
    expect(ids(rankTools('  '))).toEqual(ids(CATALOG.tools));
  });

  it('puts an exact name first, then names that start with the word, then the rest', () => {
    const r = ids(rankTools('fastp'));
    expect(r[0]).toBe('fastp');
    const star = ids(rankTools('star'));
    expect(star[0]).toBe('star');
  });

  it('ranks a name match above a description match', () => {
    // "samtools sort" is named sort; many tools only mention sorting in a description.
    const r = ids(rankTools('sort'));
    expect(r[0]).toBe('samtools-sort');
  });

  it('needs every word to match', () => {
    expect(ids(rankTools('bwa indexes'))).toEqual(['bwa-index']);
    expect(rankTools('bwa zzzzqq')).toEqual([]);
  });

  it('finds tools by the job in their description', () => {
    expect(ids(rankTools('trim'))).toContain('cutadapt');
  });

  it('finds tools by the package and by the category', () => {
    expect(ids(rankTools('subread'))).toContain('featurecounts');
    expect(ids(rankTools('nanopore signal')).length).toBeGreaterThanOrEqual(6);
  });

  it('finds tools by a file type and by a file extension', () => {
    const bam = ids(rankTools('bam'));
    expect(bam).toContain('samtools-sort');
    const fq = ids(rankTools('.fq'));
    expect(fq).toContain('fastqc');
    expect(ids(rankTools('pod5'))).toContain('dorado-basecaller');
  });

  it('forgives one typo in a word of four letters or more', () => {
    expect(ids(rankTools('fastqcc'))).toContain('fastqc');
    expect(ids(rankTools('samtool'))).toContain('samtools-sort');
    // Short words never match by guessing.
    expect(rankTools('fsq')).toEqual([]);
  });

  it('searches only the pool it is given', () => {
    const pool = CATALOG.tools.filter((t) => t.category === 'alignment');
    expect(rankTools('bwa', pool).every((t) => t.category === 'alignment')).toBe(true);
    expect(rankTools('fastqc', pool)).toEqual([]);
  });

  it('lists each tool once and keeps the catalog order between equal matches', () => {
    const r = rankTools('samtools');
    expect(new Set(ids(r)).size).toBe(r.length);
    const order = (x: { id: string }) => CATALOG.tools.findIndex((t) => t.id === x.id);
    const sameScore = r.filter((t) => t.name.toLowerCase().startsWith('samtools'));
    expect(sameScore.map(order)).toEqual([...sameScore.map(order)].sort((x, y) => x - y));
  });
});

describe('fits after the selected step', () => {
  it('matches when an output type of the first tool is an input type of the second', () => {
    expect(fitsAfter(tool('samtools-sort'), tool('bwa-mem'))).toBe(true);
    expect(fitsAfter(tool('samtools-sort'), tool('fastqc'))).toBe(false);
  });

  it('lists the tools that read what the step makes', () => {
    const after = ids(toolsFittingAfter(tool('bwa-mem')));
    expect(after).toContain('samtools-sort');
    expect(after).not.toContain('fastqc');
    for (const t of toolsFittingAfter(tool('bwa-mem'))) {
      const shared = sharedTypes(t, tool('bwa-mem'));
      expect(shared.length > 0 || inputTypesOf(t).includes('any')).toBe(true);
    }
  });

  it('names the types the two tools share', () => {
    expect(sharedTypes(tool('samtools-sort'), tool('bwa-mem'))).toEqual(
      outputTypesOf(tool('bwa-mem')).filter((t) => inputTypesOf(tool('samtools-sort')).includes(t))
    );
  });

  it('combines with search through the pool', () => {
    const pool = toolsFittingAfter(tool('bwa-mem'));
    expect(ids(rankTools('sort', pool))).toContain('samtools-sort');
    expect(ids(rankTools('index', pool))).not.toContain('samtools-index');
    expect(ids(rankTools('fastqc', pool))).toEqual([]);
  });
});

describe('favourites and recently used', () => {
  it('toggles a favourite on and off', () => {
    const on = toggleFavourite(EMPTY_PREFS, 'fastqc');
    expect(on.favourites).toEqual(['fastqc']);
    expect(toggleFavourite(on, 'fastp').favourites).toEqual(['fastqc', 'fastp']);
    expect(toggleFavourite(on, 'fastqc').favourites).toEqual([]);
    expect(EMPTY_PREFS.favourites).toEqual([]);
  });

  it('puts the newest recent tool first, without repeats, up to the limit', () => {
    let p = EMPTY_PREFS;
    for (const t of CATALOG.tools.slice(0, MAX_RECENT + 3)) p = recordRecent(p, t.id);
    expect(p.recent).toHaveLength(MAX_RECENT);
    expect(p.recent[0]).toBe(CATALOG.tools[MAX_RECENT + 2].id);
    const again = recordRecent(p, p.recent[3]);
    expect(again.recent[0]).toBe(p.recent[3]);
    expect(new Set(again.recent).size).toBe(again.recent.length);
    expect(again.recent).toHaveLength(MAX_RECENT);
  });

  it('drops unknown ids, repeats and wrong types when reading saved preferences', () => {
    const p = cleanPrefs({ favourites: ['fastqc', 'fastqc', 'gone', 3], recent: 'nope' });
    expect(p).toEqual({ favourites: ['fastqc'], recent: [] });
    expect(cleanPrefs(null)).toEqual(EMPTY_PREFS);
  });
});

describe('the category tree', () => {
  it('groups every tool once, by category and subcategory, in the catalog order', () => {
    const groups = groupTools(CATALOG.tools);
    const all = groups.flatMap((g) => g.subcategories.flatMap((s) => s.tools));
    expect(all).toHaveLength(CATALOG.tools.length);
    expect(new Set(ids(all)).size).toBe(CATALOG.tools.length);
    for (const g of groups) {
      expect(g.count).toBe(g.subcategories.reduce((n, s) => n + s.tools.length, 0));
    }
    expect(groups.map((g) => g.id)).toEqual(
      Object.keys(CATALOG.categories).filter((id) => CATALOG.tools.some((t) => t.category === id))
    );
  });

  it('lists tools in the keyboard order only for open categories', () => {
    const groups = groupTools(CATALOG.tools);
    const closed = browseOrder(groups, [], [], new Set());
    expect(closed.every((i) => i.kind === 'category')).toBe(true);
    expect(closed).toHaveLength(groups.length);

    const open = browseOrder(groups, [tool('fastp')], [tool('fastqc')], new Set([groups[0].id]));
    expect(open[0]).toMatchObject({ kind: 'tool', key: 'fav-fastp' });
    expect(open[1]).toMatchObject({ kind: 'tool', key: 'recent-fastqc' });
    expect(open[2]).toMatchObject({ kind: 'category', id: groups[0].id });
    expect(open[3].kind).toBe('tool');
  });

  it('moves the cursor without wrapping', () => {
    expect(moveIndex(0, -1, 5)).toBe(0);
    expect(moveIndex(4, 1, 5)).toBe(4);
    expect(moveIndex(1, 3, 5)).toBe(4);
    expect(moveIndex(0, 1, 0)).toBe(-1);
  });
});
