/**
 * Metagenomics domain: Kraken2 and Bracken on a tiny custom database. Three
 * synthetic genomes (two of one genus, so many reads fit both) with a small
 * made-up taxonomy are built into a Kraken2 database by the catalog tool itself,
 * prepared for Bracken, and a read mixture of known composition is classified.
 * The checks compare the results with the composition the data was made with.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { defineDomain, exists, read, type Chain, type Check } from '../harness';
import { fastqRecords, tableRows } from '../seqio';

const ok = (tool: string, condition: boolean, message: string): Check => ({ tool, ok: condition, message });

interface KrakenLine {
  percent: number;
  clade: number;
  direct: number;
  rank: string;
  taxid: number;
  name: string;
}

/** The lines of a Kraken2 (or Bracken) report, by taxonomy number. */
function krakenReport(text: string): Map<number, KrakenLine> {
  const lines = new Map<number, KrakenLine>();
  for (const line of text.split('\n').filter(Boolean)) {
    const f = line.split('\t');
    lines.set(Number(f[4]), { percent: Number(f[0]), clade: Number(f[1]), direct: Number(f[2]), rank: f[3].trim(), taxid: Number(f[4]), name: f[5].trim() });
  }
  return lines;
}

/** Kraken2's per-read table: classified flag, read name, taxonomy number, length text. */
function assignments(dir: string, rel: string): Array<{ classified: boolean; read: string; taxid: number; length: string }> {
  return read(dir, rel)
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const f = l.split('\t');
      return { classified: f[0] === 'C', read: f[1], taxid: Number(f[2]), length: f[3] };
    });
}

/** Reads per source of a truth table (`A  1424`). */
function truth(dir: string, rel: string): Record<string, number> {
  return Object.fromEntries(
    read(dir, rel)
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        const [key, n] = l.split('\t');
        return [key, Number(n)];
      })
  );
}

const within = (value: number, expected: number, share: number): boolean => Math.abs(value - expected) <= expected * share;

const SPECIES: Record<string, number> = { A: 101, B: 102, C: 201 };

const GENOMES = 'meta_A.fa, meta_B.fa, meta_C.fa';

const CHAINS: Chain[] = [
  {
    // Build, prepare, classify, estimate: the whole custom-database path, plus extracting the
    // reads of one species with seqkit.
    name: 'kraken2-bracken',
    files: ['meta_A.fa', 'meta_B.fa', 'meta_C.fa', 'meta_names.dmp', 'meta_nodes.dmp', 'meta_reads.fastq.gz', 'meta_truth.tsv'],
    nodes: [
      { key: 'build', catalog: 'kraken2-build', files: { genomes: GENOMES, names: 'meta_names.dmp', nodes: 'meta_nodes.dmp', db: 'kraken2_db/' } },
      { key: 'prep', catalog: 'bracken-build', files: { bracken_db: 'bracken_db/' } },
      { key: 'plain', catalog: 'kraken2', files: { reads1: 'meta_reads.fastq.gz', report: 'plain_report.tsv', assignments: 'plain_reads.tsv' } },
      { key: 'kraken', catalog: 'kraken2', files: { reads1: 'meta_reads.fastq.gz', report: 'kraken_report.tsv', assignments: 'kraken_reads.tsv' } },
      { key: 'bracken', catalog: 'bracken', files: { estimates: 'bracken_species.tsv', new_report: 'bracken_species_report.tsv' } },
      { key: 'genus', catalog: 'bracken', params: { level: 'G' }, files: { estimates: 'bracken_genus.tsv', new_report: 'bracken_genus_report.tsv' } },
      { key: 'thr', catalog: 'bracken', params: { threshold: 700 }, files: { estimates: 'bracken_threshold.tsv', new_report: 'bracken_threshold_report.tsv' } },
      {
        key: 'mklist',
        raw: { label: 'Names of the reads of species C', tool: 'bash', command: "awk '$1==\"C\" && $3==201 {print $2}' kraken_reads.tsv > species_c.txt", output: 'species_c.txt' },
      },
      { key: 'grepc', catalog: 'seqkit-grep', files: { sequences: 'meta_reads.fastq.gz', names: 'species_c.txt', matched: 'species_c_reads.fastq.gz' } },
    ],
    edges: [
      ['build', 'prep'],
      ['build', 'plain'],
      ['prep', 'kraken'],
      ['kraken', 'bracken'],
      ['prep', 'bracken'],
      ['kraken', 'genus'],
      ['prep', 'genus'],
      ['kraken', 'thr'],
      ['prep', 'thr'],
      ['kraken', 'mklist', 'after'],
      ['mklist', 'grepc', 'after'],
    ],
    bindings: Object.fromEntries(['bracken', 'genus', 'thr'].map((k) => [`kraken>${k}`, [{ slot: 'report', output: 'report' }]])),
    verify: (dir) => {
      const t = truth(dir, 'meta_truth.tsv');
      const total = Object.values(t).reduce((a, b) => a + b, 0);
      const report = krakenReport(read(dir, 'kraken_report.tsv'));
      const reads = assignments(dir, 'kraken_reads.tsv');
      const estimates = Object.fromEntries(tableRows(read(dir, 'bracken_species.tsv')).map((r) => [Number(r.taxonomy_id), r]));
      const genus = tableRows(read(dir, 'bracken_genus.tsv'));
      const thr = tableRows(read(dir, 'bracken_threshold.tsv'));
      const brackenReport = krakenReport(read(dir, 'bracken_species_report.tsv'));
      const dbDir = path.join(dir, 'kraken2_db');
      const prepDir = path.join(dir, 'bracken_db');
      const sources = fs.readdirSync(prepDir);
      const addedReads = Object.values(estimates).reduce((n, r) => n + Number(r.added_reads), 0);
      const listed = read(dir, 'species_c.txt').split('\n').filter(Boolean);
      const cReads = fastqRecords(dir, 'species_c_reads.fastq.gz');
      return [
        ok('kraken2-build', ['hash.k2d', 'opts.k2d', 'taxo.k2d', 'seqid2taxid.map'].every((f) => fs.existsSync(path.join(dbDir, f))), 'the database folder holds the three index files and the sequence-to-taxonomy map'),
        ok('kraken2-build', read(dir, 'kraken2_db/seqid2taxid.map').split('\n').filter(Boolean).length === 3, 'all three genomes were added, each with its taxonomy number from the header'),
        ok('kraken2-build', read(dir, 'kraken2_db/taxonomy/names.dmp') === read(dir, 'meta_names.dmp'), 'the taxonomy names were copied into the database'),
        ok('bracken-build', !fs.readdirSync(dbDir).some((f) => f.startsWith('database')), 'the original database folder was not changed'),
        ok('bracken-build', exists(dir, 'bracken_db/database150mers.kmer_distrib') && sources.includes('hash.k2d') && fs.lstatSync(path.join(prepDir, 'hash.k2d')).isSymbolicLink(), 'the prepared folder links to the index files and adds the Bracken files for 150-base reads'),
        ok('kraken2', krakenReport(read(dir, 'plain_report.tsv')).get(201)?.clade === report.get(201)?.clade && read(dir, 'plain_report.tsv') === read(dir, 'kraken_report.tsv'), 'the prepared folder works as a Kraken2 database and gives the same summary as the original'),
        ok('kraken2', reads.length === total && reads.filter((r) => !r.classified).length >= 0.8 * t.none && reads.filter((r) => !r.classified).length <= 1.2 * t.none, `every read has a line, and about the ${t.none} reads from no genome are unclassified (${reads.filter((r) => !r.classified).length})`),
        ok('kraken2', report.get(201)?.clade === t.C, `all ${t.C} reads of genome C are in its species (${report.get(201)?.clade})`),
        ok('kraken2', (report.get(10)?.direct ?? 0) > 300 && (report.get(101)?.clade ?? 0) + (report.get(102)?.clade ?? 0) + (report.get(10)?.direct ?? 0) === report.get(10)?.clade, `reads that fit both related genomes stay on their genus (${report.get(10)?.direct} reads)`),
        ok('kraken2', reads.filter((r) => r.classified && r.read.endsWith('_C')).every((r) => r.taxid === 201) && reads.filter((r) => r.classified && r.read.endsWith('_C')).length === t.C, 'every read made from C is assigned to C and to nothing else'),
        ok('bracken', Object.keys(estimates).length === 3, 'one line for each of the three species'),
        ok('bracken', within(Number(estimates[101].new_est_reads), t.A, 0.03) && within(Number(estimates[102].new_est_reads), t.B, 0.03) && within(Number(estimates[201].new_est_reads), t.C, 0.03), `the estimates are within 3 percent of the true ${t.A}, ${t.B} and ${t.C} reads (${estimates[101].new_est_reads}, ${estimates[102].new_est_reads}, ${estimates[201].new_est_reads})`),
        ok('bracken', Math.abs(addedReads - report.get(10)!.direct) <= 2 && addedReads > 300, `the reads Kraken2 left on the genus were shared out over its species (${addedReads} added)`),
        ok('bracken', Math.abs(Object.values(estimates).reduce((n, r) => n + Number(r.fraction_total_reads), 0) - 1) < 0.001, 'the shares of all species add up to one'),
        ok('bracken', brackenReport.get(101)?.clade === Number(estimates[101].new_est_reads) && brackenReport.get(10)?.clade === report.get(10)?.clade, 'the updated summary carries the new numbers and the same genus total'),
        ok('bracken', genus.length === 2 && genus.every((r) => r.taxonomy_lvl === 'G') && Number(genus.find((r) => r.taxonomy_id === '10')!.new_est_reads) === t.A + t.B, `at genus level there are two lines and Alphus has all ${t.A + t.B} reads of A and B`),
        ok('bracken', thr.length === 2 && !thr.some((r) => r.taxonomy_id === '102'), 'a threshold of 700 reads leaves the small species out'),
        ok('seqkit-grep', listed.length === report.get(201)!.clade && cReads.length === listed.length && cReads.every((r) => r.name.endsWith('_C')), `the reads Kraken2 put in species C were picked from the reads by name (${cReads.length})`),
      ];
    },
  },

  {
    // Paired reads, a stricter classification read from disk, a database with other word
    // sizes, and Bracken for another read length.
    name: 'kraken2-options',
    files: ['meta_A.fa', 'meta_B.fa', 'meta_C.fa', 'meta_names.dmp', 'meta_nodes.dmp', 'meta_reads.fastq.gz', 'meta_pairs_R1.fastq.gz', 'meta_pairs_R2.fastq.gz', 'meta_pairs_truth.tsv'],
    nodes: [
      { key: 'build', catalog: 'kraken2-build', files: { genomes: GENOMES, names: 'meta_names.dmp', nodes: 'meta_nodes.dmp', db: 'db_default/' } },
      {
        key: 'small',
        catalog: 'kraken2-build',
        params: { kmer_length: 25, minimizer_length: 21, minimizer_spaces: 3 },
        files: { genomes: GENOMES, names: 'meta_names.dmp', nodes: 'meta_nodes.dmp', db: 'db_k25/' },
      },
      { key: 'paired', catalog: 'kraken2', files: { reads1: 'meta_pairs_R1.fastq.gz', reads2: 'meta_pairs_R2.fastq.gz', report: 'paired_report.tsv', assignments: 'paired_reads.tsv' } },
      { key: 'default', catalog: 'kraken2', files: { reads1: 'meta_reads.fastq.gz', report: 'default_report.tsv', assignments: 'default_reads.tsv' } },
      {
        key: 'strict',
        catalog: 'kraken2',
        params: { confidence: 0.5, min_hit_groups: 4, memory_mapping: true },
        files: { reads1: 'meta_reads.fastq.gz', report: 'strict_report.tsv', assignments: 'strict_reads.tsv' },
      },
      { key: 'k25', catalog: 'kraken2', files: { reads1: 'meta_reads.fastq.gz', report: 'k25_report.tsv', assignments: 'k25_reads.tsv' } },
      { key: 'prep100', catalog: 'bracken-build', params: { read_length: 100 }, files: { bracken_db: 'bracken_db_100/' } },
      { key: 'brack100', catalog: 'bracken', params: { read_length: 100 }, files: { estimates: 'bracken_100.tsv', new_report: 'bracken_100_report.tsv' } },
    ],
    edges: [
      ['build', 'paired'],
      ['build', 'default'],
      ['build', 'strict'],
      ['small', 'k25'],
      ['build', 'prep100'],
      ['paired', 'brack100'],
      ['prep100', 'brack100'],
    ],
    bindings: { 'paired>brack100': [{ slot: 'report', output: 'report' }] },
    verify: (dir) => {
      const p = truth(dir, 'meta_pairs_truth.tsv');
      const paired = assignments(dir, 'paired_reads.tsv');
      const pairedReport = krakenReport(read(dir, 'paired_report.tsv'));
      const def = assignments(dir, 'default_reads.tsv');
      const strict = assignments(dir, 'strict_reads.tsv');
      const k25 = assignments(dir, 'k25_reads.tsv');
      const est = Object.fromEntries(tableRows(read(dir, 'bracken_100.tsv')).map((r) => [Number(r.taxonomy_id), r]));
      const classified = (list: Array<{ classified: boolean }>) => list.filter((r) => r.classified).length;
      return [
        ok('kraken2', paired.length === 1000 && paired.every((r) => /^\d+\|\d+$/.test(r.length)), 'the two files were read as 1000 pairs, not 2000 reads'),
        ok('kraken2', classified(paired) >= 0.9 * 1000 && pairedReport.get(201)?.clade === p.C, `pairs are classified from both mates (${classified(paired)} of 1000; ${pairedReport.get(201)?.clade} of the ${p.C} C pairs in species C)`),
        ok('kraken2', classified(strict) < classified(def) && classified(strict) > 0, `a higher confidence and more matching words name fewer reads (${classified(strict)} against ${classified(def)})`),
        ok(
          'kraken2',
          strict.filter((r) => r.classified && !r.read.endsWith('_none')).every((r) => [SPECIES[r.read.slice(-1)], 10, 1].includes(r.taxid)),
          'every read the strict run names is on its own species, its genus or the root'
        ),
        ok('kraken2', classified(def) > 0.94 * def.length && read(dir, 'strict_report.tsv') !== read(dir, 'default_report.tsv'), 'the default run names about 95 percent of the reads'),
        ok('kraken2-build', classified(k25) > 0.93 * k25.length && fs.statSync(path.join(dir, 'db_k25/opts.k2d')).size > 0 && read(dir, 'db_k25/opts.k2d') !== read(dir, 'db_default/opts.k2d'), 'a database built with other word sizes has other options and still classifies'),
        ok('bracken-build', exists(dir, 'bracken_db_100/database100mers.kmer_distrib') && !exists(dir, 'bracken_db_100/database150mers.kmer_distrib'), 'the files for 100-base reads were made, not those for 150'),
        ok('bracken', within(Number(est[101].new_est_reads), p.A, 0.1) && within(Number(est[102].new_est_reads), p.B, 0.2) && within(Number(est[201].new_est_reads), p.C, 0.1), `the estimates for the read pairs fit the mixture they were made from (${est[101].new_est_reads}, ${est[102].new_est_reads}, ${est[201].new_est_reads} against ${p.A}, ${p.B}, ${p.C})`),
      ];
    },
  },
];

defineDomain({
  domain: 'metagenomics',
  covers: ['kraken2-build', 'kraken2', 'bracken-build', 'bracken'],
  chains: CHAINS,
});
