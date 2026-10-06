import { describe, it, expect } from 'vitest';
import yaml from 'js-yaml';
import {
  DEFAULT_WILDCARD_NAME,
  buildChecks,
  buildMetadata,
  generateWorkflowId,
  isValidWorkflowId,
  extractWildcardNames,
  normalizeMetadataText,
  normalizeWildcardName,
  renameWildcardInPattern,
  wildcardNameError,
  convertNodesToWorkflow,
  countMockedNodes,
  declaredOutputs,
  normalizeCheckTarget,
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
    expect(steps[0].wildcard_files).toEqual({ [DEFAULT_WILDCARD_NAME]: ['/d/s1.fq', '/d/s2.fq'] });
    expect('wildcard_files' in steps[1]).toBe(false);
  });

  it('omits wildcard_files for empty lists and ignores deleted nodes', () => {
    const files = { n1: [], ghost: ['/x/a.fq'] };
    const { steps } = convertNodesToWorkflow(nodes, edges, files);
    expect(steps.every((s: any) => !('wildcard_files' in s))).toBe(true);
  });
});

describe('user-named wildcards', () => {
  it('emits each node\'s own wildcard name', () => {
    const nodes = [
      node('n1', 'Align', { input: 'in/{sample}.fq', wildcardName: 'sample' }),
      node('n2', 'Merge', { input: 'lanes/{lane}.fq', wildcardName: ' lane ' }),
      node('n3', 'Legacy', { input: 'old/{sample}.fq' }),
    ];
    const files = { n1: ['/d/a.fq'], n2: ['/l/x.fq', '/l/y.fq'], n3: ['/o/z.fq'] };
    const { steps } = convertNodesToWorkflow(nodes, [], files);
    expect(steps[0].wildcard_files).toEqual({ sample: ['/d/a.fq'] });
    expect(steps[1].wildcard_files).toEqual({ lane: ['/l/x.fq', '/l/y.fq'] });
    // A node saved before names were configurable keeps "sample".
    expect(steps[2].wildcard_files).toEqual({ sample: ['/o/z.fq'] });
  });

  it('falls back to the default for an unusable name', () => {
    for (const bad of ['', '  ', 'input', 'OUTPUT', '1abc', 'a-b', 'a b', undefined, 5]) {
      expect(normalizeWildcardName(bad)).toBe(DEFAULT_WILDCARD_NAME);
    }
    expect(normalizeWildcardName('lane_2')).toBe('lane_2');
  });

  it('explains why a name is rejected, and accepts blank as "default"', () => {
    expect(wildcardNameError('')).toBeNull();
    expect(wildcardNameError('read1')).toBeNull();
    expect(wildcardNameError('1abc')).toMatch(/letter or underscore/);
    expect(wildcardNameError('input')).toMatch(/placeholder/);
    expect(wildcardNameError('x'.repeat(41))).toMatch(/at most 40/);
  });

  it('generates patterns with the chosen name', () => {
    expect(generatePattern(['/d/a.fq', '/d/b.fq'], 'lane')).toBe('/d/{lane}.fq');
  });

  it('renames a wildcard inside a pattern without touching other braces', () => {
    expect(renameWildcardInPattern('out/{sample}/{sample}.bam', 'sample', 'lane')).toBe(
      'out/{lane}/{lane}.bam'
    );
    expect(renameWildcardInPattern('{other}.txt', 'sample', 'lane')).toBe('{other}.txt');
    expect(renameWildcardInPattern('', 'a', 'b')).toBe('');
  });

  it('extracts the distinct names used in a pattern', () => {
    expect(extractWildcardNames('{a}/{b}_{a}.txt')).toEqual(['a', 'b']);
    expect(extractWildcardNames('plain.txt')).toEqual([]);
  });

  it('validateWorkflow flags a pattern whose name has no files', () => {
    const step = {
      id: 's',
      tool: 'bash',
      command: 'x',
      input: ['in/{lane}.fq'],
      output: [],
      wildcard_files: { sample: ['a.fq'] },
    };
    expect(validateWorkflow({ steps: [step] })).toEqual([
      'Step s: pattern uses {lane} but the selected files are for {sample}',
    ]);
    const noFiles = { ...step, wildcard_files: undefined };
    expect(validateWorkflow({ steps: [noFiles] })[0]).toMatch(/no files are selected/);
    const ok = { ...step, wildcard_files: { lane: ['a.fq'] } };
    expect(validateWorkflow({ steps: [ok] })).toEqual([]);
  });
});

describe('workflow metadata', () => {
  it('is omitted when neither name nor version is set', () => {
    expect(buildMetadata({})).toBeUndefined();
    expect(buildMetadata({ name: '  ', version: '' })).toBeUndefined();
    const wf = convertNodesToWorkflow([node('a', 'A')], [], {}, { name: '', version: '' });
    expect(wf).not.toHaveProperty('metadata');
  });

  it('reaches the engine YAML as a metadata block', () => {
    const wf = convertNodesToWorkflow([node('a', 'A')], [], {}, { name: ' RNA QC ', version: '1.2' });
    expect(wf.metadata).toEqual({ name: 'RNA QC', version: '1.2' });
    const parsed: any = yaml.load(yaml.dump(wf));
    expect(parsed.metadata).toEqual({ name: 'RNA QC', version: '1.2' });
    expect(buildMetadata({ name: 'only' })).toEqual({ name: 'only' });
  });

  it('strips control characters and caps the length like the engine requires', () => {
    expect(normalizeMetadataText('a\nStarting step: x')).toBe('a Starting step: x');
    expect(normalizeMetadataText('x'.repeat(500))).toHaveLength(200);
    expect(normalizeMetadataText(undefined)).toBe('');
  });
});

describe('workflow id', () => {
  it('generates distinct ids the engine accepts', () => {
    const a = generateWorkflowId();
    const b = generateWorkflowId();
    expect(a).not.toBe(b);
    expect(isValidWorkflowId(a)).toBe(true);
    expect(a.length).toBeLessThanOrEqual(64);
  });

  it('accepts only path-safe ids', () => {
    for (const ok of ['abc', '3f2b8c1e-5a47-4c0e-9d3a-7b1f6e2a9c10', 'a_b-C9']) {
      expect(isValidWorkflowId(ok)).toBe(true);
    }
    for (const bad of ['', '../x', 'a/b', 'a b', 'é', 'x'.repeat(65), 12, undefined, null]) {
      expect(isValidWorkflowId(bad)).toBe(false);
    }
  });

  it('reaches the engine YAML in the metadata block, even with no name', () => {
    const id = generateWorkflowId();
    const wf = convertNodesToWorkflow([node('a', 'A')], [], {}, { id, name: 'QC' });
    expect(wf.metadata).toEqual({ id, name: 'QC' });
    const parsed: any = yaml.load(yaml.dump(wf));
    expect(parsed.metadata.id).toBe(id);
    expect(typeof parsed.metadata.id).toBe('string');
    expect(buildMetadata({ id })).toEqual({ id });
  });

  it('drops an invalid id instead of sending it to the engine', () => {
    expect(buildMetadata({ id: '../evil' })).toBeUndefined();
    expect(buildMetadata({ id: 'a b', name: 'x' })).toEqual({ name: 'x' });
  });
});

describe('keep going', () => {
  it('is omitted by default so old YAML is unchanged', () => {
    const plain = convertNodesToWorkflow([node('a', 'A')], [], {}, { name: 'x' });
    expect(plain).not.toHaveProperty('keep_going');
    const off = convertNodesToWorkflow([node('a', 'A')], [], {}, { keepGoing: false });
    expect(off).not.toHaveProperty('keep_going');
  });

  it('reaches the engine YAML as keep_going: true', () => {
    const wf: any = convertNodesToWorkflow([node('a', 'A')], [], {}, { keepGoing: true });
    expect(wf.keep_going).toBe(true);
    const parsed: any = yaml.load(yaml.dump(wf));
    expect(parsed.keep_going).toBe(true);
    expect(parsed.steps).toHaveLength(1);
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

describe('per-output check targets', () => {
  const two = (data: Record<string, unknown>) => ({ output: 'out/a.bam, out/a.bai', ...data });
  const twoNode = (data: Record<string, unknown>) => node('a', 'A', two(data));

  it('splits the output field like the engine does', () => {
    expect(declaredOutputs('out/a.bam, out/a.bai ,')).toEqual(['out/a.bam', 'out/a.bai']);
    expect(declaredOutputs('')).toEqual([]);
    expect(declaredOutputs(undefined)).toEqual([]);
  });

  it('keeps "all outputs" (no target key) by default and for blank targets', () => {
    expect(buildChecks(two({ checkExists: true }))).toEqual([{ kind: 'exists' }]);
    expect(buildChecks(two({ checkExists: true, checkExistsTarget: '' }))).toEqual([{ kind: 'exists' }]);
    expect(buildChecks(two({ checkExists: true, checkExistsTarget: '   ' }))).toEqual([{ kind: 'exists' }]);
    expect(normalizeCheckTarget(undefined)).toBeUndefined();
  });

  it('gives every preset its own target', () => {
    const checks = buildChecks(
      two({
        checkExists: true,
        checkNonEmpty: true,
        checkNonEmptyTarget: 'out/a.bam',
        checkMinLinesEnabled: true,
        checkMinLines: '4',
        checkMinLinesTarget: ' out/a.bai ',
        checkBlocking: false,
      })
    );
    expect(checks).toEqual([
      { kind: 'exists', blocking: false },
      { kind: 'non_empty', target: 'out/a.bam', blocking: false },
      { kind: 'min_lines', lines: 4, target: 'out/a.bai', blocking: false },
    ]);
  });

  it('ignores the target of a preset that is switched off', () => {
    expect(buildChecks(two({ checkNonEmptyTarget: 'out/a.bam' }))).toEqual([]);
  });

  it('writes the target into YAML the engine reads', () => {
    const { steps } = convertNodesToWorkflow(
      [twoNode({ checkNonEmpty: true, checkNonEmptyTarget: 'out/a.bai' })],
      []
    );
    const parsed: any = yaml.load(yaml.dump({ steps }));
    expect(parsed.steps[0].checks).toEqual([{ kind: 'non_empty', target: 'out/a.bai' }]);
    expect(validateWorkflow({ steps })).toEqual([]);
  });

  it('reports a target that is no longer one of the outputs', () => {
    const { steps } = convertNodesToWorkflow(
      [twoNode({ checkExists: true, checkExistsTarget: 'gone.txt' })],
      []
    );
    const errors = validateWorkflow({ steps });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('gone.txt');
    expect(errors[0]).toContain('not one of the step');
  });

  it('accepts targets spelled as wildcard patterns', () => {
    const { steps } = convertNodesToWorkflow(
      [
        node('a', 'A', {
          tool: 'bash',
          command: 'x',
          output: 'out/{sample}.bam',
          checkExists: true,
          checkExistsTarget: 'out/{sample}.bam',
        }),
      ],
      [],
      { a: ['x/s1.fastq'] }
    );
    expect(validateWorkflow({ steps })).toEqual([]);
  });
});

describe('mocked steps', () => {
  it('emits mock: true only when switched on, keeping old YAML unchanged', () => {
    const { steps } = convertNodesToWorkflow(
      [
        node('a', 'A', { mock: true }),
        node('b', 'B', { mock: false }),
        node('c', 'C', {}),
        node('d', 'D', { mock: 'true' }),
      ],
      []
    );
    expect(steps[0].mock).toBe(true);
    expect(steps[1]).not.toHaveProperty('mock');
    expect(steps[2]).not.toHaveProperty('mock');
    expect(steps[3].mock).toBe(true);
    const parsed: any = yaml.load(yaml.dump({ steps }));
    expect(parsed.steps[0].mock).toBe(true);
  });

  it('counts mocked nodes for the run toolbar warning', () => {
    expect(countMockedNodes([])).toBe(0);
    expect(
      countMockedNodes([
        node('a', 'A', { mock: true }),
        node('b', 'B', {}),
        node('c', 'C', { mock: 'true' }),
        node('d', 'D', { mock: false }),
      ])
    ).toBe(2);
  });
});
