/**
 * RNA domain: index builders, spliced alignment, assembly, quantification and
 * RNA-seq QC. Each chain is built the way the app builds it (see ../harness.ts)
 * and runs the real tools on the small synthetic RNA data of make_data.py:
 * three two-exon genes (txA, txB, txC) with known abundance, `rna_se` (single-end,
 * unstranded) and `rna_R1/R2` (2000 paired, dUTP-stranded reads, see
 * `rna_truth.tsv` for the pairs drawn from each transcript).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { DATA, countsPerGene, defineDomain, exists, read, sizeOf, type Chain } from '../harness';

// -----------------------------------------------------------------------------
// Reading results
// -----------------------------------------------------------------------------

const TRUTH_IDS = ['txA', 'txB', 'txC'];

/** Pairs drawn from each transcript, as written by make_data.py. */
function truthCounts(): Record<string, number> {
  return Object.fromEntries(
    fs
      .readFileSync(path.join(DATA, 'rna_truth.tsv'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => {
        const [id, n] = line.split('\t');
        return [id, Number(n)];
      })
  );
}

/** The planted abundance of the three transcripts as shares of their total. */
const plantedShares = (): number[] => shares(TRUTH_IDS.map((id) => truthCounts()[id]));

/** Rows of a tab-separated table with a header line, as objects. */
function table(text: string): Array<Record<string, string>> {
  const [head, ...rows] = text.trim().split('\n');
  const names = head.split('\t');
  return rows.map((row) => Object.fromEntries(row.split('\t').map((value, i) => [names[i], value])));
}

/** FASTA text as `id -> sequence`. */
function fasta(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  let id = '';
  for (const line of text.split('\n')) {
    if (line.startsWith('>')) {
      id = line.slice(1).split(/\s/)[0];
      out[id] = '';
    } else if (id) out[id] += line.trim();
  }
  return out;
}

interface GtfLine {
  contig: string;
  feature: string;
  start: number;
  end: number;
  strand: string;
  attrs: Record<string, string>;
}

function gtf(text: string): GtfLine[] {
  return text
    .split('\n')
    .filter((l) => l && !l.startsWith('#'))
    .map((l) => {
      const f = l.split('\t');
      const attrs: Record<string, string> = {};
      for (const m of f[8].matchAll(/(\w+) "([^"]*)"/g)) attrs[m[1]] = m[2];
      return { contig: f[0], feature: f[2], start: Number(f[3]), end: Number(f[4]), strand: f[6], attrs };
    });
}

const transcriptsOf = (text: string): GtfLine[] => gtf(text).filter((l) => l.feature === 'transcript');

/** The share of the total each value makes. */
function shares(values: number[]): number[] {
  const total = values.reduce((a, b) => a + b, 0);
  return values.map((v) => v / total);
}

const near = (value: number, expected: number, tolerance: number): boolean => Math.abs(value - expected) <= tolerance;

const text = (values: number[]): string => values.map((v) => v.toFixed(2)).join(' / ');

/** A number of the STAR `Log.final.out` ("Uniquely mapped reads % | 96.2%"). */
function starLog(log: string, name: string): number {
  const line = log.split('\n').find((l) => l.includes(name));
  if (!line) throw new Error(`no "${name}" in the STAR log`);
  return parseFloat(line.split('|')[1]);
}

/** The count behind a samtools flagstat line ("1872 + 0 properly paired (...)"). */
function flagstat(report: string, what: string): number {
  const line = report.split('\n').find((l) => l.includes(what));
  if (!line) throw new Error(`no "${what}" in the flagstat report`);
  return Number(line.split(' ')[0]);
}

/** The number on the `Assigned` line of a featureCounts summary. */
function assigned(summary: string): number {
  const line = summary.split('\n').find((l) => l.startsWith('Assigned'));
  if (!line) throw new Error('no Assigned line in the featureCounts summary');
  return Number(line.split('\t')[1]);
}

/** Modules MultiQC says it read (multiqc_report_data/multiqc_sources.txt). */
function multiqcModules(dir: string, folder: string): string[] {
  return [...new Set(table(read(dir, `${folder}/multiqc_report_data/multiqc_sources.txt`)).map((r) => r.Module))];
}

// -----------------------------------------------------------------------------
// Chains
// -----------------------------------------------------------------------------

const PAIRED = { reads1: 'rna_R1.fastq.gz', reads2: 'rna_R2.fastq.gz' };

const CHAINS: Chain[] = [
  {
    name: 'star-rna-featurecounts',
    files: ['ref.fa', 'genes.gtf', 'rna_se.fastq.gz'],
    nodes: [
      {
        key: 'gen',
        catalog: 'star-genomegenerate',
        params: { sjdb_overhang: 74, sa_index_nbases: 4 },
        files: { genome: 'ref.fa', annotation: 'genes.gtf' },
      },
      { key: 'star', catalog: 'star', files: { reads: 'rna_se.fastq.gz' } },
      { key: 'fc', catalog: 'featurecounts', files: { annotation: 'genes.gtf' } },
    ],
    edges: [
      ['gen', 'star'],
      // STAR's BAM (not its output folder) is bound to featureCounts.
      ['star', 'fc'],
    ],
    verify: (dir) => [
      {
        tool: 'featurecounts',
        ok: countsPerGene(read(dir, 'counts.tsv')).every((n) => n > 0),
        message: 'every gene has reads (spliced RNA reads)',
      },
      { tool: 'star', ok: sizeOf(dir, 'star/Aligned.sortedByCoord.out.bam') > 1000, message: 'BAM not tiny' },
      { tool: 'star', ok: /Number of input reads\s*\|\s*1500/.test(read(dir, 'star/Log.final.out')), message: 'STAR read all 1500 reads' },
      {
        tool: 'star-genomegenerate',
        ok: read(dir, 'star_index/sjdbList.out.tab').trim().split('\n').length === 3,
        message: 'the index holds the three annotated splice junctions',
      },
      {
        tool: 'star',
        ok:
          starLog(read(dir, 'star/Log.final.out'), 'Number of splices: Annotated (sjdb)') > 100 &&
          starLog(read(dir, 'star/Log.final.out'), 'Number of splices: Annotated (sjdb)') ===
            starLog(read(dir, 'star/Log.final.out'), 'Number of splices: Total'),
        message: 'reads cross the junctions, and STAR knew every one of them from the annotation',
      },
    ],
  },
  {
    // The annotation is optional: without it the index holds no junctions, and the
    // reads still align because STAR finds the splices itself.
    name: 'star-index-without-annotation',
    files: ['ref.fa', 'rna_se.fastq.gz'],
    nodes: [
      {
        key: 'gen',
        catalog: 'star-genomegenerate',
        params: { sa_index_nbases: 4 },
        files: { genome: 'ref.fa', index_dir: 'star_index_plain/' },
      },
      { key: 'star', catalog: 'star', files: { reads: 'rna_se.fastq.gz', out_dir: 'star_plain/' } },
    ],
    edges: [['gen', 'star']],
    verify: (dir) => {
      const log = read(dir, 'star_plain/Log.final.out');
      return [
        {
          tool: 'star-genomegenerate',
          ok: !exists(dir, 'star_index_plain/sjdbList.out.tab'),
          message: 'no annotation, so the index holds no junction list',
        },
        { tool: 'star', ok: starLog(log, 'Uniquely mapped reads %') > 70, message: 'reads align without annotated junctions' },
        { tool: 'star', ok: starLog(log, 'Number of splices: Annotated (sjdb)') === 0, message: 'no splice is annotated' },
      ];
    },
  },
  {
    name: 'star-paired-rseqc-multiqc',
    files: ['ref.fa', 'genes.gtf', 'rna_R1.fastq.gz', 'rna_R2.fastq.gz'],
    nodes: [
      {
        key: 'gen',
        catalog: 'star-genomegenerate',
        params: { sjdb_overhang: 74, sa_index_nbases: 4 },
        files: { genome: 'ref.fa', annotation: 'genes.gtf' },
      },
      { key: 'star', catalog: 'star', files: { reads: PAIRED.reads1, reads2: PAIRED.reads2, out_dir: 'star_pe/' } },
      { key: 'bed', catalog: 'gffread-bed', files: { annotation: 'genes.gtf' } },
      { key: 'infer', catalog: 'rseqc-infer-experiment' },
      { key: 'dist', catalog: 'rseqc-read-distribution' },
      {
        key: 'fc',
        catalog: 'featurecounts',
        params: { paired: true, strand: '2' },
        files: { annotation: 'genes.gtf', counts: 'counts_pe.tsv' },
      },
      { key: 'mq', catalog: 'multiqc' },
    ],
    edges: [
      ['gen', 'star'],
      ['star', 'infer'],
      ['bed', 'infer'],
      ['star', 'dist'],
      ['bed', 'dist'],
      ['star', 'fc'],
      ['star', 'mq'],
      ['infer', 'mq'],
      ['dist', 'mq'],
      ['fc', 'mq'],
    ],
    bindings: {
      'star>mq': [{ slot: 'reports', output: 'log' }],
      'fc>mq': [{ slot: 'reports', output: 'summary' }],
    },
    verify: (dir) => {
      const infer = read(dir, 'infer_experiment.txt');
      const reverse = Number(infer.match(/"1\+-,1-\+,2\+\+,2--":\s*([\d.]+)/)?.[1]);
      const forward = Number(infer.match(/"1\+\+,1--,2\+-,2-\+":\s*([\d.]+)/)?.[1]);
      const dist = read(dir, 'read_distribution.txt');
      const totalTags = Number(dist.match(/Total Assigned Tags\s+(\d+)/)?.[1]);
      const exonTags = Number(dist.match(/^CDS_Exons\s+\d+\s+(\d+)/m)?.[1]);
      const log = read(dir, 'star_pe/Log.final.out');
      const fragments = assigned(read(dir, 'counts_pe.tsv.summary'));
      const bed = read(dir, 'genes.bed').trim().split('\n');
      const modules = multiqcModules(dir, 'multiqc');
      return [
        { tool: 'rseqc-infer-experiment', ok: /This is PairEnd Data/.test(infer), message: 'the paired reads are recognised' },
        {
          tool: 'rseqc-infer-experiment',
          ok: reverse > 0.95 && forward < 0.05,
          message: `the dUTP library is called reverse-stranded (${reverse} against ${forward})`,
        },
        {
          tool: 'rseqc-read-distribution',
          ok: totalTags > 3500 && exonTags / totalTags > 0.95,
          message: `over 95% of ${totalTags} tags are in exons`,
        },
        {
          tool: 'gffread-bed',
          ok: bed.length === 3 && bed.every((l) => l.split('\t')[9] === '2'),
          message: 'a BED12 line per transcript, two exon blocks each',
        },
        {
          tool: 'star',
          ok: starLog(log, 'Number of input reads') === 2000 && starLog(log, 'Uniquely mapped reads %') > 90,
          message: 'STAR aligned the pairs as pairs (2000 input reads, over 90% unique)',
        },
        {
          tool: 'featurecounts',
          ok: fragments > 1800 && fragments <= 2000,
          message: `fragments are counted, not reads: ${fragments} of at most 2000 pairs`,
        },
        {
          tool: 'multiqc',
          ok: ['RSeQC', 'STAR', 'featureCounts'].every((m) => modules.includes(m)),
          message: `MultiQC read RSeQC, STAR and featureCounts (it read ${modules.join(', ')})`,
        },
      ];
    },
  },
  {
    name: 'hisat2-paired-featurecounts',
    files: ['ref.fa', 'genes.gtf', 'rna_R1.fastq.gz', 'rna_R2.fastq.gz'],
    nodes: [
      { key: 'build', catalog: 'hisat2-build', files: { genome: 'ref.fa' } },
      { key: 'align', catalog: 'hisat2', params: { dta: true }, files: PAIRED },
      { key: 'sort', catalog: 'samtools-sort' },
      { key: 'flag', catalog: 'samtools-flagstat' },
      {
        key: 'fc',
        catalog: 'featurecounts',
        params: { paired: true, strand: '2' },
        files: { annotation: 'genes.gtf', counts: 'counts_reverse.tsv' },
      },
      {
        key: 'fc_fwd',
        catalog: 'featurecounts',
        params: { paired: true, strand: '1' },
        files: { annotation: 'genes.gtf', counts: 'counts_forward.tsv' },
      },
    ],
    edges: [
      ['build', 'align'],
      ['align', 'sort'],
      ['sort', 'flag'],
      ['sort', 'fc'],
      ['sort', 'fc_fwd'],
    ],
    verify: (dir) => {
      const summary = read(dir, 'hisat2_summary.txt');
      const properly = flagstat(read(dir, 'flagstat.txt'), 'properly paired');
      const fragments = assigned(read(dir, 'counts_reverse.tsv.summary'));
      const got = shares(countsPerGene(read(dir, 'counts_reverse.tsv')));
      const wanted = plantedShares();
      return [
        { tool: 'hisat2-build', ok: sizeOf(dir, 'hisat2_index/genome.1.ht2') > 100, message: 'the index files are in the folder' },
        {
          tool: 'hisat2',
          ok: /HISAT2 summary stats:/.test(summary) && /Total pairs: 2000/.test(summary),
          message: 'the summary is written for 2000 pairs',
        },
        { tool: 'hisat2', ok: properly > 2 * 1700, message: `the pairs align as pairs (${properly} reads properly paired)` },
        {
          tool: 'featurecounts',
          ok: fragments > 1700 && fragments <= 2000,
          message: `paired mode counts fragments: ${fragments} of at most 2000 pairs`,
        },
        {
          tool: 'featurecounts',
          ok: wanted.every((w, i) => near(got[i], w, 0.04)),
          message: `the counts follow the planted abundance (${text(got)} against ${text(wanted)})`,
        },
        {
          tool: 'featurecounts',
          ok: assigned(read(dir, 'counts_forward.tsv.summary')) < 0.05 * fragments,
          message: 'the wrong strand setting assigns almost nothing',
        },
      ];
    },
  },
  {
    name: 'hisat2-single-end',
    files: ['ref.fa', 'genes.gtf', 'rna_se.fastq.gz'],
    nodes: [
      { key: 'build', catalog: 'hisat2-build', files: { genome: 'ref.fa' } },
      {
        key: 'align',
        catalog: 'hisat2',
        files: { reads1: 'rna_se.fastq.gz', sam: 'hisat2_se.sam', summary: 'hisat2_se_summary.txt' },
      },
      { key: 'fc', catalog: 'featurecounts', files: { annotation: 'genes.gtf' } },
    ],
    edges: [
      ['build', 'align'],
      // featureCounts reads the SAM as it is.
      ['align', 'fc'],
    ],
    verify: (dir) => {
      const summary = read(dir, 'hisat2_se_summary.txt');
      return [
        {
          tool: 'hisat2',
          ok: /Total reads: 1500/.test(summary) && !/Total pairs/.test(summary),
          message: 'the reads were aligned as single-end reads',
        },
        {
          tool: 'hisat2',
          ok: parseFloat(summary.match(/Overall alignment rate: ([\d.]+)%/)?.[1] ?? '0') > 90,
          message: 'over 90% of the reads align',
        },
        {
          tool: 'featurecounts',
          ok: countsPerGene(read(dir, 'counts.tsv')).every((n) => n > 200),
          message: 'every gene has reads from the SAM',
        },
      ];
    },
  },
  {
    name: 'hisat2-stringtie',
    files: ['ref.fa', 'genes.gtf', 'rna_R1.fastq.gz', 'rna_R2.fastq.gz'],
    nodes: [
      { key: 'build', catalog: 'hisat2-build', files: { genome: 'ref.fa' } },
      { key: 'align', catalog: 'hisat2', params: { dta: true }, files: PAIRED },
      { key: 'sort', catalog: 'samtools-sort' },
      { key: 'asm', catalog: 'stringtie-assemble', params: { strand: '--rf' }, files: { gtf: 'asm.gtf', genes: 'asm_genes.tsv' } },
      { key: 'asm_fr', catalog: 'stringtie-assemble', params: { strand: '--fr' }, files: { gtf: 'asm_fr.gtf', genes: 'asm_fr_genes.tsv' } },
      {
        key: 'asm_guided',
        catalog: 'stringtie-assemble',
        params: { strand: '--rf' },
        files: { annotation: 'genes.gtf', gtf: 'asm_guided.gtf', genes: 'asm_guided_genes.tsv' },
      },
      { key: 'quant', catalog: 'stringtie-quantify', params: { strand: '--rf' }, files: { annotation: 'genes.gtf', out_dir: 'stringtie_truth/' } },
      { key: 'quant_asm', catalog: 'stringtie-quantify', params: { strand: '--rf' }, files: { out_dir: 'stringtie_asm/' } },
    ],
    edges: [
      ['build', 'align'],
      ['align', 'sort'],
      ['sort', 'asm'],
      ['sort', 'asm_fr'],
      ['sort', 'asm_guided'],
      ['sort', 'quant'],
      ['sort', 'quant_asm'],
      // The assembled transcripts become the annotation of the second quantification.
      ['asm', 'quant_asm'],
    ],
    verify: (dir) => {
      const truth = transcriptsOf(read(dir, 'genes.gtf'));
      const found = (file: string) => transcriptsOf(read(dir, file));
      /** Three transcripts at the planted genes, on their strand or (flipped) on the other one. */
      const atPlantedGenes = (file: string, flipped: boolean) => {
        const transcripts = found(file);
        return (
          transcripts.length === 3 &&
          truth.every((t, i) => {
            const f = transcripts[i];
            const strand = flipped ? (t.strand === '+' ? '-' : '+') : t.strand;
            return f.contig === t.contig && near(f.start, t.start, 60) && near(f.end, t.end, 60) && f.strand === strand;
          })
        );
      };
      const tpm = (file: string) => shares(found(file).map((t) => Number(t.attrs.TPM)));
      const wanted = plantedShares();
      const truthShares = tpm('stringtie_truth/transcripts.gtf');
      const assembledShares = tpm('stringtie_asm/transcripts.gtf');
      return [
        { tool: 'stringtie-assemble', ok: atPlantedGenes('asm.gtf', false), message: 'three transcripts found at the planted genes, on the right strands' },
        {
          tool: 'stringtie-assemble',
          ok: gtf(read(dir, 'asm.gtf')).filter((l) => l.feature === 'exon').length === 6,
          message: 'each transcript has its two exons (the intron is spliced out)',
        },
        { tool: 'stringtie-assemble', ok: atPlantedGenes('asm_fr.gtf', true), message: 'the wrong strandedness puts every transcript on the opposite strand' },
        {
          tool: 'stringtie-assemble',
          ok: found('asm_guided.gtf').map((t) => t.attrs.reference_id).join() === 'txA,txB,txC',
          message: 'with a guide annotation each transcript is matched to its known one',
        },
        {
          tool: 'stringtie-quantify',
          ok: wanted.every((w, i) => near(truthShares[i], w, 0.05)),
          message: `TPM follows the planted abundance (${text(truthShares)} against ${text(wanted)})`,
        },
        {
          tool: 'stringtie-quantify',
          ok: table(read(dir, 'stringtie_asm/gene_abundances.tsv')).length === 3 && found('stringtie_asm/transcripts.gtf').every((t) => t.attrs.transcript_id.startsWith('STRG.')),
          message: 'quantifying the assembled transcripts reports them by their new names',
        },
        {
          tool: 'stringtie-quantify',
          ok: wanted.every((w, i) => near(assembledShares[i], w, 0.05)),
          message: 'the assembled transcripts give the same abundance picture',
        },
        {
          tool: 'stringtie-quantify',
          ok: read(dir, 'stringtie_truth/t_data.ctab').trim().split('\n').length === 4,
          message: 'the Ballgown tables are written (3 transcripts)',
        },
      ];
    },
  },
  {
    name: 'transcript-sequences-to-quantifiers',
    files: ['ref.fa', 'genes.gtf', 'rna_se.fastq.gz', 'rna_R1.fastq.gz', 'rna_R2.fastq.gz'],
    nodes: [
      { key: 'gff', catalog: 'gffread', files: { genome: 'ref.fa', annotation: 'genes.gtf' } },
      { key: 'sidx', catalog: 'salmon-index' },
      { key: 'squant', catalog: 'salmon-quant', files: { reads: 'rna_se.fastq.gz' } },
      { key: 'kidx', catalog: 'kallisto-index' },
      { key: 'kq', catalog: 'kallisto-quant', files: { ...PAIRED, out_dir: 'kallisto_pe/', log: 'kallisto_pe.log' } },
      {
        key: 'kq_rf',
        catalog: 'kallisto-quant',
        params: { strand: '--rf-stranded' },
        files: { ...PAIRED, out_dir: 'kallisto_rf/', log: 'kallisto_rf.log' },
      },
      {
        key: 'kq_se',
        catalog: 'kallisto-quant',
        files: { reads1: 'rna_se.fastq.gz', out_dir: 'kallisto_se/', log: 'kallisto_se.log' },
      },
      { key: 'mq', catalog: 'multiqc' },
    ],
    edges: [
      ['gff', 'sidx'],
      ['sidx', 'squant'],
      ['gff', 'kidx'],
      ['kidx', 'kq'],
      ['kidx', 'kq_rf'],
      ['kidx', 'kq_se'],
      ['kq', 'mq'],
      ['kq_se', 'mq'],
    ],
    bindings: {
      'kq>mq': [{ slot: 'reports', output: 'log' }],
      'kq_se>mq': [{ slot: 'reports', output: 'log' }],
    },
    verify: (dir) => {
      const truth = truthCounts();
      const cut = fasta(read(dir, 'transcripts.fa'));
      const planted = fasta(fs.readFileSync(path.join(DATA, 'transcripts.fa'), 'utf8'));
      const estCounts = (folder: string) => table(read(dir, `${folder}/abundance.tsv`)).map((r) => Number(r.est_counts));
      const paired = estCounts('kallisto_pe');
      const single = estCounts('kallisto_se');
      const runCall = (folder: string): string => JSON.parse(read(dir, `${folder}/run_info.json`)).call as string;
      const salmon = table(read(dir, 'salmon_out/quant.sf')).map((r) => Number(r.NumReads));
      const modules = multiqcModules(dir, 'multiqc');
      return [
        {
          tool: 'gffread',
          ok: Object.keys(cut).length === 3 && TRUTH_IDS.every((id) => cut[id] === planted[id]),
          message: 'one sequence per annotated transcript, equal to the planted ones base for base',
        },
        { tool: 'kallisto-index', ok: sizeOf(dir, 'kallisto.idx') > 500, message: 'the index file is written' },
        {
          tool: 'kallisto-quant',
          ok: TRUTH_IDS.every((id, i) => near(paired[i], truth[id], 0.03 * truth[id] + 5)),
          message: `paired reads: the counts match the planted ones (${paired.join(' / ')})`,
        },
        {
          tool: 'kallisto-quant',
          ok: estCounts('kallisto_rf').every((n, i) => near(n, paired[i], 1)),
          message: 'reverse-stranded setting: all pairs still pseudoalign',
        },
        {
          tool: 'kallisto-quant',
          ok: runCall('kallisto_rf').includes(' --rf-stranded ') && !runCall('kallisto_pe').includes('stranded'),
          message: 'the strandedness choice reached kallisto, and unstranded adds nothing',
        },
        {
          tool: 'kallisto-quant',
          ok: runCall('kallisto_pe').includes(' -b 0 ') && !/ -l \d+/.test(runCall('kallisto_pe')),
          message: 'paired reads: no fragment length is given, kallisto measures it',
        },
        {
          tool: 'kallisto-quant',
          ok: / --single -l 200 -s 20 /.test(runCall('kallisto_se')),
          message: 'one reads file: kallisto is told it is single-end, with the fragment length from the form',
        },
        {
          tool: 'kallisto-quant',
          ok: single.every((n) => n > 250) && Math.max(...single) / Math.min(...single) < 1.6,
          message: `single-end reads give even counts for the three transcripts (${single.map((n) => n.toFixed(0)).join(' / ')})`,
        },
        {
          tool: 'salmon-index',
          ok: salmon.length === 3 && salmon.every((n) => n > 350 && n < 650),
          message: `Salmon quantifies the three transcripts evenly through its own index (${salmon.map((n) => n.toFixed(0)).join(' / ')})`,
        },
        {
          tool: 'multiqc',
          ok: modules.includes('Kallisto'),
          message: `MultiQC read the kallisto logs (it read ${modules.join(', ')})`,
        },
      ];
    },
  },
  {
    name: 'fastp-hisat2-star-multiqc',
    files: ['ref.fa', 'genes.gtf', 'rna_se.fastq.gz'],
    nodes: [
      { key: 'fastp', catalog: 'fastp', files: { reads: 'rna_se.fastq.gz' } },
      { key: 'build', catalog: 'hisat2-build', files: { genome: 'ref.fa' } },
      { key: 'hisat', catalog: 'hisat2' },
      {
        key: 'gen',
        catalog: 'star-genomegenerate',
        params: { sjdb_overhang: 74, sa_index_nbases: 4 },
        files: { genome: 'ref.fa', annotation: 'genes.gtf' },
      },
      { key: 'star', catalog: 'star' },
      { key: 'fc_star', catalog: 'featurecounts', files: { annotation: 'genes.gtf', counts: 'counts_star.tsv' } },
      { key: 'fc_hisat', catalog: 'featurecounts', files: { annotation: 'genes.gtf', counts: 'counts_hisat2.tsv' } },
      { key: 'mq', catalog: 'multiqc' },
    ],
    edges: [
      ['fastp', 'hisat'],
      ['build', 'hisat'],
      ['fastp', 'star'],
      ['gen', 'star'],
      ['star', 'fc_star'],
      ['hisat', 'fc_hisat'],
      ['fastp', 'mq'],
      ['hisat', 'mq'],
      ['star', 'mq'],
      ['fc_star', 'mq'],
      ['fc_hisat', 'mq'],
    ],
    bindings: {
      'fastp>mq': [{ slot: 'reports', output: 'json_report' }],
      'hisat>mq': [{ slot: 'reports', output: 'summary' }],
      'star>mq': [{ slot: 'reports', output: 'log' }],
      'fc_star>mq': [{ slot: 'reports', output: 'summary' }],
      'fc_hisat>mq': [{ slot: 'reports', output: 'summary' }],
    },
    verify: (dir) => {
      const modules = multiqcModules(dir, 'multiqc');
      const trimmed = JSON.parse(read(dir, 'fastp.json')).summary.after_filtering.total_reads as number;
      const hisatReads = Number(read(dir, 'hisat2_summary.txt').match(/Total reads: (\d+)/)?.[1]);
      const starReads = starLog(read(dir, 'star/Log.final.out'), 'Number of input reads');
      const general = table(read(dir, 'multiqc/multiqc_report_data/multiqc_general_stats.txt'));
      return [
        {
          tool: 'fastp',
          ok: trimmed > 1000 && hisatReads === trimmed && starReads === trimmed,
          message: `both aligners got the ${trimmed} reads fastp kept (HISAT2 ${hisatReads}, STAR ${starReads})`,
        },
        {
          tool: 'multiqc',
          ok: ['fastp', 'STAR', 'HISAT2', 'featureCounts'].every((m) => modules.includes(m)),
          message: `MultiQC read fastp, STAR, HISAT2 and featureCounts (it read ${modules.join(', ')})`,
        },
        {
          tool: 'multiqc',
          ok: general.length >= 4 && read(dir, 'multiqc/multiqc_report.html').includes('HISAT2'),
          message: `the general statistics table has a row per sample and tool (${general.length} rows)`,
        },
        {
          tool: 'featurecounts',
          ok: assigned(read(dir, 'counts_star.tsv.summary')) > 1000 && assigned(read(dir, 'counts_hisat2.tsv.summary')) > 1000,
          message: 'both aligners give over 1000 assigned reads',
        },
      ];
    },
  },
  {
    name: 'salmon',
    files: ['transcripts.fa', 'rna_se.fastq.gz'],
    nodes: [
      { key: 'idx', catalog: 'salmon-index', files: { transcripts: 'transcripts.fa' } },
      { key: 'quant', catalog: 'salmon-quant', files: { reads: 'rna_se.fastq.gz' } },
    ],
    edges: [['idx', 'quant']],
    verify: (dir) => {
      const rows = read(dir, 'salmon_out/quant.sf').trim().split('\n').slice(1);
      const reads = rows.reduce((sum, r) => sum + Number(r.split('\t')[4]), 0);
      return [
        { tool: 'salmon-quant', ok: rows.length === 3 && reads > 1000, message: `3 transcripts, ${reads.toFixed(0)} reads quantified` },
      ];
    },
  },
  {
    name: 'salmon-library-types',
    files: ['transcripts.fa', 'rna_se.fastq.gz'],
    nodes: [
      { key: 'idx', catalog: 'salmon-index', params: { kmer: 21 }, files: { transcripts: 'transcripts.fa' } },
      ...['U', 'SF', 'SR'].map((libtype) => ({
        key: `salmon_${libtype}`,
        catalog: 'salmon-quant',
        params: { libtype },
        files: { reads: 'rna_se.fastq.gz', out_dir: `salmon_${libtype}/` },
      })),
    ],
    edges: [
      ['idx', 'salmon_U'],
      ['idx', 'salmon_SF'],
      ['idx', 'salmon_SR'],
    ],
    verify: (dir) =>
      ['U', 'SF', 'SR'].map((libtype) => ({
        tool: 'salmon-quant',
        ok: read(dir, `salmon_${libtype}/quant.sf`).trim().split('\n').length === 4,
        message: `library type ${libtype} wrote 3 transcripts`,
      })),
  },
];

defineDomain({
  domain: 'rna',
  covers: [
    'star',
    'star-genomegenerate',
    'salmon-index',
    'salmon-quant',
    'featurecounts',
    'hisat2-build',
    'hisat2',
    'kallisto-index',
    'kallisto-quant',
    'stringtie-assemble',
    'stringtie-quantify',
    'gffread',
    'gffread-bed',
    'rseqc-infer-experiment',
    'rseqc-read-distribution',
  ],
  chains: CHAINS,
});
