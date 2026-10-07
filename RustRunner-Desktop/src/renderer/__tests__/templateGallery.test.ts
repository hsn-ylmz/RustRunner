import { describe, expect, it } from 'vitest';
import { BUNDLED_SOURCES } from '../templates/registry';
import type { WorkflowTemplate } from '../templates/schema';
import { databaseNeeds } from '../templates/schema';
import {
  dagDescription,
  dagOf,
  domainLabel,
  domainsOf,
  filterEntries,
  needsDatabase,
  stepCountLabel,
  toolsLine,
  type GalleryEntry,
} from '../templates/gallery';
import { CATALOG } from '../tools/catalog';

const basic = (): WorkflowTemplate => JSON.parse(JSON.stringify(BUNDLED_SOURCES[0].raw));
const entry = (t: WorkflowTemplate, source: 'bundled' | 'user' = 'bundled'): GalleryEntry => ({ template: t, source });

describe('searching the gallery', () => {
  const rna: WorkflowTemplate = { ...basic(), id: 'rna-demo', name: 'RNA counts', description: 'Count genes.', domain: 'rna' };
  const entries = [entry(basic()), entry(rna, 'user')];

  it('shows everything for an empty search', () => {
    expect(filterEntries(entries, '', '')).toHaveLength(2);
  });

  it('matches every word, in the name, the description or the tool names', () => {
    expect(filterEntries(entries, 'quality', '').map((e) => e.template.id)).toEqual(['basic-read-qc', 'rna-demo']);
    expect(filterEntries(entries, 'rna counts', '').map((e) => e.template.id)).toEqual(['rna-demo']);
    expect(filterEntries(entries, 'multiqc fastp', '')).toHaveLength(2);
    expect(filterEntries(entries, 'salmon', '')).toHaveLength(0);
  });

  it('is not case sensitive and ignores extra spaces', () => {
    expect(filterEntries(entries, '  FASTQC   ', '')).toHaveLength(2);
  });

  it('filters by domain', () => {
    expect(filterEntries(entries, '', 'rna').map((e) => e.template.id)).toEqual(['rna-demo']);
    expect(filterEntries(entries, 'counts', 'qc')).toEqual([]);
  });

  it('lists only the domains that exist, in the usual order', () => {
    expect(domainsOf(entries)).toEqual(['qc', 'rna']);
    expect(domainLabel('qc')).toBe('Read quality');
    expect(domainLabel('made-up')).toBe('made-up');
  });
});

describe('card text', () => {
  it('counts steps and lists tools once', () => {
    expect(stepCountLabel(basic())).toBe('4 steps');
    expect(stepCountLabel({ steps: [basic().steps[0]] })).toBe('1 step');
    expect(toolsLine(basic())).toBe('FastQC, fastp, MultiQC');
  });

  it('reports a database a tool needs, from the catalog', () => {
    const withDb = CATALOG.tools.find((t) => t.needs_database);
    expect(withDb).toBeDefined();
    const t: WorkflowTemplate = { ...basic(), steps: [{ key: 'k', tool: withDb!.id, position: { x: 0, y: 0 } }] };
    expect(needsDatabase(t)).toBe(true);
    expect(databaseNeeds(t)[0]).toMatchObject({ tool: withDb!.name, label: withDb!.needs_database!.label });
    expect(needsDatabase(basic())).toBe(false);
  });
});

describe('the pipeline drawing', () => {
  it('puts every step in the picture, inside its bounds', () => {
    const dag = dagOf(basic());
    expect(dag.nodes).toHaveLength(4);
    for (const n of dag.nodes) {
      expect(n.x).toBeGreaterThanOrEqual(0);
      expect(n.y).toBeGreaterThanOrEqual(0);
      expect(n.x + n.width).toBeLessThanOrEqual(dag.width);
      expect(n.y + n.height).toBeLessThanOrEqual(dag.height);
    }
  });

  it('draws one curve per connection from the bottom of one step to the top of the next', () => {
    const dag = dagOf(basic());
    expect(dag.edges).toHaveLength(4);
    const fastp = dag.nodes.find((n) => n.key === 'fastp')!;
    const edge = dag.edges.find((e) => e.from === 'fastp' && e.to === 'fastqc_trimmed')!;
    expect(edge.path.startsWith(`M ${fastp.x + fastp.width / 2} ${fastp.y + fastp.height}`)).toBe(true);
  });

  it('colours a step by its tool category', () => {
    const dag = dagOf(basic());
    expect(dag.nodes.find((n) => n.key === 'fastp')!.color).toBe(CATALOG.categories.trimming.color);
    expect(dag.nodes.find((n) => n.key === 'fastqc_raw')!.color).toBe(CATALOG.categories.qc.color);
  });

  it('is described in words for a screen reader, top to bottom', () => {
    expect(dagDescription(basic())).toBe(
      'Pipeline of 4 steps: FastQC (raw reads), then Trim reads (fastp), then FastQC (trimmed reads), then MultiQC report.'
    );
  });
});
