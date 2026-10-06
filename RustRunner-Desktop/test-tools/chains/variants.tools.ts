/**
 * Variants domain: reference indexes, a second aligner, duplicate marking,
 * coverage and alignment QC, three variant callers, VCF tools and snpEff.
 * Every chain is built the way the app builds it (see ../harness.ts) and joins
 * the new tools to each other and to catalog tools from the dna domain by file
 * slots, so the reference folders, derived files and optional files are used
 * the way a person's connections use them.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import { defineDomain, exists, read, sizeOf, truthSnps, type Chain, type Check } from '../harness';

// -----------------------------------------------------------------------------
// Small readers for the files the chains check
// -----------------------------------------------------------------------------

interface VcfRecord {
  contig: string;
  pos: number;
  ref: string;
  alt: string[];
  qual: number;
  info: Record<string, string>;
}

function vcfRecords(text: string): VcfRecord[] {
  return text
    .split('\n')
    .filter((l) => l && !l.startsWith('#'))
    .map((line) => {
      const f = line.split('\t');
      const info: Record<string, string> = {};
      for (const item of (f[7] ?? '').split(';')) {
        const [key, ...rest] = item.split('=');
        info[key] = rest.join('=');
      }
      return { contig: f[0], pos: Number(f[1]), ref: f[3], alt: f[4].split(','), qual: Number(f[5]), info };
    });
}

/** How many of the planted SNPs a VCF reports with the right alternative base. */
function plantedSnpsFound(records: VcfRecord[]): number {
  return truthSnps().filter((s) => records.some((r) => r.contig === s.contig && r.pos === s.pos && r.alt.includes(s.alt))).length;
}

/** The number in `<count> + 0 <what>` of a samtools flagstat report. */
function flagstatCount(report: string, what: string): number {
  const line = report.split('\n').find((l) => l.includes(` ${what}`));
  if (!line) throw new Error(`no "${what}" line in the flagstat report`);
  return Number(line.split(' ')[0]);
}

/** The value of `KEY: number` in a samtools markdup statistics file. */
function markdupStat(report: string, key: string): number {
  const line = report.split('\n').find((l) => l.startsWith(`${key}:`));
  if (!line) throw new Error(`no ${key} in the markdup statistics`);
  return Number(line.split(':')[1].trim());
}

const gunzip = (dir: string, rel: string): string => zlib.gunzipSync(fs.readFileSync(path.join(dir, rel))).toString();

/** True when a file starts with the gzip magic number and has bgzip's extra "BC" field. */
function isBgzip(dir: string, rel: string): boolean {
  const head = fs.readFileSync(path.join(dir, rel)).subarray(0, 14);
  return head[0] === 0x1f && head[1] === 0x8b && head[3] === 4 && head[12] === 0x42 && head[13] === 0x43;
}

const ok = (tool: string, condition: boolean, message: string): Check => ({ tool, ok: condition, message });

/** The genes of data/genes.gtf as `[contig, first base, last base, id]`. */
const GENES: Array<[string, number, number, string]> = [
  ['chr1', 201, 1100, 'geneA'],
  ['chr1', 1601, 2500, 'geneB'],
  ['chr2', 301, 1200, 'geneC'],
];

// -----------------------------------------------------------------------------
// Chains
// -----------------------------------------------------------------------------

const CHAINS: Chain[] = [
  {
    // Both aligners get their index from an index-builder step, not from files
    // sitting next to the FASTA.
    name: 'index-builders',
    files: ['ref.fa', 'dna_se.fastq.gz'],
    nodes: [
      { key: 'bwaidx', catalog: 'bwa-index', files: { ref: 'ref.fa' } },
      { key: 'bwa', catalog: 'bwa-mem', files: { reads1: 'dna_se.fastq.gz' } },
      { key: 'bwaflag', catalog: 'samtools-flagstat', files: { report: 'bwa_flagstat.txt' } },
      { key: 'btidx', catalog: 'bowtie2-build', files: { ref: 'ref.fa' } },
      { key: 'bt', catalog: 'bowtie2', files: { reads: 'dna_se.fastq.gz', sam: 'bt2.sam' } },
      { key: 'btflag', catalog: 'samtools-flagstat', files: { report: 'bt2_flagstat.txt' } },
    ],
    edges: [
      ['bwaidx', 'bwa'],
      ['bwa', 'bwaflag'],
      ['btidx', 'bt'],
      ['bt', 'btflag'],
    ],
    verify: (dir) => {
      const mapped = (file: string) => /mapped \((?:9\d|100)\.\d+%/.test(read(dir, file));
      return [
        ok('bwa-index', ['amb', 'ann', 'bwt', 'pac', 'sa'].every((e) => exists(dir, `bwa_index/reference.fa.${e}`)), 'the five BWA index files are in the folder'),
        ok('bwa-index', exists(dir, 'bwa_index/reference.fa') && read(dir, 'bwa_index/reference.fa') === read(dir, 'ref.fa'), 'the folder holds an exact copy of the FASTA'),
        ok('bwa-mem', mapped('bwa_flagstat.txt'), 'BWA MEM aligned over 90% using the index folder'),
        ok(
          'bowtie2-build',
          ['1', '2', '3', '4', 'rev.1', 'rev.2'].every((n) => exists(dir, `bowtie2_index/reference.fa.${n}.bt2`)),
          'the six Bowtie2 index files are in the folder'
        ),
        ok('bowtie2', mapped('bt2_flagstat.txt'), 'Bowtie2 aligned over 90% using the built index'),
      ];
    },
  },

  {
    // Paired reads through minimap2 on an indexed reference; coverage, a read
    // group and the older bcftools caller on the same indexed copy.
    name: 'minimap2-paired-and-depth',
    files: ['ref.fa', 'dna_R1.fastq.gz', 'dna_R2.fastq.gz'],
    nodes: [
      { key: 'faidx', catalog: 'samtools-faidx', files: { ref: 'ref.fa' } },
      {
        key: 'mm',
        catalog: 'minimap2',
        params: { sample_name: 'patient1' },
        files: { reads1: 'dna_R1.fastq.gz', reads2: 'dna_R2.fastq.gz' },
      },
      { key: 'sort', catalog: 'samtools-sort' },
      { key: 'index', catalog: 'samtools-index' },
      { key: 'depth', catalog: 'samtools-depth', params: { all_positions: true } },
      { key: 'flag', catalog: 'samtools-flagstat' },
      { key: 'call', catalog: 'bcftools-call' },
    ],
    edges: [
      ['faidx', 'mm'],
      ['mm', 'sort'],
      ['sort', 'index'],
      ['sort', 'depth'],
      ['sort', 'flag'],
      ['sort', 'call'],
      ['faidx', 'call'],
    ],
    verify: (dir) => {
      const sam = read(dir, 'aligned.sam');
      const depths = read(dir, 'depth.tsv')
        .split('\n')
        .filter(Boolean)
        .map((l) => Number(l.split('\t')[2]));
      const mean = depths.reduce((a, b) => a + b, 0) / depths.length;
      const genomeLength = 3000 + 2000;
      return [
        ok('samtools-faidx', read(dir, 'indexed_reference/reference.fa.fai').startsWith('chr1\t3000\t'), 'the .fai lists chr1 with its length'),
        ok('minimap2', /@RG\tID:patient1\tSM:patient1/.test(sam), 'the read group carries the sample name'),
        ok(
          'minimap2',
          flagstatCount(read(dir, 'flagstat.txt'), 'properly paired') > 1800 && flagstatCount(read(dir, 'flagstat.txt'), 'in total') === 2000,
          'both read files were aligned as proper pairs'
        ),
        ok('samtools-depth', depths.length === genomeLength, `one line for each of the ${genomeLength} bases (-a), got ${depths.length}`),
        ok('samtools-depth', mean > 25 && mean < 55, `mean depth is about 40x (${mean.toFixed(1)})`),
        ok('bcftools-call', plantedSnpsFound(vcfRecords(read(dir, 'variants.vcf'))) >= 9, 'bcftools call found the planted SNPs on the indexed copy'),
      ];
    },
  },

  {
    // PCR duplicates two ways, then coverage and QC of the deduplicated BAM,
    // merging two samples, and MultiQC reading what the new QC tools wrote.
    name: 'duplicates-coverage-qc',
    files: ['ref.fa', 'dup_R1.fastq.gz', 'dup_R2.fastq.gz', 'dna_R1.fastq.gz', 'dna_R2.fastq.gz'],
    nodes: [
      { key: 'faidx', catalog: 'samtools-faidx', files: { ref: 'ref.fa' } },
      { key: 'mmdup', catalog: 'minimap2', files: { reads1: 'dup_R1.fastq.gz', reads2: 'dup_R2.fastq.gz', sam: 'dup.sam' } },
      { key: 'mmdna', catalog: 'minimap2', files: { reads1: 'dna_R1.fastq.gz', reads2: 'dna_R2.fastq.gz', sam: 'dna.sam' } },
      { key: 'sortdup', catalog: 'samtools-sort', files: { bam: 'dup.sorted.bam' } },
      { key: 'sortdna', catalog: 'samtools-sort', files: { bam: 'dna.sorted.bam' } },
      // samtools: mark, and remove.
      { key: 'mark', catalog: 'samtools-markdup', files: { marked: 'st_marked.bam', stats: 'st_stats.txt' } },
      { key: 'markflag', catalog: 'samtools-flagstat', files: { report: 'st_marked_flagstat.txt' } },
      {
        key: 'remove',
        catalog: 'samtools-markdup',
        params: { remove_duplicates: true, optical_distance: 100 },
        files: { marked: 'st_removed.bam', stats: 'st_removed_stats.txt' },
      },
      { key: 'removeflag', catalog: 'samtools-flagstat', files: { report: 'st_removed_flagstat.txt' } },
      // Picard on the sorted BAM, then what reads the result.
      { key: 'picard', catalog: 'picard-markduplicates' },
      { key: 'pindex', catalog: 'samtools-index', files: { bai: 'marked.bam.bai' } },
      { key: 'mosdepth', catalog: 'mosdepth', params: { window_size: 500 } },
      { key: 'qualimap', catalog: 'qualimap-bamqc', params: { skip_duplicates: true } },
      { key: 'merge', catalog: 'samtools-merge' },
      { key: 'mergeflag', catalog: 'samtools-flagstat', files: { report: 'merged_flagstat.txt' } },
      { key: 'depth2', catalog: 'samtools-depth', files: { depth: 'depth_two_samples.tsv' } },
      { key: 'multiqc', catalog: 'multiqc', files: { reports: 'qualimap/, mosdepth/, duplication_metrics.txt' } },
    ],
    edges: [
      ['faidx', 'mmdup'],
      ['faidx', 'mmdna'],
      ['mmdup', 'sortdup'],
      ['mmdna', 'sortdna'],
      ['mmdup', 'mark'],
      ['mark', 'markflag'],
      ['mmdup', 'remove'],
      ['remove', 'removeflag'],
      ['sortdup', 'picard'],
      ['picard', 'pindex'],
      ['picard', 'mosdepth'],
      ['pindex', 'mosdepth'],
      ['picard', 'qualimap'],
      ['sortdna', 'merge'],
      ['sortdup', 'merge'],
      ['merge', 'mergeflag'],
      ['sortdna', 'depth2'],
      ['sortdup', 'depth2'],
      ['picard', 'multiqc', 'after'],
      ['mosdepth', 'multiqc', 'after'],
      ['qualimap', 'multiqc', 'after'],
    ],
    // Picard's two outputs both fit the next step's BAM slots; the person's answer is the BAM.
    bindings: {
      'picard>pindex': [{ slot: 'bam', output: 'marked' }],
      'picard>mosdepth': [{ slot: 'bam', output: 'marked' }],
      'picard>qualimap': [{ slot: 'bam', output: 'marked' }],
    },
    verify: (dir) => {
      const metrics = read(dir, 'duplication_metrics.txt').split('\n');
      const header = metrics.findIndex((l) => l.startsWith('LIBRARY'));
      const cols = metrics[header].split('\t');
      const row = metrics[header + 1].split('\t');
      const metric = (name: string) => row[cols.indexOf(name)];
      const summary = read(dir, 'mosdepth/sample.mosdepth.summary.txt');
      const chr1Mean = Number(summary.split('\n').find((l) => l.startsWith('chr1\t'))!.split('\t')[3]);
      const windows = gunzip(dir, 'mosdepth/sample.regions.bed.gz').split('\n').filter(Boolean);
      const results = read(dir, 'qualimap/genome_results.txt');
      // Qualimap leaves the 400 flagged reads out of the bases and the depth, not out of the read count.
      const qualimapBases = Number(/number of mapped bases = ([\d,]+) bp/.exec(results)?.[1].replace(/,/g, ''));
      const qualimapDepth = Number(/mean coverageData = ([\d.]+)X/.exec(results)?.[1]);
      const stStats = read(dir, 'st_stats.txt');
      const twoSamples = read(dir, 'depth_two_samples.tsv').split('\n').filter(Boolean);
      const report = read(dir, 'multiqc/multiqc_report.html');
      return [
        // 800 pairs of which 200 are exact copies: 400 reads are duplicates.
        ok('samtools-markdup', markdupStat(stStats, 'DUPLICATE TOTAL') === 400, `samtools found 400 duplicate reads (${markdupStat(stStats, 'DUPLICATE TOTAL')})`),
        ok('samtools-flagstat', flagstatCount(read(dir, 'st_marked_flagstat.txt'), 'duplicates') === 400 && flagstatCount(read(dir, 'st_marked_flagstat.txt'), 'in total') === 1600, 'the marked BAM keeps 1600 reads and flags 400'),
        ok('samtools-markdup', flagstatCount(read(dir, 'st_removed_flagstat.txt'), 'in total') === 1200, 'removing duplicates leaves 1200 reads'),
        ok('picard-markduplicates', Number(metric('READ_PAIR_DUPLICATES')) === 200 && Number(metric('READ_PAIRS_EXAMINED')) === 800, 'Picard found 200 duplicate pairs among 800'),
        ok('picard-markduplicates', /^0\.25/.test(metric('PERCENT_DUPLICATION')), `the report uses a decimal point (${metric('PERCENT_DUPLICATION')})`),
        ok('mosdepth', chr1Mean > 20 && chr1Mean < 50, `chr1 mean depth is about 32x (${chr1Mean})`),
        ok('mosdepth', windows.length === 6 + 4, `10 windows of 500 bases (${windows.length})`),
        ok('qualimap-bamqc', qualimapBases === 120000, `Qualimap skipped the duplicates: 1200 reads of 100 bases counted (${qualimapBases})`),
        ok('qualimap-bamqc', qualimapDepth === 24, `mean depth without the duplicates is 24x, not 32x (${qualimapDepth})`),
        ok('qualimap-bamqc', sizeOf(dir, 'qualimap/qualimapReport.html') > 1000, 'the HTML report was written'),
        ok('samtools-merge', flagstatCount(read(dir, 'merged_flagstat.txt'), 'in total') === 1600 + 2000, 'the merged BAM holds both samples'),
        ok('samtools-depth', twoSamples.every((l) => l.split('\t').length === 4), 'one depth column for each BAM'),
        ok('multiqc', /Qualimap/i.test(report) && /mosdepth/i.test(report) && /Picard/i.test(report), 'MultiQC shows Qualimap, mosdepth and Picard'),
      ];
    },
  },

  {
    // Three callers on the same alignments, then the VCF tools on the result.
    name: 'variant-callers-and-vcf-tools',
    files: ['ref.fa', 'dna_R1.fastq.gz', 'dna_R2.fastq.gz', 'unnormalized.vcf'],
    nodes: [
      { key: 'faidx', catalog: 'samtools-faidx', files: { ref: 'ref.fa' } },
      { key: 'dict', catalog: 'gatk-createsequencedictionary' },
      { key: 'mm', catalog: 'minimap2', files: { reads1: 'dna_R1.fastq.gz', reads2: 'dna_R2.fastq.gz' } },
      { key: 'sort', catalog: 'samtools-sort' },
      { key: 'index', catalog: 'samtools-index' },
      { key: 'fb', catalog: 'freebayes' },
      { key: 'hc', catalog: 'gatk-haplotypecaller' },
      { key: 'filter', catalog: 'bcftools-filter', params: { min_qual: 1500, min_depth: 30 }, files: { filtered: 'filtered.vcf' } },
      { key: 'marked', catalog: 'bcftools-filter', params: { min_qual: 1500, min_depth: 30, mark_only: true }, files: { filtered: 'marked.vcf' } },
      { key: 'norm', catalog: 'bcftools-norm' },
      { key: 'stats', catalog: 'bcftools-stats' },
      { key: 'bgzip', catalog: 'bgzip' },
      { key: 'tabix', catalog: 'tabix' },
      { key: 'norm2', catalog: 'bcftools-norm', files: { vcf: 'unnormalized.vcf', normalized: 'normalized_sites.vcf' } },
    ],
    edges: [
      ['faidx', 'dict'],
      ['faidx', 'mm'],
      ['mm', 'sort'],
      ['sort', 'index'],
      ['faidx', 'fb'],
      ['sort', 'fb'],
      ['dict', 'hc'],
      ['sort', 'hc'],
      ['index', 'hc'],
      ['fb', 'filter'],
      ['fb', 'marked'],
      ['fb', 'norm'],
      ['faidx', 'norm'],
      ['norm', 'stats'],
      ['norm', 'bgzip'],
      ['bgzip', 'tabix'],
      ['faidx', 'norm2'],
    ],
    verify: (dir) => {
      const total = truthSnps().length;
      const fb = vcfRecords(read(dir, 'freebayes.vcf'));
      const hc = vcfRecords(read(dir, 'haplotypecaller.vcf'));
      const kept = vcfRecords(read(dir, 'filtered.vcf'));
      const marked = vcfRecords(read(dir, 'marked.vcf'));
      const passes = (r: VcfRecord) => r.qual >= 1500 && Number(r.info.DP) >= 30;
      const normalized = read(dir, 'normalized.vcf');
      const stats = read(dir, 'variant_stats.txt');
      const statsSnps = Number(/number of SNPs:\t(\d+)/.exec(stats)?.[1]);
      const sites = vcfRecords(read(dir, 'normalized_sites.vcf'));
      const fbSites = new Set(fb.map((r) => `${r.contig}:${r.pos}`));
      const both = hc.filter((r) => fbSites.has(`${r.contig}:${r.pos}`)).length;
      return [
        ok('gatk-createsequencedictionary', /^@SQ\tSN:chr1\tLN:3000/m.test(read(dir, 'gatk_reference/reference.dict')), 'the dictionary lists chr1'),
        ok('gatk-createsequencedictionary', exists(dir, 'gatk_reference/reference.fa.fai'), 'the .fai travelled into the GATK folder'),
        ok('freebayes', plantedSnpsFound(fb) >= Math.ceil(total * 0.75), `${plantedSnpsFound(fb)}/${total} planted SNPs called by FreeBayes`),
        ok('gatk-haplotypecaller', plantedSnpsFound(hc) >= Math.ceil(total * 0.75), `${plantedSnpsFound(hc)}/${total} planted SNPs called by HaplotypeCaller`),
        ok('gatk-haplotypecaller', both >= Math.ceil(total * 0.75), `the two callers agree on ${both} sites`),
        // The cut-off must really split the calls, or the check proves nothing.
        ok('bcftools-filter', fb.some((r) => !passes(r)) && fb.some(passes), 'the cut-off splits the calls into some that pass and some that fail'),
        ok('bcftools-filter', kept.length === fb.filter(passes).length, `kept exactly the ${fb.filter(passes).length} calls above the cut-off (${kept.length})`),
        ok(
          'bcftools-filter',
          marked.length === fb.length && marked.filter((r) => r.contig).length === fb.length && read(dir, 'marked.vcf').split('\n').filter((l) => /\tLowQuality\t/.test(l)).length === fb.filter((r) => !passes(r)).length,
          'marking keeps every call and labels exactly the failing ones LowQuality'
        ),
        ok('bcftools-norm', vcfRecords(normalized).length === fb.length, 'normalizing single-base calls keeps every record'),
        ok('bcftools-stats', statsSnps === vcfRecords(normalized).length, `bcftools stats counts ${statsSnps} SNPs, as many as the file has`),
        ok('bgzip', isBgzip(dir, 'variants.vcf.gz'), 'the file is block-compressed (BGZF)'),
        ok('bgzip', gunzip(dir, 'variants.vcf.gz') === normalized, 'decompressing gives back the normalized VCF'),
        ok('tabix', gunzip(dir, 'tabix/indexed.gz.tbi').startsWith('TBI\u0001'), 'the .tbi file is a tabix index'),
        ok('tabix', gunzip(dir, 'tabix/indexed.gz') === normalized, 'the indexed copy has the same content'),
        // The multi-allelic site becomes two lines; the deletion moves one base to the left.
        ok('bcftools-norm', sites.length === 4, `the unnormalized file has 4 records after splitting (${sites.length})`),
        ok(
          'bcftools-norm',
          (() => {
            const before = vcfRecords(read(dir, 'unnormalized.vcf')).find((r) => r.ref.length === 2)!;
            const after = sites.find((r) => r.contig === before.contig && r.ref.length === 2);
            return !!after && after.pos === before.pos - 1;
          })(),
          'the right-aligned deletion was left-aligned (position moved one base left)'
        ),
      ];
    },
  },

  {
    // A database for the synthetic genome, then variant effects.
    name: 'snpeff-annotation',
    files: ['ref.fa', 'genes.gtf', 'dna_R1.fastq.gz', 'dna_R2.fastq.gz'],
    nodes: [
      { key: 'faidx', catalog: 'samtools-faidx', files: { ref: 'ref.fa' } },
      { key: 'mm', catalog: 'minimap2', files: { reads1: 'dna_R1.fastq.gz', reads2: 'dna_R2.fastq.gz' } },
      { key: 'sort', catalog: 'samtools-sort' },
      { key: 'fb', catalog: 'freebayes' },
      { key: 'build', catalog: 'snpeff-build', params: { genome_name: 'synthetic' }, files: { genome: 'ref.fa', annotation: 'genes.gtf' } },
      { key: 'ann', catalog: 'snpeff-annotate', params: { genome_name: 'synthetic' } },
    ],
    edges: [
      ['faidx', 'mm'],
      ['mm', 'sort'],
      ['faidx', 'fb'],
      ['sort', 'fb'],
      ['fb', 'ann'],
      ['build', 'ann'],
    ],
    verify: (dir) => {
      const annotated = read(dir, 'annotated.vcf');
      const records = vcfRecords(annotated);
      const effects = (r: VcfRecord) => (r.info.ANN ?? '').split(',').map((a) => a.split('|'));
      const inGene = (r: VcfRecord) => GENES.find(([contig, from, to]) => contig === r.contig && r.pos >= from && r.pos <= to);
      const genic = records.filter(inGene);
      const intergenic = records.filter((r) => !inGene(r));
      const summary = read(dir, 'snpeff_summary.html');
      return [
        ok('snpeff-build', exists(dir, 'snpeff_db/synthetic/snpEffectPredictor.bin'), 'the database was built into the folder'),
        ok('snpeff-annotate', records.length >= 9 && records.every((r) => r.info.ANN !== undefined), 'every variant carries an ANN field'),
        ok(
          'snpeff-annotate',
          genic.length > 0 && genic.every((r) => effects(r).some((e) => e[4] === inGene(r)![3] && !/gene_variant|intergenic/.test(e[1]))),
          `${genic.length} variants inside genes are annotated with their own gene`
        ),
        ok(
          'snpeff-annotate',
          intergenic.length > 0 && intergenic.every((r) => !effects(r).some((e) => /missense|synonymous|intron|exon/.test(e[1]))),
          `${intergenic.length} variants outside genes get no coding or intron effect`
        ),
        ok('snpeff-annotate', genic.some((r) => effects(r).some((e) => /missense_variant|synonymous_variant/.test(e[1]))), 'a variant inside an exon is called missense or synonymous'),
        ok('snpeff-annotate', /snpEff/i.test(summary) && sizeOf(dir, 'snpeff_stats.csv') > 100, 'the summary page and the CSV counts were written'),
      ];
    },
  },
];

defineDomain({
  domain: 'variants',
  covers: [
    'bwa-index',
    'bowtie2-build',
    'minimap2',
    'samtools-faidx',
    'samtools-merge',
    'samtools-markdup',
    'samtools-depth',
    'picard-markduplicates',
    'mosdepth',
    'qualimap-bamqc',
    'freebayes',
    'bcftools-filter',
    'bcftools-norm',
    'bcftools-stats',
    'gatk-haplotypecaller',
    'gatk-createsequencedictionary',
    'bgzip',
    'tabix',
    'snpeff-build',
    'snpeff-annotate',
  ],
  chains: CHAINS,
});
