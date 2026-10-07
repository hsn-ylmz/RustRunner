/**
 * What the two Ribo-seq chains share: the data they link into the sandbox, the
 * readers of the tools' files, and `verifyRiboseq`, the checks run on a finished
 * run (HEK293T footprints, Diagenode D-Plex library, GSE158374 / SRR12693498;
 * see riboseq-test/DATA.md for the layout and for how the data is made).
 *
 * The same checks run on the workflow built step by step from catalog tools
 * (`chains/riboseq.tools.ts`) and on the workflow made from the bundled template
 * "Ribo-seq with UMIs (riboWaltz)" by the code the template dialog runs
 * (`chains/templates.tools.ts`), so both paths are held to the same science.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { DATA, REPO, SANDBOX, exists, read, run, type Check } from '../harness';
import { parseReport } from './html';

export const RIBO_DATA = path.join(REPO, 'riboseq-test', 'data');
const TINY = path.join(RIBO_DATA, 'tiny', 'SRR12693498_200000reads_seed42.fastq.gz');
const FULL = path.join(RIBO_DATA, 'full', 'SRR12693498_5000000reads.fastq.gz');
const REF = path.join(RIBO_DATA, 'ref');

/** Name in the sandbox data folder -> real file. */
export const LINKS: Record<string, string> = {
  'ribo_tiny.fastq.gz': TINY,
  'ribo_full.fastq.gz': FULL,
  'ribo_genome.fa': path.join(REF, 'genome_chr17_19_22.fa'),
  'ribo_genes.gtf': path.join(REF, 'annotation_chr17_19_22.gtf'),
  'ribo_rRNA.fa': path.join(REF, 'rRNA.fa'),
  'ribo_tRNA.fa': path.join(REF, 'tRNA.fa'),
  'ribo_ncRNA.fa': path.join(REF, 'ncRNA.fa'),
};

/** Poly(A) tail (A10 C A10) followed by the Illumina adapter: the 3' side of a D-Plex read. */
export const DPLEX_ADAPTER = 'AAAAAAAAAACAAAAAAAAAAGATCGGAAGAGCACACGTCTGAACTCCAGTCAC';
export const UMI_LENGTH = 12;
export const SPACER_LENGTH = 4;

const R_TEST = path.join(__dirname, 'test_ribowaltz_report.R');
const R_SCRIPT = path.join(REPO, 'RustRunner', 'runtime', 'app_resources', 'ribowaltz', 'ribowaltz_report.R');

/** The files a chain on the 200 000-read set needs, and with RIBOSEQ_FULL=1 the 5 million read file too. */
export function riboDataMissing(): string[] {
  return Object.entries(LINKS)
    .filter(([name]) => name !== 'ribo_full.fastq.gz' || process.env.RIBOSEQ_FULL === '1')
    .map(([, file]) => file)
    .filter((file) => !fs.existsSync(file));
}

/**
 * Links the real data into the sandbox's data folder, where chains copy their files from.
 * `strict`: stop with the instruction to build the data when it is missing (a domain that
 * only needs it for some chains passes false and the chain itself checks).
 */
export function linkRiboData(strict = true): void {
  const missing = riboDataMissing();
  if (missing.length > 0 && strict) {
    throw new Error(
      `the Ribo-seq test data is missing (${missing.map((f) => path.relative(REPO, f)).join(', ')}). ` +
        'Build it once with: ./riboseq-test/prepare_data.sh'
    );
  }
  for (const [name, target] of Object.entries(LINKS)) {
    if (!fs.existsSync(target)) continue; // the 5 M file is only needed with RIBOSEQ_FULL=1
    const link = path.join(DATA, name);
    fs.rmSync(link, { force: true });
    fs.symlinkSync(target, link);
  }
}

// -----------------------------------------------------------------------------
// Reading results
// -----------------------------------------------------------------------------

export interface Fastq {
  names: string[];
  seqs: string[];
  quals: string[];
}

/** The first `limit` reads of a gzipped FASTQ (all of them when omitted; a big file is never held whole). */
export function readFastq(file: string, limit = Infinity): Fastq {
  let text: string;
  if (Number.isFinite(limit)) {
    const head = run('sh', ['-c', `gzip -dc "$1" | head -n ${4 * limit}`, 'sh', file]);
    text = head.stdout;
  } else {
    text = gunzipSync(fs.readFileSync(file)).toString('latin1');
  }
  const lines = text.split('\n');
  const out: Fastq = { names: [], seqs: [], quals: [] };
  for (let i = 0; i + 3 < lines.length; i += 4) {
    out.names.push(lines[i]);
    out.seqs.push(lines[i + 1]);
    out.quals.push(lines[i + 3]);
  }
  return out;
}

/** How many reads a gzipped FASTQ holds, counted without holding it. */
export function fastqReads(file: string): number {
  const counted = run('sh', ['-c', 'gzip -dc "$1" | wc -l', 'sh', file]);
  return Number(counted.stdout.trim()) / 4;
}

/** The read id: the name up to the first space, without the '@'. */
export const idOf = (name: string): string => name.slice(1).split(' ')[0];

/** The 'N' of "N reads; of these:" and the "aligned 0 times" count of a Bowtie2 summary. */
export function bowtie2Summary(log: string): { reads: number; unaligned: number; rate: number } {
  const reads = Number(/^(\d+) reads; of these:/m.exec(log)?.[1]);
  const unaligned = Number(/^\s+(\d+) \([\d.]+%\) aligned 0 times/m.exec(log)?.[1]);
  const rate = parseFloat(/([\d.]+)% overall alignment rate/.exec(log)?.[1] ?? 'NaN');
  return { reads, unaligned, rate };
}

/** A number of the STAR `Log.final.out` ("Uniquely mapped reads % | 14.68%"). */
export function starLog(log: string, name: string): number {
  const line = log.split('\n').find((l) => l.includes(name));
  if (!line) throw new Error(`no "${name}" in the STAR log`);
  return parseFloat(line.split('|')[1]);
}

/** `samtools` of the pinned environment the engine created (HOME is the sandbox). */
export function samtools(...args: string[]): string {
  const bin = path.join(SANDBOX, 'home', '.rustrunner', 'micromamba', 'envs', 'samtools-1.24', 'bin', 'samtools');
  const result = run(bin, args);
  if (result.status !== 0) throw new Error(`samtools ${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout;
}
export const count = (file: string, ...filters: string[]): number => Number(samtools('view', '-c', ...filters, file).trim());

export function tsv(text: string): Array<Record<string, string>> {
  const [head, ...rows] = text.trim().split('\n');
  const names = head.split('\t');
  return rows.filter(Boolean).map((row) => Object.fromEntries(row.split('\t').map((v, i) => [names[i], v])));
}

// -----------------------------------------------------------------------------
// Checks on a finished run
// -----------------------------------------------------------------------------

export function verifyRiboseq(dir: string, full: boolean): Check[] {
  const checks: Check[] = [];
  const lines: string[] = [];
  const ok = (tool: string, cond: boolean, message: string) => {
    checks.push({ tool, ok: cond, message });
    lines.push(`${cond ? 'ok  ' : 'FAIL'} [${tool}] ${message}`);
  };
  const f = (rel: string) => path.join(dir, rel);

  // --- cutadapt: the poly(A) tail and the adapter are found and cut --------
  const cutReport = read(dir, 'cutadapt.txt');
  const total = Number(/Total reads processed:\s+([\d,]+)/.exec(cutReport)?.[1].replace(/,/g, ''));
  const written = Number(/Reads written \(passing filters\):\s+([\d,]+)/.exec(cutReport)?.[1].replace(/,/g, ''));
  const withAdapter = Number(/Reads with adapters:\s+([\d,]+)/.exec(cutReport)?.[1].replace(/,/g, ''));
  ok('cutadapt', withAdapter / total > 0.9, `at least 90% of the reads carry the poly(A) tail and adapter (${((100 * withAdapter) / total).toFixed(1)}%)`);
  ok('cutadapt', /Minimum overlap: 10/.test(cutReport) && /Type: regular 3'/.test(cutReport), 'cutadapt ran with the 3\' adapter and a minimum overlap of 10');
  // A big data set is checked read by read on its first reads and by counts on all of them.
  const LIMIT = full ? 300000 : Infinity;
  const trimmedReads = fastqReads(f('trimmed.fastq.gz'));
  const trimmed = readFastq(f('trimmed.fastq.gz'), LIMIT);
  ok('cutadapt', trimmedReads === written, 'the trimmed file holds every read cutadapt reported writing');
  ok('cutadapt', trimmed.seqs.every((s) => s.length >= 20), 'no trimmed read is shorter than the minimum length of 20');
  ok('cutadapt', !trimmed.seqs.some((s) => s.endsWith('AGATCGGAAGAGC')), 'no trimmed read still ends with the Illumina adapter');

  // --- umi_tools extract: 12 nt UMI into the name, 4 nt motif removed --------
  const umi = readFastq(f('umi_extracted.fastq.gz'), LIMIT);
  const umiReads = fastqReads(f('umi_extracted.fastq.gz'));
  ok('umi-tools-extract', umiReads === trimmedReads && umi.names.length === trimmed.names.length, 'every read came through extraction');
  let exact = true;
  for (let i = 0; i < umi.names.length && exact; i++) {
    const before = trimmed.seqs[i];
    const name = umi.names[i];
    const match = /^(\S+)_([ACGTN]{12})( |$)/.exec(name.slice(1));
    exact =
      idOf(trimmed.names[i]) === idOf(name).replace(/_[ACGTN]{12}$/, '') &&
      match !== null &&
      match[2] === before.slice(0, UMI_LENGTH) &&
      umi.seqs[i] === before.slice(UMI_LENGTH + SPACER_LENGTH) &&
      umi.quals[i] === trimmed.quals[i].slice(UMI_LENGTH + SPACER_LENGTH);
  }
  ok('umi-tools-extract', exact, 'for every read the UMI is the first 12 bases, the next 4 are gone and the insert and its qualities are what follows');
  ok('umi-tools-extract', /Reads output: \d+/.test(read(dir, 'umi_extract.log')), 'the extraction log reports the reads written');

  // --- bowtie2 removal: a read leaves a step only when it did not match ------
  const logs = ['rrna', 'trna', 'ncrna'].map((n) => bowtie2Summary(read(dir, `${n}_removal.log`)));
  const keptCounts = ['rRNA', 'tRNA', 'ncRNA'].map((n) => fastqReads(f(`no_${n}.fastq.gz`)));
  ok('bowtie2-remove-reads', logs[0].reads === umiReads, 'the rRNA step read every extracted read');
  ok('bowtie2-remove-reads', logs[1].reads === keptCounts[0] && logs[2].reads === keptCounts[1], 'each removal step read exactly the reads the one before kept');
  ok('bowtie2-remove-reads', logs.every((l, i) => l.unaligned === keptCounts[i]), 'the reads kept are the ones that aligned 0 times, per the alignment summary');
  ok('bowtie2-remove-reads', umiReads > keptCounts[0] && keptCounts[0] > keptCounts[1] && keptCounts[1] > keptCounts[2] && keptCounts[2] > 0, `reads fall at every depletion step: ${umiReads} extracted, ${keptCounts[0]} without rRNA, ${keptCounts[1]} without tRNA, ${keptCounts[2]} without ncRNA`);
  ok('bowtie2-remove-reads', logs.every((l) => l.reads > 0 && l.rate > 0), 'each alignment summary states how many reads it read and how many matched');
  ok('bowtie2-remove-reads', logs[0].rate > 55 && logs[0].rate < 85, `rRNA takes most of a footprint library (${logs[0].rate}%)`);
  ok('bowtie2-remove-reads', logs[1].rate > 1 && logs[1].rate < 20 && logs[2].rate > 3 && logs[2].rate < 35, `tRNA (${logs[1].rate}%) and ncRNA (${logs[2].rate}%) take a smaller share`);
  if (!full) {
    const kept = readFastq(f('no_ncRNA.fastq.gz'));
    const idsBefore = new Set(umi.names.map(idOf));
    ok('bowtie2-remove-reads', kept.names.every((n) => idsBefore.has(idOf(n))), 'the reads left are a subset of the extracted reads, unchanged');
    const seqOf = new Map(umi.names.map((n, i) => [idOf(n), umi.seqs[i]]));
    ok('bowtie2-remove-reads', kept.names.every((n, i) => seqOf.get(idOf(n)) === kept.seqs[i] && kept.seqs[i].length === kept.quals[i].length), 'the sequences of the reads left are the extracted ones, quality lengths equal');
    // --reorder: the reads left come out in the order they went in.
    const pos = new Map(umi.names.map((n, i) => [idOf(n), i]));
    const inputOrder = kept.names.map((n) => pos.get(idOf(n))!);
    ok('bowtie2-remove-reads', inputOrder.every((p, i) => i === 0 || p > inputOrder[i - 1]), 'the reads left keep the order of the input (--reorder)');
  }

  // --- STAR: transcript coordinates, unmapped kept, no genome BAM -------------
  const star = read(dir, 'star_riboseq/Log.final.out');
  ok('star-riboseq', starLog(star, 'Number of input reads') === keptCounts[2], 'STAR read every read the last removal step kept');
  ok('star-riboseq', starLog(star, 'Uniquely mapped reads %') > 5, `reads align (${starLog(star, 'Uniquely mapped reads %')}% uniquely)`);
  ok('star-riboseq', starLog(star, 'Number of reads mapped to multiple loci') === 0, 'with one place allowed, no read maps to several loci');
  const txBam = f('star_riboseq/Aligned.toTranscriptome.out.bam');
  ok('star-riboseq', exists(dir, 'star_riboseq/Aligned.toTranscriptome.out.bam'), 'the transcript-coordinate BAM exists');
  ok('star-riboseq', !exists(dir, 'star_riboseq/Aligned.sortedByCoord.out.bam'), 'no genome BAM was written (not asked for)');
  const txHeader = samtools('view', '-H', txBam);
  ok('star-riboseq', /^@SQ\tSN:ENST\d+/m.test(txHeader), 'the BAM is aligned to transcripts (ENST names), not chromosomes');
  // Every transcript the BAM is aligned to, and every one a read landed on, is a transcript of the GTF.
  const gtfTranscripts = new Set<string>();
  for (const line of fs.readFileSync(f('ribo_genes.gtf'), 'utf8').split('\n')) {
    if (line.startsWith('#')) continue;
    const cols = line.split('\t');
    if (cols[2] === 'transcript') gtfTranscripts.add(/transcript_id "([^"]+)"/.exec(cols[8])?.[1] ?? '');
  }
  const bamTranscripts = [...txHeader.matchAll(/^@SQ\tSN:(\S+)/gm)].map((m) => m[1]);
  ok('star-riboseq', gtfTranscripts.size > 1000 && bamTranscripts.length === gtfTranscripts.size && bamTranscripts.every((t) => gtfTranscripts.has(t)), `the ${bamTranscripts.length} transcripts of the BAM header are exactly the ${gtfTranscripts.size} transcripts of the GTF, same ids`);
  const samtoolsPath = path.join(SANDBOX, 'home', '.rustrunner', 'micromamba', 'envs', 'samtools-1.24', 'bin', 'samtools');
  const hitIds = run('sh', ['-c', '"$1" view -F 4 "$2" | cut -f3 | sort -u', 'sh', samtoolsPath, txBam]).stdout.split('\n').filter(Boolean);
  ok('star-riboseq', hitIds.length > 100 && hitIds.every((t) => gtfTranscripts.has(t)), `reads landed on ${hitIds.length} transcripts and every one is in the GTF`);
  const txUnmapped = count(txBam, '-f', '4');
  const txMapped = count(txBam, '-F', '4');
  ok('star-riboseq', txUnmapped > 0 && txMapped > 0, `--outSAMunmapped Within keeps unmapped reads in the BAM (${txUnmapped}) beside the mapped (${txMapped})`);
  const firstAlignments = run('sh', ['-c', 'exec "$1" view "$2" | head -n 200000', 'sh', samtoolsPath, txBam]).stdout;
  const cigars = firstAlignments.split('\n').filter(Boolean).map((l) => l.split('\t')[5]);
  ok('star-riboseq', cigars.every((c) => c === '*' || /^\d+M$/.test(c)), 'no alignment among the first 200 000 of the transcript BAM has soft clipping or an indel (end to end, transcript output rules)');

  // --- samtools view / sort / index ---------------------------------------------
  const expectedMapped = count(txBam, '-q', '20', '-F', '4', '-G', '16');
  ok('samtools-view', count(f('mapped.bam')) === expectedMapped && expectedMapped > 0, `view kept the ${expectedMapped} mapped, forward-strand, MAPQ 20 alignments`);
  ok('samtools-view', count(f('mapped.bam'), '-f', '4') === 0 && count(f('mapped.bam'), '-f', '16') === 0, 'the filtered BAM has no unmapped and no reverse-strand alignment');
  ok('samtools-sort', /SO:coordinate/.test(samtools('view', '-H', f('sorted.bam'))) && count(f('sorted.bam')) === expectedMapped, 'sort wrote a coordinate-sorted BAM with every alignment');
  ok('samtools-index', exists(dir, 'sorted.bam.bai'), 'the BAM index is next to the sorted BAM');

  // --- UMI-tools dedup -------------------------------------------------------------
  const dedupCount = count(f('deduplicated.bam'));
  ok('umi-tools-dedup', dedupCount > 0 && dedupCount < expectedMapped && dedupCount >= 0.8 * expectedMapped, `a nonzero fraction of the alignments was removed as duplicates: ${expectedMapped} to ${dedupCount} (${((100 * (expectedMapped - dedupCount)) / expectedMapped).toFixed(2)}% removed)`);
  const dedupLog = read(dir, 'umi_dedup.log');
  ok('umi-tools-dedup', Number(/Number of reads out: (\d+)/.exec(dedupLog)?.[1]) === dedupCount, 'the log and the BAM agree on how many reads are left');
  ok('umi-tools-dedup', Number(/Input Reads: (\d+)/.exec(dedupLog)?.[1]) === expectedMapped, 'the log says every sorted alignment went in');
  ok('umi-tools-dedup', /--method=directional|method\s+: directional/.test(dedupLog) && /read_length\s+: True/.test(dedupLog) && /random_seed\s+: 1/.test(dedupLog), 'the log shows directional, read length and seed 1');
  ok('umi-tools-dedup', exists(dir, 'umi_stats/dedup_edit_distance.tsv') && exists(dir, 'umi_stats/dedup_per_umi.tsv'), 'the UMI statistics tables are in the stats folder');
  const names = samtools('view', f('deduplicated.bam')).split('\n').filter(Boolean).map((l) => l.split('\t')[0]);
  ok('umi-tools-dedup', names.every((n) => /_[ACGT]{12}$/.test(n)) && new Set(names).size === names.length, 'every read left is one read with a UMI in its name');
  const sortedNames = new Set(samtools('view', f('sorted.bam')).split('\n').filter(Boolean).map((l) => l.split('\t')[0]));
  ok('umi-tools-dedup', names.every((n) => sortedNames.has(n)), 'the reads left are reads of the input, not new ones');

  // --- riboWaltz report -----------------------------------------------------------------
  const html = read(dir, 'ribowaltz/ribowaltz_report.html');
  const images = (html.match(/src="data:image\/png;base64,[A-Za-z0-9+/=]{100,}"/g) ?? []).length;
  const page = parseReport(html);
  ok('ribowaltz-report', page.problems.length === 0 && page.title === 'riboWaltz report', `the report parses as HTML with every element closed in order and a title${page.problems.length ? ` (${page.problems.join('; ')})` : ''}`);
  ok('ribowaltz-report', page.external.length === 0 && page.active.length === 0 && !/https?:\/\//.test(html.replace(/data:image\/png;base64,[A-Za-z0-9+/=]+/g, '')), 'the page is self-contained: no script, no stylesheet link, no web font, no external address');
  ok('ribowaltz-report', page.figures.length === images && page.figures.every((fig) => fig.width >= 300 && fig.height >= 150), `every one of the ${page.figures.length} inline figures decodes to a real PNG of at least 300 x 150 pixels`);
  ok('ribowaltz-report', ['Read lengths', 'P-site offsets', '3-nucleotide periodicity', 'Profiles around start and stop codons', 'P-sites per region', 'Codon usage'].every((h) => html.includes(`<h2>${h}</h2>`)), 'every section of the report is there');
  const samples = tsv(read(dir, 'ribowaltz/samples.tsv'));
  ok('ribowaltz-report', samples.length === 1 && Number(samples[0].reads) === dedupCount, `riboWaltz read exactly the ${dedupCount} deduplicated alignments`);
  const lengths = tsv(read(dir, 'ribowaltz/read_lengths.tsv'));
  ok('ribowaltz-report', lengths.reduce((n, r) => n + Number(r.reads), 0) === dedupCount && lengths.every((r) => Number(r.length) >= 20), 'read_lengths.tsv adds up to the BAM');
  const modal = lengths.reduce((a, b) => (Number(b.reads) > Number(a.reads) ? b : a));
  ok('ribowaltz-report', Number(modal.length) >= 29 && Number(modal.length) <= 33, `the most common footprint length is ${modal.length} nt (the library peaks at 31 to 32)`);
  const offsets = tsv(read(dir, 'ribowaltz/psite_offsets.tsv'));
  const degraded = html.includes('could not estimate the P-site offsets');
  if (full) {
    ok('ribowaltz-report', !degraded && offsets.length >= 5, `riboWaltz found offsets for ${offsets.length} read lengths`);
    // The P-site offset of the lengths that carry the signal: DATA.md's start-codon pile-up is at 12 to 13 nt.
    const inWindow = lengths.filter((r) => Number(r.length) >= 28 && Number(r.length) <= 34);
    const top = Math.max(...inWindow.map((r) => Number(r.reads)));
    const dominant = inWindow.filter((r) => Number(r.reads) >= 0.75 * top).map((r) => Number(r.length));
    const offsetOf = (len: number) => Number(offsets.find((r) => Number(r.length) === len)?.corrected_offset_from_5);
    ok('ribowaltz-report', dominant.length >= 2 && dominant.every((len) => offsetOf(len) >= 12 && offsetOf(len) <= 13), `the P-site is 12 to 13 nt from the 5' end for the dominant lengths (${dominant.map((len) => `${len} nt: ${offsetOf(len)}`).join(', ')})`);
    ok('ribowaltz-report', offsets.every((r) => Number(r.corrected_offset_from_5) >= 11 && Number(r.corrected_offset_from_5) <= 14), `no length has an implausible offset (${offsets.map((r) => `${r.length}:${r.corrected_offset_from_5}`).join(' ')})`);
    ok('ribowaltz-report', images >= 7, `the report has ${images} figures: lengths, read ends, periodicity twice, profile, regions, codons`);
    // 3-nt periodicity: in the CDS the P-sites sit in frame 0 more than in the other two frames (a third each would be none).
    const frames = tsv(read(dir, 'ribowaltz/periodicity_by_region.tsv')).filter((r) => r.region === 'CDS');
    const frame = (n: number) => Number(frames.find((r) => Number(r.frame) === n)?.scaled_count);
    const inFrame = Number(samples[0].in_frame_percent);
    ok('ribowaltz-report', frames.length === 3 && frame(0) > frame(1) && frame(0) > frame(2) && frame(0) >= 40, `CDS P-sites are periodic with frame 0 dominant: frame 0 ${frame(0).toFixed(1)}%, frame 1 ${frame(1).toFixed(1)}%, frame 2 ${frame(2).toFixed(1)}%`);
    ok('ribowaltz-report', Math.abs(inFrame - frame(0)) < 0.01, `samples.tsv reports the same in-frame share (${inFrame.toFixed(1)}%)`);
    // CDS against the UTRs: enriched compared with the share of the transcript space the CDS takes.
    const regions = tsv(read(dir, 'ribowaltz/psites_per_region.tsv'));
    const share = (who: (s: string) => boolean, region: string) => Number(regions.find((r) => who(r.sample ?? '') && r.region === region)?.scaled_count);
    const mine = (s: string) => s !== 'RNAs';
    const rna = (s: string) => s === 'RNAs';
    const cds = share(mine, 'CDS');
    const enrichment = (region: string) => share(mine, region) / share(rna, region);
    ok('ribowaltz-report', cds > 80 && cds > share(mine, "5' UTR") + share(mine, "3' UTR"), `most P-sites are in the CDS (${cds.toFixed(1)}%), the UTRs hold ${share(mine, "5' UTR").toFixed(1)}% and ${share(mine, "3' UTR").toFixed(1)}%`);
    ok('ribowaltz-report', enrichment('CDS') > 1.5 && enrichment("3' UTR") < 0.25 && enrichment("5' UTR") < 1, `P-sites are enriched in the CDS against the transcript space (CDS ${enrichment('CDS').toFixed(2)}x, 5' UTR ${enrichment("5' UTR").toFixed(2)}x, 3' UTR ${enrichment("3' UTR").toFixed(2)}x of what position-blind reads would give)`);
    ok('ribowaltz-report', tsv(read(dir, 'ribowaltz/codon_usage.tsv')).length === 64, 'codon usage lists all 64 codons');
  } else if (degraded) {
    // Too few start-codon reads in 200 000 reads: the report must say so and must not make up offsets.
    ok('ribowaltz-report', offsets.length === 0, 'no offsets were invented when riboWaltz had too few reads over start codons');
    ok('ribowaltz-report', /role="alert"/.test(html) && /Sequence more reads/.test(html), 'the report starts with a plain warning that says what to do');
    ok('ribowaltz-report', images >= 2, `the figures that need no offsets are there (${images})`);
  } else {
    ok('ribowaltz-report', offsets.length >= 3 && images >= 7, `riboWaltz found offsets for ${offsets.length} read lengths and drew ${images} figures`);
  }
  ok('ribowaltz-report', exists(dir, 'ribowaltz/psite_offsets.tsv') && read(dir, 'ribowaltz/psite_offsets.tsv').startsWith('sample\tlength\t'), 'psite_offsets.tsv always exists, with its header');

  // --- the R helpers of the report script ---------------------------------------------------
  const rscript = path.join(SANDBOX, 'home', '.rustrunner', 'micromamba', 'envs', 'ribowaltz-2.0', 'bin', 'Rscript');
  const helpers = run(rscript, ['--vanilla', R_TEST, R_SCRIPT]);
  ok('ribowaltz-report', helpers.status === 0, `the R unit tests of the report script pass (${(helpers.stdout + helpers.stderr).trim().split('\n').slice(-3).join(' | ')})`);

  // --- MultiQC reads all of it ------------------------------------------------------------------
  const sources = tsv(read(dir, 'multiqc/multiqc_report_data/multiqc_sources.txt'));
  const modules = (m: string) => sources.filter((r) => r.Module === m).length;
  ok('multiqc', modules('FastQC') >= 4, `MultiQC read the FastQC reports of the four checkpoints (${modules('FastQC')})`);
  ok('multiqc', modules('Cutadapt') === 1, 'MultiQC read the cutadapt report');
  ok('multiqc', modules('UMI-tools') >= 2, `MultiQC read the UMI-tools extract and dedup logs (${modules('UMI-tools')})`);
  ok('multiqc', modules('Bowtie 2 / HiSAT2') === 3, 'MultiQC read the three depletion summaries as three samples');
  ok('multiqc', modules('STAR') === 1, 'MultiQC read the STAR summary');

  // Every check and its numbers, for reading after the run (the run folder is the sandbox's).
  fs.writeFileSync(path.join(dir, 'verification.txt'), `${lines.join('\n')}\n`);
  return checks;
}

