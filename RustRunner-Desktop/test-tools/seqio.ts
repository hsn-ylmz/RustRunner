/**
 * Small readers for the files the long-read, assembly and metagenomics chains check
 * (FASTQ, FASTA, SAM and tab-separated tables). Standard library only.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as zlib from 'node:zlib';

/** The text of a file; `.gz` files are decompressed. */
export function textOf(dir: string, rel: string): string {
  const raw = fs.readFileSync(path.join(dir, rel));
  return (rel.endsWith('.gz') ? zlib.gunzipSync(raw) : raw).toString('utf8');
}

export interface FastqRecord {
  name: string;
  seq: string;
  qual: string;
}

/** The records of a FASTQ file (four lines each); the name is the first word of the header. */
export function fastqRecords(dir: string, rel: string): FastqRecord[] {
  const lines = textOf(dir, rel).split('\n');
  const records: FastqRecord[] = [];
  for (let i = 0; i + 3 < lines.length; i += 4) {
    records.push({ name: lines[i].slice(1).split(/\s/)[0], seq: lines[i + 1], qual: lines[i + 3] });
  }
  return records;
}

export interface FastaRecord {
  name: string;
  seq: string;
}

export function fastaRecords(dir: string, rel: string): FastaRecord[] {
  const records: FastaRecord[] = [];
  for (const line of textOf(dir, rel).split('\n')) {
    if (line.startsWith('>')) records.push({ name: line.slice(1).split(/\s/)[0], seq: '' });
    else if (records.length > 0) records[records.length - 1].seq += line.trim();
  }
  return records;
}

const COMPLEMENT: Record<string, string> = { A: 'T', C: 'G', G: 'C', T: 'A', a: 't', c: 'g', g: 'c', t: 'a', N: 'N', n: 'n' };

export function reverseComplement(seq: string): string {
  let out = '';
  for (let i = seq.length - 1; i >= 0; i--) out += COMPLEMENT[seq[i]] ?? 'N';
  return out;
}

export const totalBases = (records: Array<{ seq: string }>): number => records.reduce((n, r) => n + r.seq.length, 0);

export interface SamRecord {
  qname: string;
  flag: number;
  rname: string;
  /** 1-based leftmost position. */
  pos: number;
  mapq: number;
  cigar: string;
  tags: string[];
}

/** The alignment lines of SAM text; `@` header lines are left out (see `samHeader`). */
export function samRecords(sam: string): SamRecord[] {
  return sam
    .split('\n')
    .filter((l) => l && !l.startsWith('@'))
    .map((line) => {
      const f = line.split('\t');
      return { qname: f[0], flag: Number(f[1]), rname: f[2], pos: Number(f[3]), mapq: Number(f[4]), cigar: f[5], tags: f.slice(11) };
    });
}

export const samHeader = (sam: string): string[] => sam.split('\n').filter((l) => l.startsWith('@'));

/** Primary alignments only: neither secondary (256) nor supplementary (2048). */
export const primaryOnly = (records: SamRecord[]): SamRecord[] => records.filter((r) => (r.flag & 2304) === 0);

/** The operations of a CIGAR string, `[length, letter]`. */
export function cigarOps(cigar: string): Array<[number, string]> {
  return [...cigar.matchAll(/(\d+)([MIDNSHP=X])/g)].map((m) => [Number(m[1]), m[2]]);
}

/** A table with a header line: one object per row. */
export function tableRows(text: string, separator = '\t'): Array<Record<string, string>> {
  const lines = text.split('\n').filter((l) => l.trim() !== '');
  const header = lines[0].replace(/^#/, '').split(separator);
  return lines.slice(1).map((line) => {
    const cells = line.split(separator);
    return Object.fromEntries(header.map((h, i) => [h, cells[i] ?? '']));
  });
}

/** The two-column rows of a QUAST report: `{ metric: { assembly: value } }`. */
export function quastTable(text: string): Record<string, Record<string, string>> {
  const lines = text.split('\n').filter((l) => l !== '');
  const assemblies = lines[0].split('\t').slice(1);
  const table: Record<string, Record<string, string>> = {};
  for (const line of lines.slice(1)) {
    const cells = line.split('\t');
    table[cells[0]] = Object.fromEntries(assemblies.map((a, i) => [a, cells[i + 1]]));
  }
  return table;
}

/** The number after a label in NanoPlot's statistics, such as `Number of reads:   270.0`. */
export function nanoStat(text: string, label: string): number {
  const line = text.split('\n').find((l) => l.startsWith(label));
  if (!line) throw new Error(`no "${label}" in the NanoPlot statistics`);
  return Number(line.slice(label.length).replace(/[,\s:]/g, ''));
}
