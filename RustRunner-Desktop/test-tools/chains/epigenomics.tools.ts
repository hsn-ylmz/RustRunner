/**
 * Epigenomics domain: ChIP-seq and ATAC-seq peak calling, signal tracks and
 * plots (deepTools), region arithmetic (bedtools) and peak annotation (HOMER).
 * Every chain is built the way the app builds it (see ../harness.ts) and joins
 * the new tools to each other and to catalog tools of the dna domain by file
 * slots, on the synthetic data of make_data.py: a 5 kb genome, a ChIP sample with
 * four enriched regions (`chip_peaks_truth.bed`), its input control, and an ATAC
 * sample with three open regions (`atac_regions_truth.bed`).
 *
 * Planted regions (0-based, as in the truth files), by where they lie in the
 * genes of genes.gtf: chip peak 1 on the promoter of geneA, 2 in an intron of
 * geneA, 3 in an exon of geneC, 4 on the promoter of geneB; ATAC regions at the
 * start of geneA, geneB and geneC. ChIP peaks 1 and 4 overlap ATAC regions.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { DATA, defineDomain, exists, read, sizeOf, type Chain, type Check } from '../harness';

// -----------------------------------------------------------------------------
// Small readers for the files the chains check
// -----------------------------------------------------------------------------

interface Region {
  contig: string;
  start: number;
  end: number;
  name: string;
  columns: string[];
}

/** The regions of a BED-like text (BED, narrowPeak, bedGraph), skipping header lines. */
function regions(text: string): Region[] {
  return text
    .split('\n')
    .filter((l) => l.trim() !== '' && !/^(#|track|browser)/.test(l))
    .map((line) => {
      const columns = line.split('\t');
      return { contig: columns[0], start: Number(columns[1]), end: Number(columns[2]), name: columns[3] ?? '', columns };
    });
}

/** The features of a GTF text: its start is 1-based, so it is moved to the BED convention. */
function gtfRegions(text: string): Region[] {
  return text
    .split('\n')
    .filter((l) => l.trim() !== '' && !l.startsWith('#'))
    .map((line) => {
      const columns = line.split('\t');
      return { contig: columns[0], start: Number(columns[3]) - 1, end: Number(columns[4]), name: columns[2], columns };
    });
}

const truthFile = (name: string): Region[] => regions(fs.readFileSync(path.join(DATA, name), 'utf8'));
const CHIP_TRUTH = (): Region[] => truthFile('chip_peaks_truth.bed');
const ATAC_TRUTH = (): Region[] => truthFile('atac_regions_truth.bed');

const overlap = (a: Region, b: Region): boolean => a.contig === b.contig && a.start < b.end && b.start < a.end;
const hits = (set: Region[], target: Region): Region[] => set.filter((r) => overlap(r, target));

/** The sequences of a FASTA text by the text after `>` up to the first space. */
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

const reference = (): Record<string, string> => fasta(fs.readFileSync(path.join(DATA, 'ref.fa'), 'utf8'));

function revcomp(seq: string): string {
  const pair: Record<string, string> = { A: 'T', C: 'G', G: 'C', T: 'A' };
  return [...seq].reverse().map((b) => pair[b] ?? 'N').join('');
}

/** Rows of a computeMatrix table (`--outFileNameMatrix`): one array of numbers per region. */
function matrixRows(text: string): number[][] {
  return text
    .split('\n')
    .filter((l) => l.trim() !== '' && !l.startsWith('#') && !l.startsWith('genes:'))
    .map((l) => l.split('\t').map(Number));
}

const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;

/** Width and height of a PNG, or null when the file is not one. */
function pngSize(dir: string, rel: string): { width: number; height: number } | null {
  const head = fs.readFileSync(path.join(dir, rel)).subarray(0, 24);
  if (head.readUInt32BE(0) !== 0x89504e47) return null;
  return { width: head.readUInt32BE(16), height: head.readUInt32BE(20) };
}

/** True when a file starts with the bigWig magic number (little endian 0x888FFC26). */
function isBigWig(dir: string, rel: string): boolean {
  return fs.readFileSync(path.join(dir, rel)).subarray(0, 4).readUInt32LE(0) === 0x888ffc26;
}

/** Rows of a tab-separated table with a header line, as objects. */
function table(text: string): Array<Record<string, string>> {
  const [head, ...rows] = text.trim().split('\n');
  const names = head.split('\t');
  return rows.map((row) => Object.fromEntries(row.split('\t').map((value, i) => [names[i], value])));
}

const lineCount = (dir: string, rel: string): number => read(dir, rel).split('\n').filter(Boolean).length;


/** The depth values of a bedGraph as `[start, end, depth]` per contig. */
function bedGraph(text: string): Array<{ contig: string; start: number; end: number; depth: number }> {
  return regions(text).map((r) => ({ contig: r.contig, start: r.start, end: r.end, depth: Number(r.columns[3]) }));
}

/** Mean depth of a bedGraph over a window, counting bases that no stretch lists as zero. */
function meanDepth(graph: ReturnType<typeof bedGraph>, window: Region): number {
  let total = 0;
  for (const g of graph) {
    if (g.contig !== window.contig) continue;
    const length = Math.min(g.end, window.end) - Math.max(g.start, window.start);
    if (length > 0) total += length * g.depth;
  }
  return total / (window.end - window.start);
}

/** The first of the two tables in a HOMER annotation summary, as `kind -> number of peaks`. */
function homerSummary(text: string): Record<string, number> {
  const out: Record<string, number> = {};
  const lines = text.split('\n').filter(Boolean);
  for (const line of lines.slice(1)) {
    if (line.startsWith('Annotation')) break;
    const [kind, count] = line.split('\t');
    out[kind] = Number(count);
  }
  return out;
}

/** HOMER's annotated peaks with the row of each peak found by overlap (HOMER starts at 1). */
function homerRows(text: string): Array<Region & { annotation: string; nearest: string; distance: number }> {
  return table(text).map((row) => {
    const keys = Object.keys(row);
    return {
      contig: row.Chr,
      start: Number(row.Start) - 1,
      end: Number(row.End),
      name: row[keys[0]],
      columns: [],
      annotation: row.Annotation,
      nearest: row['Nearest PromoterID'],
      distance: Number(row['Distance to TSS']),
    };
  });
}

const ok = (tool: string, condition: boolean, message: string): Check => ({ tool, ok: condition, message });

// -----------------------------------------------------------------------------
// Chains
// -----------------------------------------------------------------------------

const CHAINS: Chain[] = [
  {
    // The whole ChIP-seq path on paired reads: align, sort, index, call peaks
    // against the input, make signal tracks, draw the signal around the peaks.
    name: 'chip-macs3-deeptools',
    files: ['ref.fa', 'chip_R1.fastq.gz', 'chip_R2.fastq.gz', 'input_R1.fastq.gz', 'input_R2.fastq.gz'],
    nodes: [
      { key: 'faidx', catalog: 'samtools-faidx', files: { ref: 'ref.fa' } },
      { key: 'mmchip', catalog: 'minimap2', params: { sample_name: 'chip' }, files: { reads1: 'chip_R1.fastq.gz', reads2: 'chip_R2.fastq.gz', sam: 'chip.sam' } },
      { key: 'mminput', catalog: 'minimap2', params: { sample_name: 'input' }, files: { reads1: 'input_R1.fastq.gz', reads2: 'input_R2.fastq.gz', sam: 'input.sam' } },
      { key: 'sortchip', catalog: 'samtools-sort', files: { bam: 'chip.sorted.bam' } },
      { key: 'sortinput', catalog: 'samtools-sort', files: { bam: 'input.sorted.bam' } },
      { key: 'idxchip', catalog: 'samtools-index', files: { bai: 'chip.sorted.bam.bai' } },
      { key: 'idxinput', catalog: 'samtools-index', files: { bai: 'input.sorted.bam.bai' } },
      { key: 'macs3', catalog: 'macs3-callpeak', params: { genome_size: '5000' } },
      { key: 'covchip', catalog: 'deeptools-bamcoverage', params: { extend: '--extendReads' }, files: { coverage: 'chip.bw' } },
      { key: 'covinput', catalog: 'deeptools-bamcoverage', params: { extend: '--extendReads' }, files: { coverage: 'input.bw' } },
      { key: 'matrix', catalog: 'deeptools-computematrix', params: { upstream: 500, downstream: 500 } },
      { key: 'heat', catalog: 'deeptools-plotheatmap', params: { title: 'ChIP and input at the peaks' } },
      { key: 'fp', catalog: 'deeptools-plotfingerprint', params: { sample_regions: 400, extend: '--extendReads' } },
    ],
    edges: [
      ['faidx', 'mmchip'],
      ['faidx', 'mminput'],
      ['mmchip', 'sortchip'],
      ['mminput', 'sortinput'],
      ['sortchip', 'idxchip'],
      ['sortinput', 'idxinput'],
      ['sortchip', 'macs3'],
      ['sortinput', 'macs3'],
      ['sortchip', 'covchip'],
      ['idxchip', 'covchip'],
      ['sortinput', 'covinput'],
      ['idxinput', 'covinput'],
      ['covchip', 'matrix'],
      ['covinput', 'matrix'],
      ['macs3', 'matrix'],
      ['matrix', 'heat'],
      ['sortchip', 'fp'],
      ['sortinput', 'fp'],
      ['idxchip', 'fp'],
      ['idxinput', 'fp'],
    ],
    bindings: {
      'macs3>matrix': [{ slot: 'regions', output: 'peaks' }],
    },
    verify: (dir) => {
      const peaks = regions(read(dir, 'macs3/sample_peaks.narrowPeak'));
      const summits = regions(read(dir, 'macs3/sample_summits.bed'));
      const truth = CHIP_TRUTH();
      const rows = matrixRows(read(dir, 'matrix_values.tsv'));
      const bins = 20; // 1000 bases in bins of 50
      // Columns: the ChIP track first (the order the tracks were connected), then the input.
      const centre = (row: number[], from: number) => mean(row.slice(from + 8, from + 12));
      const sortedRegions = regions(read(dir, 'matrix_regions.bed'));
      const metrics = table(read(dir, 'fingerprint_metrics.tsv'));
      const auc = (sample: string) => Number(metrics.find((m) => m.Sample === sample)?.AUC);
      const heat = pngSize(dir, 'heatmap.png');
      const fp = pngSize(dir, 'fingerprint.png');
      return [
        ok('macs3-callpeak', peaks.length === truth.length, `one peak for each of the ${truth.length} planted regions (${peaks.length})`),
        ok('macs3-callpeak', truth.every((t) => hits(peaks, t).length === 1), 'every planted region holds exactly one peak'),
        ok('macs3-callpeak', peaks.every((p) => hits(truth, p).length === 1), 'no peak lies outside the planted regions'),
        ok('macs3-callpeak', summits.length === peaks.length && summits.every((s) => hits(truth, s).length === 1), 'each summit lies inside a planted region'),
        ok('macs3-callpeak', /fold_enrichment/.test(read(dir, 'macs3/sample_peaks.xls')), 'the peak table has its header'),
        ok(
          'macs3-callpeak',
          /# ChIP-seq file = \['chip\.sorted\.bam'\]/.test(read(dir, 'macs3/sample_peaks.xls')) && /# control file = \['input\.sorted\.bam'\]/.test(read(dir, 'macs3/sample_peaks.xls')),
          'MACS3 read the ChIP as treatment and the input as control'
        ),
        ok('macs3-callpeak', regions(read(dir, 'macs3/sample_treat_pileup.bdg')).length > 10, 'the signal track has stretches'),
        ok('deeptools-bamcoverage', isBigWig(dir, 'chip.bw') && isBigWig(dir, 'input.bw'), 'both signal tracks are bigWig files'),
        ok('deeptools-computematrix', rows.length === peaks.length && rows.every((r) => r.length === 2 * bins), `${peaks.length} regions, ${2 * bins} bins each (two tracks)`),
        ok(
          'deeptools-computematrix',
          rows.every((r) => centre(r, 0) > 2 * centre(r, bins)),
          'at every peak the ChIP signal is more than twice the input signal at the centre'
        ),
        ok('deeptools-computematrix', sortedRegions.length === peaks.length && sortedRegions.every((s) => hits(peaks, s).length === 1), 'the regions file lists the peaks'),
        ok('deeptools-plotheatmap', heat !== null && heat.width > 300 && heat.height > 300, `the heatmap is a PNG (${heat?.width}x${heat?.height})`),
        ok('deeptools-plotfingerprint', fp !== null && fp.width > 300, 'the fingerprint plot is a PNG'),
        ok('deeptools-plotfingerprint', metrics.length === 2, 'the metrics have a row for each sample'),
        ok(
          'deeptools-plotfingerprint',
          auc('chip.sorted.bam') < auc('input.sorted.bam') - 0.1,
          `the ChIP is more enriched than the input: its curve lies lower (AUC ${auc('chip.sorted.bam').toFixed(2)} against ${auc('input.sorted.bam').toFixed(2)})`
        ),
      ];
    },
  },
  {
    // ATAC-seq: Genrich on name-sorted alignments, with and without a list of
    // regions to ignore, then bedtools on its peaks and on the alignments.
    name: 'atac-genrich-bedtools',
    files: ['ref.fa', 'atac_R1.fastq.gz', 'atac_R2.fastq.gz', 'input_R1.fastq.gz', 'input_R2.fastq.gz', 'blacklist.bed'],
    nodes: [
      { key: 'faidx', catalog: 'samtools-faidx', files: { ref: 'ref.fa' } },
      { key: 'mm', catalog: 'minimap2', params: { sample_name: 'atac' }, files: { reads1: 'atac_R1.fastq.gz', reads2: 'atac_R2.fastq.gz', sam: 'atac.sam' } },
      { key: 'mmctl', catalog: 'minimap2', params: { sample_name: 'control' }, files: { reads1: 'input_R1.fastq.gz', reads2: 'input_R2.fastq.gz', sam: 'control.sam' } },
      { key: 'sortctl', catalog: 'samtools-sort', params: { by_name: true }, files: { bam: 'control.byname.bam' } },
      { key: 'sortn', catalog: 'samtools-sort', params: { by_name: true }, files: { bam: 'atac.byname.bam' } },
      { key: 'sortc', catalog: 'samtools-sort', files: { bam: 'atac.sorted.bam' } },
      { key: 'gen1', catalog: 'genrich' },
      // A control picked by typing its file name: the connection only fixes the order.
      { key: 'gen3', catalog: 'genrich', files: { control: 'control.byname.bam', peaks: 'genrich_control.narrowPeak' } },
      {
        key: 'gen2',
        catalog: 'genrich',
        params: { atac_mode: false, skip_chroms: '', min_length: 100 },
        files: { blacklist: 'blacklist.bed', peaks: 'genrich_blacklisted.narrowPeak' },
      },
      { key: 'covall', catalog: 'bedtools-genomecov', params: { mode: '-bga', fragments: true }, files: { coverage: 'coverage_all.bedgraph' } },
      { key: 'covtwice', catalog: 'bedtools-genomecov', params: { fragments: true, scale: 2 }, files: { coverage: 'coverage_twice.bedgraph' } },
      { key: 'inside', catalog: 'bedtools-intersect', files: { b: 'blacklist.bed', result: 'peaks_in_blacklist.bed' } },
      { key: 'outside', catalog: 'bedtools-intersect', params: { mode: '-v' }, files: { b: 'blacklist.bed', result: 'peaks_outside_blacklist.bed' } },
      { key: 'merge', catalog: 'bedtools-merge', params: { count: true } },
      { key: 'fasta', catalog: 'bedtools-getfasta' },
    ],
    edges: [
      ['faidx', 'mm'],
      ['faidx', 'mmctl'],
      ['mm', 'sortn'],
      ['mm', 'sortc'],
      ['mmctl', 'sortctl'],
      ['sortn', 'gen1'],
      ['sortn', 'gen2'],
      ['sortn', 'gen3'],
      ['sortctl', 'gen3', 'after'],
      ['sortc', 'covall'],
      ['sortc', 'covtwice'],
      ['gen1', 'inside'],
      ['gen1', 'outside'],
      ['gen1', 'merge'],
      ['gen2', 'merge'],
      ['merge', 'fasta'],
      ['faidx', 'fasta'],
    ],
    verify: (dir) => {
      const truth = ATAC_TRUTH();
      const peaks = regions(read(dir, 'genrich_peaks.narrowPeak'));
      const blacklisted = regions(read(dir, 'genrich_blacklisted.narrowPeak'));
      const controlled = regions(read(dir, 'genrich_control.narrowPeak'));
      const blacklist = regions(read(dir, 'blacklist.bed'))[0];
      const all = bedGraph(read(dir, 'coverage_all.bedgraph'));
      const twice = bedGraph(read(dir, 'coverage_twice.bedgraph'));
      const merged = regions(read(dir, 'merged.bed'));
      const sequences = fasta(read(dir, 'regions.fa'));
      const genome = reference();
      const quiet: Region = { contig: 'chr1', start: 1200, end: 2200, name: '', columns: [] };
      return [
        ok('genrich', peaks.length === truth.length && truth.every((t) => hits(peaks, t).length === 1), `ATAC mode: exactly one peak in each of the ${truth.length} open regions (${peaks.length} peaks)`),
        ok('genrich', peaks.every((p) => hits(truth, p).length === 1), 'ATAC mode: no peak outside the open regions'),
        ok('genrich', peaks.every((p) => p.columns.length === 10), 'the peaks are written in narrowPeak format (10 columns)'),
        ok('genrich', blacklisted.length > 0 && blacklisted.every((p) => !overlap(p, blacklist)), 'with regions to ignore, no peak overlaps them'),
        ok('genrich', hits(blacklisted, truth[1]).length > 0 && hits(blacklisted, truth[2]).length > 0 && hits(blacklisted, truth[0]).length === 0, 'the open regions outside the ignored one are still found (here with ATAC mode off)'),
        ok(
          'genrich',
          controlled.length > 0 && controlled.every((p) => hits(truth, p).length === 1) && controlled.map((p) => p.columns[6]).join() !== peaks.map((p) => p.columns[6]).join(),
          'with a control the peaks still lie in the open regions, and their signal differs from the run without one'
        ),
        ok('bedtools-intersect', regions(read(dir, 'peaks_in_blacklist.bed')).length === 1 && overlap(regions(read(dir, 'peaks_in_blacklist.bed'))[0], blacklist), 'intersect keeps the one peak that overlaps the ignore list'),
        ok(
          'bedtools-intersect',
          regions(read(dir, 'peaks_outside_blacklist.bed')).length === peaks.length - 1 && regions(read(dir, 'peaks_outside_blacklist.bed')).every((p) => !overlap(p, blacklist)),
          'intersect with "does not overlap" keeps the other peaks'
        ),
        ok('bedtools-genomecov', all.reduce((n, g) => n + g.end - g.start, 0) === 5000, 'writing every stretch covers all 5000 bases of the genome'),
        ok('bedtools-genomecov', all.some((g) => g.depth === 0), 'stretches with no reads are listed'),
        ok(
          'bedtools-genomecov',
          meanDepth(all, { ...truth[0], start: truth[0].start + 50, end: truth[0].end - 50 }) > 4 * meanDepth(all, quiet),
          'the open region is covered much more deeply than a quiet stretch of chr1'
        ),
        ok(
          'bedtools-genomecov',
          twice.every((g) => g.depth > 0) && twice.length === all.filter((g) => g.depth > 0).length && twice.every((g, i) => g.depth === 2 * all.filter((a) => a.depth > 0)[i].depth),
          'with a scale of 2 only covered stretches are written, each with double the depth'
        ),
        ok(
          'bedtools-merge',
          merged.length === truth.length && merged.map((m) => m.columns[3]).join(',') === '1,2,2',
          `the peaks of both runs merge into ${truth.length} regions, joined from 1, 2 and 2 peaks (${merged.map((m) => m.columns[3]).join(',')})`
        ),
        ok('bedtools-merge', truth.every((t) => hits(merged, t).length === 1), 'every open region lies in one merged region'),
        ok(
          'bedtools-getfasta',
          Object.keys(sequences).length === merged.length && merged.every((m) => sequences[`${m.contig}:${m.start}-${m.end}`] === genome[m.contig].slice(m.start, m.end)),
          'each sequence is exactly the genome between the start and end of its merged region'
        ),
      ];
    },
  },

  {
    // ChIP and ATAC peaks compared: overlap sets, a union, HOMER's view of where
    // the peaks lie, and the sequences under the shared ones.
    name: 'chip-atac-overlap-and-annotation',
    files: ['ref.fa', 'genes.gtf', 'chip_R1.fastq.gz', 'chip_R2.fastq.gz', 'atac_R1.fastq.gz', 'atac_R2.fastq.gz'],
    nodes: [
      { key: 'faidx', catalog: 'samtools-faidx', files: { ref: 'ref.fa' } },
      { key: 'mmchip', catalog: 'minimap2', params: { sample_name: 'chip' }, files: { reads1: 'chip_R1.fastq.gz', reads2: 'chip_R2.fastq.gz', sam: 'chip.sam' } },
      { key: 'mmatac', catalog: 'minimap2', params: { sample_name: 'atac' }, files: { reads1: 'atac_R1.fastq.gz', reads2: 'atac_R2.fastq.gz', sam: 'atac.sam' } },
      { key: 'sortchip', catalog: 'samtools-sort', files: { bam: 'chip.sorted.bam' } },
      { key: 'sortatac', catalog: 'samtools-sort', params: { by_name: true }, files: { bam: 'atac.byname.bam' } },
      { key: 'macs3', catalog: 'macs3-callpeak', params: { genome_size: '5000' } },
      { key: 'genrich', catalog: 'genrich' },
      { key: 'shared', catalog: 'bedtools-intersect', files: { result: 'shared_peaks.bed' } },
      { key: 'chiponly', catalog: 'bedtools-intersect', params: { mode: '-v' }, files: { result: 'chip_only_peaks.bed' } },
      {
        key: 'counted',
        catalog: 'bedtools-intersect',
        params: { mode: '-c', min_overlap: '0.3', reciprocal: true },
        files: { result: 'overlap_counts.bed' },
      },
      { key: 'union', catalog: 'bedtools-merge', files: { merged: 'union_peaks.bed' } },
      { key: 'homer', catalog: 'homer-annotatepeaks', files: { annotation: 'genes.gtf', annotated: 'chip_annotated.tsv', stats: 'chip_annotation_summary.txt' } },
      { key: 'homershared', catalog: 'homer-annotatepeaks', files: { annotation: 'genes.gtf', annotated: 'shared_annotated.tsv', stats: 'shared_annotation_summary.txt' } },
      { key: 'fasta', catalog: 'bedtools-getfasta', params: { names: '-nameOnly' }, files: { sequences: 'shared_peaks.fa' } },
    ],
    edges: [
      ['faidx', 'mmchip'],
      ['faidx', 'mmatac'],
      ['mmchip', 'sortchip'],
      ['mmatac', 'sortatac'],
      ['sortchip', 'macs3'],
      ['sortatac', 'genrich'],
      ['macs3', 'shared'],
      ['genrich', 'shared'],
      ['macs3', 'chiponly'],
      ['genrich', 'chiponly'],
      ['macs3', 'counted'],
      ['genrich', 'counted'],
      ['macs3', 'union'],
      ['genrich', 'union'],
      ['macs3', 'homer'],
      ['faidx', 'homer'],
      ['shared', 'homershared'],
      ['faidx', 'homershared'],
      ['shared', 'fasta'],
      ['faidx', 'fasta'],
    ],
    bindings: {
      'macs3>shared': [{ slot: 'a', output: 'peaks' }],
      'genrich>shared': [{ slot: 'b', output: 'peaks' }],
      'macs3>chiponly': [{ slot: 'a', output: 'peaks' }],
      'genrich>chiponly': [{ slot: 'b', output: 'peaks' }],
      'macs3>counted': [{ slot: 'a', output: 'peaks' }],
      'genrich>counted': [{ slot: 'b', output: 'peaks' }],
      'macs3>union': [{ slot: 'intervals', output: 'peaks' }],
      'macs3>homer': [{ slot: 'peaks', output: 'peaks' }],
    },
    verify: (dir) => {
      const chipTruth = CHIP_TRUTH();
      const atacTruth = ATAC_TRUTH();
      const chip = regions(read(dir, 'macs3/sample_peaks.narrowPeak'));
      const atac = regions(read(dir, 'genrich_peaks.narrowPeak'));
      const shared = regions(read(dir, 'shared_peaks.bed'));
      const only = regions(read(dir, 'chip_only_peaks.bed'));
      const counted = regions(read(dir, 'overlap_counts.bed'));
      const union = regions(read(dir, 'union_peaks.bed'));
      // The ChIP regions that lie on an open region of the ATAC sample, and those that do not.
      const open = chipTruth.map((t) => atacTruth.some((a) => overlap(a, t)));
      const sharedTruth = chipTruth.filter((_, i) => open[i]);
      const onlyTruth = chipTruth.filter((_, i) => !open[i]);
      const annotated = homerRows(read(dir, 'chip_annotated.tsv'));
      const row = (t: Region) => annotated.find((r) => overlap(r, t));
      const summary = homerSummary(read(dir, 'chip_annotation_summary.txt'));
      const sharedRows = homerRows(read(dir, 'shared_annotated.tsv'));
      const sequences = fasta(read(dir, 'shared_peaks.fa'));
      const genome = reference();
      return [
        ok('macs3-callpeak', chip.length === chipTruth.length, `MACS3 without a control still finds the ${chipTruth.length} planted peaks (${chip.length})`),
        ok('genrich', atac.length === atacTruth.length, `Genrich finds the ${atacTruth.length} open regions (${atac.length})`),
        ok('bedtools-intersect', open.filter(Boolean).length === 2, 'two of the four ChIP regions lie on open chromatin (the planted design)'),
        ok(
          'bedtools-intersect',
          shared.length === sharedTruth.length && sharedTruth.every((t) => hits(shared, t).length === 1) && shared.every((p) => p.columns.length === 10),
          'the shared set is exactly the ChIP peaks on open chromatin, with all ten narrowPeak columns kept'
        ),
        ok(
          'bedtools-intersect',
          only.length === onlyTruth.length && onlyTruth.every((t) => hits(only, t).length === 1) && only.length + shared.length === chip.length,
          'the ChIP-only set is the rest, and the two sets together are all the ChIP peaks'
        ),
        ok(
          'bedtools-intersect',
          counted.length === chip.length && counted.every((p) => p.columns.length === 11 && Number(p.columns[10]) === (sharedTruth.some((t) => overlap(t, p)) ? 1 : 0)),
          'counting with a minimum overlap gives 1 for the shared peaks and 0 for the others, one line for every ChIP peak'
        ),
        ok('bedtools-merge', union.length === 5, `the union of 4 ChIP and 3 ATAC peaks is 5 regions (${union.length})`),
        ok('bedtools-merge', chipTruth.every((t) => hits(union, t).length === 1) && atacTruth.every((t) => hits(union, t).length === 1), 'every ChIP and ATAC region lies in one union region'),
        ok('homer-annotatepeaks', annotated.length === chip.length, 'one annotated row for every peak'),
        ok('homer-annotatepeaks', /^promoter-TSS \(txA\)/.test(row(chipTruth[0])?.annotation ?? ''), 'the peak on the promoter of geneA is called a promoter of txA'),
        ok('homer-annotatepeaks', /^promoter-TSS \(txB\)/.test(row(chipTruth[3])?.annotation ?? ''), 'the peak on the promoter of geneB is called a promoter of txB'),
        ok('homer-annotatepeaks', /^exon \(txC/.test(row(chipTruth[2])?.annotation ?? ''), 'the peak in the exon of geneC is called an exon of txC'),
        ok('homer-annotatepeaks', row(chipTruth[1])?.nearest === 'txA', 'the peak inside geneA is closest to txA'),
        ok('homer-annotatepeaks', Math.abs(row(chipTruth[0])?.distance ?? 9999) < 100, 'the promoter peak is within 100 bases of the gene start'),
        ok('homer-annotatepeaks', summary.Promoter === 2 && summary.Exon === 1 && summary.TTS === 1 && summary.Intron === 0, `the summary counts 2 promoter, 1 exon and 1 end-of-gene peaks (${JSON.stringify(summary)})`),
        ok(
          'homer-annotatepeaks',
          sharedRows.length === shared.length && sharedRows.every((r) => /^promoter-TSS/.test(r.annotation)),
          'peaks handed over from bedtools intersect are annotated too: both shared peaks are on promoters'
        ),
        ok(
          'bedtools-getfasta',
          Object.keys(sequences).length === shared.length && shared.every((p) => sequences[p.name] === genome[p.contig].slice(p.start, p.end)),
          'named by the name column, each sequence is exactly the genome under its shared peak'
        ),
      ];
    },
  },

  {
    // Single-end ChIP reads with the less common options: MACS3 in single-end
    // mode with summits, scaled and filtered tracks, regions to leave out,
    // genes as regions, other plot settings, strand-aware sequences.
    name: 'chip-single-end-options',
    files: ['ref.fa', 'genes.gtf', 'blacklist.bed', 'chip_R1.fastq.gz'],
    nodes: [
      { key: 'faidx', catalog: 'samtools-faidx', files: { ref: 'ref.fa' } },
      { key: 'mm', catalog: 'minimap2', params: { sample_name: 'chip' }, files: { reads1: 'chip_R1.fastq.gz', sam: 'chip.sam' } },
      { key: 'sort', catalog: 'samtools-sort', files: { bam: 'chip.sorted.bam' } },
      { key: 'index', catalog: 'samtools-index', files: { bai: 'chip.sorted.bam.bai' } },
      {
        key: 'macs3',
        catalog: 'macs3-callpeak',
        params: { format: 'BAM', genome_size: '5000', fragment_length: 220, keep_dup: 'all', call_summits: true },
      },
      {
        key: 'cov',
        catalog: 'deeptools-bamcoverage',
        params: { normalize: 'RPKM', bin_size: 25, min_mapq: 10, ignore_dup: true },
        files: { blacklist: 'blacklist.bed', coverage: 'chip_rpkm.bw' },
      },
      { key: 'peakmatrix', catalog: 'deeptools-computematrix', params: { upstream: 400, downstream: 400, bin_size: 25 }, files: { matrix: 'peak_matrix.mat.gz', sorted_regions: 'peak_matrix_regions.bed', values: 'peak_matrix_values.tsv' } },
      {
        key: 'genematrix',
        catalog: 'deeptools-computematrix',
        params: { reference_point: 'TSS', upstream: 300, downstream: 300, bin_size: 25, skip_zeros: true },
        files: { regions: 'genes.gtf', matrix: 'gene_matrix.mat.gz', sorted_regions: 'gene_matrix_regions.bed', values: 'gene_matrix_values.tsv' },
      },
      {
        key: 'heat',
        catalog: 'deeptools-plotheatmap',
        params: { color_map: 'viridis', sort_regions: 'ascend', sort_using: 'max', dpi: 100 },
        files: { heatmap: 'genes_heatmap.pdf' },
      },
      { key: 'fp', catalog: 'deeptools-plotfingerprint', params: { sample_regions: 300, bin_size: 100, skip_zeros: true } },
      { key: 'depth', catalog: 'bedtools-genomecov', params: { scale: 1000, split: true }, files: { coverage: 'chip_x1000.bedgraph' } },
      { key: 'genesfasta', catalog: 'bedtools-getfasta', params: { strand: true }, files: { regions: 'genes.gtf', sequences: 'genes.fa' } },
      {
        key: 'samestrand',
        catalog: 'bedtools-intersect',
        params: { strand: '-s', min_overlap: '0.9', reciprocal: true },
        files: { a: 'genes.gtf', b: 'genes.gtf', result: 'genes_same_strand.gtf' },
      },
      { key: 'genesonpeaks', catalog: 'bedtools-intersect', files: { a: 'genes.gtf', result: 'genes_with_peaks.gtf' } },
    ],
    edges: [
      ['faidx', 'mm'],
      ['mm', 'sort'],
      ['sort', 'index'],
      ['sort', 'macs3'],
      ['sort', 'cov'],
      ['index', 'cov'],
      ['cov', 'peakmatrix'],
      ['macs3', 'peakmatrix'],
      ['cov', 'genematrix'],
      ['genematrix', 'heat'],
      ['sort', 'fp'],
      ['index', 'fp'],
      ['sort', 'depth'],
      ['faidx', 'genesfasta'],
      ['macs3', 'genesonpeaks'],
    ],
    bindings: {
      'macs3>peakmatrix': [{ slot: 'regions', output: 'peaks' }],
      'macs3>genesonpeaks': [{ slot: 'b', output: 'peaks' }],
    },
    verify: (dir) => {
      const truth = CHIP_TRUTH();
      const peaks = regions(read(dir, 'macs3/sample_peaks.narrowPeak'));
      const summits = regions(read(dir, 'macs3/sample_summits.bed'));
      const blacklist = regions(read(dir, 'blacklist.bed'))[0];
      const peakRows = matrixRows(read(dir, 'peak_matrix_values.tsv'));
      const peakOrder = regions(read(dir, 'peak_matrix_regions.bed'));
      const geneRows = matrixRows(read(dir, 'gene_matrix_values.tsv'));
      const geneOrder = regions(read(dir, 'gene_matrix_regions.bed'));
      const heatmap = fs.readFileSync(path.join(dir, 'genes_heatmap.pdf')).subarray(0, 5).toString();
      const metrics = table(read(dir, 'fingerprint_metrics.tsv'));
      const depth = bedGraph(read(dir, 'chip_x1000.bedgraph'));
      const genes = fasta(read(dir, 'genes.fa'));
      const genome = reference();
      const sameStrand = gtfRegions(read(dir, 'genes_same_strand.gtf'));
      const onPeaks = gtfRegions(read(dir, 'genes_with_peaks.gtf'));
      const geneLines = gtfRegions(read(dir, 'genes.gtf'));
      // The bins within 100 bases of a peak's centre: the middle of the 32 bins of 25 bases.
      const aroundCentre = (r: number[]) => r.slice(12, 20);
      return [
        ok('macs3-callpeak', truth.every((t) => hits(peaks, t).length >= 1) && peaks.every((p) => hits(truth, p).length === 1), 'single-end mode finds every planted region and nothing else'),
        ok('macs3-callpeak', summits.length === peaks.length && summits.length >= truth.length, 'summit splitting gives one summit per peak'),
        ok('macs3-callpeak', /# format = BAM\b/.test(read(dir, 'macs3/sample_peaks.xls')) && /# d = 220\b/.test(read(dir, 'macs3/sample_peaks.xls')), 'the read type and fragment length reached MACS3 (BAM, d = 220)'),
        ok('deeptools-bamcoverage', isBigWig(dir, 'chip_rpkm.bw'), 'the scaled, filtered signal track is a bigWig'),
        ok(
          'deeptools-bamcoverage',
          peakRows.length === peakOrder.length &&
            peakRows.every((r) => r.length === 32) &&
            peakOrder.some((p) => overlap(p, blacklist)) &&
            peakOrder.every((p, i) => (overlap(p, blacklist) ? Math.max(...aroundCentre(peakRows[i])) === 0 : Math.min(...aroundCentre(peakRows[i])) > 0)),
          'the signal is zero at the centre of the peak inside the regions to leave out and present at the others'
        ),
        ok('deeptools-computematrix', geneOrder.length === 3 && geneRows.length === 3 && geneRows.every((r) => r.length === 24), 'genes as regions: 3 transcripts, 24 bins of 25 bases each'),
        ok('deeptools-computematrix', new Set(geneOrder.map((g) => g.columns[5])).size === 2, 'the strand of each gene is kept (plus and minus both present)'),
        ok('deeptools-plotheatmap', heatmap === '%PDF-', 'the heatmap was written as a PDF because of its name'),
        ok('deeptools-plotfingerprint', metrics.length === 1 && metrics[0].Sample === 'chip.sorted.bam', 'one sample on its own works'),
        ok('bedtools-genomecov', depth.length > 5 && depth.every((g) => g.depth > 0 && g.depth % 1000 === 0), 'a scale of 1000 multiplies every depth, and gaps with no reads are not written'),
        ok(
          'bedtools-getfasta',
          Object.keys(genes).length === geneLines.length && geneLines.every((g) => {
            const plus = genome[g.contig].slice(g.start, g.end);
            const strand = g.columns[6];
            const want = strand === '-' ? revcomp(plus) : plus;
            return genes[`${g.contig}:${g.start}-${g.end}(${strand})`] === want;
          }),
          'GTF regions are cut out and the genes on the minus strand are reverse-complemented'
        ),
        ok('bedtools-intersect', sameStrand.length === geneLines.length, 'a minimum overlap of 0.9 with a same-strand rule keeps every gene line compared with itself'),
        ok(
          'bedtools-intersect',
          onPeaks.length > 0 && onPeaks.every((g) => hits(peaks, g).length > 0) && onPeaks.every((g) => g.columns.length === 9),
          'gene lines handed in as A keep their GTF columns, and each one lies on a peak'
        ),
      ];
    },
  },
];

defineDomain({
  domain: 'epigenomics',
  covers: [
    'macs3-callpeak',
    'deeptools-bamcoverage',
    'deeptools-computematrix',
    'deeptools-plotheatmap',
    'deeptools-plotfingerprint',
    'genrich',
    'bedtools-intersect',
    'bedtools-merge',
    'bedtools-genomecov',
    'bedtools-getfasta',
    'homer-annotatepeaks',
  ],
  chains: CHAINS,
});

