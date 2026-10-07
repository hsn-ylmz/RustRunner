import { describe, expect, it } from 'vitest';
import { bundledTemplates } from '../templates/registry';
import { instantiateTemplate, templateNodeId } from '../templates/instantiate';
import { databaseNeeds, toolsUsed } from '../templates/schema';
import { needsDatabase } from '../templates/gallery';
import { collectIssues } from '../validation';
import { findTool, validateCatalogNodes } from '../tools/catalog';
import { convertNodesToWorkflow, validateWorkflow } from '../workflowConversion';

const byId = (id: string) => bundledTemplates().find((t) => t.id === id)!;

/** A plausible file for each input, by the type it asks for. */
const ENDINGS: Record<string, string> = { fasta: 'fa', gtf: 'gtf', bed: 'bed', pod5: 'pod5', database: 'db' };
const sampleFiles = (id: string): Record<string, string[]> =>
  Object.fromEntries(
    byId(id).inputs.map((i) => [i.id, [`/data/${i.id}.${ENDINGS[i.types[0]] ?? 'fastq.gz'}`]])
  );

describe('bundled templates', () => {
  it('ships the quality check and the RNA-seq, variant calling, epigenomics, long-read, metagenomics and assembly pipelines', () => {
    expect(bundledTemplates().map((t) => t.id)).toEqual([
      'basic-read-qc',
      'rnaseq-salmon',
      'rnaseq-hisat2-counts',
      'variants-bcftools',
      'variants-bcftools-paired',
      'variants-gatk',
      'chipseq-macs3',
      'atacseq-genrich',
      'nanopore-signal',
      'nanopore-fastq',
      'metagenomics-kraken2-bracken',
      'assembly-spades-quast',
      'assembly-flye-quast',
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

  it('ChIP-seq: the ChIP and the control are aligned and sorted apart, MACS3 gets them as treatment and control, HOMER gets the genome and the genes', () => {
    const made = instantiateTemplate(byId('chipseq-macs3'), sampleFiles('chipseq-macs3'));
    if (made.ok === false) throw new Error(made.errors.join('; '));
    const node = (key: string) => made.nodes.find((n) => n.id === templateNodeId(key))!;
    expect(node('macs3').data.slotLinks.treatment).toEqual({ from: templateNodeId('sort_chip'), output: 'bam' });
    expect(node('macs3').data.slotLinks.control).toEqual({ from: templateNodeId('sort_input'), output: 'bam' });
    expect(node('macs3').data.catalogParams.format).toBe('BAM');
    expect(node('bt_chip').data.slotLinks.index).toEqual({ from: templateNodeId('bt_build'), output: 'index' });
    expect(node('bt_input').data.slotLinks.index).toEqual({ from: templateNodeId('bt_build'), output: 'index' });
    expect(node('bt_build').data.slotFiles.ref).toBe('/data/genome.fa');
    expect(node('homer').data.slotFiles.genome).toBe('/data/genome.fa');
    expect(node('homer').data.slotFiles.annotation).toBe('/data/annotation.gtf');
    expect(node('homer').data.slotLinks.peaks).toEqual({ from: templateNodeId('macs3'), output: 'peaks' });
    expect(node('fingerprint').data.slotLinks.bams).toHaveLength(2);
    expect(node('fingerprint').data.slotLinks.bais).toHaveLength(2);
  });

  it('ChIP-seq: the two samples never write the same file name', () => {
    const made = instantiateTemplate(byId('chipseq-macs3'), sampleFiles('chipseq-macs3'));
    if (made.ok === false) throw new Error(made.errors.join('; '));
    const outputs = made.nodes.flatMap((n) => {
      const tool = findTool(n.data.catalogId)!;
      return tool.outputs.filter((o) => !o.derived).map((o) => n.data.slotFiles[o.name] as string);
    });
    expect(new Set(outputs).size).toBe(outputs.length);
  });

  it('ATAC-seq: Genrich gets alignments sorted by read name, and the signal track gets the position-sorted copy with its index', () => {
    const made = instantiateTemplate(byId('atacseq-genrich'), sampleFiles('atacseq-genrich'));
    if (made.ok === false) throw new Error(made.errors.join('; '));
    const node = (key: string) => made.nodes.find((n) => n.id === templateNodeId(key))!;
    expect(node('sort_name').data.catalogParams.by_name).toBe(true);
    expect(node('sort_pos').data.catalogParams.by_name).toBe(false);
    expect(node('genrich').data.slotLinks.alignments).toEqual([{ from: templateNodeId('sort_name'), output: 'bam' }]);
    expect(node('genrich').data.catalogParams.atac_mode).toBe(true);
    expect(node('coverage').data.slotLinks.bam).toEqual({ from: templateNodeId('sort_pos'), output: 'bam' });
    expect(node('coverage').data.slotLinks.bai).toEqual({ from: templateNodeId('index'), output: 'bai' });
    // Both read files reach Bowtie2, which allows the long fragments of ATAC-seq.
    expect(node('bowtie2').data.slotFiles.reads).toBe('/data/reads1.fastq.gz');
    expect(node('bowtie2').data.slotFiles.reads2).toBe('/data/reads2.fastq.gz');
    expect(node('bowtie2').data.command).toContain('-X 2000');
    expect(node('bowtie2').data.command).toContain('-1 "{reads}" -2 "{reads2}"');
  });

  it('ATAC-seq: the regions to ignore are optional, and a file for them reaches Genrich and the signal track', () => {
    const t = byId('atacseq-genrich');
    expect(t.inputs.find((i) => i.id === 'blacklist')!.required).toBe(false);
    const made = instantiateTemplate(t, { ...sampleFiles('atacseq-genrich'), blacklist: ['/data/blacklist.bed'] });
    if (made.ok === false) throw new Error(made.errors.join('; '));
    expect(made.nodes.find((n) => n.id === templateNodeId('genrich'))!.data.slotFiles.blacklist).toBe('/data/blacklist.bed');
    expect(made.nodes.find((n) => n.id === templateNodeId('coverage'))!.data.slotFiles.blacklist).toBe('/data/blacklist.bed');
  });

  it('Nanopore from raw signal says Dorado is an external, Apple-silicon-only download and names the FASTQ template as the alternative', () => {
    const t = byId('nanopore-signal');
    expect(t.details).toMatch(/Apple silicon/);
    expect(t.details).toMatch(/Windows and on Linux/);
    expect(t.details).toContain(byId('nanopore-fastq').name);
    expect(findTool('dorado-basecaller')!.install).toMatchObject({ kind: 'external' });
    expect(needsDatabase(t)).toBe(true);
    expect(needsDatabase(byId('nanopore-fastq'))).toBe(false);
    expect(toolsUsed(byId('nanopore-fastq')).join(' ')).not.toMatch(/Dorado/);
  });

  it('Nanopore from raw signal: the called reads are turned into FASTQ before filtering, and one filter feeds both the report and the mapping', () => {
    const made = instantiateTemplate(byId('nanopore-signal'), sampleFiles('nanopore-signal'));
    if (made.ok === false) throw new Error(made.errors.join('; '));
    const node = (key: string) => made.nodes.find((n) => n.id === templateNodeId(key))!;
    expect(node('merge').data.slotFiles.pods).toBe('/data/pod5.pod5');
    expect(node('fastq').data.slotLinks.alignments).toEqual({ from: templateNodeId('dorado'), output: 'calls' });
    expect(node('chopper').data.slotLinks.reads).toEqual({ from: templateNodeId('fastq'), output: 'reads' });
    expect(node('nanoplot').data.slotLinks.reads).toEqual([{ from: templateNodeId('chopper'), output: 'filtered' }]);
    expect(node('minimap2').data.slotLinks.reads).toEqual({ from: templateNodeId('chopper'), output: 'filtered' });
    expect(node('minimap2').data.catalogParams.preset).toBe('map-ont');
    expect(node('mosdepth').data.slotLinks.bai).toEqual({ from: templateNodeId('index'), output: 'bai' });
  });

  it('metagenomics: the database is shown as a need before the workflow is made, and one folder feeds Kraken2 and Bracken', () => {
    const t = byId('metagenomics-kraken2-bracken');
    expect(needsDatabase(t)).toBe(true);
    expect(databaseNeeds(t).map((n) => n.tool)).toEqual(['Kraken2', 'Bracken']);
    expect(databaseNeeds(t)[0].link?.url).toMatch(/^https:/);
    const made = instantiateTemplate(t, sampleFiles('metagenomics-kraken2-bracken'));
    if (made.ok === false) throw new Error(made.errors.join('; '));
    const node = (key: string) => made.nodes.find((n) => n.id === templateNodeId(key))!;
    expect(node('kraken2').data.slotFiles.db).toBe('/data/database.db');
    expect(node('bracken').data.slotFiles.db).toBe('/data/database.db');
    expect(node('bracken').data.slotLinks.report).toEqual({ from: templateNodeId('kraken2'), output: 'report' });
    expect(node('kraken2').data.slotLinks.reads1).toEqual({ from: templateNodeId('fastp'), output: 'trimmed' });
  });

  it('assembly: short reads go to SPAdes (the second file is optional) and long reads to Flye, each assembly is judged by QUAST', () => {
    const short = instantiateTemplate(byId('assembly-spades-quast'), sampleFiles('assembly-spades-quast'));
    const long = instantiateTemplate(byId('assembly-flye-quast'), sampleFiles('assembly-flye-quast'));
    if (short.ok === false || long.ok === false) throw new Error('could not make the assembly workflows');
    const quastOf = (nodes: any[]) => nodes.find((n) => n.id === templateNodeId('quast'))!;
    expect(quastOf(short.nodes).data.slotLinks.assemblies).toEqual([{ from: templateNodeId('spades'), output: 'contigs' }]);
    expect(quastOf(long.nodes).data.slotLinks.assemblies).toEqual([{ from: templateNodeId('flye'), output: 'assembly' }]);
    expect(byId('assembly-spades-quast').inputs.filter((i) => !i.required).map((i) => i.id)).toEqual(['reads2', 'reference']);
    expect(byId('assembly-flye-quast').inputs.filter((i) => !i.required).map((i) => i.id)).toEqual(['reference']);
    // Without the optional files the workflow still has no problem.
    const bare = instantiateTemplate(byId('assembly-spades-quast'), { reads1: ['/data/r1.fastq.gz'] });
    if (bare.ok === false) throw new Error(bare.errors.join('; '));
    expect(bare.missing).toEqual([]);
    expect(collectIssues(bare.nodes, {}, bare.edges)).toEqual([]);
  });

  it('every new template says which kind of reads it takes and what to do for the other kind', () => {
    expect(byId('chipseq-macs3').details).toMatch(/single-end/);
    expect(byId('atacseq-genrich').details).toMatch(/paired-end/);
    expect(byId('assembly-spades-quast').details).toContain(byId('assembly-flye-quast').name);
    expect(byId('assembly-flye-quast').details).toContain(byId('assembly-spades-quast').name);
  });
});
