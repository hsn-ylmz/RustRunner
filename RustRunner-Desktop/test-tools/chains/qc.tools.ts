/**
 * QC domain: read trimming reports and the combined report. Each chain is
 * built the way the app builds it (see ../harness.ts). MultiQC takes files
 * from several steps, so these chains also exercise a slot that follows more
 * than one connection.
 */
import { defineDomain, exists, read, type Chain } from '../harness';

const CHAINS: Chain[] = [
  {
    name: 'trim-and-qc',
    files: ['dna_se.fastq.gz'],
    nodes: [
      { key: 'cut', catalog: 'cutadapt', files: { reads: 'dna_se.fastq.gz', trimmed: 'cut.fastq.gz' } },
      { key: 'fqc', catalog: 'fastqc' },
      { key: 'mqc', catalog: 'multiqc' },
    ],
    edges: [
      ['cut', 'fqc'],
      // FastQC's report folder is the only thing it makes: it binds without a question.
      ['fqc', 'mqc'],
      // Cutadapt makes reads and a report: MultiQC is answered with the report.
      ['cut', 'mqc'],
    ],
    bindings: { 'cut>mqc': [{ slot: 'reports', output: 'report' }] },
    verify: (dir) => [
      { tool: 'cutadapt', ok: exists(dir, 'cut.fastq.gz'), message: 'trimmed reads written' },
      { tool: 'cutadapt', ok: read(dir, 'cutadapt.txt').includes('Total reads processed'), message: 'trimming report written' },
      { tool: 'fastqc', ok: exists(dir, 'qc/cut_fastqc.zip'), message: 'FastQC zip written' },
      {
        tool: 'multiqc',
        ok: read(dir, 'multiqc/multiqc_report.html').includes('FastQC'),
        message: 'report mentions FastQC',
      },
      {
        tool: 'multiqc',
        ok: read(dir, 'multiqc/multiqc_report.html').includes('Cutadapt'),
        message: 'report mentions Cutadapt (a second step feeding the same slot)',
      },
    ],
  },
  {
    name: 'fastp-and-alignment-qc',
    files: ['ref.fa', 'dna_se.fastq.gz'],
    nodes: [
      { key: 'fastp', catalog: 'fastp', files: { reads: 'dna_se.fastq.gz' } },
      {
        key: 'idx',
        raw: {
          label: 'Bowtie2 build',
          tool: 'bowtie2',
          command: 'bowtie2-build {input} ref_bt2',
          input: 'ref.fa',
          output: 'ref_bt2.1.bt2',
        },
      },
      { key: 'align', catalog: 'bowtie2', files: { index: 'ref_bt2' } },
      { key: 'flagstat', catalog: 'samtools-flagstat' },
      { key: 'mqc', catalog: 'multiqc', files: { report_dir: 'qc_all/' } },
    ],
    edges: [
      ['fastp', 'align'],
      ['idx', 'align', 'after'],
      ['align', 'flagstat'],
      ['fastp', 'mqc'],
      ['flagstat', 'mqc'],
    ],
    // fastp makes reads and two reports; MultiQC is answered with the JSON one.
    bindings: { 'fastp>mqc': [{ slot: 'reports', output: 'json_report' }] },
    verify: (dir) => {
      const html = read(dir, 'qc_all/multiqc_report.html');
      return [
        { tool: 'fastp', ok: html.includes('fastp'), message: 'report mentions fastp' },
        { tool: 'samtools-flagstat', ok: html.includes('Samtools'), message: 'report mentions Samtools' },
        { tool: 'multiqc', ok: exists(dir, 'qc_all/multiqc_report.html'), message: 'combined report is in the chosen folder' },
      ];
    },
  },
];

defineDomain({
  domain: 'qc',
  covers: ['fastqc', 'multiqc', 'fastp', 'cutadapt'],
  chains: CHAINS,
});
