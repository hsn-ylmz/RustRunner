/**
 * DNA domain: trimming, short-read alignment, BAM processing and variant
 * calling. Each chain is built the way the app builds it (see ../harness.ts).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import { DATA, countsPerGene, defineDomain, read, sizeOf, truthSnps, type Chain } from '../harness';

/** Alignments in a SAM text that are marked as one mate of a pair. */
function pairedAlignments(sam: string): number {
  return sam
    .split('\n')
    .filter((l) => l && !l.startsWith('@'))
    .filter((l) => {
      const flag = Number(l.split('\t')[1]);
      return (flag & 1) === 1 && (flag & (64 | 128)) !== 0;
    }).length;
}

const bwaIndex = { label: 'BWA index', tool: 'bwa', command: 'bwa index {input}', input: 'ref.fa', output: 'ref.fa.bwt' };
const faidx = {
  label: 'Reference index',
  tool: 'samtools',
  command: 'samtools faidx {input}',
  input: 'ref.fa',
  output: 'ref.fa.fai',
};
const bowtieBuild = {
  label: 'Bowtie2 build',
  tool: 'bowtie2',
  command: 'bowtie2-build {input} ref_bt2',
  input: 'ref.fa',
  output: 'ref_bt2.1.bt2',
};

const CHAINS: Chain[] = [
  {
    name: 'dna-single-end',
    files: ['ref.fa', 'dna_se.fastq.gz'],
    nodes: [
      { key: 'fastp', catalog: 'fastp', files: { reads: 'dna_se.fastq.gz' } },
      { key: 'bwaidx', raw: bwaIndex },
      { key: 'bwa', catalog: 'bwa-mem', files: { ref: 'ref.fa' } },
      { key: 'sort', catalog: 'samtools-sort' },
      { key: 'index', catalog: 'samtools-index' },
      { key: 'faidx', raw: faidx },
      { key: 'call', catalog: 'bcftools-call', files: { ref: 'ref.fa' } },
      { key: 'view', catalog: 'samtools-view' },
      { key: 'flagstat', catalog: 'samtools-flagstat' },
    ],
    edges: [
      // fastp's trimmed reads fill the first read file; bwa's SAM, sort's BAM and so on bind by type.
      ['fastp', 'bwa'],
      ['bwaidx', 'bwa', 'after'],
      ['bwa', 'sort'],
      ['sort', 'index'],
      ['sort', 'call'],
      ['index', 'call', 'after'],
      ['faidx', 'call', 'after'],
      ['sort', 'view'],
      ['sort', 'flagstat'],
    ],
    verify: (dir) => {
      const sam = read(dir, 'aligned.sam');
      const calls = read(dir, 'variants.vcf')
        .split('\n')
        .filter((l) => l && !l.startsWith('#'))
        .map((l) => l.split('\t'));
      const found = truthSnps().filter((s) =>
        calls.some((c) => c[0] === s.contig && Number(c[1]) === s.pos && c[4].split(',').includes(s.alt))
      );
      const total = truthSnps().length;
      return [
        { tool: 'bwa-mem', ok: sam.includes('@SQ') && /\n[^@]/.test(sam), message: 'SAM has header and alignments' },
        {
          tool: 'bcftools-call',
          ok: found.length >= Math.ceil(total * 0.75),
          message: `${found.length}/${total} planted SNPs called`,
        },
        { tool: 'samtools-flagstat', ok: /mapped \((?:9\d|100)\.\d+%/.test(read(dir, 'flagstat.txt')), message: 'over 90% mapped' },
        { tool: 'samtools-view', ok: sizeOf(dir, 'filtered.bam') > 1000, message: 'filtered BAM not tiny' },
        { tool: 'samtools-index', ok: sizeOf(dir, 'sorted.bam.bai') > 0, message: 'BAM index written' },
      ];
    },
  },
  {
    name: 'dna-paired-end-featurecounts',
    files: ['ref.fa', 'genes.gtf', 'dna_R1.fastq.gz', 'dna_R2.fastq.gz'],
    nodes: [
      { key: 'bwaidx', raw: bwaIndex },
      // Both read files of the pair: the optional second slot is filled.
      {
        key: 'bwa',
        catalog: 'bwa-mem',
        files: { ref: 'ref.fa', reads1: 'dna_R1.fastq.gz', reads2: 'dna_R2.fastq.gz' },
      },
      { key: 'sort', catalog: 'samtools-sort' },
      { key: 'fc', catalog: 'featurecounts', params: { paired: true }, files: { annotation: 'genes.gtf' } },
    ],
    edges: [
      ['bwaidx', 'bwa', 'after'],
      ['bwa', 'sort'],
      ['sort', 'fc'],
    ],
    verify: (dir) => {
      const counts = countsPerGene(read(dir, 'counts.tsv'));
      const pairs = zlib.gunzipSync(fs.readFileSync(path.join(DATA, 'dna_R1.fastq.gz'))).toString().split('\n').length / 4;
      const assigned = counts.reduce((a, b) => a + b, 0);
      return [
        { tool: 'featurecounts', ok: counts.every((n) => n > 0), message: 'every gene has reads' },
        // Counting single reads instead of pairs (-p without --countReadPairs) would exceed the pair count.
        { tool: 'featurecounts', ok: assigned <= pairs, message: `counted pairs, not reads (${assigned} <= ${pairs})` },
        {
          tool: 'bwa-mem',
          ok: pairedAlignments(read(dir, 'aligned.sam')) > pairs / 2,
          message: 'both read files were aligned as pairs',
        },
      ];
    },
  },
  {
    name: 'bowtie2',
    files: ['ref.fa', 'dna_se.fastq.gz'],
    nodes: [
      { key: 'idx', raw: bowtieBuild },
      { key: 'align', catalog: 'bowtie2', files: { index: 'ref_bt2', reads: 'dna_se.fastq.gz' } },
      { key: 'flagstat', catalog: 'samtools-flagstat' },
    ],
    edges: [
      ['idx', 'align', 'after'],
      ['align', 'flagstat'],
    ],
    verify: (dir) => [
      { tool: 'bowtie2', ok: /mapped \((?:9\d|100)\.\d+%/.test(read(dir, 'flagstat.txt')), message: 'over 90% mapped' },
    ],
  },
  {
    name: 'dna-parameter-variants',
    files: ['ref.fa', 'dna_se.fastq.gz'],
    nodes: [
      { key: 'bt2idx', raw: bowtieBuild },
      ...['very-fast', 'fast', 'very-sensitive'].map((preset) => ({
        key: `bt2_${preset}`,
        catalog: 'bowtie2',
        params: { preset },
        files: { index: 'ref_bt2', reads: 'dna_se.fastq.gz', sam: `bt2_${preset}.sam` },
      })),
      { key: 'bwaidx', raw: bwaIndex },
      {
        key: 'bwa',
        catalog: 'bwa-mem',
        params: { mark_secondary: false, min_seed_length: 25 },
        files: { ref: 'ref.fa', reads1: 'dna_se.fastq.gz', sam: 'bwa_plain.sam' },
      },
      { key: 'byname', catalog: 'samtools-sort', params: { by_name: true, memory_per_thread: '256M' }, files: { bam: 'byname.bam' } },
      {
        key: 'all',
        catalog: 'samtools-view',
        params: { mapped_only: false, min_mapq: 0 },
        files: { filtered: 'all.bam' },
      },
    ],
    edges: [
      ['bt2idx', 'bt2_very-fast', 'after'],
      ['bt2idx', 'bt2_fast', 'after'],
      ['bt2idx', 'bt2_very-sensitive', 'after'],
      ['bwaidx', 'bwa', 'after'],
      ['bwa', 'byname'],
      ['byname', 'all'],
    ],
    verify: (dir) => [
      { tool: 'samtools-view', ok: sizeOf(dir, 'all.bam') > 1000, message: 'unfiltered BAM not tiny' },
      { tool: 'bowtie2', ok: sizeOf(dir, 'bt2_very-fast.sam') > 1000, message: 'preset runs wrote alignments' },
    ],
  },
];

defineDomain({
  domain: 'dna',
  covers: [
    'fastp',
    'bwa-mem',
    'bowtie2',
    'samtools-sort',
    'samtools-index',
    'samtools-view',
    'samtools-flagstat',
    'bcftools-call',
    'featurecounts',
  ],
  chains: CHAINS,
});
