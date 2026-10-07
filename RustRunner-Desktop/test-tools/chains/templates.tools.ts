/**
 * Templates domain: every bundled workflow template is made into steps by the
 * code the "New from template" dialog runs (`instantiateTemplate`, with files
 * chosen the way the setup step passes them), converted to the engine's YAML
 * the way the app does, and run for real against the bioconda tools on the
 * synthetic data. A template that works in the editor but not in the engine,
 * or whose declared outputs are not what the tools write, fails here.
 *
 * To add a bundled template: add an entry to `SETUPS` (the data files and the
 * file chosen for each input, and what the results must hold). The layout test
 * in `../coverage.tools.ts` fails for a bundled template without one.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { DATA, defineDomain, ensurePod5Data, exists, read, sizeOf, truthSnps, type BuiltChain, type Chain, type Check, type NodeSpec } from '../harness';
import { ATAC_TRUTH, CHIP_TRUTH, hits, homerRows, homerSummary, isBigWig, overlap, pngSize, regions, type Region } from '../regions';
import { fastaRecords, fastqRecords, nanoStat, quastTable, samRecords, tableRows } from '../seqio';
import { bundledTemplates } from '../../src/renderer/templates/registry';
import { instantiateTemplate, templateNodeId, type SettingTexts } from '../../src/renderer/templates/instantiate';
import { collectIssues } from '../../src/renderer/validation';
import { applyParamChange, findTool, buildCatalogNodeData, defaultParams, renderCommand, validateCatalogNodes, type ParamValue } from '../../src/renderer/tools/catalog';
import { convertNodesToWorkflow, labelToId, validateWorkflow } from '../../src/renderer/workflowConversion';

interface Setup {
  /** Data files copied from the synthetic data folder into the run directory. */
  files: string[];
  /** The files chosen for each template input, as the setup step would pass them. */
  values: Record<string, string[]>;
  /** Values typed into the setup step's settings (by setting id), as a person would for this data. */
  settings?: SettingTexts;
  verify: Chain['verify'];
  /**
   * Options changed for the synthetic data, by step key. A template's defaults suit real
   * data (human genome size, 500000 sampled regions, Q10 reads); the 5 kb genome and the
   * 16 made-up reads need smaller values. Nothing else about the steps is changed.
   */
  overrides?: Record<string, Record<string, ParamValue>>;
  /**
   * Steps whose output may be empty on the synthetic data (only that it exists is checked).
   * The made-up Nanopore signal does not map to any genome, so the depth tables are empty.
   */
  mayBeEmpty?: string[];
  /**
   * Steps that make something the template asks the person to bring (a Kraken2 database).
   * They run first, in the same workflow, and the template steps in `before` run after them.
   */
  prelude?: { nodes: NodeSpec[]; edges: Array<[string, string]>; before: Record<string, string[]> };
}


/** Rows of a tab-separated table with a header line. */
function table(text: string): Array<Record<string, string>> {
  const [head, ...rows] = text.trim().split('\n');
  const names = head.split('\t');
  return rows.map((row) => Object.fromEntries(row.split('\t').map((value, i) => [names[i], value])));
}

/** The MultiQC modules that found something in a report folder. */
function multiqcModules(dir: string, folder: string): string[] {
  return [...new Set(table(read(dir, `${folder}/multiqc_report_data/multiqc_sources.txt`)).map((r) => r.Module))];
}

interface VcfCall {
  contig: string;
  pos: number;
  alt: string[];
}

function vcfCalls(text: string): VcfCall[] {
  return text
    .split('\n')
    .filter((l) => l && !l.startsWith('#'))
    .map((l) => {
      const f = l.split('\t');
      return { contig: f[0], pos: Number(f[1]), alt: f[4].split(',') };
    });
}

/** How many of the planted SNPs a VCF reports with the right alternative base. */
function plantedFound(text: string): number {
  const calls = vcfCalls(text);
  return truthSnps().filter((s) => calls.some((c) => c.contig === s.contig && c.pos === s.pos && c.alt.includes(s.alt))).length;
}

const ok = (tool: string, condition: boolean, message: string): Check => ({ tool, ok: condition, message });

/** The checks the two bcftools templates share: planted SNPs found, the filter, the stats, the report. */
function bcftoolsChecks(dir: string, extraModules: string[]): Check[] {
  const total = truthSnps().length;
  const all = read(dir, 'variants.vcf');
  const kept = vcfCalls(read(dir, 'filtered.vcf'));
  const stats = read(dir, 'variant_stats.txt');
  const statsSnps = Number(/number of SNPs:\t(\d+)/.exec(stats)?.[1]);
  const modules = multiqcModules(dir, 'multiqc');
  return [
    ok('bcftools-call', plantedFound(all) >= Math.ceil(total * 0.75), `${plantedFound(all)}/${total} planted SNPs called`),
    ok('bcftools-filter', plantedFound(read(dir, 'filtered.vcf')) >= Math.ceil(total * 0.75), 'the default filter keeps the planted SNPs'),
    ok('bcftools-stats', statsSnps > 0 && statsSnps <= vcfCalls(all).length, `bcftools stats counts ${statsSnps} SNPs in the filtered file (${kept.length} records)`),
    ok('multiqc', ['Bcftools', ...extraModules].every((m) => modules.includes(m)), `MultiQC read ${modules.join(', ')}`),
  ];
}

/** Template id -> how to run it on the synthetic data. */
export const SETUPS: Record<string, Setup> = {
  'basic-read-qc': {
    files: ['dna_se.fastq.gz'],
    values: { reads: ['dna_se.fastq.gz'] },
    verify: (dir) => {
      const report = read(dir, 'multiqc/multiqc_report.html');
      return [
        { tool: 'fastqc', ok: exists(dir, 'qc_raw/dna_se_fastqc.zip'), message: 'FastQC checked the raw reads' },
        { tool: 'fastp', ok: exists(dir, 'trimmed.fastq.gz'), message: 'fastp wrote the trimmed reads' },
        { tool: 'fastqc', ok: exists(dir, 'qc_trimmed/trimmed_fastqc.zip'), message: 'FastQC checked the trimmed reads' },
        { tool: 'multiqc', ok: report.includes('FastQC'), message: 'the combined report has the FastQC results' },
        { tool: 'multiqc', ok: report.includes('fastp'), message: 'the combined report has the fastp results' },
      ];
    },
  },
  'rnaseq-salmon': {
    files: ['rna_se.fastq.gz', 'transcripts.fa'],
    values: { reads: ['rna_se.fastq.gz'], transcripts: ['transcripts.fa'] },
    verify: (dir) => {
      const counts = table(read(dir, 'salmon_out/quant.sf')).map((r) => Number(r.NumReads));
      const trimmed = JSON.parse(read(dir, 'fastp.json')).summary.after_filtering.total_reads as number;
      const modules = multiqcModules(dir, 'multiqc');
      return [
        ok('fastp', exists(dir, 'trimmed.fastq.gz'), 'fastp wrote the trimmed reads'),
        ok('salmon-index', exists(dir, 'salmon_index/info.json'), 'the Salmon index was built from the transcripts'),
        ok('salmon-quant', counts.length === 3 && counts.every((n) => n > 350 && n < 650), `Salmon quantifies the three transcripts evenly (${counts.map((n) => n.toFixed(0)).join(' / ')})`),
        ok('salmon-quant', Math.abs(counts.reduce((a, b) => a + b, 0) - trimmed) < 0.05 * trimmed, `the estimated reads add up to the ${trimmed} reads fastp kept`),
        ok('multiqc', ['fastp', 'Salmon'].every((m) => modules.includes(m)), `MultiQC read fastp and Salmon (it read ${modules.join(', ')})`),
      ];
    },
  },
  'rnaseq-hisat2-counts': {
    files: ['rna_se.fastq.gz', 'ref.fa', 'genes.gtf'],
    values: { reads: ['rna_se.fastq.gz'], genome: ['ref.fa'], annotation: ['genes.gtf'] },
    verify: (dir) => {
      const rows = table(read(dir, 'counts.tsv').split('\n').filter((l) => !l.startsWith('#')).join('\n'));
      const perGene = rows.map((r) => Number(Object.values(r).at(-1)));
      const modules = multiqcModules(dir, 'multiqc');
      const trimmed = JSON.parse(read(dir, 'fastp.json')).summary.after_filtering.total_reads as number;
      const hisatReads = Number(read(dir, 'hisat2_summary.txt').match(/Total reads: (\d+)/)?.[1]);
      return [
        ok('hisat2-build', exists(dir, 'hisat2_index/genome.1.ht2'), 'the HISAT2 index was built from the genome'),
        ok('hisat2', hisatReads === trimmed && trimmed > 1000, `HISAT2 aligned the ${trimmed} reads fastp kept (${hisatReads})`),
        ok('samtools-index', exists(dir, 'sorted.bam.bai'), 'the sorted BAM has an index'),
        ok('featurecounts', rows.length === 3 && perGene.every((n) => n > 350 && n < 650), `featureCounts counts the three genes evenly (${perGene.join(' / ')})`),
        ok('multiqc', ['fastp', 'HISAT2', 'featureCounts'].every((m) => modules.includes(m)), `MultiQC read fastp, HISAT2 and featureCounts (it read ${modules.join(', ')})`),
      ];
    },
  },
  'variants-bcftools': {
    files: ['dna_se.fastq.gz', 'ref.fa'],
    values: { reads: ['dna_se.fastq.gz'], reference: ['ref.fa'] },
    verify: (dir) => [
      ok('bwa-index', exists(dir, 'bwa_index/reference.fa.bwt'), 'the BWA index was built from the reference'),
      ok('samtools-markdup', exists(dir, 'markdup.bam') && exists(dir, 'markdup.bam.bai'), 'the marked BAM and its index exist'),
      ...bcftoolsChecks(dir, ['fastp']),
    ],
  },
  'variants-bcftools-paired': {
    files: ['dna_R1.fastq.gz', 'dna_R2.fastq.gz', 'ref.fa'],
    values: { reads1: ['dna_R1.fastq.gz'], reads2: ['dna_R2.fastq.gz'], reference: ['ref.fa'] },
    verify: (dir) => {
      const flag = read(dir, 'flagstat.txt');
      const properly = Number(/(\d+) \+ 0 properly paired/.exec(flag)?.[1]);
      return [
        ok('bwa-mem', properly > 1000, `the read pairs align as pairs (${properly} reads properly paired)`),
        ok('samtools-markdup', exists(dir, 'markdup.bam') && exists(dir, 'markdup.bam.bai'), 'the marked BAM and its index exist'),
        ...bcftoolsChecks(dir, ['Samtools']),
      ];
    },
  },
  'variants-gatk': {
    files: ['dna_se.fastq.gz', 'ref.fa'],
    values: { reads: ['dna_se.fastq.gz'], reference: ['ref.fa'] },
    verify: (dir) => {
      const total = truthSnps().length;
      const vcf = read(dir, 'haplotypecaller.vcf');
      const metrics = read(dir, 'duplication_metrics.txt');
      const modules = multiqcModules(dir, 'multiqc');
      return [
        ok('gatk-createsequencedictionary', /^@SQ\tSN:chr1\tLN:3000/m.test(read(dir, 'gatk_reference/reference.dict')), 'the dictionary lists chr1'),
        ok('picard-markduplicates', metrics.includes('LIBRARY') && exists(dir, 'marked.bam.bai'), 'Picard marked the duplicates and the BAM is indexed'),
        ok('gatk-haplotypecaller', plantedFound(vcf) >= Math.ceil(total * 0.75), `${plantedFound(vcf)}/${total} planted SNPs called by HaplotypeCaller`),
        ok('multiqc', ['fastp', 'Picard', 'Bcftools'].every((m) => modules.includes(m)), `MultiQC read fastp, Picard and bcftools (it read ${modules.join(', ')})`),
      ];
    },
  },
  'chipseq-macs3': {
    files: ['chip_R1.fastq.gz', 'input_R1.fastq.gz', 'ref.fa', 'genes.gtf'],
    values: { chip_reads: ['chip_R1.fastq.gz'], control_reads: ['input_R1.fastq.gz'], genome: ['ref.fa'], annotation: ['genes.gtf'] },
    // The 5 kb test genome is entered in the setup step's "Genome size" field, as a person would for their own genome.
    settings: { genome_size: '5000' },
    overrides: { fingerprint: { sample_regions: 400 } },
    verify: (dir) => {
      const truth = CHIP_TRUTH();
      const peaks = regions(read(dir, 'macs3/sample_peaks.narrowPeak'));
      const summits = regions(read(dir, 'macs3/sample_summits.bed'));
      const header = read(dir, 'macs3/sample_peaks.xls');
      const metrics = tableRows(read(dir, 'fingerprint_metrics.tsv'));
      const auc = (sample: string) => Number(metrics.find((m) => m.Sample === sample)?.AUC);
      const fp = pngSize(dir, 'fingerprint.png');
      const annotated = homerRows(read(dir, 'annotated_peaks.tsv'));
      const row = (t: Region) => annotated.find((r) => overlap(r, t));
      const summary = homerSummary(read(dir, 'annotation_summary.txt'));
      return [
        ok('fastp', exists(dir, 'chip.trimmed.fastq.gz') && exists(dir, 'input.trimmed.fastq.gz'), 'both read files were trimmed'),
        ok('bowtie2-build', exists(dir, 'bowtie2_index/reference.fa.1.bt2'), 'the Bowtie2 index was built from the genome'),
        ok('samtools-index', exists(dir, 'chip.sorted.bam.bai') && exists(dir, 'input.sorted.bam.bai'), 'both sorted BAMs have an index'),
        ok('macs3-callpeak', peaks.length === truth.length && truth.every((t) => hits(peaks, t).length === 1), `one peak in each of the ${truth.length} planted regions (${peaks.length} peaks)`),
        ok('macs3-callpeak', peaks.every((p) => hits(truth, p).length === 1) && summits.length === peaks.length, 'no peak outside the planted regions, one summit per peak'),
        ok('macs3-callpeak', /# ChIP-seq file = \['chip\.sorted\.bam'\]/.test(header) && /# control file = \['input\.sorted\.bam'\]/.test(header), 'MACS3 took the ChIP as treatment and the input as control'),
        ok('macs3-callpeak', /# effective genome size = 5\.00e\+03/.test(header), 'MACS3 used the genome size typed in the setup step (5000)'),
        ok('deeptools-bamcoverage', isBigWig(dir, 'chip.bw') && isBigWig(dir, 'input.bw'), 'both signal tracks are bigWig files'),
        ok('deeptools-plotfingerprint', fp !== null && fp.width > 300 && metrics.length === 2, 'the fingerprint plot is a picture and its numbers have a row for each sample'),
        ok('deeptools-plotfingerprint', auc('chip.sorted.bam') < auc('input.sorted.bam') - 0.1, `the ChIP is more enriched than the control (AUC ${auc('chip.sorted.bam').toFixed(2)} against ${auc('input.sorted.bam').toFixed(2)})`),
        ok('homer-annotatepeaks', annotated.length === peaks.length && /^promoter-TSS \(txA\)/.test(row(truth[0])?.annotation ?? '') && /^promoter-TSS \(txB\)/.test(row(truth[3])?.annotation ?? ''), 'the peaks on the two promoters are called promoters of txA and txB'),
        ok('homer-annotatepeaks', /^exon \(txC/.test(row(truth[2])?.annotation ?? '') && row(truth[1])?.nearest === 'txA', 'the exon peak is called an exon of txC and the intron peak is nearest to txA'),
        ok('homer-annotatepeaks', summary.Promoter === 2 && summary.Exon === 1 && summary.TTS === 1, `the summary counts 2 promoter, 1 exon and 1 end-of-gene peaks (${JSON.stringify(summary)})`),
      ];
    },
  },
  'atacseq-genrich': {
    files: ['atac_R1.fastq.gz', 'atac_R2.fastq.gz', 'ref.fa'],
    values: { reads1: ['atac_R1.fastq.gz'], reads2: ['atac_R2.fastq.gz'], genome: ['ref.fa'] },
    verify: (dir) => {
      const truth = ATAC_TRUTH();
      const peaks = regions(read(dir, 'genrich_peaks.narrowPeak'));
      const merged = regions(read(dir, 'merged.bed'));
      return [
        ok('bowtie2-build', exists(dir, 'bowtie2_index/reference.fa.1.bt2'), 'the Bowtie2 index was built from the genome'),
        ok('bowtie2', exists(dir, 'atac.sam') && sizeOf(dir, 'atac.sam') > 100000, 'the read pairs were aligned'),
        ok('genrich', peaks.length === truth.length && truth.every((t) => hits(peaks, t).length === 1), `ATAC mode: exactly one peak in each of the ${truth.length} open regions (${peaks.length} peaks)`),
        ok('genrich', peaks.every((p) => hits(truth, p).length === 1 && p.columns.length === 10), 'no peak outside the open regions, all in narrowPeak format'),
        ok('bedtools-merge', merged.length === truth.length && truth.every((t) => hits(merged, t).length === 1), `the merged peaks are the ${truth.length} open regions`),
        ok('samtools-index', exists(dir, 'atac.sorted.bam.bai'), 'the position-sorted BAM has an index'),
        ok('deeptools-bamcoverage', isBigWig(dir, 'coverage.bw'), 'the signal track is a bigWig file'),
      ];
    },
  },
  'nanopore-signal': {
    files: ['nano_a.pod5', 'nano_b.pod5', 'nano_truth.tsv', 'long_ref.fa'],
    values: { pod5: ['nano_a.pod5', 'nano_b.pod5'], reference: ['long_ref.fa'] },
    // The signal is made up, so its calls are low quality and short: the fastest model, no quality cut, and a small length cut.
    overrides: { dorado: { model: 'fast', min_qscore: 0 }, chopper: { min_quality: 0, min_length: 50 } },
    mayBeEmpty: ['mosdepth'],
    verify: (dir) => {
      const ids = read(dir, 'nano_truth.tsv').split('\n').filter(Boolean).map((l) => l.split('\t')).filter((f) => f[0] !== 'nano_fast5.fast5').map((f) => f[1]).sort();
      const called = fastqRecords(dir, 'reads.fastq.gz');
      const kept = fastqRecords(dir, 'chopped.fastq.gz');
      const summary = read(dir, 'mosdepth/sample.mosdepth.summary.txt');
      const mapped = samRecords(read(dir, 'long_aligned.sam'));
      return [
        ok('pod5-merge', /16 reads/.test(read(dir, 'pod5_inspect.txt')), 'the merged signal file holds the 16 reads of both files'),
        ok('dorado-basecaller', called.length === ids.length && JSON.stringify(called.map((r) => r.name).sort()) === JSON.stringify(ids), 'Dorado called every one of the 16 reads, each once'),
        ok('chopper', kept.length === called.length && kept.every((r) => r.seq.length >= 50), `chopper kept the ${called.length} called reads (${kept.length})`),
        ok('nanoplot', nanoStat(read(dir, 'nanoplot/NanoStats.txt'), 'Number of reads:') === kept.length, 'NanoPlot reports the filtered reads'),
        ok('minimap2-long', mapped.length === kept.length, `minimap2 got every kept read (${mapped.length}); the made-up signal does not map to the genome, so none align (${mapped.filter((r) => (r.flag & 4) === 0).length})`),
        ok('samtools-index', exists(dir, 'sorted.bam') && exists(dir, 'sorted.bam.bai'), 'the sorted BAM has an index'),
        ok('mosdepth', /^total\t0\t0\t0\.00/m.test(summary) && exists(dir, 'mosdepth/sample.regions.bed.gz'), 'mosdepth ran and reported no covered bases, as it must when nothing aligned'),
      ];
    },
  },
  'nanopore-fastq': {
    files: ['long_ont.fastq.gz', 'long_ref.fa'],
    values: { reads: ['long_ont.fastq.gz'], reference: ['long_ref.fa'] },
    verify: (dir) => {
      const raw = fastqRecords(dir, 'long_ont.fastq.gz');
      const kept = fastqRecords(dir, 'chopped.fastq.gz');
      const bases = kept.reduce((n, r) => n + r.seq.length, 0);
      const summary = tableRows(read(dir, 'mosdepth/sample.mosdepth.summary.txt'));
      const chr = summary.find((r) => r.chrom === 'contigL');
      const windows = fs.existsSync(path.join(dir, 'mosdepth/sample.regions.bed.gz'));
      return [
        ok('chopper', kept.length > 0 && kept.length < raw.length && kept.every((r) => r.seq.length >= 500), `chopper dropped the poor and short reads (${kept.length} of ${raw.length} kept)`),
        ok('nanoplot', nanoStat(read(dir, 'nanoplot/NanoStats.txt'), 'Number of reads:') === kept.length, 'NanoPlot reports the filtered reads'),
        ok('minimap2-long', exists(dir, 'sorted.bam.bai'), 'the reads were mapped, sorted and indexed'),
        ok('mosdepth', Boolean(chr) && Number(chr!.mean) > 0.7 * bases / 25000 && Number(chr!.mean) < 1.1 * bases / 25000, `mean depth ${chr?.mean} matches the ${(bases / 25000).toFixed(1)}x the kept reads give`),
        ok('mosdepth', windows, 'the depth in windows was written'),
      ];
    },
  },
  'metagenomics-kraken2-bracken': {
    files: ['meta_A.fa', 'meta_B.fa', 'meta_C.fa', 'meta_names.dmp', 'meta_nodes.dmp', 'meta_reads.fastq.gz', 'meta_truth.tsv'],
    values: { reads: ['meta_reads.fastq.gz'], database: ['bracken_db/'] },
    // The database the person would download is made here from three small genomes.
    prelude: {
      nodes: [
        { key: 'dbbuild', catalog: 'kraken2-build', files: { genomes: 'meta_A.fa, meta_B.fa, meta_C.fa', names: 'meta_names.dmp', nodes: 'meta_nodes.dmp', db: 'kraken2_db/' } },
        { key: 'dbprep', catalog: 'bracken-build', files: { db: 'kraken2_db/', bracken_db: 'bracken_db/' } },
      ],
      edges: [['dbbuild', 'dbprep']],
      before: { dbprep: ['kraken2', 'bracken'] },
    },
    verify: (dir) => {
      const t = Object.fromEntries(read(dir, 'meta_truth.tsv').split('\n').filter(Boolean).map((l) => l.split('\t')).map(([k, n]) => [k, Number(n)]));
      const estimates = Object.fromEntries(tableRows(read(dir, 'bracken_abundance.tsv')).map((r) => [Number(r.taxonomy_id), r]));
      const report = read(dir, 'kraken2_report.tsv');
      const within = (value: number, expected: number) => Math.abs(value - expected) <= expected * 0.05;
      const modules = multiqcModules(dir, 'multiqc');
      return [
        ok('kraken2', /\t201\t/.test(report) && /\t101\t/.test(report) && /\t102\t/.test(report), 'Kraken2 found the three species of the database'),
        ok('bracken', Object.keys(estimates).length === 3, 'Bracken has one line for each of the three species'),
        ok('bracken', within(Number(estimates[101].new_est_reads), t.A) && within(Number(estimates[102].new_est_reads), t.B) && within(Number(estimates[201].new_est_reads), t.C), `the estimates are within 5 percent of the true ${t.A}, ${t.B} and ${t.C} reads (${estimates[101].new_est_reads}, ${estimates[102].new_est_reads}, ${estimates[201].new_est_reads})`),
        ok('bracken', exists(dir, 'bracken_report.tsv'), 'the summary with the Bracken numbers was written'),
        ok('multiqc', ['fastp', 'Kraken'].every((m) => modules.includes(m)), `MultiQC read fastp and Kraken (it read ${modules.join(', ')})`),
      ];
    },
  },
  'assembly-spades-quast': {
    files: ['asm_R1.fastq.gz', 'asm_R2.fastq.gz', 'long_ref.fa'],
    values: { reads1: ['asm_R1.fastq.gz'], reads2: ['asm_R2.fastq.gz'], reference: ['long_ref.fa'] },
    verify: (dir) => {
      const contigs = fastaRecords(dir, 'spades/contigs.fasta');
      const quast = quastTable(read(dir, 'quast/report.tsv'));
      const column = Object.keys(quast['Genome fraction (%)'] ?? {})[0];
      return [
        ok('spades', contigs.length === 1 && contigs[0].seq.length > 24900 && contigs[0].seq.length < 25300, `SPAdes assembled the 25 kb genome into one contig (${contigs.map((c) => c.seq.length).join(', ')})`),
        ok('quast', Number(quast['Genome fraction (%)'][column]) > 99.9 && Number(quast['# misassemblies'][column]) === 0, 'QUAST: the assembly covers the whole reference with no misassembly'),
        ok('quast', Number(quast['# contigs'][column]) === 1 && exists(dir, 'quast/report.html'), 'QUAST counts one contig and wrote its page'),
      ];
    },
  },
  'assembly-flye-quast': {
    files: ['long_ont.fastq.gz', 'long_ref.fa'],
    values: { reads: ['long_ont.fastq.gz'], reference: ['long_ref.fa'] },
    verify: (dir) => {
      const contigs = fastaRecords(dir, 'flye/assembly.fasta');
      const info = tableRows(read(dir, 'flye/assembly_info.txt'));
      const quast = quastTable(read(dir, 'quast/report.tsv'));
      const column = Object.keys(quast['Genome fraction (%)'] ?? {})[0];
      return [
        ok('flye', contigs.length === 1 && contigs[0].seq.length > 24800 && contigs[0].seq.length < 25200, `Flye assembled the 25 kb genome into one contig (${contigs.map((c) => c.seq.length).join(', ')})`),
        ok('flye', info.length === 1 && info[0]['circ.'] === 'Y', 'the contig table says the contig is circular'),
        ok('quast', Number(quast['Genome fraction (%)'][column]) > 99.5 && Number(quast['# misassemblies'][column]) === 0, 'QUAST: the assembly covers the reference with no misassembly'),
      ];
    },
  },
};

function templateChain(id: string): Chain {
  const setup = SETUPS[id];
  const name = `template-${id}`;
  const build = (): BuiltChain => {
    const template = bundledTemplates().find((t) => t.id === id);
    if (!template) throw new Error(`no bundled template ${id}`);
    const made = instantiateTemplate(template, setup.values, { settings: setup.settings });
    if (made.ok === false) throw new Error(made.errors.join('; '));
    // The same switches every chain turns on: a declared output that is not what the tool writes fails the step.
    let nodes = made.nodes.map((n) => {
      const changes = Object.entries(setup.overrides ?? {}).find(([key]) => templateNodeId(key) === n.id)?.[1];
      const tool = findTool(n.data.catalogId)!;
      const data = changes ? { ...n.data, ...applyParamChange(tool, n.data, { params: { ...n.data.catalogParams, ...changes } }) } : n.data;
      return { ...n, data: { ...data, checkExists: true, checkNonEmpty: !(setup.mayBeEmpty ?? []).some((key) => templateNodeId(key) === n.id) } };
    });
    let edges = made.edges;
    const preludeStepIds: Record<string, string> = {};
    if (setup.prelude) {
      // The things the template asks for are made by catalog steps of their own, which come first.
      const labels = nodes.map((n) => n.data.label as string);
      const extra = setup.prelude.nodes.map((spec) => {
        const tool = findTool(spec.catalog!)!;
        const data: Record<string, any> = buildCatalogNodeData(tool, labels);
        const params = { ...defaultParams(tool), ...spec.params };
        data.catalogParams = params;
        data.command = renderCommand(tool, params, tool.threads);
        data.slotFiles = { ...data.slotFiles, ...spec.files };
        data.checkExists = true;
        data.checkNonEmpty = true;
        labels.push(data.label);
        return { id: `pre_${spec.key}`, type: 'custom', position: { x: -300, y: 0 }, data };
      });
      nodes = [...nodes, ...extra];
      const link = (source: string, target: string) => ({ id: `${source}-${target}`, source, target });
      edges = [
        ...edges,
        ...setup.prelude.edges.map(([a, b]) => link(`pre_${a}`, `pre_${b}`)),
        ...Object.entries(setup.prelude.before).flatMap(([pre, steps]) => steps.map((k) => link(`pre_${pre}`, templateNodeId(k)))),
      ];
      for (const spec of setup.prelude.nodes) preludeStepIds[spec.key] = labelToId(extra.find((n) => n.id === `pre_${spec.key}`)!.data.label as string);
    }
    const issues = collectIssues(nodes, {}, edges);
    if (issues.length > 0) throw new Error(issues.map((i) => `${i.nodeLabel}: ${i.message}`).join('; '));
    const problems = validateCatalogNodes(nodes);
    if (problems.length > 0) throw new Error(problems.join('; '));
    const workflow = convertNodesToWorkflow(nodes, edges, {}, { name });
    const errors = validateWorkflow(workflow);
    if (errors.length > 0) throw new Error(errors.join('; '));
    const stepOf: Record<string, string> = {};
    const toolOf: Record<string, string> = {};
    for (const step of template.steps) {
      const node = nodes.find((n) => n.id === templateNodeId(step.key))!;
      const stepId = labelToId(node.data.label);
      stepOf[step.key] = stepId;
      toolOf[stepId] = step.tool;
    }
    for (const spec of setup.prelude?.nodes ?? []) {
      stepOf[spec.key] = preludeStepIds[spec.key];
      toolOf[preludeStepIds[spec.key]] = spec.catalog!;
    }
    return { workflow, stepOf, toolOf };
  };
  return { name, files: setup.files, nodes: [], edges: [], build, verify: setup.verify };
}

defineDomain({
  domain: 'templates',
  // The tools are covered by their own domains; this domain checks the templates built from them.
  covers: [],
  // The Nanopore templates start from the synthetic signal files.
  prepare: ensurePod5Data,
  chains: Object.keys(SETUPS).map(templateChain),
});
