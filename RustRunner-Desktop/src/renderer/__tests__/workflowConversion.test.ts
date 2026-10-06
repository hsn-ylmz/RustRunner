import { describe, it, expect } from 'vitest';
import yaml from 'js-yaml';
import {
  WILDCARD_NAME,
  buildChecks,
  convertNodesToWorkflow,
  isBlocking,
  normalizeMinLines,
  findInvalidNodeIds,
  generatePattern,
  hasWildcards,
  labelToId,
  normalizeBackoff,
  normalizeRetries,
  normalizeRetryDelay,
  normalizeThreads,
  normalizeTimeout,
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

describe('retry and timeout settings', () => {
  it('omits all retry keys for a plain step', () => {
    const { steps } = convertNodesToWorkflow([node('a', 'A')], []);
    expect(steps[0]).not.toHaveProperty('retries');
    expect(steps[0]).not.toHaveProperty('retry_backoff');
    expect(steps[0]).not.toHaveProperty('retry_delay_secs');
    expect(steps[0]).not.toHaveProperty('timeout_secs');
  });

  it('emits retries, backoff, delay and timeout as snake_case YAML keys', () => {
    const { steps } = convertNodesToWorkflow(
      [node('a', 'A', { retries: '3', retryBackoff: 'exponential', retryDelaySecs: '2', timeoutSecs: '90' })],
      []
    );
    expect(steps[0]).toMatchObject({
      retries: 3,
      retry_backoff: 'exponential',
      retry_delay_secs: 2,
      timeout_secs: 90,
    });
    const parsed: any = yaml.load(yaml.dump({ steps }));
    expect(parsed.steps[0].retry_backoff).toBe('exponential');
    expect(parsed.steps[0].timeout_secs).toBe(90);
  });

  it('uses defaults for backoff and delay when only retries is set', () => {
    const { steps } = convertNodesToWorkflow([node('a', 'A', { retries: 1 })], []);
    expect(steps[0].retry_backoff).toBe('fixed');
    expect(steps[0].retry_delay_secs).toBe(5);
  });

  it('does not emit backoff or delay when retries is 0, but still emits a timeout', () => {
    const { steps } = convertNodesToWorkflow(
      [node('a', 'A', { retries: 0, retryBackoff: 'exponential', retryDelaySecs: 9, timeoutSecs: 30 })],
      []
    );
    expect(steps[0]).not.toHaveProperty('retries');
    expect(steps[0]).not.toHaveProperty('retry_backoff');
    expect(steps[0].timeout_secs).toBe(30);
  });

  it.each([
    [3, 3], ['4', 4], [-1, 0], ['x', 0], [undefined, 0], [1000, 100], [2.7, 2],
  ])('normalizeRetries(%p) -> %p', (input, expected) => {
    expect(normalizeRetries(input)).toBe(expected);
  });

  it.each([
    ['exponential', 'exponential'], ['fixed', 'fixed'], ['linear', 'fixed'], [undefined, 'fixed'],
  ])('normalizeBackoff(%p) -> %p', (input, expected) => {
    expect(normalizeBackoff(input)).toBe(expected);
  });

  it.each([
    [0, 0], ['7', 7], ['', 5], [undefined, 5], [-3, 5], ['x', 5], [99999, 3600],
  ])('normalizeRetryDelay(%p) -> %p', (input, expected) => {
    expect(normalizeRetryDelay(input)).toBe(expected);
  });

  it.each([
    ['60', 60], [1, 1], ['', undefined], [0, undefined], [-5, undefined], ['abc', undefined], [null, undefined],
  ])('normalizeTimeout(%p) -> %p', (input, expected) => {
    expect(normalizeTimeout(input)).toBe(expected);
  });
});

describe('output checks', () => {
  const withOutput = (data: Record<string, unknown>) => node('a', 'A', { output: 'out.tsv', ...data });

  it('emits no checks by default, keeping old YAML unchanged', () => {
    const { steps } = convertNodesToWorkflow([withOutput({})], []);
    expect(steps[0]).not.toHaveProperty('checks');
  });

  it('emits each preset as a blocking check, in a stable order', () => {
    const { steps } = convertNodesToWorkflow(
      [withOutput({ checkMinLinesEnabled: true, checkMinLines: '10', checkNonEmpty: true, checkExists: true })],
      []
    );
    expect(steps[0].checks).toEqual([
      { kind: 'exists' },
      { kind: 'non_empty' },
      { kind: 'min_lines', lines: 10 },
    ]);
  });

  it('writes blocking: false on every check when Blocking is off', () => {
    const checks = buildChecks({ output: 'o', checkExists: true, checkNonEmpty: true, checkBlocking: false });
    expect(checks).toEqual([
      { kind: 'exists', blocking: false },
      { kind: 'non_empty', blocking: false },
    ]);
  });

  it('treats Blocking as on unless explicitly off', () => {
    expect(isBlocking(undefined)).toBe(true);
    expect(isBlocking(true)).toBe(true);
    expect(isBlocking(false)).toBe(false);
    expect(isBlocking('false')).toBe(false);
  });

  it('drops min_lines when N is unusable (the engine rejects 0)', () => {
    for (const bad of ['', '0', '-3', 'abc', undefined]) {
      expect(buildChecks({ output: 'o', checkMinLinesEnabled: true, checkMinLines: bad })).toEqual([]);
    }
    expect(normalizeMinLines('7.9')).toBe(7);
  });

  it('ignores a min_lines value whose checkbox is off', () => {
    expect(buildChecks({ output: 'o', checkMinLines: '5' })).toEqual([]);
  });

  it('emits nothing for a step without an output', () => {
    expect(buildChecks({ output: '', checkExists: true })).toEqual([]);
  });

  it('serializes to YAML the engine can read', () => {
    const { steps } = convertNodesToWorkflow(
      [withOutput({ checkMinLinesEnabled: true, checkMinLines: 3, checkBlocking: false })],
      []
    );
    const parsed: any = yaml.load(yaml.dump({ steps }));
    expect(parsed.steps[0].checks).toEqual([{ kind: 'min_lines', lines: 3, blocking: false }]);
  });
});
