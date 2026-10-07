import { describe, expect, it } from 'vitest';
import { bundledTemplates } from '../templates/registry';
import { instantiateTemplate, initialSettingTexts, templateNodeId } from '../templates/instantiate';
import { stepLabels, toolsUsed } from '../templates/schema';
import { findTool } from '../tools/catalog';
import { collectIssues } from '../validation';
import { convertNodesToWorkflow, validateWorkflow } from '../workflowConversion';

/**
 * The Ribo-seq template is the PhD pipeline of riboseq-test/DATA.md:
 * FastQC, cutadapt, FastQC, UMI-tools extract, FastQC, three bowtie2 removals,
 * FastQC, STAR (transcript BAM), samtools view / sort / index, UMI-tools dedup,
 * riboWaltz, MultiQC. The real tools run it in test-tools (domain riboseq).
 */
const template = bundledTemplates().find((t) => t.id === 'riboseq-umi-ribowaltz')!;
const FILES: Record<string, string[]> = {
  reads: ['/d/reads.fastq.gz'],
  rrna: ['/d/rRNA.fa'],
  trna: ['/d/tRNA.fa'],
  ncrna: ['/d/ncRNA.fa'],
  genome: ['/d/genome.fa'],
  annotation: ['/d/genes.gtf'],
};

function made(settings?: Record<string, string | number | boolean>) {
  const result = instantiateTemplate(template, FILES, { settings });
  if (result.ok === false) throw new Error(result.errors.join('; '));
  return result;
}
const node = (key: string, nodes: any[] = made().nodes) => nodes.find((n) => n.id === templateNodeId(key))!;
/** What fills an input slot, as `step.output` (always a list: some slots take several files). */
const from = (key: string, slot: string): string[] => {
  const link = node(key).data.slotLinks[slot];
  return (Array.isArray(link) ? link : [link]).map((l: any) => `${l.from.replace('tpl_', '')}.${l.output}`);
};

describe('Ribo-seq with UMIs template', () => {
  it('is bundled, and asks for the six files of the pipeline', () => {
    expect(template).toBeDefined();
    expect(template.inputs.map((i) => [i.id, i.required, i.types[0]])).toEqual([
      ['reads', true, 'fastq'],
      ['rrna', true, 'fasta'],
      ['trna', true, 'fasta'],
      ['ncrna', true, 'fasta'],
      ['genome', true, 'fasta'],
      ['annotation', true, 'gtf'],
    ]);
  });

  it('is exactly the pipeline: 20 steps, four FastQC checks, the index builds inside the workflow', () => {
    const tools = template.steps.map((s) => s.tool);
    expect(tools).toHaveLength(20);
    expect(tools.filter((t) => t === 'fastqc')).toHaveLength(4);
    expect(tools.filter((t) => t === 'bowtie2-build')).toHaveLength(3);
    expect(tools.filter((t) => t === 'bowtie2-remove-reads')).toHaveLength(3);
    expect(tools.filter((t) => t === 'star-genomegenerate')).toHaveLength(1);
    for (const needed of ['cutadapt', 'umi-tools-extract', 'star-riboseq', 'samtools-view', 'samtools-sort', 'samtools-index', 'umi-tools-dedup', 'ribowaltz-report', 'multiqc']) {
      expect(tools.filter((t) => t === needed)).toHaveLength(1);
    }
    expect(toolsUsed(template)).toContain('riboWaltz report');
  });

  it('passes the reads down the chain in the order of the user\'s pipeline', () => {
    expect(node('cut').data.slotFiles.reads).toBe('/d/reads.fastq.gz');
    expect(node('fqc_raw').data.slotFiles.reads).toBe('/d/reads.fastq.gz');
    expect(from('fqc_trim', 'reads')).toEqual(['cut.trimmed']);
    expect(from('umi', 'reads')).toEqual(['cut.trimmed']);
    expect(from('fqc_umi', 'reads')).toEqual(['umi.extracted']);
    expect(from('rm_rrna', 'reads')).toEqual(['umi.extracted']);
    expect(from('rm_trna', 'reads')).toEqual(['rm_rrna.unaligned']);
    expect(from('rm_ncrna', 'reads')).toEqual(['rm_trna.unaligned']);
    expect(from('fqc_clean', 'reads')).toEqual(['rm_ncrna.unaligned']);
    expect(from('star', 'reads')).toEqual(['rm_ncrna.unaligned']);
    expect(from('rm_rrna', 'index')).toEqual(['idx_rrna.index']);
    expect(from('rm_trna', 'index')).toEqual(['idx_trna.index']);
    expect(from('rm_ncrna', 'index')).toEqual(['idx_ncrna.index']);
    expect(node('idx_rrna').data.slotFiles.ref).toBe('/d/rRNA.fa');
    expect(node('idx_trna').data.slotFiles.ref).toBe('/d/tRNA.fa');
    expect(node('idx_ncrna').data.slotFiles.ref).toBe('/d/ncRNA.fa');
  });

  it('maps with STAR in transcript coordinates, filters, sorts, indexes, deduplicates, then riboWaltz reads the deduplicated BAM', () => {
    expect(from('star', 'index')).toEqual(['star_idx.index_dir']);
    expect(node('star_idx').data.slotFiles.genome).toBe('/d/genome.fa');
    expect(node('star_idx').data.slotFiles.annotation).toBe('/d/genes.gtf');
    expect(from('view', 'alignments')).toEqual(['star.transcriptome_bam']);
    expect(from('sort', 'alignments')).toEqual(['view.filtered']);
    expect(from('index', 'bam')).toEqual(['sort.bam']);
    expect(from('dedup', 'alignments')).toEqual(['sort.bam']);
    expect(from('dedup', 'index')).toEqual(['index.bai']);
    expect(from('ribo', 'bams')).toEqual(['dedup.deduplicated']);
    expect(node('ribo').data.slotFiles.annotation).toBe('/d/genes.gtf');
    expect(node('ribo').data.slotFiles.genome).toBe('/d/genome.fa');
    // STAR is pinned to the release that supports --quantMode TranscriptomeSAM.
    expect(JSON.stringify(findTool('star-riboseq')!.install)).toContain('2.7.10b');
    expect(node('star').data.command).toContain('--quantMode TranscriptomeSAM');
    expect(node('view').data.command).toContain('-G 16');
  });

  it('MultiQC reads the four FastQC reports, cutadapt, the UMI extraction, the three removals, STAR and the dedup log', () => {
    expect(from('mqc', 'reports')).toEqual([
      'fqc_raw.report_dir',
      'cut.report',
      'fqc_trim.report_dir',
      'umi.log',
      'fqc_umi.report_dir',
      'rm_rrna.log',
      'rm_trna.log',
      'rm_ncrna.log',
      'fqc_clean.report_dir',
      'star.log',
      'dedup.log',
    ]);
  });

  it('gives every FastQC step and every removal step its own output name, so nothing overwrites anything', () => {
    const fastqc = template.steps.filter((s) => s.tool === 'fastqc').map((s) => s.files!.report_dir);
    expect(new Set(fastqc).size).toBe(4);
    const removal = template.steps.filter((s) => s.tool === 'bowtie2-remove-reads');
    expect(new Set(removal.map((s) => s.files!.unaligned)).size).toBe(3);
    expect(new Set(removal.map((s) => s.files!.log)).size).toBe(3);
    const labels = Object.values(stepLabels(template));
    expect(new Set(labels).size).toBe(labels.length);
  });

  it('starts at the values of DATA.md: D-Plex adapter, cutadapt minimum 36 (UMI still on), 12 nt UMI at the 5\' end and 4 nt motif, 28 to 34 nt, frame-checked offsets, 2 mismatches, one place', () => {
    const texts = initialSettingTexts(template);
    expect(texts).toMatchObject({
      adapter: 'AAAAAAAAAACAAAAAAAAAAGATCGGAAGAGCACACGTCTGAACTCCAGTCAC',
      trim_min_length: '36',
      umi_end: '5prime',
      umi_length: '12',
      spacer_length: '4',
      min_length: '28',
      max_length: '34',
      offset_refine: 'frame',
      mismatches: '2',
      multimap: '1',
    });
    const m = made();
    // cutadapt runs before the UMI is removed: 12 UMI + 4 motif + an insert of at least 20.
    expect(node('cut', m.nodes).data.catalogParams).toMatchObject({ min_overlap: 10, error_rate: 0.1, min_length: 36 });
    expect(node('cut', m.nodes).data.command).toContain('-m 36');
    expect(node('ribo', m.nodes).data.command).toContain('--offset-refine frame');
    // MAPQ 20 stays: it removes reads on two overlapping transcripts, so dedup sees each read once.
    expect(node('view', m.nodes).data.command).toContain('-q 20');
    // The UMI is extracted with the regex method and a discard group (the string method with X leaves the motif in the read).
    expect(node('umi', m.nodes).data.command).toContain('--extract-method=regex');
    expect(node('umi', m.nodes).data.command).toContain('discard_1');
  });

  it('applies the setup settings to the steps they name', () => {
    const m = made({
      adapter: 'TGGAATTCTCGGGTGCCAAGG',
      umi_end: '3prime',
      umi_length: '8',
      spacer_length: '0',
      min_length: '26',
      max_length: '32',
      offset_refine: 'none',
      trim_min_length: '28',
      mismatches: '1',
      multimap: '2',
    });
    expect(node('cut', m.nodes).data.catalogParams.min_length).toBe(28);
    expect(node('ribo', m.nodes).data.command).toContain('--offset-refine none');
    expect(node('cut', m.nodes).data.catalogParams.adapter).toBe('TGGAATTCTCGGGTGCCAAGG');
    expect(node('umi', m.nodes).data.catalogParams).toMatchObject({ umi_end: '3prime', umi_length: 8, spacer_length: 0 });
    expect(node('ribo', m.nodes).data.catalogParams).toMatchObject({ min_length: 26, max_length: 32 });
    expect(node('star', m.nodes).data.catalogParams).toMatchObject({ max_mismatches: 1, max_multimap: 2 });
  });

  it('rejects a setting outside the tool\'s range instead of building a broken workflow', () => {
    const result = instantiateTemplate(template, FILES, { settings: { max_length: '500' } });
    expect(result.ok).toBe(false);
  });

  it('makes a workflow with no problem once the files are chosen, and the workflow is valid', () => {
    const m = made();
    expect(m.missing).toEqual([]);
    expect(collectIssues(m.nodes, {}, m.edges)).toEqual([]);
    expect(validateWorkflow(convertNodesToWorkflow(m.nodes, m.edges, {}, { name: template.id }))).toEqual([]);
  });

  it('says what it does in plain words, names its limits and cites every tool and the data set', () => {
    expect(template.details).toMatch(/D-Plex/);
    expect(template.details).toMatch(/2\.7\.10b/);
    expect(template.details).toMatch(/one transcript per gene/);
    const refs = template.references.map((r) => r.label).join('\n');
    for (const name of ['Cutadapt', 'UMI-tools', 'Bowtie 2', 'STAR', 'SAMtools', 'riboWaltz', 'MultiQC', 'FastQC', 'GSE158374']) {
      expect(refs).toContain(name);
    }
    expect(template.outputs.map((o) => `${o.step}.${o.slot}`)).toEqual(
      expect.arrayContaining(['ribo.report', 'dedup.deduplicated', 'mqc.report', 'star.log'])
    );
  });
});
