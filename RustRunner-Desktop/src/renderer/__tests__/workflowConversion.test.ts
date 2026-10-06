import { describe, it, expect } from 'vitest';
import yaml from 'js-yaml';
import {
  WILDCARD_NAME,
  convertNodesToWorkflow,
  findInvalidNodeIds,
  generatePattern,
  hasWildcards,
  labelToId,
  normalizeThreads,
  validateWorkflow,
} from '../workflowConversion';

const node = (id: string, label: string, data: Record<string, unknown> = {}) => ({
  id,
  position: { x: 0, y: 0 },
  type: 'custom',
  data: { label, tool: 'bash', command: 'echo hi', input: '', output: '', threads: 1, ...data },
});

describe('labelToId', () => {
  it('slugifies labels', () => {
    expect(labelToId('  My Step #1! ')).toBe('my_step_1');
    expect(labelToId('Process')).toBe('process');
  });
  it('returns an empty string when nothing usable remains', () => {
    expect(labelToId('!!!')).toBe('');
  });
});

describe('normalizeThreads', () => {
  it.each([
    [4, 4],
    ['8', 8],
    [2.9, 2],
    [0, 1],
    [-3, 1],
    ['abc', 1],
    [undefined, 1],
    [null, 1],
    [NaN, 1],
  ])('%p -> %p', (input, expected) => {
    expect(normalizeThreads(input)).toBe(expected);
  });
});

describe('convertNodesToWorkflow', () => {
  const nodes = [
    node('n1', 'Align Reads', { input: 'in/{sample}.fq', output: 'out/{sample}.bam', threads: '4' }),
    node('n2', 'Sort', { tool: 'samtools', command: 'sort {input}' }),
  ];
  const edges = [{ id: 'e1', source: 'n1', target: 'n2' }];

  it('produces the engine step shape', () => {
    const { steps } = convertNodesToWorkflow(nodes, edges);
    expect(steps).toHaveLength(2);
    expect(steps[0]).toEqual({
      id: 'align_reads',
      tool: 'bash',
      command: 'echo hi',
      input: ['in/{sample}.fq'],
      output: ['out/{sample}.bam'],
      previous: [],
      next: ['sort'],
      threads: 4,
    });
    expect(steps[1].previous).toEqual(['align_reads']);
    expect(steps[1].next).toEqual([]);
    expect(steps[1].input).toEqual([]);
    expect(steps[1].output).toEqual([]);
  });

  it('serializes to YAML that round-trips', () => {
    const parsed: any = yaml.load(yaml.dump(convertNodesToWorkflow(nodes, edges)));
    expect(parsed.steps.map((s: any) => s.id)).toEqual(['align_reads', 'sort']);
    expect(parsed.steps[0].threads).toBe(4);
  });

  it('normalizes bad thread values', () => {
    const { steps } = convertNodesToWorkflow([node('a', 'A', { threads: 'x' })], []);
    expect(steps[0].threads).toBe(1);
  });

  it('defaults missing tool and command to empty strings', () => {
    const { steps } = convertNodesToWorkflow(
      [{ id: 'a', position: { x: 0, y: 0 }, data: { label: 'A' } }],
      []
    );
    expect(steps[0].tool).toBe('');
    expect(steps[0].command).toBe('');
  });

  it('attaches wildcard_files per step, only for the owning node', () => {
    const files = { n1: ['/d/s1.fq', '/d/s2.fq'] };
    const { steps } = convertNodesToWorkflow(nodes, edges, files);
    expect(steps[0].wildcard_files).toEqual({ [WILDCARD_NAME]: ['/d/s1.fq', '/d/s2.fq'] });
    expect('wildcard_files' in steps[1]).toBe(false);
  });

  it('omits wildcard_files for empty lists and ignores deleted nodes', () => {
    const files = { n1: [], ghost: ['/x/a.fq'] };
    const { steps } = convertNodesToWorkflow(nodes, edges, files);
    expect(steps.every((s: any) => !('wildcard_files' in s))).toBe(true);
  });
});

describe('findInvalidNodeIds', () => {
  it('flags duplicate and empty ids', () => {
    const problems = findInvalidNodeIds([
      node('a', 'Process'),
      node('b', 'process'),
      node('c', '???'),
      node('d', 'Unique'),
    ]);
    expect(problems.a).toMatch(/Duplicate step ID "process"/);
    expect(problems.b).toMatch(/Duplicate/);
    expect(problems.c).toMatch(/at least one letter or number/);
    expect(problems.d).toBeUndefined();
  });
});

describe('validateWorkflow', () => {
  it('rejects an empty workflow', () => {
    expect(validateWorkflow({ steps: [] })).toEqual(['Workflow has no steps']);
  });
  it('reports missing tool and command', () => {
    const errors = validateWorkflow({ steps: [{ id: 's', tool: '', command: ' ' }] });
    expect(errors).toEqual(['Step s: missing tool', 'Step s: missing command']);
  });
  it('reports duplicate ids', () => {
    const step = { id: 's', tool: 'bash', command: 'x' };
    expect(validateWorkflow({ steps: [step, step] })).toContain('Duplicate step ID: s');
  });
  it('accepts a valid workflow', () => {
    expect(validateWorkflow({ steps: [{ id: 's', tool: 'bash', command: 'x' }] })).toEqual([]);
  });
});

describe('wildcard helpers', () => {
  it('generatePattern keeps directory and extension', () => {
    expect(generatePattern(['/data/a/s1.fastq', '/data/a/s2.fastq'])).toBe('/data/a/{sample}.fastq');
    expect(generatePattern(['reads.txt'])).toBe('{sample}.txt');
    expect(generatePattern(['/d/noext'])).toBe('/d/{sample}');
    expect(generatePattern([])).toBe('');
  });
  it('hasWildcards needs both braces', () => {
    expect(hasWildcards('{sample}.fq')).toBe(true);
    expect(hasWildcards('plain.fq')).toBe(false);
    expect(hasWildcards('{open')).toBe(false);
  });
});
