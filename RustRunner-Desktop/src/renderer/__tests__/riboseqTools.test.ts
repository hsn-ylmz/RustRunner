/**
 * The Ribo-seq tools of the catalog: UMI-tools extract and dedup, "Remove reads
 * matching a database (bowtie2)", STAR for transcript coordinates and the
 * riboWaltz report, plus the changes the pipeline needed in Cutadapt and
 * samtools view. The real tools run in `npm run test:tools`
 * (test-tools/chains/riboseq.tools.ts); these tests pin what runs without them:
 * the entries and their pins, the commands, the shell logic (against stand-ins
 * for the tools), how the steps connect, and the bundled-file placeholder the
 * riboWaltz step uses.
 */
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  CATALOG,
  buildCatalogNodeData,
  checkConnection,
  defaultParams,
  findTool,
  renderCommand,
  resourceOf,
  resourcePathProblem,
  validateCatalog,
  type CatalogTool,
} from '../tools/catalog';
import { connectWithBinding, placeholderNames, previewCommand, scanCommand, slotDefsFor, slotStates, slotYaml } from '../slots';

const NEW_TOOLS = ['umi-tools-extract', 'umi-tools-dedup', 'bowtie2-remove-reads', 'star-riboseq', 'ribowaltz-report'];

const tool = (id: string): CatalogTool => {
  const found = findTool(id);
  if (!found) throw new Error(`catalog has no tool ${id}`);
  return found;
};

const params = (id: string, overrides: Record<string, string | number | boolean> = {}) => ({ ...defaultParams(tool(id)), ...overrides });
const render = (id: string, overrides: Record<string, string | number | boolean> = {}, threads = 2) =>
  renderCommand(tool(id), params(id, overrides), threads);

function catalogNode(id: string, toolId: string, files: Record<string, string> = {}, over: Record<string, any> = {}) {
  const t = tool(toolId);
  const data = buildCatalogNodeData(t, []);
  data.catalogParams = { ...defaultParams(t), ...over };
  data.slotFiles = { ...(data.slotFiles as Record<string, string>), ...files };
  return { id, data: data as Record<string, any> };
}
type TestNode = ReturnType<typeof catalogNode>;

function wire(nodes: TestNode[], pairs: Array<[string, string]>) {
  const edges: Array<{ source: string; target: string }> = [];
  const plans: Array<{ pair: string; kind: string }> = [];
  let current = nodes;
  for (const [from, to] of pairs) {
    const before = [...edges];
    edges.push({ source: from, target: to });
    const out = connectWithBinding(current, before, edges, from, to);
    plans.push({ pair: `${from}>${to}`, kind: out.plan.kind });
    current = out.nodes as TestNode[];
  }
  return { nodes: current, edges, plans };
}
const linkOf = (nodes: TestNode[], id: string, slot: string) => (nodes.find((n) => n.id === id)!.data.slotLinks ?? {})[slot];

describe('the Ribo-seq tools in the catalog', () => {
  it('has the five new tools and the catalog is still valid', () => {
    for (const id of NEW_TOOLS) expect(findTool(id), id).toBeDefined();
    expect(validateCatalog(CATALOG)).toEqual([]);
  });

  it('pins each tool to the version it was run with', () => {
    const pin = (id: string) => {
      const install = tool(id).install;
      if (install.kind !== 'conda') throw new Error(`${id} is not a conda tool`);
      return install;
    };
    expect(pin('umi-tools-extract')).toMatchObject({ package: 'umi_tools', version: '1.1.6', channel: 'bioconda' });
    expect(pin('umi-tools-dedup')).toMatchObject({ package: 'umi_tools', version: '1.1.6' });
    expect(pin('bowtie2-remove-reads')).toMatchObject({ package: 'bowtie2', version: '2.5.5' });
    // STAR 2.7.11b breaks --quantMode TranscriptomeSAM, so the pin is the same as the other STAR entries, Intel build on Apple silicon.
    expect(pin('star-riboseq')).toMatchObject({ package: 'star', version: '2.7.10b', osx64: true });
    expect(pin('star-riboseq')).toEqual(pin('star'));
    // riboWaltz is on bioconda, so it is a plain pin, not a download from GitHub.
    expect(pin('ribowaltz-report')).toMatchObject({ package: 'ribowaltz', version: '2.0', channel: 'bioconda' });
  });

  it('groups them where a biologist looks for them', () => {
    expect([tool('umi-tools-extract').category, tool('umi-tools-extract').subcategory]).toEqual(['trimming', 'UMI handling']);
    expect([tool('umi-tools-dedup').category, tool('umi-tools-dedup').subcategory]).toEqual(['processing', 'Duplicates']);
    expect(tool('bowtie2-remove-reads').name).toBe('Remove reads matching a database (bowtie2)');
    expect(tool('star-riboseq').name).toBe('STAR (Ribo-seq, transcriptome BAM)');
    expect(tool('ribowaltz-report').subcategory).toBe('Ribosome profiling');
  });

  it('describes every option in plain words and labels every choice that is a flag', () => {
    for (const id of NEW_TOOLS) {
      for (const p of tool(id).params) {
        expect(p.description.length, `${id}.${p.id}`).toBeGreaterThan(30);
        if (p.type === 'select') {
          for (const o of p.options ?? []) {
            if (o.startsWith('--') || /[A-Z]/.test(o) || /\d/.test(o)) expect(p.option_labels?.[o], `${id}.${p.id}=${o} needs a label`).toBeTruthy();
          }
        }
      }
    }
  });

  it('defaults to the layout and window verified on the real reads (riboseq-test/DATA.md)', () => {
    expect(params('umi-tools-extract')).toMatchObject({ umi_end: '5prime', umi_length: 12, spacer_length: 4, custom_pattern: '' });
    expect(params('ribowaltz-report')).toMatchObject({ min_length: 28, max_length: 34, extremity: 'auto', flanking: 6 });
    expect(params('bowtie2-remove-reads')).toMatchObject({ alignment: '--local', sensitivity: 'very-sensitive', seed_length: 0 });
    expect(params('star-riboseq')).toMatchObject({ align_ends: 'EndToEnd', max_mismatches: 2, max_multimap: 1, min_matched: 20, genome_bam: 'None' });
  });
});

describe('the commands', () => {
  it('UMI-tools extract builds a regex that really removes the spacer (the string method with X does not)', () => {
    const c = render('umi-tools-extract');
    expect(c).toContain('--extract-method=regex');
    expect(c).not.toContain('--extract-method=string');
    expect(c).toContain('PATTERN="^(?P<umi_1>.{12})(?P<discard_1>.{4})"');
    expect(c).toContain('-I {reads} -S {extracted} -L {log}');
  });

  it('UMI-tools extract puts the UMI last for the 3\' end and honours the lengths', () => {
    const c = render('umi-tools-extract', { umi_end: '3prime', umi_length: 8, spacer_length: 0 });
    expect(c).toContain('PATTERN=".*(?P<discard_1>.{0})(?P<umi_1>.{8})\\$"');
  });

  it('UMI-tools dedup defaults to directional, by position, comparing the read length, with a fixed seed', () => {
    const c = render('umi-tools-dedup');
    expect(c).toContain('--method=directional');
    expect(c).toContain('--edit-distance-threshold=1');
    expect(c).toContain('--random-seed=1');
    expect(c).toContain('--read-length');
    expect(c).toContain('--output-stats={stats_dir}dedup');
    expect(c).toContain('[ position = transcript ]'); // position is the default; "transcript" is the only thing that adds flags
  });

  it('bowtie2 removal writes only the reads that did not match and keeps the summary', () => {
    const c = render('bowtie2-remove-reads');
    expect(c).toContain('--un-gz {unaligned}');
    expect(c).toContain('-S /dev/null');
    expect(c).toContain('--reorder');
    expect(c).toContain('--very-sensitive --local');
    expect(c).toContain('-x {index} -U {reads}');
    expect(c).toContain('tee {log} >&2');
    expect(c).toContain('set -o pipefail');
    expect(render('bowtie2-remove-reads', { alignment: '--end-to-end', sensitivity: 'fast' })).toContain('--fast --end-to-end');
  });

  it('STAR for Ribo-seq asks for the transcript BAM with the footprint settings', () => {
    const c = render('star-riboseq');
    for (const part of [
      '--quantMode TranscriptomeSAM',
      '--quantTranscriptomeBan IndelSoftclipSingleend',
      '--alignEndsType EndToEnd',
      '--outFilterMismatchNmax 2',
      '--outFilterMultimapNmax 1',
      '--outFilterMatchNmin 20',
      '--outSAMunmapped Within',
      '--outSAMtype None',
      '--readFilesCommand gzip -cdf',
      '--outFileNamePrefix {out_dir}',
    ]) {
      expect(c, part).toContain(part);
    }
    expect(render('star-riboseq', { genome_bam: 'BAM SortedByCoordinate', max_multimap: 10, align_ends: 'Local' })).toContain('--outSAMtype BAM SortedByCoordinate');
  });

  it('the riboWaltz step names its script as a bundled file, not a path', () => {
    const c = render('ribowaltz-report');
    expect(c).toContain('Rscript --vanilla {app_resource:ribowaltz/ribowaltz_report.R}');
    expect(c).toContain('--min-length 28 --max-length 34 --extremity auto --flanking 6 --offset-refine none');
    expect(c).toContain('-- {bams}');
    expect(c).not.toMatch(/<<|heredoc/i);
  });

  it('Cutadapt can take a poly(A) tail plus adapter with the overlap that keeps A-runs safe', () => {
    const c = render('cutadapt', { adapter: 'AAAAAAAAAACAAAAAAAAAAGATCGGAAGAGCACACGTCTGAACTCCAGTCAC', min_overlap: 10 });
    expect(c).toContain('-a AAAAAAAAAACAAAAAAAAAAGATCGGAAGAGCACACGTCTGAACTCCAGTCAC -e 0.1 -O 10 -m 20');
    expect(render('cutadapt')).toContain('-e 0.1 -O 3');
    expect(render('cutadapt')).not.toContain('--discard-untrimmed');
    expect(render('cutadapt', { discard_untrimmed: true })).toContain('--discard-untrimmed');
    expect(tool('cutadapt').params.find((p) => p.id === 'adapter')!.description).toContain('D-Plex');
  });

  it('samtools view can keep the forward strand without clashing with "mapped only"', () => {
    expect(render('samtools-view')).not.toContain('-G 16');
    const c = render('samtools-view', { forward_only: true });
    // -F and -G are separate options, so both filters apply (two -F options would not add up).
    expect(c).toContain('-F 4 -G 16');
    expect(c.match(/-F /g)).toHaveLength(1);
  });
});

describe.skipIf(process.platform === 'win32')('the shell logic of the commands', () => {
  /**
   * Runs the command with `{slot}` filled as the engine fills it and the tool replaced by a
   * function that prints its arguments, one per line. Returns what was printed (stdout and,
   * for the commands that tee, the log file) and the exit status.
   */
  function run(toolId: string, standIn: string, slots: Record<string, string>, over: Record<string, any> = {}, setup?: (dir: string) => void) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'riboseq-shell-'));
    try {
      setup?.(dir);
      const command = renderCommand(tool(toolId), { ...defaultParams(tool(toolId)), ...over }, 2).replace(/\{([A-Za-z_]\w*)\}/g, (_m, name) => {
        if (!(name in slots)) throw new Error(`no value for {${name}}`);
        return slots[name] === '' ? '' : `'${slots[name].replace('$DIR', dir)}'`;
      });
      const script = `${standIn}() { printf '%s\\n' "$@"; }\n${command.replace(/"'([^']*)'"/g, '"$1"')}`;
      const out = spawnSync('bash', ['-c', script], { encoding: 'utf8', cwd: dir });
      const files: Record<string, string> = {};
      for (const f of fs.readdirSync(dir)) if (fs.statSync(path.join(dir, f)).isFile()) files[f] = fs.readFileSync(path.join(dir, f), 'utf8');
      return { status: out.status, args: out.stdout.trim().split('\n'), stderr: out.stderr, files };
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
  const pattern = (args: string[]) => args.find((a) => a.startsWith('--bc-pattern='))!.slice('--bc-pattern='.length);

  const extract = { reads: 'in.fq.gz', extracted: 'out.fq.gz', log: 'x.log', custom_pattern: '' };

  it('extract: 5\' pattern with a UMI and a spacer; a valid Python regex', () => {
    const r = run('umi-tools-extract', 'umi_tools', extract);
    expect(r.status).toBe(0);
    expect(r.args[0]).toBe('extract');
    expect(pattern(r.args)).toBe('^(?P<umi_1>.{12})(?P<discard_1>.{4})');
    expect(r.args).toContain('--extract-method=regex');
    expect(r.args[r.args.indexOf('-I') + 1]).toBe('in.fq.gz');
    expect(r.args[r.args.indexOf('-S') + 1]).toBe('out.fq.gz');
    expect(r.args[r.args.indexOf('-L') + 1]).toBe('x.log');
  });

  it('extract: the 3\' pattern ends the read with the UMI', () => {
    const r = run('umi-tools-extract', 'umi_tools', extract, { umi_end: '3prime', umi_length: 10, spacer_length: 2 });
    expect(pattern(r.args)).toBe('.*(?P<discard_1>.{2})(?P<umi_1>.{10})$');
  });

  it('extract: your own pattern replaces the settings and reaches the tool as one word', () => {
    const own = '^(?P<umi_1>.{8})(?P<discard_1>.{2}) x';
    const r = run('umi-tools-extract', 'umi_tools', extract, { custom_pattern: own });
    expect(pattern(r.args)).toBe(own);
    expect(r.args.filter((a) => a.startsWith('--bc-pattern=')).length).toBe(1);
  });

  it('extract: the regexes match what they are meant to (checked with the same regex dialect)', () => {
    const five = new RegExp(pattern(run('umi-tools-extract', 'umi_tools', extract).args).replace(/\(\?P</g, '(?<'));
    const read = 'ACGTACGTACGT' + 'GGGA' + 'CCCCCCCCCCCCCCCCCCCC';
    const m = five.exec(read)!;
    expect(m.groups!.umi_1).toBe('ACGTACGTACGT');
    expect(m.groups!.discard_1).toBe('GGGA');
    expect(read.slice(m[0].length)).toBe('CCCCCCCCCCCCCCCCCCCC');
    const three = new RegExp(pattern(run('umi-tools-extract', 'umi_tools', extract, { umi_end: '3prime' }).args).replace(/\(\?P</g, '(?<'));
    const m3 = three.exec('TTTTTTTTTTTTTTTT' + 'GGGA' + 'ACGTACGTACGT')!;
    expect(m3.groups!.umi_1).toBe('ACGTACGTACGT');
    expect(m3.groups!.discard_1).toBe('GGGA');
  });

  const dedup = { alignments: '$DIR/s.bam', index: '$DIR/s.bam.bai', deduplicated: 'o.bam', log: 'd.log', stats_dir: 'stats/' };
  const withIndex = (dir: string) => fs.writeFileSync(path.join(dir, 's.bam.bai'), 'x');

  it('dedup: by position it adds no per-gene flags; by transcript it adds both', () => {
    const position = run('umi-tools-dedup', 'umi_tools', dedup, {}, withIndex);
    expect(position.status).toBe(0);
    expect(position.args).not.toContain('--per-gene');
    expect(position.args).not.toContain('--per-contig');
    expect(position.args).toContain('--read-length');
    expect(position.args).toContain('--method=directional');
    const transcript = run('umi-tools-dedup', 'umi_tools', dedup, { group_by: 'transcript', use_read_length: false, method: 'unique' }, withIndex);
    expect(transcript.args).toContain('--per-gene');
    expect(transcript.args).toContain('--per-contig');
    expect(transcript.args).not.toContain('--read-length');
    expect(transcript.args).toContain('--method=unique');
  });

  it('dedup: refuses, saying what is wrong, when the index is not next to the BAM', () => {
    const r = run('umi-tools-dedup', 'umi_tools', dedup, {}, () => undefined);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('needs the BAM index next to the BAM');
    expect(r.args).not.toContain('dedup');
  });

  const removal = { index: 'idx/ref', reads: 'in.fq.gz', unaligned: 'out.fq.gz', log: 'rm.log' };

  // bowtie2 prints its summary to stderr; the command copies it into the log file, so the stand-in's
  // arguments are read back from the log.
  const loggedArgs = (r: { files: Record<string, string> }) => r.files['rm.log'].trim().split('\n');

  it('removal: no -L unless a seed length is given', () => {
    const none = run('bowtie2-remove-reads', 'bowtie2', removal);
    expect(none.status).toBe(0);
    expect(loggedArgs(none)).not.toContain('-L');
    const seeded = run('bowtie2-remove-reads', 'bowtie2', removal, { seed_length: 16 });
    const args = loggedArgs(seeded);
    expect(args[args.indexOf('-L') + 1]).toBe('16');
  });

  it('removal: keeps unmatched reads, throws the SAM away and logs what bowtie2 said', () => {
    const r = run('bowtie2-remove-reads', 'bowtie2', removal);
    const args = loggedArgs(r);
    expect(args[args.indexOf('--un-gz') + 1]).toBe('out.fq.gz');
    expect(args[args.indexOf('-S') + 1]).toBe('/dev/null');
    expect(args[args.indexOf('-x') + 1]).toBe('idx/ref');
    expect(args[args.indexOf('-U') + 1]).toBe('in.fq.gz');
    expect(args).toContain('--reorder');
    expect(r.stderr).toContain('--un-gz'); // what bowtie2 said also reaches the run log
  });

  it('removal: a failing bowtie2 fails the step (pipefail), and its message is in the log', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'riboseq-fail-'));
    try {
      const command = render('bowtie2-remove-reads').replace('{index}', "'i'").replace('{reads}', "'r'").replace('{unaligned}', "'u'").replace('{log}', `'${dir}/l.log'`);
      const out = spawnSync('bash', ['-c', `bowtie2() { echo 'Error: no index' >&2; return 1; }\n${command}`], { encoding: 'utf8' });
      expect(out.status).toBe(1);
      expect(fs.readFileSync(path.join(dir, 'l.log'), 'utf8')).toContain('Error: no index');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  const ribo = { bams: 'a.bam', annotation: 'g.gtf', genome: '', report_dir: 'rep/' };

  it('riboWaltz: the genome FASTA is passed only when given; the BAMs come after --', () => {
    const without = run('ribowaltz-report', 'Rscript', ribo);
    expect(without.status).toBe(0);
    expect(without.args).not.toContain('--fasta');
    const bams = without.args.slice(without.args.indexOf('--') + 1);
    expect(bams).toEqual(['a.bam']);
    const withGenome = run('ribowaltz-report', 'Rscript', { ...ribo, genome: 'my genome.fa' });
    expect(withGenome.args[withGenome.args.indexOf('--fasta') + 1]).toBe('my genome.fa');
  });

  it('riboWaltz: the window and read end reach the script', () => {
    const r = run('ribowaltz-report', 'Rscript', ribo, { min_length: 26, max_length: 36, extremity: '5end', flanking: 9 });
    const at = (flag: string) => r.args[r.args.indexOf(flag) + 1];
    expect([at('--min-length'), at('--max-length'), at('--extremity'), at('--flanking')]).toEqual(['26', '36', '5end', '9']);
  });

  it('riboWaltz: offsets are riboWaltz\'s own unless the frame adjustment is chosen, and only these two values exist', () => {
    const tool = findTool('ribowaltz-report')!;
    const param = tool.params.find((p) => p.id === 'offset_refine')!;
    expect(param.default).toBe('none');
    expect(param.options).toEqual(['none', 'frame']);
    const at = (r: { args: string[] }) => r.args[r.args.indexOf('--offset-refine') + 1];
    expect(at(run('ribowaltz-report', 'Rscript', ribo))).toBe('none');
    expect(at(run('ribowaltz-report', 'Rscript', ribo, { offset_refine: 'frame' }))).toBe('frame');
  });

  it('Cutadapt says that a UMI still on the read counts towards the minimum length', () => {
    const param = findTool('cutadapt')!.params.find((p) => p.id === 'min_length')!;
    expect(param.description).toMatch(/UMI/);
    expect(param.description).toContain('36');
  });
});

describe('connecting the Ribo-seq steps', () => {
  it('each step of the pipeline accepts what the one before makes', () => {
    const order = ['cutadapt', 'umi-tools-extract', 'bowtie2-remove-reads', 'star-riboseq', 'samtools-view', 'samtools-sort', 'umi-tools-dedup', 'ribowaltz-report'];
    for (let i = 1; i < order.length; i++) {
      expect(checkConnection(tool(order[i - 1]), tool(order[i])).status, `${order[i - 1]} to ${order[i]}`).toBe('match');
    }
    expect(checkConnection(tool('bowtie2-build'), tool('bowtie2-remove-reads')).status).toBe('match');
    expect(checkConnection(tool('star-genomegenerate'), tool('star-riboseq')).status).toBe('match');
    expect(checkConnection(tool('samtools-index'), tool('umi-tools-dedup')).status).toBe('match');
    for (const id of ['umi-tools-extract', 'umi-tools-dedup', 'bowtie2-remove-reads', 'star-riboseq']) {
      expect(checkConnection(tool(id), tool('multiqc')).status, `${id} to MultiQC`).toBe('match');
    }
  });

  it('binds the whole pipeline without a question, except where a step makes a log beside the file', () => {
    const nodes = [
      catalogNode('cut', 'cutadapt', { reads: 'raw.fastq.gz' }),
      catalogNode('umi', 'umi-tools-extract'),
      catalogNode('idx', 'bowtie2-build', { ref: 'rRNA.fa' }),
      catalogNode('rm', 'bowtie2-remove-reads'),
      catalogNode('gen', 'star-genomegenerate', { genome: 'g.fa', annotation: 'g.gtf' }),
      catalogNode('star', 'star-riboseq'),
      catalogNode('view', 'samtools-view'),
      catalogNode('sort', 'samtools-sort'),
      catalogNode('index', 'samtools-index'),
      catalogNode('dedup', 'umi-tools-dedup'),
      catalogNode('ribo', 'ribowaltz-report', { annotation: 'g.gtf' }),
    ];
    const { nodes: wired, plans } = wire(nodes, [
      ['cut', 'umi'],
      ['umi', 'rm'],
      ['idx', 'rm'],
      ['rm', 'star'],
      ['gen', 'star'],
      ['star', 'view'],
      ['view', 'sort'],
      ['sort', 'index'],
      ['sort', 'dedup'],
      ['index', 'dedup'],
      ['dedup', 'ribo'],
    ]);
    expect(plans.filter((p) => p.kind === 'ask').map((p) => p.pair)).toEqual([]);
    const files = (id: string, slot: string) => {
      const link = linkOf(wired, id, slot);
      return Array.isArray(link) ? link[0] : link;
    };
    expect(files('umi', 'reads')).toMatchObject({ from: 'cut', output: 'trimmed' });
    expect(files('rm', 'reads')).toMatchObject({ from: 'umi', output: 'extracted' });
    expect(files('rm', 'index')).toMatchObject({ from: 'idx', output: 'index' });
    expect(files('star', 'reads')).toMatchObject({ from: 'rm', output: 'unaligned' });
    expect(files('star', 'index')).toMatchObject({ from: 'gen', output: 'index_dir' });
    expect(files('view', 'alignments')).toMatchObject({ from: 'star', output: 'transcriptome_bam' });
    expect(files('dedup', 'alignments')).toMatchObject({ from: 'sort', output: 'bam' });
    expect(files('dedup', 'index')).toMatchObject({ from: 'index', output: 'bai' });
    expect(files('ribo', 'bams')).toMatchObject({ from: 'dedup', output: 'deduplicated' });
  });

  it('the STAR transcript BAM is a derived output that follows its folder', () => {
    const [node] = [catalogNode('star', 'star-riboseq', { out_dir: 'my star/' })];
    const states = slotStates(node, [node], []);
    const bam = states.find((s) => s.def.id === 'transcriptome_bam')!;
    expect(bam.def.derived).toBeTruthy();
    expect(bam.files).toEqual(['my star/Aligned.toTranscriptome.out.bam']);
    expect(states.find((s) => s.def.id === 'log')!.files).toEqual(['my star/Log.final.out']);
  });

  it('riboWaltz has an optional genome and a report folder with two derived files', () => {
    const node = catalogNode('ribo', 'ribowaltz-report', { annotation: 'g.gtf', bams: 'a.bam', report_dir: 'out/' });
    const yaml = slotYaml(node, [node], []);
    expect(yaml.optional_slots).toEqual(['genome']);
    expect(yaml.named_outputs).toMatchObject({
      report_dir: ['out/'],
      report: ['out/ribowaltz_report.html'],
      offsets: ['out/psite_offsets.tsv'],
    });
    expect(yaml.named_inputs!.genome).toEqual([]);
  });
});

describe('files that ship with the app: {app_resource:path}', () => {
  const root = path.resolve(__dirname, '../../../../RustRunner/runtime/app_resources');

  it('reads the reference as one placeholder, not as a file slot', () => {
    const command = 'Rscript {app_resource:ribowaltz/ribowaltz_report.R} {bams}';
    expect(placeholderNames(command)).toEqual(['app_resource:ribowaltz/ribowaltz_report.R', 'bams']);
    const holes = scanCommand(command).filter((p) => p.kind === 'hole');
    expect(holes).toHaveLength(2);
    // Not a reference: nothing after the prefix, or odd characters.
    expect(placeholderNames('{app_resource:} {app_resource: x} {app_resource:a;b}')).toEqual([]);
    expect(resourceOf('app_resource:a/b.R')).toBe('a/b.R');
    expect(resourceOf('reads')).toBeNull();
  });

  it('a hand-edited command does not get a file field for the reference', () => {
    const data = { command: 'Rscript {app_resource:a/b.R} {bams}', catalogCommandCustom: true };
    expect(slotDefsFor(data).map((d) => d.id)).toEqual(['bams']);
  });

  it('shows the reference in "What will run" as a file of the app, never as a missing file', () => {
    const preview = previewCommand('Rscript {app_resource:ribowaltz/ribowaltz_report.R} {bams}', {
      structured: true,
      input: [],
      output: [],
      threads: 1,
      slots: { bams: ['a.bam'] },
    });
    expect(preview.missing).toEqual([]);
    expect(preview.text).toBe('Rscript RustRunner/app_resources/ribowaltz/ribowaltz_report.R a.bam');
    const bad = previewCommand('Rscript {app_resource:../x.R}', { structured: true, input: [], output: [], threads: 1, slots: {} });
    expect(bad.missing).toEqual(['app_resource:../x.R']);
  });

  it('accepts only plain relative paths (the same rules as the engine)', () => {
    for (const ok of ['a.R', 'ribowaltz/ribowaltz_report.R', 'a-b_c/d.e.f']) expect(resourcePathProblem(ok), ok).toBeNull();
    for (const bad of ['', '/etc/passwd', '../x', 'a/../x', 'a/./x', 'a//b', 'a/', '.hidden', 'a/.hidden', 'a b', 'a;b', 'a$b', 'a\\b', "a'b", 'ünï.R', 'x'.repeat(121)]) {
      expect(resourcePathProblem(bad), JSON.stringify(bad)).not.toBeNull();
    }
    expect(resourcePathProblem('x'.repeat(120))).toBeNull();
  });

  it('the catalog check refuses a command that names a bad path', () => {
    const copy: any = JSON.parse(JSON.stringify(CATALOG));
    const t = copy.tools.find((x: any) => x.id === 'ribowaltz-report');
    t.command = t.command.replace('ribowaltz/ribowaltz_report.R', '../../etc/passwd');
    expect(validateCatalog(copy).join('\n')).toContain('ribowaltz-report: {app_resource:../../etc/passwd}: the path may not use . or .. parts');
  });

  it('every bundled file a catalog command names exists in the resources folder', () => {
    const named = CATALOG.tools.flatMap((t) => [...t.command.matchAll(/\{app_resource:([^}]*)\}/g)].map((m) => ({ tool: t.id, rel: m[1] })));
    expect(named.length).toBeGreaterThan(0);
    for (const { tool: id, rel } of named) {
      const file = path.join(root, rel);
      expect(fs.existsSync(file), `${id}: ${rel} is not in RustRunner/runtime/app_resources`).toBe(true);
      expect(fs.statSync(file).isFile()).toBe(true);
    }
  });

  it('the report script is a plain script: nothing here needs the network or pandoc', () => {
    const script = fs
      .readFileSync(path.join(root, 'ribowaltz/ribowaltz_report.R'), 'utf8')
      .split('\n')
      .filter((line) => !/^\s*#/.test(line))
      .join('\n');
    expect(script).not.toMatch(/install\.packages|BiocManager|devtools|remotes::|download\.file|rmarkdown|pandoc|knitr/);
    expect(script).not.toMatch(/https?:\/\//); // no address to fetch from
    expect(script).toContain('.libPaths(.Library, include.site = FALSE)');
  });

  it('the packaged app carries the folder next to the engine', () => {
    const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../../package.json'), 'utf8'));
    const entry = pkg.build.extraResources.find((r: any) => r.to === 'app_resources');
    expect(entry).toMatchObject({ from: '../RustRunner/runtime/app_resources' });
  });
});
