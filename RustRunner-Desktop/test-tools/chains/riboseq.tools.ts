/**
 * Ribo-seq domain: the PhD pipeline on real public human footprint reads
 * (HEK293T, Diagenode D-Plex library, GSE158374 / SRR12693498; see
 * riboseq-test/DATA.md for the layout and for how the data is made).
 *
 *   FastQC, cutadapt (poly(A) tail + Illumina adapter), FastQC,
 *   UMI-tools extract (12 nt UMI + 4 nt template-switch motif), FastQC,
 *   bowtie2 removal of rRNA, tRNA and ncRNA, FastQC,
 *   STAR to transcript coordinates, samtools view / sort / index,
 *   UMI-tools dedup, riboWaltz report, MultiQC over everything.
 *
 * Built step by step from catalog tools (see ../harness.ts) and run through the
 * real engine against the real tools. The same pipeline made from the bundled
 * template is run by `chains/templates.tools.ts`; both are held to the checks of
 * `../riboseq/shared.ts`. The data comes from `riboseq-test/data` (run
 * `riboseq-test/prepare_data.sh` once); this domain links it into the sandbox's data folder.
 *
 * Two chains:
 *  - `riboseq-pipeline-tiny` on the 200 000-read subsample: every step runs for
 *    real and its result is checked against the step before. The tiny set has
 *    too few reads over start codons for riboWaltz to estimate offsets, so the
 *    chain also checks that the report says so instead of inventing numbers.
 *  - `riboseq-pipeline-full` on the first 5 million reads, run when
 *    RIBOSEQ_FULL=1: riboWaltz then finds the offsets the paper's library should
 *    give (12 to 13 nt for the dominant lengths), CDS enrichment and 3-nt periodicity.
 */
import { defineDomain, type Chain } from '../harness';
import { DPLEX_ADAPTER, MIN_TRIMMED, SPACER_LENGTH, UMI_LENGTH, linkRiboData, verifyRiboseq } from '../riboseq/shared';

// -----------------------------------------------------------------------------
// The chain
// -----------------------------------------------------------------------------

function pipeline(name: string, reads: string, full: boolean): Chain {
  const files = [reads, 'ribo_genome.fa', 'ribo_genes.gtf', 'ribo_rRNA.fa', 'ribo_tRNA.fa', 'ribo_ncRNA.fa'];
  return {
    name,
    files,
    requiresEnv: full ? 'RIBOSEQ_FULL' : undefined,
    nodes: [
      { key: 'fqc_raw', catalog: 'fastqc', files: { reads, report_dir: 'qc_raw/' } },
      {
        key: 'cut',
        catalog: 'cutadapt',
        params: { adapter: DPLEX_ADAPTER, error_rate: 0.1, min_overlap: 10, min_length: MIN_TRIMMED, quality_cutoff: 20 },
        files: { reads, trimmed: 'trimmed.fastq.gz', report: 'cutadapt.txt' },
      },
      { key: 'fqc_trim', catalog: 'fastqc', files: { report_dir: 'qc_trimmed/' } },
      {
        key: 'umi',
        catalog: 'umi-tools-extract',
        params: { umi_end: '5prime', umi_length: UMI_LENGTH, spacer_length: SPACER_LENGTH },
        files: { extracted: 'umi_extracted.fastq.gz', log: 'umi_extract.log' },
      },
      { key: 'fqc_umi', catalog: 'fastqc', files: { report_dir: 'qc_umi/' } },

      { key: 'idx_rrna', catalog: 'bowtie2-build', files: { ref: 'ribo_rRNA.fa', index_dir: 'idx_rrna/' } },
      { key: 'idx_trna', catalog: 'bowtie2-build', files: { ref: 'ribo_tRNA.fa', index_dir: 'idx_trna/' } },
      { key: 'idx_ncrna', catalog: 'bowtie2-build', files: { ref: 'ribo_ncRNA.fa', index_dir: 'idx_ncrna/' } },
      { key: 'rm_rrna', catalog: 'bowtie2-remove-reads', files: { unaligned: 'no_rRNA.fastq.gz', log: 'rrna_removal.log' } },
      { key: 'rm_trna', catalog: 'bowtie2-remove-reads', files: { unaligned: 'no_tRNA.fastq.gz', log: 'trna_removal.log' } },
      { key: 'rm_ncrna', catalog: 'bowtie2-remove-reads', files: { unaligned: 'no_ncRNA.fastq.gz', log: 'ncrna_removal.log' } },
      { key: 'fqc_clean', catalog: 'fastqc', files: { report_dir: 'qc_clean/' } },

      {
        key: 'star_idx',
        catalog: 'star-genomegenerate',
        params: { sjdb_overhang: 100, sa_index_nbases: 14 },
        files: { genome: 'ribo_genome.fa', annotation: 'ribo_genes.gtf', index_dir: 'star_index/' },
      },
      { key: 'star', catalog: 'star-riboseq', files: { out_dir: 'star_riboseq/' } },
      { key: 'view', catalog: 'samtools-view', params: { forward_only: true }, files: { filtered: 'mapped.bam' } },
      { key: 'sort', catalog: 'samtools-sort', files: { bam: 'sorted.bam' } },
      { key: 'index', catalog: 'samtools-index', files: { bai: 'sorted.bam.bai' } },
      {
        key: 'dedup',
        catalog: 'umi-tools-dedup',
        files: { deduplicated: 'deduplicated.bam', log: 'umi_dedup.log', stats_dir: 'umi_stats/' },
      },
      {
        key: 'ribo',
        catalog: 'ribowaltz-report',
        // The catalog default: riboWaltz's offsets as they are (the template chain runs the frame adjustment).
        params: { min_length: 28, max_length: 34, offset_refine: 'none' },
        files: { annotation: 'ribo_genes.gtf', genome: 'ribo_genome.fa', report_dir: 'ribowaltz/' },
      },
      { key: 'mqc', catalog: 'multiqc', files: { report_dir: 'multiqc/' } },
    ],
    edges: [
      ['cut', 'fqc_trim'],
      ['cut', 'umi'],
      ['umi', 'fqc_umi'],
      ['umi', 'rm_rrna'],
      ['idx_rrna', 'rm_rrna'],
      ['rm_rrna', 'rm_trna'],
      ['idx_trna', 'rm_trna'],
      ['rm_trna', 'rm_ncrna'],
      ['idx_ncrna', 'rm_ncrna'],
      ['rm_ncrna', 'fqc_clean'],
      ['star_idx', 'star'],
      ['rm_ncrna', 'star'],
      ['star', 'view'],
      ['view', 'sort'],
      ['sort', 'index'],
      ['sort', 'dedup'],
      ['index', 'dedup'],
      ['dedup', 'ribo'],
      // MultiQC reads every QC file and log.
      ['fqc_raw', 'mqc'],
      ['cut', 'mqc'],
      ['fqc_trim', 'mqc'],
      ['umi', 'mqc'],
      ['fqc_umi', 'mqc'],
      ['rm_rrna', 'mqc'],
      ['rm_trna', 'mqc'],
      ['rm_ncrna', 'mqc'],
      ['fqc_clean', 'mqc'],
      ['star', 'mqc'],
      ['dedup', 'mqc'],
    ],
    // Steps that make a file and a log are asked which one MultiQC should read.
    bindings: {
      'cut>mqc': [{ slot: 'reports', output: 'report' }],
      'umi>mqc': [{ slot: 'reports', output: 'log' }],
      'rm_rrna>mqc': [{ slot: 'reports', output: 'log' }],
      'rm_trna>mqc': [{ slot: 'reports', output: 'log' }],
      'rm_ncrna>mqc': [{ slot: 'reports', output: 'log' }],
      'star>mqc': [{ slot: 'reports', output: 'log' }],
      'dedup>mqc': [{ slot: 'reports', output: 'log' }],
    },
    verify: (dir) => verifyRiboseq(dir, full, { refine: false }),
  };
}

defineDomain({
  domain: 'riboseq',
  prepare: () => linkRiboData(true),
  covers: [
    'umi-tools-extract',
    'umi-tools-dedup',
    'bowtie2-remove-reads',
    'star-riboseq',
    'ribowaltz-report',
    'cutadapt',
    'samtools-view',
  ],
  chains: [
    pipeline('riboseq-pipeline-tiny', 'ribo_tiny.fastq.gz', false),
    pipeline('riboseq-pipeline-full', 'ribo_full.fastq.gz', true),
  ],
});
