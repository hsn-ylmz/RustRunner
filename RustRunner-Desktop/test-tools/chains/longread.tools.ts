/**
 * Long-read domain: Nanopore and HiFi read QC and filtering (NanoPlot, Filtlong,
 * chopper), long-read alignment (minimap2 presets), assembly (Flye, SPAdes, QUAST)
 * and the seqkit sequence tools. The data is `make_data.py`'s 25 kb circular
 * genome with Nanopore-like reads (good, low-quality and very short ones, named
 * after where they came from), HiFi reads, spliced cDNA reads and Illumina-like
 * pairs, so every chain can check results against the truth, not only that a
 * file was written. Chains join the tools by file slots, and to existing catalog
 * tools (samtools, MultiQC).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { defineDomain, exists, read, sizeOf, type Chain, type Check } from '../harness';
import {
  cigarOps,
  fastaRecords,
  fastqRecords,
  nanoStat,
  primaryOnly,
  quastTable,
  reverseComplement,
  samHeader,
  samRecords,
  tableRows,
  totalBases,
  type FastqRecord,
} from '../seqio';

const ok = (tool: string, condition: boolean, message: string): Check => ({ tool, ok: condition, message });

/** The Phred score a raw read was made with (its name ends `_q14`). */
const qualityOf = (name: string): number => Number(/_q(\d+)$/.exec(name)![1]);

const names = (records: Array<{ name: string }>): string[] => records.map((r) => r.name).sort();
const sameNames = (a: Array<{ name: string }>, b: Array<{ name: string }>): boolean => JSON.stringify(names(a)) === JSON.stringify(names(b));

const rawReads = (dir: string): FastqRecord[] => fastqRecords(dir, 'long_ont.fastq.gz');

/** The raw reads a filter with these limits should keep. */
const expectedKept = (dir: string, minQ: number, minLen: number, maxLen = Infinity): FastqRecord[] =>
  rawReads(dir).filter((r) => qualityOf(r.name) >= minQ && r.seq.length >= minLen && r.seq.length <= maxLen);

/** The `s<start>_l<length>_<strand>` of a read name, with whether the read runs past the end of the circular genome. */
function origin(name: string): { start: number; length: number; reverse: boolean; wraps: boolean } {
  const m = /_s(\d+)_l(\d+)_([fr])/.exec(name)!;
  const start = Number(m[1]);
  const length = Number(m[2]);
  return { start, length, reverse: m[3] === 'r', wraps: start + length > 25000 };
}

/** Share of primary alignments that start within `tolerance` bases of where the read came from. */
function sharePlacedRight(dir: string, sam: string, tolerance: number, only?: (name: string) => boolean): { share: number; tested: number } {
  const records = primaryOnly(samRecords(read(dir, sam))).filter((r) => (r.flag & 4) === 0 && (only ? only(r.qname) : true));
  const right = records.filter((r) => !origin(r.qname).wraps && Math.abs(r.pos - 1 - origin(r.qname).start) <= tolerance);
  const tested = records.filter((r) => !origin(r.qname).wraps).length;
  return { share: tested === 0 ? 0 : right.length / tested, tested };
}

/** The `# of reads` numbers of a samtools flagstat report. */
function flagstat(report: string, what: string): number {
  const line = report.split('\n').find((l) => l.includes(` ${what}`));
  if (!line) throw new Error(`no "${what}" line in the flagstat report`);
  return Number(line.split(' ')[0]);
}

const CHAINS: Chain[] = [
  {
    // Raw Nanopore reads are looked at, filtered, assembled two ways (long reads with Flye,
    // short reads with SPAdes), compared against the true genome with QUAST and summarised
    // by MultiQC.
    name: 'long-read-assembly',
    files: ['long_ref.fa', 'long_ont.fastq.gz', 'asm_R1.fastq.gz', 'asm_R2.fastq.gz'],
    nodes: [
      { key: 'rawstats', catalog: 'seqkit-stats', files: { sequences: 'long_ont.fastq.gz', stats: 'raw_stats.tsv' } },
      { key: 'rawplot', catalog: 'nanoplot', files: { reads: 'long_ont.fastq.gz', out_dir: 'nanoplot_raw/' }, params: { title: 'Raw reads' } },
      { key: 'chop', catalog: 'chopper', params: { min_quality: 10, min_length: 1000 }, files: { reads: 'long_ont.fastq.gz', filtered: 'chopped.fastq.gz' } },
      { key: 'flye', catalog: 'flye', files: { out_dir: 'flye/' } },
      { key: 'spades', catalog: 'spades', files: { reads1: 'asm_R1.fastq.gz', reads2: 'asm_R2.fastq.gz', out_dir: 'spades/' } },
      { key: 'quast', catalog: 'quast', params: { labels: 'flye,spades' }, files: { reference: 'long_ref.fa', out_dir: 'quast/' } },
      { key: 'plotchop', catalog: 'nanoplot', params: { plot_files: '', title: 'Filtered reads' }, files: { out_dir: 'nanoplot_chopped/' } },
      { key: 'mqc', catalog: 'multiqc' },
    ],
    edges: [
      ['chop', 'flye'],
      ['flye', 'quast'],
      ['spades', 'quast'],
      ['chop', 'plotchop'],
      ['quast', 'mqc'],
    ],
    bindings: {
      // SPAdes writes contigs and scaffolds, both FASTA: the person picks the contigs.
      'spades>quast': [{ slot: 'assemblies', output: 'contigs' }],
      // MultiQC's QUAST module reads the comparison table.
      'quast>mqc': [{ slot: 'reports', output: 'table' }],
    },
    verify: (dir) => {
      const raw = rawReads(dir);
      const kept = expectedKept(dir, 10, 1000);
      const chopped = fastqRecords(dir, 'chopped.fastq.gz');
      const flye = fastaRecords(dir, 'flye/assembly.fasta');
      const info = tableRows(read(dir, 'flye/assembly_info.txt'));
      const spades = fastaRecords(dir, 'spades/contigs.fasta');
      const quast = quastTable(read(dir, 'quast/report.tsv'));
      const rawStats = tableRows(read(dir, 'raw_stats.tsv'))[0];
      const mqc = read(dir, 'multiqc/multiqc_report.html');
      return [
        ok('seqkit-stats', Number(rawStats.num_seqs) === raw.length && Number(rawStats.sum_len) === totalBases(raw), `seqkit stats counts ${raw.length} raw reads and ${totalBases(raw)} bases (${rawStats.num_seqs}, ${rawStats.sum_len})`),
        ok('seqkit-stats', rawStats.N50 !== undefined && Number(rawStats.AvgQual) > 11 && Number(rawStats.AvgQual) < 13, `the all-statistics columns are there and the average quality is about 12 (${rawStats.AvgQual})`),
        ok('nanoplot', nanoStat(read(dir, 'nanoplot_raw/NanoStats.txt'), 'Number of reads:') === raw.length, 'NanoPlot counts every raw read'),
        ok('nanoplot', nanoStat(read(dir, 'nanoplot_raw/NanoStats.txt'), 'Total bases:') === totalBases(raw), 'NanoPlot adds up the bases of the raw reads'),
        ok('nanoplot', sizeOf(dir, 'nanoplot_raw/NanoPlot-report.html') > 10000, 'the report page was written'),
        ok('nanoplot', !fs.readdirSync(path.join(dir, 'nanoplot_raw')).some((f) => f.endsWith('.png')), 'report page only: no PNG pictures were made'),
        ok('chopper', chopped.length === 200 && sameNames(chopped, kept), `chopper kept exactly the 200 reads of Q10 or better and 1000 bases or longer (${chopped.length})`),
        ok('chopper', chopped.every((r) => r.seq.length === r.qual.length), 'every kept read has a quality for each base'),
        ok('nanoplot', nanoStat(read(dir, 'nanoplot_chopped/NanoStats.txt'), 'Number of reads:') === 200, 'NanoPlot got the filtered reads from chopper through the slot'),
        ok('nanoplot', fs.readdirSync(path.join(dir, 'nanoplot_chopped')).some((f) => f.endsWith('.png')), 'PNG pictures were made when asked for'),
        ok('flye', flye.length === 1 && flye[0].seq.length > 24800 && flye[0].seq.length < 25200, `Flye assembled the 25 kb genome into one contig (${flye.map((f) => f.seq.length).join(', ')})`),
        ok('flye', info.length === 1 && info[0]['circ.'] === 'Y' && Number(info[0]['cov.']) > 25, `the contig table says the contig is circular, at ${info[0]?.['cov.']}x`),
        ok('flye', sizeOf(dir, 'flye/assembly_graph.gfa') > 0 && /Flye/i.test(read(dir, 'flye/flye.log')), 'the graph and the log were written next to the contigs'),
        ok('spades', spades.length === 1 && spades[0].seq.length > 24900 && spades[0].seq.length < 25300, `SPAdes assembled the genome into one contig (${spades.map((s) => s.seq.length).join(', ')})`),
        ok('spades', fastaRecords(dir, 'spades/scaffolds.fasta').length === 1 && sizeOf(dir, 'spades/assembly_graph_with_scaffolds.gfa') > 0, 'the scaffolds and the graph were written'),
        ok('quast', Object.keys(quast['Genome fraction (%)'] ?? {}).join() === 'flye,spades', 'QUAST names the two assemblies as typed in Options'),
        ok('quast', Number(quast['Genome fraction (%)'].flye) > 99.9 && Number(quast['Genome fraction (%)'].spades) > 99.9, 'both assemblies cover the whole reference'),
        ok('quast', Number(quast['# misassemblies'].flye) === 0 && Number(quast['# misassemblies'].spades) === 0, 'neither assembly has a misassembly'),
        ok('quast', Number(quast['# mismatches per 100 kbp'].flye) < 20, `the polished long-read assembly has almost no mismatches (${quast['# mismatches per 100 kbp'].flye} per 100 kb)`),
        ok('quast', quast['Reference length'].flye === '25000' && !exists(dir, 'quast/icarus.html'), 'the reference length is 25000 and the contig browser was skipped'),
        ok('multiqc', /QUAST/i.test(mqc) && /flye/.test(mqc) && /spades/.test(mqc), 'MultiQC shows the QUAST table with both assemblies'),
      ];
    },
  },

  {
    // The same filter done three ways must keep the same reads; every option of the three
    // tools is checked against reads whose quality and length are known.
    name: 'long-read-filters',
    files: ['long_ont.fastq.gz', 'asm_R1.fastq.gz', 'asm_R2.fastq.gz'],
    nodes: [
      { key: 'chopa', catalog: 'chopper', params: { min_quality: 10, min_length: 1000 }, files: { reads: 'long_ont.fastq.gz', filtered: 'chopper_a.fastq.gz' } },
      { key: 'chopcrop', catalog: 'chopper', params: { min_quality: 10, min_length: 1000, head_crop: 50, tail_crop: 50 }, files: { reads: 'long_ont.fastq.gz', filtered: 'chopper_crop.fastq.gz' } },
      { key: 'chopmax', catalog: 'chopper', params: { min_quality: 10, min_length: 1000, max_length: 5000 }, files: { reads: 'long_ont.fastq.gz', filtered: 'chopper_max.fastq.gz' } },
      { key: 'fla', catalog: 'filtlong', params: { min_length: 1000, min_accuracy: 90 }, files: { reads: 'long_ont.fastq.gz', filtered: 'filtlong_a.fastq.gz' } },
      { key: 'flmax', catalog: 'filtlong', params: { min_length: 1000, min_accuracy: 90, max_length: 5000 }, files: { reads: 'long_ont.fastq.gz', filtered: 'filtlong_max.fastq.gz' } },
      {
        key: 'flref',
        catalog: 'filtlong',
        params: { min_length: 500, min_accuracy: 0, target_bases: '600k' },
        files: { reads: 'long_ont.fastq.gz', short1: 'asm_R1.fastq.gz', short2: 'asm_R2.fastq.gz', filtered: 'filtlong_ref.fastq.gz' },
      },
      { key: 'flpct', catalog: 'filtlong', params: { min_length: 1000, min_accuracy: 90, keep_percent: 50 }, files: { reads: 'long_ont.fastq.gz', filtered: 'filtlong_half.fastq.gz' } },
      { key: 'seqfilter', catalog: 'seqkit-seq', params: { min_length: 1000, min_quality: 10 }, files: { sequences: 'long_ont.fastq.gz', result: 'seqkit_filtered.fastq.gz' } },
      { key: 'seqmax', catalog: 'seqkit-seq', params: { min_length: 1000, max_length: 5000, min_quality: 10 }, files: { sequences: 'long_ont.fastq.gz', result: 'seqkit_max.fastq.gz' } },
      { key: 'seqrc', catalog: 'seqkit-seq', params: { reverse_complement: true, upper_case: true }, files: { result: 'seqkit_rc.fastq.gz' } },
      { key: 'grepq7', catalog: 'seqkit-grep', params: { pattern: '_q7$', regex: true }, files: { sequences: 'long_ont.fastq.gz', matched: 'q7_reads.fastq.gz' } },
      { key: 'grepnot', catalog: 'seqkit-grep', params: { pattern: '_q7$', regex: true, invert: true }, files: { sequences: 'long_ont.fastq.gz', matched: 'not_q7_reads.fastq.gz' } },
      { key: 'grepname', catalog: 'seqkit-grep', params: { pattern: '_F_Q14$', search_in: '-n', ignore_case: true, regex: true }, files: { sequences: 'long_ont.fastq.gz', matched: 'forward_reads.fastq.gz' } },
      {
        key: 'mklist',
        raw: { label: 'Make list of five names', tool: 'bash', command: "gzip -cdf chopper_crop.fastq.gz | awk 'NR%4==1 {print substr($1,2)}' | head -5 > five_names.txt", output: 'five_names.txt' },
      },
      { key: 'grepexact', catalog: 'seqkit-grep', files: { sequences: 'long_ont.fastq.gz', names: 'five_names.txt', matched: 'five_reads.fastq.gz' } },
      { key: 'grepboth', catalog: 'seqkit-grep', params: { pattern: 'no_such_read' }, files: { sequences: 'long_ont.fastq.gz', names: 'five_names.txt', matched: 'five_and_none.fastq.gz' } },
      { key: 'stats', catalog: 'seqkit-stats', params: { all: false }, files: { stats: 'filtered_stats.tsv' } },
    ],
    edges: [
      ['chopa', 'seqrc'],
      ['chopa', 'stats'],
      ['chopcrop', 'stats'],
      ['fla', 'stats'],
      ['flref', 'stats'],
      ['chopcrop', 'mklist', 'after'],
      ['mklist', 'grepexact', 'after'],
      ['mklist', 'grepboth', 'after'],
    ],
    verify: (dir) => {
      const a = fastqRecords(dir, 'chopper_a.fastq.gz');
      const crop = fastqRecords(dir, 'chopper_crop.fastq.gz');
      const lengthOfA = new Map(a.map((r) => [r.name, r.seq.length]));
      const kept = expectedKept(dir, 10, 1000);
      const keptMax = expectedKept(dir, 10, 1000, 5000);
      const fl = fastqRecords(dir, 'filtlong_a.fastq.gz');
      const flRef = fastqRecords(dir, 'filtlong_ref.fastq.gz');
      const flHalf = fastqRecords(dir, 'filtlong_half.fastq.gz');
      const rc = fastqRecords(dir, 'seqkit_rc.fastq.gz');
      const q7 = fastqRecords(dir, 'q7_reads.fastq.gz');
      const notQ7 = fastqRecords(dir, 'not_q7_reads.fastq.gz');
      const forward = fastqRecords(dir, 'forward_reads.fastq.gz');
      const rawByName = new Map(rawReads(dir).map((r) => [r.name, r]));
      const stats = tableRows(read(dir, 'filtered_stats.tsv'));
      const fiveNames = read(dir, 'five_names.txt').split('\n').filter(Boolean);
      return [
        ok('chopper', a.length === 200 && sameNames(a, kept), 'chopper keeps the 200 reads of Q10 or better and 1000 bases or longer'),
        ok('chopper', crop.length === 200 && crop.every((r) => r.seq.length === lengthOfA.get(r.name)! - 100 && r.qual.length === r.seq.length), 'cutting 50 bases off each end shortens every read by exactly 100'),
        ok('chopper', crop.every((r) => r.seq === a.find((x) => x.name === r.name)!.seq.slice(50, -50)), 'the cut reads are the middle of the original reads'),
        ok('chopper', sameNames(fastqRecords(dir, 'chopper_max.fastq.gz'), keptMax) && keptMax.length < 200 && keptMax.length > 20, `the longest-read limit drops the reads over 5000 bases (${keptMax.length} stay)`),
        ok('filtlong', sameNames(fl, a), 'Filtlong with Q10-equivalent accuracy and 1000 bases keeps the same reads as chopper'),
        ok('filtlong', sameNames(fastqRecords(dir, 'filtlong_max.fastq.gz'), keptMax), 'the longest-read limit gives the same reads as chopper does'),
        ok('filtlong', !flRef.some((r) => qualityOf(r.name) === 7), 'scored against the short reads, none of the poor reads is among the best'),
        ok('filtlong', totalBases(flRef) >= 450_000 && totalBases(flRef) <= 650_000, `the target of 600k bases is respected (${totalBases(flRef)} kept)`),
        ok('filtlong', totalBases(flHalf) > 0.35 * totalBases(fl) && totalBases(flHalf) < 0.65 * totalBases(fl), `keeping the best 50 percent keeps about half the bases (${totalBases(flHalf)} of ${totalBases(fl)})`),
        ok('seqkit-seq', sameNames(fastqRecords(dir, 'seqkit_filtered.fastq.gz'), kept), 'seqkit seq with a length and a quality limit keeps the same 200 reads'),
        ok('seqkit-seq', sameNames(fastqRecords(dir, 'seqkit_max.fastq.gz'), keptMax), 'seqkit seq with a longest-read limit keeps the same reads as chopper'),
        ok('seqkit-seq', rc.length === a.length && rc.every((r, i) => r.seq === reverseComplement(a[i].seq).toUpperCase() && r.qual === [...a[i].qual].reverse().join('')), 'the reverse complement of every connected read, upper case, with the quality turned round'),
        ok('seqkit-grep', q7.length === 40 && q7.every((r) => qualityOf(r.name) === 7), 'the regular expression finds exactly the 40 poor reads'),
        ok('seqkit-grep', notQ7.length === 230 && notQ7.every((r) => qualityOf(r.name) !== 7) && q7.length + notQ7.length === rawByName.size, 'the inverted match keeps the other 230'),
        ok('seqkit-grep', forward.length > 0 && forward.every((r) => /_f_q14$/.test(r.name)) && forward.length === [...rawByName.keys()].filter((n) => /_f_q14$/.test(n)).length, 'a pattern searched in the whole name line, ignoring capitals, finds every forward Q14 read'),
        ok('seqkit-grep', fiveNames.length === 5 && sameNames(fastqRecords(dir, 'five_reads.fastq.gz'), fiveNames.map((name) => ({ name }))), 'a list of five names gives exactly those five reads'),
        ok('seqkit-grep', sameNames(fastqRecords(dir, 'five_and_none.fastq.gz'), fiveNames.map((name) => ({ name }))), 'a typed pattern that matches nothing adds nothing to the list'),
        ok(
          'seqkit-stats',
          stats.length === 4 && stats.some((r) => r.file === 'chopper_a.fastq.gz' && Number(r.num_seqs) === 200) && stats.some((r) => r.file === 'filtlong_ref.fastq.gz' && Number(r.num_seqs) === flRef.length),
          'one row for each connected file, with the right read counts'
        ),
        ok('seqkit-stats', stats[0].N50 === undefined && stats[0].AvgQual === undefined, 'without the all-statistics option the table stays short'),
      ];
    },
  },

  {
    // Every minimap2 preset against reads whose true place is in the read name, then the
    // alignments through samtools and NanoPlot.
    name: 'long-read-mapping',
    files: ['long_ref.fa', 'ref.fa', 'long_ont.fastq.gz', 'long_hifi.fastq.gz', 'long_cdna.fastq.gz'],
    nodes: [
      { key: 'mmont', catalog: 'minimap2-long', params: { sample_name: 'ont1' }, files: { ref: 'long_ref.fa', reads: 'long_ont.fastq.gz', sam: 'ont.sam' } },
      { key: 'sortont', catalog: 'samtools-sort', files: { bam: 'ont.sorted.bam' } },
      { key: 'idxont', catalog: 'samtools-index', files: { bai: 'ont.sorted.bam.bai' } },
      { key: 'flagont', catalog: 'samtools-flagstat', files: { report: 'ont_flagstat.txt' } },
      { key: 'plotbam', catalog: 'nanoplot', params: { format: '--bam' }, files: { out_dir: 'nanoplot_bam/' } },
      { key: 'mmhq', catalog: 'minimap2-long', params: { preset: 'lr:hq' }, files: { ref: 'long_ref.fa', reads: 'long_hifi.fastq.gz', sam: 'hq.sam' } },
      { key: 'mmhifi', catalog: 'minimap2-long', params: { preset: 'map-hifi' }, files: { ref: 'long_ref.fa', reads: 'long_hifi.fastq.gz', sam: 'hifi.sam' } },
      { key: 'sorthifi', catalog: 'samtools-sort', files: { bam: 'hifi.sorted.bam' } },
      { key: 'flaghifi', catalog: 'samtools-flagstat', files: { report: 'hifi_flagstat.txt' } },
      { key: 'mmpb', catalog: 'minimap2-long', params: { preset: 'map-pb', primary_only: false }, files: { ref: 'long_ref.fa', reads: 'long_hifi.fastq.gz', sam: 'pb.sam' } },
      { key: 'mmsplice', catalog: 'minimap2-long', params: { preset: 'splice' }, files: { ref: 'ref.fa', reads: 'long_cdna.fastq.gz', sam: 'splice.sam' } },
      { key: 'sortsplice', catalog: 'samtools-sort', files: { bam: 'splice.sorted.bam' } },
      { key: 'flagsplice', catalog: 'samtools-flagstat', files: { report: 'splice_flagstat.txt' } },
      { key: 'mmsplicehq', catalog: 'minimap2-long', params: { preset: 'splice:hq' }, files: { ref: 'ref.fa', reads: 'long_cdna.fastq.gz', sam: 'splice_hq.sam' } },
    ],
    edges: [
      ['mmont', 'sortont'],
      ['sortont', 'idxont'],
      ['sortont', 'flagont'],
      ['sortont', 'plotbam'],
      ['mmhifi', 'sorthifi'],
      ['sorthifi', 'flaghifi'],
      ['mmsplice', 'sortsplice'],
      ['sortsplice', 'flagsplice'],
    ],
    verify: (dir) => {
      const ontSam = read(dir, 'ont.sam');
      const goodOnly = (name: string) => qualityOf(name) === 14 && origin(name).length >= 2500;
      const placedOnt = sharePlacedRight(dir, 'ont.sam', 300, goodOnly);
      const placedHifi = sharePlacedRight(dir, 'hifi.sam', 30);
      const placedHq = sharePlacedRight(dir, 'hq.sam', 30);
      const hifiFlag = read(dir, 'hifi_flagstat.txt');
      const ontFlag = read(dir, 'ont_flagstat.txt');
      const spliceFlag = read(dir, 'splice_flagstat.txt');
      const transcriptContig: Record<string, string> = { txA: 'chr1', txB: 'chr1', txC: 'chr2' };
      const spliced = (file: string) =>
        primaryOnly(samRecords(read(dir, file))).map((r) => ({
          r,
          introns: cigarOps(r.cigar)
            .filter(([, op]) => op === 'N')
            .map(([n]) => n),
        }));
      const sp = spliced('splice.sam');
      const spHq = spliced('splice_hq.sam');
      const rightIntron = (x: { r: { qname: string; rname: string }; introns: number[] }) =>
        x.introns.length === 1 && x.introns[0] >= 280 && x.introns[0] <= 320 && x.r.rname === transcriptContig[x.r.qname.split('_')[1]];
      const pb = samRecords(read(dir, 'pb.sam'));
      const header = samHeader(ontSam);
      const nanoStatsBam = read(dir, 'nanoplot_bam/NanoStats.txt');
      return [
        ok('minimap2-long', flagstat(ontFlag, 'primary') === 270 && flagstat(ontFlag, 'mapped') >= 268, `270 reads, nearly all mapped (${flagstat(ontFlag, 'mapped')} mapped records)`),
        ok('minimap2-long', header.some((l) => /^@RG\tID:ont1\tSM:ont1/.test(l)), 'the sample name is the read group of the alignments'),
        ok('minimap2-long', placedOnt.tested > 100 && placedOnt.share > 0.95, `the good Nanopore reads start where they came from (${(placedOnt.share * 100).toFixed(1)} percent of ${placedOnt.tested})`),
        ok('minimap2-long', flagstat(ontFlag, 'supplementary') > 0, 'reads that run across the end of the circular genome are split into supplementary alignments'),
        ok('minimap2-long', flagstat(hifiFlag, 'primary') === 160 && flagstat(hifiFlag, 'mapped') === 160 && flagstat(hifiFlag, 'secondary') === 0, 'all 160 HiFi reads map, with no secondary alignments'),
        ok('minimap2-long', placedHifi.share > 0.99 && placedHq.share > 0.99, `the HiFi reads start where they came from with map-hifi and with lr:hq (${(placedHifi.share * 100).toFixed(1)} and ${(placedHq.share * 100).toFixed(1)} percent)`),
        ok('minimap2-long', pb.length >= 160 && primaryOnly(pb).length === 160, 'the PacBio CLR preset with every alignment kept maps all reads'),
        ok('minimap2-long', flagstat(spliceFlag, 'primary') === 80 && flagstat(spliceFlag, 'mapped') === 80, 'all 80 cDNA reads map to the genome'),
        ok('minimap2-long', sp.filter(rightIntron).length >= 72 && !samHeader(read(dir, 'splice.sam')).some((l) => l.startsWith('@RG')), `at least 90 percent of the cDNA reads have one intron of 300 bases on their own gene's contig (${sp.filter(rightIntron).length} of ${sp.length}); no read group without a sample name`),
        ok('minimap2-long', spHq.filter(rightIntron).length >= 72, 'the accurate-cDNA preset finds the same introns'),
        ok('samtools-sort', exists(dir, 'ont.sorted.bam') && exists(dir, 'ont.sorted.bam.bai'), 'the long-read alignments sort and index like any others'),
        ok('nanoplot', nanoStat(nanoStatsBam, 'Number of reads:') >= 268 && nanoStat(nanoStatsBam, 'Number of reads:') <= 270 + 60, 'NanoPlot reads the aligned BAM that came through two steps'),
      ];
    },
  },

  {
    // Flye with each kind of read, polished and not, and every SPAdes mode, all compared
    // by QUAST against the true genome.
    name: 'assembler-options',
    files: ['long_ref.fa', 'long_ont.fastq.gz', 'long_hifi.fastq.gz', 'asm_R1.fastq.gz', 'asm_R2.fastq.gz'],
    nodes: [
      { key: 'chop', catalog: 'chopper', params: { min_quality: 10, min_length: 1000 }, files: { reads: 'long_ont.fastq.gz', filtered: 'chopped.fastq.gz' } },
      { key: 'polished', catalog: 'flye', files: { out_dir: 'flye_polished/' } },
      {
        key: 'unpolished',
        catalog: 'flye',
        params: { read_type: '--nano-hq', iterations: 0, meta: true, min_overlap: '2000', genome_size: '25k' },
        files: { out_dir: 'flye_unpolished/' },
      },
      { key: 'hifi', catalog: 'flye', params: { read_type: '--pacbio-hifi' }, files: { reads: 'long_hifi.fastq.gz', out_dir: 'flye_hifi/' } },
      { key: 'quastlong', catalog: 'quast', params: { labels: 'polished,unpolished,hifi', browser: '' }, files: { reference: 'long_ref.fa', out_dir: 'quast_long/' } },
      { key: 'spstd', catalog: 'spades', params: { mode: '' }, files: { reads1: 'asm_R1.fastq.gz', reads2: 'asm_R2.fastq.gz', out_dir: 'spades_standard/' } },
      { key: 'spcare', catalog: 'spades', params: { mode: '--careful' }, files: { reads1: 'asm_R1.fastq.gz', reads2: 'asm_R2.fastq.gz', out_dir: 'spades_careful/' } },
      { key: 'spmeta', catalog: 'spades', params: { mode: '--meta' }, files: { reads1: 'asm_R1.fastq.gz', reads2: 'asm_R2.fastq.gz', out_dir: 'spades_meta/' } },
      { key: 'spsc', catalog: 'spades', params: { mode: '--sc' }, files: { reads1: 'asm_R1.fastq.gz', reads2: 'asm_R2.fastq.gz', out_dir: 'spades_sc/' } },
      { key: 'spone', catalog: 'spades', params: { kmers: '21,33', memory: 4 }, files: { reads1: 'asm_R1.fastq.gz', out_dir: 'spades_single/' } },
      { key: 'quastshort', catalog: 'quast', params: { labels: 'standard,careful,meta,sc,single' }, files: { reference: 'long_ref.fa', out_dir: 'quast_short/' } },
    ],
    edges: [
      ['chop', 'polished'],
      ['chop', 'unpolished'],
      ['polished', 'quastlong'],
      ['unpolished', 'quastlong'],
      ['hifi', 'quastlong'],
      ['spstd', 'quastshort'],
      ['spcare', 'quastshort'],
      ['spmeta', 'quastshort'],
      ['spsc', 'quastshort'],
      ['spone', 'quastshort'],
    ],
    bindings: Object.fromEntries(['spstd', 'spcare', 'spmeta', 'spsc', 'spone'].map((k) => [`${k}>quastshort`, [{ slot: 'assemblies', output: 'contigs' }]])),
    verify: (dir) => {
      const long = quastTable(read(dir, 'quast_long/report.tsv'));
      const short = quastTable(read(dir, 'quast_short/report.tsv'));
      const infoHifi = tableRows(read(dir, 'flye_hifi/assembly_info.txt'));
      const spadesLog = (name: string) => read(dir, `spades_${name}/spades.log`);
      const inShort = (metric: string) => ['standard', 'careful', 'meta', 'sc', 'single'].map((a) => short[metric][a]);
      return [
        ok('flye', Number(long['# mismatches per 100 kbp'].polished) < 10 && Number(long['# indels per 100 kbp'].polished) < 10, 'with one polishing round the assembly matches the reference'),
        ok(
          'flye',
          exists(dir, 'flye_polished/40-polishing') && /Polishing genome \(1\/1\)/.test(read(dir, 'flye_polished/flye.log')) && !exists(dir, 'flye_unpolished/40-polishing'),
          'one polishing round polishes, none leaves the polishing step out'
        ),
        ok(
          'flye',
          Number(long['# mismatches per 100 kbp'].unpolished) + Number(long['# indels per 100 kbp'].unpolished) >= Number(long['# mismatches per 100 kbp'].polished) + Number(long['# indels per 100 kbp'].polished),
          'the polished assembly is no worse than the one without polishing'
        ),
        ok(
          'flye',
          ['--nano-hq', '--iterations 0', '--meta', '--genome-size 25k', '--min-overlap 2000'].every((flag) => read(dir, 'flye_unpolished/flye.log').includes(flag)) &&
            read(dir, 'flye_hifi/flye.log').includes('--pacbio-hifi') &&
            read(dir, 'flye_polished/flye.log').includes('--nano-raw') &&
            !/--genome-size|--min-overlap|--meta/.test(read(dir, 'flye_polished/flye.log').split('\n').find((l) => l.includes('Cmd:')) ?? ''),
          'every option of the form reached Flye, and the empty ones were left out'
        ),
        ok('flye', Number(long['Genome fraction (%)'].unpolished) > 99 && Number(long['Total length'].unpolished) > 24900, 'the metagenome mode with a genome size and an overlap still assembles the whole genome'),
        ok('flye', Number(long['Genome fraction (%)'].hifi) > 80 && infoHifi.length === 1 && Number(infoHifi[0].length) > 20000, 'HiFi reads (22x, none across the circle) assemble most of the genome with the HiFi setting'),
        ok('quast', exists(dir, 'quast_long/icarus.html') && sizeOf(dir, 'quast_long/report.html') > 1000, 'the contig browser was made when asked for'),
        ok('spades', inShort('# contigs').every((n) => n === '1') && inShort('Genome fraction (%)').every((g) => Number(g) > 99.9), 'every SPAdes mode assembles the genome into one contig'),
        ok('spades', inShort('Total length').every((n) => Math.abs(Number(n) - 25000) < 120), `all five assemblies are about 25 kb (${inShort('Total length').join(', ')})`),
        ok('spades', /Metagenomic mode/.test(spadesLog('meta')) && !/Metagenomic mode/.test(spadesLog('standard')), 'the metagenome mode really ran in meta mode'),
        ok('spades', /--careful/.test(spadesLog('careful')) && /--sc/.test(spadesLog('sc')), 'the careful and single-cell modes were passed on'),
        ok('spades', exists(dir, 'spades_single/K21') && exists(dir, 'spades_single/K33') && !exists(dir, 'spades_single/K55'), 'the word sizes 21 and 33 were used, not the automatic ones'),
        ok('spades', /single reads/i.test(spadesLog('single')) && /Library number: 1, library type: paired-end/.test(spadesLog('standard')), 'one file is run as single reads, two as a pair'),
      ];
    },
  },
];

defineDomain({
  domain: 'longread',
  covers: ['minimap2-long', 'nanoplot', 'filtlong', 'chopper', 'flye', 'spades', 'quast', 'seqkit-stats', 'seqkit-seq', 'seqkit-grep'],
  chains: CHAINS,
});
