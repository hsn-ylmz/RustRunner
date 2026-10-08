/**
 * Nanopore domain: the POD5 tools (pod5 view, inspect, filter, subset, merge and
 * the FAST5 converter) and Dorado. The data is `make_pod5.py`'s synthetic signal:
 * 10 reads in one POD5 file, 6 in a second, and 4 in a FAST5 file, with known
 * read ids, channels and lengths. The chain converts, merges, lists, filters and
 * splits the files, then basecalls them with the real Dorado (downloaded and
 * checked by the engine, with a real model) and checks the result against the
 * reads that went in. The signal is not real DNA, so the basecalled sequence
 * means nothing; the checks are about which reads come out, not what they say.
 *
 * Dorado is an external tool with a download for macOS on Apple silicon only; on
 * another platform its step is recorded as unavailable.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { defineDomain, ensurePod5Data, exists, read, type Chain, type Check } from '../harness';
import { fastqRecords, nanoStat, tableRows } from '../seqio';

const ok = (tool: string, condition: boolean, message: string): Check => ({ tool, ok: condition, message });

interface TruthRow {
  file: string;
  id: string;
  channel: number;
  samples: number;
}

function truthRows(dir: string): TruthRow[] {
  return read(dir, 'nano_truth.tsv')
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const [file, id, channel, samples] = l.split('\t');
      return { file, id, channel: Number(channel), samples: Number(samples) };
    });
}

const sorted = (values: string[]): string[] => [...values].sort();

/** The number in `<count> + 0 <what>` of a samtools flagstat report. */
function flagstat(report: string, what: string): number {
  const line = report.split('\n').find((l) => l.includes(` ${what}`));
  if (!line) throw new Error(`no "${what}" line in the flagstat report`);
  return Number(line.split(' ')[0]);
}

const CHAINS: Chain[] = [
  {
    name: 'pod5-and-dorado',
    files: ['nano_a.pod5', 'nano_b.pod5', 'nano_fast5.fast5', 'nano_ids.txt', 'nano_truth.tsv'],
    nodes: [
      // The extra package limit of the pod5 install, checked in the real environment.
      {
        key: 'polars',
        raw: {
          label: 'Which polars does pod5 get',
          tool: 'python',
          command: 'python -c "import polars; print(polars.__version__)" > polars_version.txt',
          output: 'polars_version.txt',
          install: { kind: 'conda', package: 'pod5', version: '0.3.48', channel: 'bioconda', constraints: ['polars<2'] },
        },
      },
      { key: 'convert', catalog: 'pod5-convert-fast5', files: { fast5: 'nano_fast5.fast5', converted: 'converted.pod5' } },
      { key: 'merge', catalog: 'pod5-merge', files: { pods: 'nano_a.pod5, nano_b.pod5', merged: 'merged.pod5' } },
      { key: 'inspect', catalog: 'pod5-inspect', files: { report: 'inspect_summary.txt' } },
      { key: 'view', catalog: 'pod5-view', files: { table: 'reads.tsv' } },
      { key: 'viewcols', catalog: 'pod5-view', params: { columns: 'read_id,channel,num_samples' }, files: { table: 'reads_small.tsv' } },
      { key: 'filter', catalog: 'pod5-filter', files: { ids: 'nano_ids.txt', filtered: 'filtered.pod5' } },
      { key: 'viewfiltered', catalog: 'pod5-view', params: { columns: 'read_id,channel' }, files: { table: 'filtered_reads.tsv' } },
      { key: 'subset', catalog: 'pod5-subset', files: { out_dir: 'by_channel/' } },
      {
        key: 'viewchannels',
        catalog: 'pod5-view',
        params: { columns: 'read_id,channel' },
        files: { pods: 'by_channel/channel-1.pod5, by_channel/channel-5.pod5', table: 'channels_1_and_5.tsv' },
      },
      { key: 'dorado', catalog: 'dorado-basecaller', params: { model: 'fast', min_qscore: 0 }, files: { calls: 'calls.bam' } },
      { key: 'summary', catalog: 'dorado-summary', files: { summary: 'sequencing_summary.tsv' } },
      { key: 'flag', catalog: 'samtools-flagstat', files: { report: 'calls_flagstat.txt' } },
      { key: 'tofastq', catalog: 'samtools-fastq', files: { reads: 'calls.fastq.gz' } },
      { key: 'plotbam', catalog: 'nanoplot', params: { format: '--ubam' }, files: { out_dir: 'nanoplot_bam/' } },
      { key: 'plotsum', catalog: 'nanoplot', params: { format: '--summary' }, files: { out_dir: 'nanoplot_summary/' } },
      { key: 'subset2', catalog: 'pod5-subset', files: { out_dir: 'by_channel_from_summary/' } },
      { key: 'doradocpu', catalog: 'dorado-basecaller', params: { model: 'fast', min_qscore: 6, device: 'cpu' }, files: { calls: 'calls_cpu.bam' } },
      { key: 'flagcpu', catalog: 'samtools-flagstat', files: { report: 'calls_cpu_flagstat.txt' } },
    ],
    edges: [
      ['convert', 'merge'],
      ['merge', 'inspect'],
      ['merge', 'view'],
      ['merge', 'viewcols'],
      ['merge', 'filter'],
      ['filter', 'viewfiltered'],
      ['merge', 'subset'],
      ['view', 'subset'],
      ['subset', 'viewchannels', 'after'],
      ['merge', 'dorado'],
      ['dorado', 'summary'],
      ['dorado', 'flag'],
      ['dorado', 'tofastq'],
      ['dorado', 'plotbam'],
      ['summary', 'plotsum'],
      ['merge', 'subset2'],
      ['summary', 'subset2'],
      ['filter', 'doradocpu'],
      ['doradocpu', 'flagcpu'],
    ],
    verify: (dir) => {
      const truth = truthRows(dir);
      const ids = sorted(truth.map((r) => r.id));
      const view = tableRows(read(dir, 'reads.tsv'));
      const small = tableRows(read(dir, 'reads_small.tsv'));
      const wantedIds = read(dir, 'nano_ids.txt').split('\n').filter(Boolean);
      const filtered = tableRows(read(dir, 'filtered_reads.tsv'));
      const channels = [...new Set(truth.map((r) => r.channel))].sort((a, b) => a - b);
      const filesIn = (folder: string) => fs.readdirSync(path.join(dir, folder)).sort();
      const oneAndFive = tableRows(read(dir, 'channels_1_and_5.tsv'));
      const summary = tableRows(read(dir, 'sequencing_summary.tsv'));
      const fromFast5 = truth.filter((r) => r.file === 'nano_fast5.fast5');
      const cpuCount = flagstat(read(dir, 'calls_cpu_flagstat.txt'), 'primary');
      const polars = read(dir, 'polars_version.txt').trim();
      const fastq = fastqRecords(dir, 'calls.fastq.gz');
      return [
        ok('pod5-view', /^1\.\d+\.\d+/.test(polars), `pod5 runs with polars below 2 because of the install's extra package limit (polars ${polars})`),
        ok('pod5-convert-fast5', exists(dir, 'converted.pod5') && fromFast5.length === 4, 'the FAST5 file became a POD5 file'),
        ok('pod5-merge', view.length === 20 && JSON.stringify(sorted(view.map((r) => r.read_id))) === JSON.stringify(ids), 'the merged file holds all 20 reads: 10 + 6 from the two POD5 files and the 4 converted from FAST5'),
        ok('pod5-view', view.every((r) => truth.find((t) => t.id === r.read_id)!.channel === Number(r.channel) && truth.find((t) => t.id === r.read_id)!.samples === Number(r.num_samples)), 'the table gives the right channel and length in samples of every read'),
        ok('pod5-view', Object.keys(small[0]).join() === 'read_id,channel,num_samples' && small.length === 20, 'only the columns asked for are in the table'),
        ok('pod5-inspect', /20 reads/.test(read(dir, 'inspect_summary.txt')), 'the summary counts 20 reads'),
        ok('pod5-filter', filtered.length === 4 && JSON.stringify(sorted(filtered.map((r) => r.read_id))) === JSON.stringify(sorted(wantedIds)), 'only the four listed reads are in the filtered file'),
        ok('pod5-subset', JSON.stringify(filesIn('by_channel')) === JSON.stringify(channels.map((c) => `channel-${c}.pod5`)), `one file for each of the ${channels.length} channels, named after the channel`),
        ok(
          'pod5-subset',
          JSON.stringify(sorted(oneAndFive.map((r) => r.read_id))) === JSON.stringify(sorted(truth.filter((r) => r.channel === 1 || r.channel === 5).map((r) => r.id))) &&
            oneAndFive.every((r) => r.channel === '1' || r.channel === '5'),
          'the files for channels 1 and 5 hold exactly the reads of those channels'
        ),
        ok('dorado-summary', JSON.stringify(filesIn('by_channel_from_summary')) === JSON.stringify(filesIn('by_channel')), 'the Dorado summary works as the table of pod5 subset, with the same result'),
        ok('dorado-basecaller', flagstat(read(dir, 'calls_flagstat.txt'), 'primary') === 20, 'Dorado called all 20 reads'),
        ok('dorado-summary', summary.length === 20 && JSON.stringify(sorted(summary.map((r) => r.read_id))) === JSON.stringify(ids), 'the summary lists exactly the 20 reads of the POD5 file'),
        ok('dorado-summary', summary.every((r) => Number(r.sequence_length_template) > 100 && Number(r.channel) === truth.find((t) => t.id === r.read_id)!.channel), 'every read has a called sequence and its own channel'),
        ok('samtools-fastq', fastq.length === 20 && JSON.stringify(sorted(fastq.map((r) => r.name))) === JSON.stringify(ids) && fastq.every((r) => r.seq.length > 100 && r.seq.length === r.qual.length), 'the called reads became a FASTQ file with all 20 reads once each, bases and qualities of equal length'),
        ok('nanoplot', nanoStat(read(dir, 'nanoplot_bam/NanoStats.txt'), 'Number of reads:') === 20, 'NanoPlot reads the unaligned BAM from Dorado'),
        ok('nanoplot', nanoStat(read(dir, 'nanoplot_summary/NanoStats.txt'), 'Number of reads:') === 20, 'NanoPlot reads the sequencing summary'),
        ok('dorado-basecaller', cpuCount >= 1 && cpuCount < 4, `on the processor alone, with reads under Q6 dropped, some but not all of the 4 filtered reads are kept (${cpuCount})`),
      ];
    },
  },
];

defineDomain({
  domain: 'nanopore',
  prepare: ensurePod5Data,
  covers: ['pod5-view', 'pod5-inspect', 'pod5-filter', 'pod5-subset', 'pod5-merge', 'pod5-convert-fast5', 'dorado-basecaller', 'dorado-summary', 'samtools-fastq'],
  chains: CHAINS,
});
