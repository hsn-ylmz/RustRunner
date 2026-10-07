import { describe, expect, it } from 'vitest';
import { bundledTemplates } from '../templates/registry';
import { instantiateTemplate, templateNodeId } from '../templates/instantiate';
import { toolsUsed } from '../templates/schema';
import { collectIssues } from '../validation';
import { validateCatalogNodes } from '../tools/catalog';
import { convertNodesToWorkflow, validateWorkflow } from '../workflowConversion';

const byId = (id: string) => bundledTemplates().find((t) => t.id === id)!;

/** A plausible file for each input, by the type it asks for. */
const sampleFiles = (id: string): Record<string, string[]> =>
  Object.fromEntries(
    byId(id).inputs.map((i) => [i.id, [`/data/${i.id}.${i.types[0] === 'fasta' ? 'fa' : i.types[0] === 'gtf' ? 'gtf' : 'fastq.gz'}`]])
  );

describe('bundled templates', () => {
  it('ships the quality check and the RNA-seq and variant calling pipelines', () => {
    expect(bundledTemplates().map((t) => t.id)).toEqual([
      'basic-read-qc',
      'rnaseq-salmon',
      'rnaseq-hisat2-counts',
      'variants-bcftools',
      'variants-bcftools-paired',
      'variants-gatk',
    ]);
  });

  it.each(bundledTemplates().map((t) => [t.id] as const))('%s explains itself and cites its tools', (id) => {
    const t = byId(id);
    expect(t.description.length).toBeGreaterThan(30);
    expect(t.details.length).toBeGreaterThan(200);
    expect(t.inputs.length).toBeGreaterThan(0);
    expect(t.outputs.length).toBeGreaterThan(1);
    expect(t.references.length).toBeGreaterThanOrEqual(2);
    for (const input of t.inputs) {
      expect(input.hint).not.toMatch(/\{|\}/);
      expect(input.example).toBeTruthy();
    }
  });

  it.each(bundledTemplates().map((t) => [t.id] as const))(
    '%s makes a workflow without problems once its files are chosen, and converts to a valid workflow',
    (id) => {
      const made = instantiateTemplate(byId(id), sampleFiles(id));
      if (made.ok === false) throw new Error(made.errors.join('; '));
      expect(made.missing).toEqual([]);
      expect(collectIssues(made.nodes, {}, made.edges)).toEqual([]);
      expect(validateCatalogNodes(made.nodes)).toEqual([]);
      expect(validateWorkflow(convertNodesToWorkflow(made.nodes, made.edges, {}, { name: id }))).toEqual([]);
    }
  );

  it.each(bundledTemplates().map((t) => [t.id] as const))('%s names every missing file when nothing is chosen', (id) => {
    const made = instantiateTemplate(byId(id), {});
    if (made.ok === false) throw new Error(made.errors.join('; '));
    expect(made.missing.map((i) => i.id)).toEqual(byId(id).inputs.filter((i) => i.required).map((i) => i.id));
    expect(collectIssues(made.nodes, {}, made.edges).length).toBeGreaterThan(0);
  });

  it('Salmon: the transcript FASTA feeds the index and the trimmed reads feed the quantification', () => {
    const made = instantiateTemplate(byId('rnaseq-salmon'), sampleFiles('rnaseq-salmon'));
    if (made.ok === false) throw new Error(made.errors.join('; '));
    const node = (key: string) => made.nodes.find((n) => n.id === templateNodeId(key))!;
    expect(node('salmon_index').data.slotFiles.transcripts).toBe('/data/transcripts.fa');
    expect(node('fastp').data.slotFiles.reads).toBe('/data/reads.fastq.gz');
    expect(node('salmon_quant').data.slotLinks.reads).toEqual({ from: templateNodeId('fastp'), output: 'trimmed' });
    expect(node('salmon_quant').data.slotLinks.index).toEqual({ from: templateNodeId('salmon_index'), output: 'index_dir' });
  });

  it('HISAT2: HISAT2 is used, and the description names STAR as the alternative', () => {
    const t = byId('rnaseq-hisat2-counts');
    expect(toolsUsed(t)).toEqual(expect.arrayContaining(['HISAT2', 'featureCounts', 'MultiQC']));
    expect(toolsUsed(t).join(' ')).not.toMatch(/STAR/);
    expect(t.details).toContain('STAR');
  });

  it('paired-end variant calling: both read files go to BWA, which gets the indexed reference', () => {
    const made = instantiateTemplate(byId('variants-bcftools-paired'), sampleFiles('variants-bcftools-paired'));
    if (made.ok === false) throw new Error(made.errors.join('; '));
    const bwa = made.nodes.find((n) => n.id === templateNodeId('bwa_mem'))!;
    expect(bwa.data.slotFiles.reads1).toBe('/data/reads1.fastq.gz');
    expect(bwa.data.slotFiles.reads2).toBe('/data/reads2.fastq.gz');
    expect(bwa.data.slotLinks.ref).toEqual({ from: templateNodeId('bwa_index'), output: 'indexed_ref' });
    expect(bwa.data.command).toContain('{reads2}');
  });

  it('every alignment gets a read group, which GATK needs (BWA step has a sample name)', () => {
    for (const id of ['variants-bcftools', 'variants-bcftools-paired', 'variants-gatk']) {
      const made = instantiateTemplate(byId(id), sampleFiles(id));
      if (made.ok === false) throw new Error(made.errors.join('; '));
      const bwa = made.nodes.find((n) => n.id === templateNodeId('bwa_mem'))!;
      expect(bwa.data.command).toContain('SM:$sample');
    }
  });

  it('GATK: the caller gets the reference with its index and dictionary, and the BAM with its index', () => {
    const made = instantiateTemplate(byId('variants-gatk'), sampleFiles('variants-gatk'));
    if (made.ok === false) throw new Error(made.errors.join('; '));
    const hc = made.nodes.find((n) => n.id === templateNodeId('hc'))!;
    expect(hc.data.slotLinks.ref).toEqual({ from: templateNodeId('dict'), output: 'fasta' });
    expect(hc.data.slotLinks.bam).toEqual({ from: templateNodeId('markdup'), output: 'marked' });
    expect(hc.data.slotLinks.bai).toEqual({ from: templateNodeId('bam_index'), output: 'bai' });
  });
});
