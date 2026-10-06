import { describe, expect, it } from 'vitest';
import {
  blockedReason,
  collectIssues,
  fieldErrors,
  issueCountLabel,
  type ValidationIssue,
} from '../validation';
import { convertNodesToWorkflow, validateWorkflow } from '../workflowConversion';
import { buildCatalogNodeData, findTool, validateCatalogNodes } from '../tools/catalog';

const node = (id: string, label: string, data: Record<string, unknown> = {}) => ({
  id,
  position: { x: 0, y: 0 },
  type: 'custom',
  data: { label, tool: 'bash', command: 'echo hi', input: '', output: '', threads: 1, ...data },
});

const fields = (issues: ValidationIssue[]) => issues.map((i) => `${i.nodeLabel}:${i.field}`);

describe('collectIssues', () => {
  it('reports an empty workflow once, without a node', () => {
    const issues = collectIssues([]);
    expect(issues).toHaveLength(1);
    expect(issues[0].nodeId).toBeUndefined();
  });

  it('accepts a complete step', () => {
    expect(collectIssues([node('a', 'Align')])).toEqual([]);
  });

  it('flags a missing tool and command on their fields, by the step name', () => {
    const issues = collectIssues([node('a', 'Align', { tool: ' ', command: '' })]);
    expect(fields(issues)).toEqual(['Align:tool', 'Align:command']);
    expect(issues[0].message).toMatch(/tool/i);
  });

  it('flags duplicate and empty names on the name field', () => {
    const dup = collectIssues([node('a', 'Same'), node('b', 'same')]);
    expect(fields(dup)).toEqual(['Same:label', 'same:label']);
    expect(dup[0].message).toMatch(/same name/);

    const empty = collectIssues([node('a', '!!!')]);
    expect(empty[0].field).toBe('label');
    expect(empty[0].message).toMatch(/letter or number/);
    expect(collectIssues([node('a', '')])[0].nodeLabel).toBe('Unnamed step');
  });

  it('flags a check aimed at an output the step no longer has', () => {
    const issues = collectIssues([
      node('a', 'A', { output: 'x.txt', checkExists: true, checkExistsTarget: 'y.txt' }),
    ]);
    expect(fields(issues)).toEqual(['A:checkExistsTarget']);
    // A check that is switched off, or a target that still exists, is fine.
    expect(
      collectIssues([
        node('a', 'A', { output: 'x.txt, y.txt', checkExists: true, checkExistsTarget: 'y.txt' }),
        node('b', 'B', { output: 'x.txt', checkNonEmpty: false, checkNonEmptyTarget: 'gone' }),
      ])
    ).toEqual([]);
  });

  it('flags a {name} in a pattern that has no files, and one that names other files', () => {
    const none = collectIssues([node('a', 'A', { input: 'in/{sample}.fq' })]);
    expect(fields(none)).toEqual(['A:input']);
    expect(none[0].message).toMatch(/no files are selected/);

    const wrong = collectIssues([node('a', 'A', { output: 'out/{lane}.txt' })], { a: ['x.fq'] });
    expect(fields(wrong)).toEqual(['A:output']);
    expect(wrong[0].message).toMatch(/\{sample\}/);

    expect(collectIssues([node('a', 'A', { input: '{sample}.fq' })], { a: ['x.fq'] })).toEqual([]);
    const renamed = node('a', 'A', { input: '{lane}.fq', wildcardName: 'lane' });
    expect(collectIssues([renamed], { a: ['x.fq'] })).toEqual([]);
  });

  it('puts a missing catalog option on that option, not on the command', () => {
    const tool = findTool('fastqc')!;
    const required = tool.params.find((p) => p.required);
    // Every catalog step is built complete; blank one required option if the catalog has any.
    const data = buildCatalogNodeData(tool, []);
    if (required) {
      data.catalogParams = { ...(data.catalogParams as object), [required.id]: '' };
      const issues = collectIssues([node('a', 'FastQC', data)]);
      expect(issues.map((i) => i.field)).toEqual([`param:${required.id}`]);
    }
    // Edited by hand: the command rules, the options no longer matter.
    expect(
      collectIssues([node('a', 'FastQC', { ...data, command: '', catalogCommandCustom: true })]).map(
        (i) => i.field
      )
    ).toEqual(['command']);
  });

  it('agrees with the run-time validators on what is a problem', () => {
    const cases: Array<[any[], Record<string, string[]>, any[]?]> = [
      [[node('a', 'A'), node('b', 'B', { input: 'a.txt' })], {}],
      [[node('a', 'A', { tool: '' })], {}],
      [[node('a', 'A', { command: '' })], {}],
      [[node('a', 'A'), node('b', 'a')], {}],
      [[node('a', 'A', { input: '{x}.txt' })], {}],
      [[node('a', 'A', { input: '{x}.txt' })], { a: ['1.txt'] }],
      [[node('a', 'A', { output: 'o', checkNonEmpty: true, checkNonEmptyTarget: 'p' })], {}],
      // Named file slots
      [[node('a', 'A', { command: 'bwa {ref}' })], {}],
      [[node('a', 'A', { command: 'bwa {ref}', slotFiles: { ref: 'g.fa' } })], {}],
      [[node('a', 'A', { command: 'bwa {ref}', slotFiles: { ref: '{x}.fa' } })], {}],
      [[node('a', 'A', { command: 'bwa {ref}', slotFiles: { ref: '{x}.fa' } })], { a: ['1.fa'] }],
      [[node('a', 'A', { command: 'x > {out}', slotKinds: { out: 'output' } })], {}],
      [[node('a', 'A', { command: 'x > {out}', slotKinds: { out: 'output' }, slotFiles: { out: 'o.txt' }, checkExists: true, checkExistsTarget: 'o.txt' })], {}],
      [[node('a', 'A', { command: 'x > {out}', slotKinds: { out: 'output' }, slotFiles: { out: 'o.txt' }, checkExists: true, checkExistsTarget: 'p.txt' })], {}],
      [
        [node('a', 'A', { output: 'a.fq' }), node('b', 'B', { command: 'bwa {reads}', slotLinks: { reads: { from: 'a', output: '' } } })],
        {},
        [{ id: 'e', source: 'a', target: 'b' }],
      ],
      [
        [node('a', 'A', { output: '' }), node('b', 'B', { command: 'bwa {reads}', slotLinks: { reads: { from: 'a', output: '' } } })],
        {},
        [{ id: 'e', source: 'a', target: 'b' }],
      ],
    ];
    for (const [nodes, files, edges = []] of cases) {
      const workflow = convertNodesToWorkflow(nodes, edges, files);
      const backstop = [...validateWorkflow(workflow), ...validateCatalogNodes(nodes)];
      expect(collectIssues(nodes, files, edges).length > 0, JSON.stringify(nodes)).toBe(backstop.length > 0);
    }
  });
});

describe('named file slots', () => {
  it('flags a slot with no file on its own field, naming the label and the placeholder', () => {
    const issues = collectIssues([node('a', 'Align', { command: 'bwa mem {ref} {reads}', slotFiles: { reads: 'r.fq' } })]);
    expect(fields(issues)).toEqual(['Align:slot:ref']);
    expect(issues[0].message).toBe('Choose a file for "Reference genome" (written {ref} in the command).');
  });

  it('is happy once every slot has a typed or linked file', () => {
    const a = node('a', 'A', { output: 'x.fq' });
    const b = node('b', 'B', {
      command: 'bwa {ref} {reads}',
      slotFiles: { ref: 'g.fa' },
      slotLinks: { reads: { from: 'a', output: '' } },
    });
    expect(collectIssues([a, b], {}, [{ source: 'a', target: 'b' }])).toEqual([]);
    // Remove the connection and the linked slot is open again.
    expect(fields(collectIssues([a, b], {}, []))).toEqual(['B:slot:reads']);
  });

  it('asks for batch files when a slot has a {name} pattern', () => {
    const n = node('a', 'A', { command: 'x {f}', slotFiles: { f: 'd/{sample}.fq' } });
    expect(fields(collectIssues([n]))).toEqual(['A:slot:f']);
    expect(collectIssues([n], { a: ['d/1.fq'] })).toEqual([]);
  });

  it('lets a check point at a named output', () => {
    const n = node('a', 'A', {
      command: 'x > {out}',
      slotKinds: { out: 'output' },
      slotFiles: { out: 'o.txt' },
      checkNonEmpty: true,
      checkNonEmptyTarget: 'o.txt',
    });
    expect(collectIssues([n])).toEqual([]);
  });

  it('opens the Inputs and outputs section for a slot problem', () => {
    const issues = collectIssues([node('a', 'A', { command: 'x {f}' })]);
    expect(issues[0].field).toBe('slot:f');
  });
});

describe('summary helpers', () => {
  const issues = collectIssues([node('a', 'Align', { command: '' }), node('b', 'Sort', { tool: '' })]);

  it('blockedReason counts the problems and names the first', () => {
    expect(blockedReason([])).toBeUndefined();
    const reason = blockedReason(issues)!;
    expect(reason).toMatch(/^Fix 2 problems before running\./);
    expect(reason).toContain('Align:');
    expect(blockedReason(issues.slice(0, 1))).toMatch(/^Fix 1 problem before/);
  });

  it('fieldErrors keeps the first message per field of one node', () => {
    expect(Object.keys(fieldErrors(issues, 'a'))).toEqual(['command']);
    expect(fieldErrors(issues, 'b')).toHaveProperty('tool');
    expect(fieldErrors(issues, 'zzz')).toEqual({});
  });

  it('issueCountLabel pluralises', () => {
    expect(issueCountLabel(1)).toBe('1 problem');
    expect(issueCountLabel(3)).toBe('3 problems');
  });
});
