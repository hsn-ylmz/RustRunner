import { describe, expect, it } from 'vitest';
import { BUNDLED_SOURCES } from '../templates/registry';
import { validateTemplate, type WorkflowTemplate } from '../templates/schema';
import { instantiateTemplate } from '../templates/instantiate';
import {
  autoLayout,
  buildUserTemplate,
  groupCandidates,
  inputCandidates,
  newTemplateId,
  templateBlockers,
} from '../templates/fromWorkflow';
import { buildCatalogNodeData, findTool } from '../tools/catalog';
import { collectIssues } from '../validation';
import { convertNodesToWorkflow } from '../workflowConversion';

const bundled = (): WorkflowTemplate => JSON.parse(JSON.stringify(BUNDLED_SOURCES[0].raw));

/** The canvas as the person has it after using the bundled template with one file. */
function canvas(file = '/data/sample.fastq.gz') {
  const made = instantiateTemplate(bundled(), { reads: [file] });
  if (made.ok === false) throw new Error(made.errors.join('; '));
  return { nodes: made.nodes, edges: made.edges };
}

const ASK_READS = (nodes: any[], edges: any[]) => {
  const groups = groupCandidates(inputCandidates(nodes, edges));
  return [{ candidateIds: groups[0].candidates.map((c) => c.id), label: 'Sequencing reads' }];
};

describe('what can become a template', () => {
  it('accepts a workflow made only of catalog steps', () => {
    const { nodes } = canvas();
    expect(templateBlockers(nodes)).toEqual([]);
  });

  it('refuses an empty canvas', () => {
    expect(templateBlockers([])).toEqual(['Add some steps first.']);
  });

  it('names a custom step as the thing in the way', () => {
    const { nodes } = canvas();
    const custom = { id: 'n9', position: { x: 0, y: 0 }, data: { label: 'My script', tool: 'bash', command: 'echo hi' } };
    const reasons = templateBlockers([...nodes, custom]);
    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toMatch(/"My script" is a custom step/);
  });

  it('names a catalog step whose command was edited by hand', () => {
    const { nodes } = canvas();
    const edited = nodes.map((n, i) => (i === 1 ? { ...n, data: { ...n.data, catalogCommandCustom: true } } : n));
    expect(templateBlockers(edited)[0]).toMatch(/"Trim reads \(fastp\)" has a command you edited by hand/);
    const renamedTool = nodes.map((n, i) => (i === 1 ? { ...n, data: { ...n.data, tool: 'other' } } : n));
    expect(templateBlockers(renamedTool)).toHaveLength(1);
  });

  it('refuses to build a template from a blocked workflow', () => {
    const result = buildUserTemplate([], [], { name: 'X', description: '', inputs: [] });
    expect(result.ok).toBe(false);
  });
});

describe('which files could be asked for', () => {
  it('finds the slots no connection fills, and groups those holding the same file', () => {
    const { nodes, edges } = canvas();
    const candidates = inputCandidates(nodes, edges);
    expect(candidates.map((c) => `${c.stepLabel}.${c.slotId}`)).toEqual([
      'FastQC (raw reads).reads',
      'Trim reads (fastp).reads',
    ]);
    const groups = groupCandidates(candidates);
    expect(groups).toHaveLength(1);
    expect(groups[0].candidates).toHaveLength(2);
    expect(groups[0].label).toBe('Reads');
    expect(groups[0].required).toBe(true);
    expect(groups[0].mustAsk).toBe(false);
  });

  it('keeps empty slots apart and says they must be asked for', () => {
    const { nodes, edges } = canvas('');
    const groups = groupCandidates(inputCandidates(nodes, edges));
    expect(groups).toHaveLength(2);
    expect(groups.every((g) => g.mustAsk)).toBe(true);
    expect(groups[0].label).toBe('Reads for FastQC (raw reads)');
  });
});

describe('saving the canvas as a template and using it again', () => {
  it('produces a valid template that holds no file of the person unless asked to keep it', () => {
    const { nodes, edges } = canvas();
    const result = buildUserTemplate(
      nodes,
      edges,
      { name: 'My QC', description: 'Checks reads.', inputs: ASK_READS(nodes, edges) },
      undefined,
      1_700_000_000_000
    );
    if (result.ok === false) throw new Error(result.errors.join('; '));
    const t = result.template;
    expect(validateTemplate(t)).toEqual([]);
    expect(t.name).toBe('My QC');
    expect(t.id).toMatch(/^my-qc-[a-z0-9]+$/);
    expect(t.domain).toBe('general');
    expect(t.inputs).toHaveLength(1);
    expect(t.inputs[0]).toMatchObject({ label: 'Sequencing reads', required: true, multiple: false, types: ['fastq'] });
    expect(t.inputs[0].example).toBe('sample.fastq.gz');
    expect(t.inputs[0].targets).toHaveLength(2);
    expect(JSON.stringify(t)).not.toContain('/data/sample');
    expect(t.steps.map((s) => s.tool)).toEqual(['fastqc', 'fastp', 'fastqc', 'multiqc']);
    expect(t.steps[0].files).toEqual({ report_dir: 'qc_raw/' });
    expect(t.edges).toHaveLength(4);
    expect(t.edges[3].bind).toEqual([{ slot: 'reports', output: 'report_dir' }]);
    expect(t.outputs.length).toBeGreaterThan(0);
  });

  it('round trips: the template makes the same workflow again, for another file', () => {
    const { nodes, edges } = canvas();
    const saved = buildUserTemplate(nodes, edges, { name: 'My QC', description: '', inputs: ASK_READS(nodes, edges) });
    if (saved.ok === false) throw new Error(saved.errors.join('; '));
    // Through JSON, as the file on disk.
    const loaded = JSON.parse(JSON.stringify(saved.template));
    expect(validateTemplate(loaded)).toEqual([]);

    const again = instantiateTemplate(loaded, { [loaded.inputs[0].id]: ['/other/run2.fq.gz'] });
    if (again.ok === false) throw new Error(again.errors.join('; '));
    expect(collectIssues(again.nodes, {}, again.edges)).toEqual([]);

    const first = convertNodesToWorkflow(nodes, edges, {});
    const second = convertNodesToWorkflow(again.nodes, again.edges, {});
    const normalise = (w: any) =>
      JSON.parse(JSON.stringify(w).replace(/\/data\/sample\.fastq\.gz|\/other\/run2\.fq\.gz/g, 'READS'));
    expect(normalise(second)).toEqual(normalise(first));
    expect(second.steps[0].named_inputs.reads).toEqual(['/other/run2.fq.gz']);
  });

  it('keeps a file that is not asked for as the default', () => {
    const { nodes, edges } = canvas();
    const result = buildUserTemplate(nodes, edges, { name: 'Fixed', description: '', inputs: [] });
    if (result.ok === false) throw new Error(result.errors.join('; '));
    expect(result.template.inputs).toEqual([]);
    expect(result.template.steps[0].files).toMatchObject({ reads: '/data/sample.fastq.gz' });
    const made = instantiateTemplate(result.template, {});
    if (made.ok === false) throw new Error('should instantiate');
    expect(collectIssues(made.nodes, {}, made.edges)).toEqual([]);
  });

  it('keeps changed options and drops those equal to the default', () => {
    const { nodes, edges } = canvas();
    const changed = nodes.map((n) =>
      n.data.catalogId === 'fastp' ? { ...n, data: { ...n.data, catalogParams: { ...n.data.catalogParams, min_quality: 25 } } } : n
    );
    const result = buildUserTemplate(changed, edges, { name: 'Strict', description: '', inputs: ASK_READS(changed, edges) });
    if (result.ok === false) throw new Error(result.errors.join('; '));
    const fastp = result.template.steps.find((s) => s.tool === 'fastp')!;
    expect(fastp.params).toEqual({ min_quality: 25 });
    expect(result.template.steps.find((s) => s.tool === 'fastqc')!.params).toBeUndefined();
    const made = instantiateTemplate(result.template, { [result.template.inputs[0].id]: ['x.fq'] });
    if (made.ok === false) throw new Error('should instantiate');
    expect(made.nodes.find((n) => n.data.catalogId === 'fastp')!.data.command).toContain('-q 25');
  });

  it('fails with a sentence when a required file is neither asked for nor set', () => {
    const { nodes, edges } = canvas('');
    const result = buildUserTemplate(nodes, edges, { name: 'Broken', description: '', inputs: [] });
    expect(result.ok).toBe(false);
    if (result.ok === false) expect(result.errors.join()).toMatch(/gets no file/);
  });

  it('spreads steps that sit too close together', () => {
    const { nodes, edges } = canvas();
    const crowded = nodes.map((n, i) => ({ ...n, position: { x: i * 30, y: i * 10 } }));
    const result = buildUserTemplate(crowded, edges, { name: 'Tight', description: '', inputs: ASK_READS(crowded, edges) });
    if (result.ok === false) throw new Error(result.errors.join('; '));
    expect(validateTemplate(result.template)).toEqual([]);
  });

  it('refuses two steps whose names make the same step id, as the canvas does', () => {
    const fastqc = findTool('fastqc')!;
    const a = { id: 'a', position: { x: 0, y: 0 }, data: { ...buildCatalogNodeData(fastqc, []), label: 'FastQC', slotFiles: { reads: 'a.fq', report_dir: 'qa/' } } };
    const b = { id: 'b', position: { x: 300, y: 0 }, data: { ...buildCatalogNodeData(fastqc, []), label: 'fastqc!', slotFiles: { reads: 'b.fq', report_dir: 'qb/' } } };
    const result = buildUserTemplate([a, b], [], { name: 'Two', description: '', inputs: [] });
    expect(result.ok).toBe(false);
    if (result.ok === false) expect(result.errors.join()).toMatch(/same name/);
  });

  it('gives steps with odd names usable keys', () => {
    const fastqc = findTool('fastqc')!;
    const a = { id: 'a', position: { x: 0, y: 0 }, data: { ...buildCatalogNodeData(fastqc, []), label: '1st check', slotFiles: { reads: 'a.fq', report_dir: 'qa/' } } };
    const b = { id: 'b', position: { x: 300, y: 0 }, data: { ...buildCatalogNodeData(fastqc, []), label: 'Second', slotFiles: { reads: 'b.fq', report_dir: 'qb/' } } };
    const result = buildUserTemplate([a, b], [], { name: 'Two', description: '', inputs: [] });
    if (result.ok === false) throw new Error(result.errors.join('; '));
    expect(result.template.steps.map((s) => s.key)).toEqual(['s_1st_check', 'second']);
  });
});

describe('helpers', () => {
  it('makes readable, collision-proof ids', () => {
    expect(newTemplateId('My RNA-seq (v2)!', 36 * 36)).toBe('my-rna-seq-v2-100');
    expect(newTemplateId('???', 0)).toBe('template-0');
    expect(newTemplateId('A', 1)).not.toBe(newTemplateId('A', 2));
  });

  it('lays out by depth with no two steps in one spot', () => {
    const spots = autoLayout(['a', 'b', 'c', 'd'], [
      { from: 'a', to: 'c' },
      { from: 'b', to: 'c' },
      { from: 'c', to: 'd' },
    ]);
    expect(spots.a.y).toBe(0);
    expect(spots.b.y).toBe(0);
    expect(spots.a.x).not.toBe(spots.b.x);
    expect(spots.c.y).toBeGreaterThan(spots.a.y);
    expect(spots.d.y).toBeGreaterThan(spots.c.y);
  });
});
