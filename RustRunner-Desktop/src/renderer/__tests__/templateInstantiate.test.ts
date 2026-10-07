import { describe, expect, it } from 'vitest';
import { BUNDLED_SOURCES } from '../templates/registry';
import type { WorkflowTemplate } from '../templates/schema';
import {
  DEFAULT_ORIGIN,
  COMMA_PROBLEM,
  filesOf,
  inputProblems,
  instantiateTemplate,
  missingInputs,
  pickerExtensions,
  templateNodeId,
  typeWarning,
  valuesFromText,
} from '../templates/instantiate';
import { collectIssues } from '../validation';
import { convertNodesToWorkflow, validateWorkflow } from '../workflowConversion';
import { slotStates } from '../slots';
import { rectsOverlap } from '../nodePlacement';

const template = (): WorkflowTemplate => JSON.parse(JSON.stringify(BUNDLED_SOURCES[0].raw));
const make = (values: Record<string, string[]> = { reads: ['/data/sample.fastq.gz'] }) => {
  const result = instantiateTemplate(template(), values, { edgeDefaults: { type: 'typed', animated: true } });
  if (result.ok === false) throw new Error(result.errors.join('; '));
  return result;
};
const node = (nodes: any[], key: string) => nodes.find((n) => n.id === templateNodeId(key))!;

describe('instantiateTemplate: basic read quality check', () => {
  it('makes one catalog step per template step, named and coloured like a hand-added one', () => {
    const { nodes } = make();
    expect(nodes.map((n) => n.data.label)).toEqual([
      'FastQC (raw reads)',
      'Trim reads (fastp)',
      'FastQC (trimmed reads)',
      'MultiQC report',
    ]);
    expect(nodes.map((n) => n.data.catalogId)).toEqual(['fastqc', 'fastp', 'fastqc', 'multiqc']);
    expect(nodes.every((n) => n.type === 'custom')).toBe(true);
    expect(node(nodes, 'fastp').data.command).toContain('fastp -i {reads}');
    expect(node(nodes, 'fastp').data.tool).toBe('fastp');
    expect(node(nodes, 'multiqc').data.color).toBeTruthy();
  });

  it('puts the chosen file into every slot the input maps to', () => {
    const { nodes } = make();
    expect(node(nodes, 'fastqc_raw').data.slotFiles.reads).toBe('/data/sample.fastq.gz');
    expect(node(nodes, 'fastp').data.slotFiles.reads).toBe('/data/sample.fastq.gz');
    expect(node(nodes, 'fastqc_trimmed').data.slotFiles.reads).toBeUndefined();
  });

  it('keeps the two FastQC reports in separate folders', () => {
    const { nodes } = make();
    expect(node(nodes, 'fastqc_raw').data.slotFiles.report_dir).toBe('qc_raw/');
    expect(node(nodes, 'fastqc_trimmed').data.slotFiles.report_dir).toBe('qc_trimmed/');
  });

  it('draws the connections and binds every slot that a step passes on', () => {
    const { nodes, edges } = make();
    expect(edges.map((e) => `${e.source}>${e.target}`)).toEqual([
      'tpl_fastp>tpl_fastqc_trimmed',
      'tpl_fastqc_raw>tpl_multiqc',
      'tpl_fastp>tpl_multiqc',
      'tpl_fastqc_trimmed>tpl_multiqc',
    ]);
    expect(edges.every((e) => e.type === 'typed' && e.animated === true)).toBe(true);
    expect(new Set(edges.map((e) => e.id)).size).toBe(edges.length);

    const reads = slotStates(node(nodes, 'fastqc_trimmed'), nodes, edges).find((s) => s.def.id === 'reads')!;
    expect(reads.files).toEqual(['trimmed.fastq.gz']);
    const reports = slotStates(node(nodes, 'multiqc'), nodes, edges).find((s) => s.def.id === 'reports')!;
    expect(reports.links.map((l) => l.stepLabel)).toEqual([
      'FastQC (raw reads)',
      'Trim reads (fastp)',
      'FastQC (trimmed reads)',
    ]);
    expect(reports.files).toEqual(['qc_raw/', 'fastp.json', 'qc_trimmed/']);
  });

  it('leaves nothing for validation to complain about when the file is chosen', () => {
    const { nodes, edges, missing } = make();
    expect(missing).toEqual([]);
    expect(collectIssues(nodes, {}, edges)).toEqual([]);
  });

  it('converts to a workflow the engine check accepts, with the right order', () => {
    const { nodes, edges } = make();
    const workflow = convertNodesToWorkflow(nodes, edges, {}, { name: 'QC' });
    expect(validateWorkflow(workflow)).toEqual([]);
    const byId = Object.fromEntries(workflow.steps.map((s: any) => [s.id, s]));
    expect(byId.multiqc_report.previous.sort()).toEqual(['fastqc_raw_reads', 'fastqc_trimmed_reads', 'trim_reads_fastp']);
    expect(byId.fastqc_trimmed_reads.previous).toEqual(['trim_reads_fastp']);
    expect(byId.trim_reads_fastp.previous).toEqual([]);
    expect(byId.fastqc_raw_reads.named_inputs.reads).toEqual(['/data/sample.fastq.gz']);
    expect(byId.multiqc_report.named_inputs.reports).toEqual(['qc_raw/', 'fastp.json', 'qc_trimmed/']);
    expect(byId.trim_reads_fastp.install.package).toBe('fastp');
  });

  it('lays the steps out top to bottom without overlap, starting at the origin', () => {
    const { nodes } = make();
    const ys = Object.fromEntries(nodes.map((n) => [n.id, n.position.y]));
    expect(ys.tpl_fastqc_raw).toBe(DEFAULT_ORIGIN.y);
    expect(ys.tpl_fastp).toBe(DEFAULT_ORIGIN.y);
    expect(ys.tpl_fastqc_trimmed).toBeGreaterThan(ys.tpl_fastp);
    expect(ys.tpl_multiqc).toBeGreaterThan(ys.tpl_fastqc_trimmed);
    expect(Math.min(...nodes.map((n) => n.position.x))).toBe(DEFAULT_ORIGIN.x);
    const rects = nodes.map((n) => ({ x: n.position.x, y: n.position.y, width: 160, height: 80 }));
    for (let i = 0; i < rects.length; i++) {
      for (let j = i + 1; j < rects.length; j++) expect(rectsOverlap(rects[i], rects[j])).toBe(false);
    }
  });

  it('honours another origin', () => {
    const result = instantiateTemplate(template(), {}, { origin: { x: 0, y: 0 } });
    if (result.ok === false) throw new Error('should instantiate');
    expect(Math.min(...result.nodes.map((n) => n.position.x))).toBe(0);
    expect(Math.min(...result.nodes.map((n) => n.position.y))).toBe(0);
  });
});

describe('inputs left empty', () => {
  it('creates the workflow and lets validation say what is missing', () => {
    const { nodes, edges, missing } = make({});
    expect(missing.map((m) => m.id)).toEqual(['reads']);
    const issues = collectIssues(nodes, {}, edges);
    expect(issues.map((i) => i.nodeLabel).sort()).toEqual(['FastQC (raw reads)', 'Trim reads (fastp)']);
    expect(issues.every((i) => i.field === 'slot:reads')).toBe(true);
    expect(issues[0].message).toMatch(/Choose a file for "Reads"/);
  });

  it('treats blank text as empty', () => {
    expect(make({ reads: ['  '] }).missing).toHaveLength(1);
    expect(missingInputs(template(), valuesFromText(template(), { reads: '   ' }))).toHaveLength(1);
  });

  it('does not count an optional input as missing', () => {
    const t = template();
    // An optional input needs an optional slot; reuse fastqc's? none are optional, so only check the rule itself.
    t.inputs[0].required = false;
    expect(missingInputs(t, {})).toEqual([]);
  });
});

describe('input values', () => {
  it('reads one file, or a comma separated list for an input that takes several', () => {
    expect(filesOf({ multiple: false }, ' a.fq ')).toEqual(['a.fq']);
    expect(filesOf({ multiple: false }, '')).toEqual([]);
    expect(filesOf({ multiple: true }, 'a.fq, b.fq ,,c.fq')).toEqual(['a.fq', 'b.fq', 'c.fq']);
  });

  it('refuses several files for an input that takes one', () => {
    const problems = inputProblems(template(), { reads: ['a.fq', 'b.fq'] });
    expect(problems.reads).toMatch(/takes one file/);
    const result = instantiateTemplate(template(), { reads: ['a.fq', 'b.fq'] });
    expect(result.ok).toBe(false);
  });

  it('refuses a file name with a comma, which the step fields would split', () => {
    expect(inputProblems(template(), { reads: ['/data/a,b.fastq'] }).reads).toBe(COMMA_PROBLEM);
  });

  it('warns, without blocking, about a file of the wrong kind', () => {
    const input = template().inputs[0];
    expect(typeWarning(input, ['/data/reads.bam'])).toMatch(/looks like a BAM file/);
    expect(typeWarning(input, ['/data/reads.fq.gz'])).toBeNull();
    expect(typeWarning(input, ['/data/reads'])).toBeNull();
    expect(typeWarning({ ...input, types: ['any'] }, ['/data/reads.bam'])).toBeNull();
    expect(instantiateTemplate(template(), { reads: ['/data/reads.bam'] }).ok).toBe(true);
  });

  it('offers the right endings in the file picker', () => {
    expect(pickerExtensions({ types: ['fastq'] })).toEqual(expect.arrayContaining(['fastq', 'fq', 'gz']));
    expect(pickerExtensions({ types: ['any'] })).toEqual([]);
  });
});

describe('a template that does not fit this app', () => {
  it('fails with sentences instead of building a broken workflow', () => {
    const t = template();
    t.steps[0].tool = 'no-such-tool';
    const result = instantiateTemplate(t, { reads: ['a.fq'] });
    expect(result.ok).toBe(false);
    if (result.ok === false) expect(result.errors.join()).toMatch(/not in the tool catalog/);
  });

  it('fails when it needs a newer tool catalog', () => {
    const t = template();
    t.minCatalogVersion = '2999.0.0';
    const result = instantiateTemplate(t, {});
    expect(result.ok).toBe(false);
  });
});
