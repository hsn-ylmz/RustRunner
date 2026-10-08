/**
 * Small readers shared by the epigenomics chains and the template chains: BED-like
 * regions, GTF features, FASTA, computeMatrix tables, PNG and bigWig checks, tab-separated
 * tables, bedGraph depth and HOMER annotation tables.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { DATA, read } from './harness';

export interface Region {
  contig: string;
  start: number;
  end: number;
  name: string;
  columns: string[];
}

/** The regions of a BED-like text (BED, narrowPeak, bedGraph), skipping header lines. */
export function regions(text: string): Region[] {
  return text
    .split('\n')
    .filter((l) => l.trim() !== '' && !/^(#|track|browser)/.test(l))
    .map((line) => {
      const columns = line.split('\t');
      return { contig: columns[0], start: Number(columns[1]), end: Number(columns[2]), name: columns[3] ?? '', columns };
    });
}

/** The features of a GTF text: its start is 1-based, so it is moved to the BED convention. */
export function gtfRegions(text: string): Region[] {
  return text
    .split('\n')
    .filter((l) => l.trim() !== '' && !l.startsWith('#'))
    .map((line) => {
      const columns = line.split('\t');
      return { contig: columns[0], start: Number(columns[3]) - 1, end: Number(columns[4]), name: columns[2], columns };
    });
}

export const truthFile = (name: string): Region[] => regions(fs.readFileSync(path.join(DATA, name), 'utf8'));
export const CHIP_TRUTH = (): Region[] => truthFile('chip_peaks_truth.bed');
export const ATAC_TRUTH = (): Region[] => truthFile('atac_regions_truth.bed');

export const overlap = (a: Region, b: Region): boolean => a.contig === b.contig && a.start < b.end && b.start < a.end;
export const hits = (set: Region[], target: Region): Region[] => set.filter((r) => overlap(r, target));

/** The sequences of a FASTA text by the text after `>` up to the first space. */
export function fasta(text: string): Record<string, string> {
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

export const reference = (): Record<string, string> => fasta(fs.readFileSync(path.join(DATA, 'ref.fa'), 'utf8'));

export function revcomp(seq: string): string {
  const pair: Record<string, string> = { A: 'T', C: 'G', G: 'C', T: 'A' };
  return [...seq].reverse().map((b) => pair[b] ?? 'N').join('');
}

/** Rows of a computeMatrix table (`--outFileNameMatrix`): one array of numbers per region. */
export function matrixRows(text: string): number[][] {
  return text
    .split('\n')
    .filter((l) => l.trim() !== '' && !l.startsWith('#') && !l.startsWith('genes:'))
    .map((l) => l.split('\t').map(Number));
}

export const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;

/** Width and height of a PNG, or null when the file is not one. */
export function pngSize(dir: string, rel: string): { width: number; height: number } | null {
  const head = fs.readFileSync(path.join(dir, rel)).subarray(0, 24);
  if (head.readUInt32BE(0) !== 0x89504e47) return null;
  return { width: head.readUInt32BE(16), height: head.readUInt32BE(20) };
}

/** True when a file starts with the bigWig magic number (little endian 0x888FFC26). */
export function isBigWig(dir: string, rel: string): boolean {
  return fs.readFileSync(path.join(dir, rel)).subarray(0, 4).readUInt32LE(0) === 0x888ffc26;
}

/** Rows of a tab-separated table with a header line, as objects. */
export function table(text: string): Array<Record<string, string>> {
  const [head, ...rows] = text.trim().split('\n');
  const names = head.split('\t');
  return rows.map((row) => Object.fromEntries(row.split('\t').map((value, i) => [names[i], value])));
}

export const lineCount = (dir: string, rel: string): number => read(dir, rel).split('\n').filter(Boolean).length;


/** The depth values of a bedGraph as `[start, end, depth]` per contig. */
export function bedGraph(text: string): Array<{ contig: string; start: number; end: number; depth: number }> {
  return regions(text).map((r) => ({ contig: r.contig, start: r.start, end: r.end, depth: Number(r.columns[3]) }));
}

/** Mean depth of a bedGraph over a window, counting bases that no stretch lists as zero. */
export function meanDepth(graph: ReturnType<typeof bedGraph>, window: Region): number {
  let total = 0;
  for (const g of graph) {
    if (g.contig !== window.contig) continue;
    const length = Math.min(g.end, window.end) - Math.max(g.start, window.start);
    if (length > 0) total += length * g.depth;
  }
  return total / (window.end - window.start);
}

/** The first of the two tables in a HOMER annotation summary, as `kind -> number of peaks`. */
export function homerSummary(text: string): Record<string, number> {
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
export function homerRows(text: string): Array<Region & { annotation: string; nearest: string; distance: number }> {
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
