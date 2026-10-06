/**
 * Real-tool validation of the bundled catalog (opt-in: `npm run test:tools`).
 *
 * Every catalog entry is rendered by the GUI's own code (`buildCatalogNodeData`,
 * `renderCommand`, `convertNodesToWorkflow`), written as YAML exactly like
 * main.ts does, and run through the real `rustrunner` binary against the real
 * bioconda tools on small synthetic data (`make_data.py`).
 *
 * Everything lives in `<repo>/.sandbox` (gitignored): micromamba, the conda
 * environments (the engine's `$HOME/.rustrunner`, with HOME pointed at
 * `.sandbox/home`), the data and the run directories. Nothing is written to
 * the real home directory.
 */
import { describe, expect, it, beforeAll } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import * as yaml from 'js-yaml';
import {
  CATALOG,
  buildCatalogNodeData,
  defaultParams,
  findTool,
  renderCommand,
  uniqueLabel,
  validateCatalogNodes,
} from '../src/renderer/tools/catalog';
import { convertNodesToWorkflow, labelToId, validateWorkflow } from '../src/renderer/workflowConversion';

const ENABLED = process.env.RUSTRUNNER_REAL_TOOLS === '1';

const DESKTOP = path.resolve(__dirname, '..');
const REPO = path.resolve(DESKTOP, '..');
const ENGINE_DIR = path.join(REPO, 'RustRunner');
const SANDBOX = path.join(REPO, '.sandbox');
const HOME = path.join(SANDBOX, 'home');
const BIN = path.join(SANDBOX, 'bin');
const DATA = path.join(SANDBOX, 'data');
const RUNS = path.join(SANDBOX, 'runs');
const MAMBA_ROOT = path.join(HOME, '.rustrunner', 'micromamba');

/** Set when a package only installs through Rosetta (osx-64 on Apple silicon). */
const rosetta = new Set<string>();

/**
 * Packages whose newest bioconda build is broken on macOS. The suite installs
 * an older build into the environment the engine will use (the engine reuses an
 * existing environment of the same name), so the catalog's command is still
 * checked against a working tool. The table notes it.
 */
const MACOS_PINS: Record<string, { spec: string; note: string }> = {
  star: {
    spec: 'star=2.7.10b',
    note: 'STAR 2.7.11b (current bioconda build) reads 0 reads on macOS and cannot spawn --readFilesCommand; checked with 2.7.10b under Rosetta',
  },
};
const pinned = new Map<string, string>();

interface NodeSpec {
  key: string;
  /** Catalog tool id; its command is rendered by the GUI code. */
  catalog?: string;
  params?: Record<string, string | number | boolean>;
  /** A plain node for a step the catalog does not have (index builders). */
  raw?: { label: string; tool: string; command: string; threads?: number };
  input: string;
  output: string;
}

interface Chain {
  name: string;
  files: string[];
  nodes: NodeSpec[];
  edges: Array<[string, string]>;
  verify?: (dir: string) => Array<{ tool?: string; ok: boolean; message: string }>;
}

const read = (dir: string, rel: string): string => fs.readFileSync(path.join(dir, rel), 'utf8');
const exists = (dir: string, rel: string): boolean => fs.existsSync(path.join(dir, rel));

function truthSnps(): Array<{ contig: string; pos: number; alt: string }> {
  return fs
    .readFileSync(path.join(DATA, 'truth_snps.tsv'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => {
      const [contig, pos, , alt] = line.split('\t');
      return { contig, pos: Number(pos), alt };
    });
}

const CHAINS: Chain[] = [
  {
    name: 'dna-single-end',
    files: ['ref.fa', 'dna_se.fastq.gz'],
    nodes: [
      { key: 'fastp', catalog: 'fastp', input: 'dna_se.fastq.gz', output: 'trimmed.fastq.gz' },
      {
        key: 'bwaidx',
        raw: { label: 'BWA index', tool: 'bwa', command: 'bwa index {input}' },
        input: 'ref.fa',
        output: 'ref.fa.bwt',
      },
      {
        key: 'bwa',
        catalog: 'bwa-mem',
        params: { ref: 'ref.fa' },
        input: 'trimmed.fastq.gz',
        output: 'aligned.sam',
      },
      { key: 'sort', catalog: 'samtools-sort', input: 'aligned.sam', output: 'sorted.bam' },
      { key: 'index', catalog: 'samtools-index', input: 'sorted.bam', output: 'sorted.bam.bai' },
      {
        key: 'faidx',
        raw: { label: 'Reference index', tool: 'samtools', command: 'samtools faidx {input}' },
        input: 'ref.fa',
        output: 'ref.fa.fai',
      },
      {
        key: 'call',
        catalog: 'bcftools-call',
        params: { ref: 'ref.fa' },
        input: 'sorted.bam',
        output: 'variants.vcf',
      },
      { key: 'view', catalog: 'samtools-view', input: 'sorted.bam', output: 'filtered.bam' },
      { key: 'flagstat', catalog: 'samtools-flagstat', input: 'sorted.bam', output: 'flagstat.txt' },
    ],
    edges: [
      ['fastp', 'bwa'],
      ['bwaidx', 'bwa'],
      ['bwa', 'sort'],
      ['sort', 'index'],
      ['sort', 'call'],
      ['index', 'call'],
      ['faidx', 'call'],
      ['sort', 'view'],
      ['sort', 'flagstat'],
    ],
    verify: (dir) => {
      const sam = read(dir, 'aligned.sam');
      const calls = read(dir, 'variants.vcf')
        .split('\n')
        .filter((l) => l && !l.startsWith('#'))
        .map((l) => l.split('\t'));
      const found = truthSnps().filter((s) =>
        calls.some((c) => c[0] === s.contig && Number(c[1]) === s.pos && c[4].split(',').includes(s.alt))
      );
      const total = truthSnps().length;
      return [
        { tool: 'bwa-mem', ok: sam.includes('@SQ') && /\n[^@]/.test(sam), message: 'SAM has header and alignments' },
        {
          tool: 'bcftools-call',
          ok: found.length >= Math.ceil(total * 0.75),
          message: `${found.length}/${total} planted SNPs called`,
        },
        { tool: 'samtools-flagstat', ok: /mapped \((?:9\d|100)\.\d+%/.test(read(dir, 'flagstat.txt')), message: 'over 90% mapped' },
        { tool: 'samtools-view', ok: fs.statSync(path.join(dir, 'filtered.bam')).size > 1000, message: 'filtered BAM not tiny' },
      ];
    },
  },
  {
    name: 'dna-paired-end-featurecounts',
    files: ['ref.fa', 'genes.gtf', 'dna_R1.fastq.gz', 'dna_R2.fastq.gz'],
    nodes: [
      {
        key: 'bwaidx',
        raw: { label: 'BWA index', tool: 'bwa', command: 'bwa index {input}' },
        input: 'ref.fa',
        output: 'ref.fa.bwt',
      },
      {
        key: 'bwa',
        catalog: 'bwa-mem',
        params: { ref: 'ref.fa' },
        input: 'dna_R1.fastq.gz, dna_R2.fastq.gz',
        output: 'aligned.sam',
      },
      { key: 'sort', catalog: 'samtools-sort', input: 'aligned.sam', output: 'sorted.bam' },
      {
        key: 'fc',
        catalog: 'featurecounts',
        params: { annotation: 'genes.gtf', paired: true },
        input: 'sorted.bam',
        output: 'counts.tsv',
      },
    ],
    edges: [
      ['bwaidx', 'bwa'],
      ['bwa', 'sort'],
      ['sort', 'fc'],
    ],
    verify: (dir) => {
      const counts = countsPerGene(read(dir, 'counts.tsv'));
      const pairs = zlib.gunzipSync(fs.readFileSync(path.join(dir, 'dna_R1.fastq.gz'))).toString().split('\n').length / 4;
      const assigned = counts.reduce((a, b) => a + b, 0);
      return [
        { tool: 'featurecounts', ok: counts.every((n) => n > 0), message: 'every gene has reads' },
        // Counting single reads instead of pairs (-p without --countReadPairs) would exceed the pair count.
        { tool: 'featurecounts', ok: assigned <= pairs, message: `counted pairs, not reads (${assigned} <= ${pairs})` },
      ];
    },
  },
  {
    name: 'trim-and-qc',
    files: ['dna_se.fastq.gz'],
    nodes: [
      { key: 'cut', catalog: 'cutadapt', input: 'dna_se.fastq.gz', output: 'cut.fastq.gz' },
      { key: 'fqc', catalog: 'fastqc', input: 'cut.fastq.gz', output: 'qc/cut_fastqc.html' },
      { key: 'mqc', catalog: 'multiqc', input: 'qc/cut_fastqc.zip', output: 'multiqc/multiqc_report.html' },
    ],
    edges: [
      ['cut', 'fqc'],
      ['fqc', 'mqc'],
    ],
    verify: (dir) => [
      { tool: 'cutadapt', ok: exists(dir, 'cut.fastq.gz'), message: 'trimmed reads written' },
      { tool: 'fastqc', ok: exists(dir, 'qc/cut_fastqc.zip'), message: 'FastQC zip written' },
      { tool: 'multiqc', ok: read(dir, 'multiqc/multiqc_report.html').includes('FastQC'), message: 'report mentions FastQC' },
    ],
  },
  {
    name: 'bowtie2',
    files: ['ref.fa', 'dna_se.fastq.gz'],
    nodes: [
      {
        key: 'idx',
        raw: { label: 'Bowtie2 build', tool: 'bowtie2', command: 'bowtie2-build {input} ref_bt2' },
        input: 'ref.fa',
        output: 'ref_bt2.1.bt2',
      },
      {
        key: 'align',
        catalog: 'bowtie2',
        params: { index: 'ref_bt2' },
        input: 'dna_se.fastq.gz',
        output: 'aligned.sam',
      },
      { key: 'flagstat', catalog: 'samtools-flagstat', input: 'aligned.sam', output: 'flagstat.txt' },
    ],
    edges: [
      ['idx', 'align'],
      ['align', 'flagstat'],
    ],
    verify: (dir) => [
      { tool: 'bowtie2', ok: /mapped \((?:9\d|100)\.\d+%/.test(read(dir, 'flagstat.txt')), message: 'over 90% mapped' },
    ],
  },
  {
    name: 'star-rna-featurecounts',
    files: ['ref.fa', 'genes.gtf', 'rna_se.fastq.gz'],
    nodes: [
      {
        key: 'gen',
        raw: {
          label: 'STAR genomeGenerate',
          tool: 'star',
          command:
            'STAR --runMode genomeGenerate --runThreadN {threads} --genomeDir star_index ' +
            '--genomeFastaFiles {input} --sjdbGTFfile genes.gtf --sjdbOverhang 74 ' +
            '--genomeSAindexNbases 4 --outFileNamePrefix star_gen_',
          threads: 2,
        },
        input: 'ref.fa',
        output: 'star_index/SA',
      },
      {
        key: 'star',
        catalog: 'star',
        params: { genome_dir: 'star_index' },
        input: 'rna_se.fastq.gz',
        output: 'star/Aligned.sortedByCoord.out.bam',
      },
      {
        key: 'fc',
        catalog: 'featurecounts',
        params: { annotation: 'genes.gtf' },
        input: 'star/Aligned.sortedByCoord.out.bam',
        output: 'counts.tsv',
      },
    ],
    edges: [
      ['gen', 'star'],
      ['star', 'fc'],
    ],
    verify: (dir) => [
      {
        tool: 'featurecounts',
        ok: countsPerGene(read(dir, 'counts.tsv')).every((n) => n > 0),
        message: 'every gene has reads (spliced RNA reads)',
      },
      { tool: 'star', ok: fs.statSync(path.join(dir, 'star/Aligned.sortedByCoord.out.bam')).size > 1000, message: 'BAM not tiny' },
    ],
  },
  {
    name: 'parameter-variants',
    files: ['ref.fa', 'transcripts.fa', 'dna_se.fastq.gz', 'rna_se.fastq.gz'],
    nodes: [
      {
        key: 'bt2idx',
        raw: { label: 'Bowtie2 build', tool: 'bowtie2', command: 'bowtie2-build {input} ref_bt2' },
        input: 'ref.fa',
        output: 'ref_bt2.1.bt2',
      },
      ...['very-fast', 'fast', 'very-sensitive'].map((preset) => ({
        key: `bt2_${preset}`,
        catalog: 'bowtie2',
        params: { index: 'ref_bt2', preset },
        input: 'dna_se.fastq.gz',
        output: `bt2_${preset}.sam`,
      })),
      {
        key: 'bwaidx',
        raw: { label: 'BWA index', tool: 'bwa', command: 'bwa index {input}' },
        input: 'ref.fa',
        output: 'ref.fa.bwt',
      },
      {
        key: 'bwa',
        catalog: 'bwa-mem',
        params: { ref: 'ref.fa', mark_secondary: false, min_seed_length: 25 },
        input: 'dna_se.fastq.gz',
        output: 'bwa_plain.sam',
      },
      {
        key: 'byname',
        catalog: 'samtools-sort',
        params: { by_name: true, memory_per_thread: '256M' },
        input: 'bwa_plain.sam',
        output: 'byname.bam',
      },
      {
        key: 'all',
        catalog: 'samtools-view',
        params: { mapped_only: false, min_mapq: 0 },
        input: 'byname.bam',
        output: 'all.bam',
      },
      {
        key: 'sidx',
        raw: { label: 'Salmon index', tool: 'salmon', command: 'salmon index -t {input} -i salmon_index -k 11' },
        input: 'transcripts.fa',
        output: 'salmon_index/info.json',
      },
      ...['U', 'SF', 'SR'].map((libtype) => ({
        key: `salmon_${libtype}`,
        catalog: 'salmon-quant',
        params: { index: 'salmon_index', libtype, outdir: `salmon_${libtype}` },
        input: 'rna_se.fastq.gz',
        output: `salmon_${libtype}/quant.sf`,
      })),
    ],
    edges: [
      ['bt2idx', 'bt2_very-fast'],
      ['bt2idx', 'bt2_fast'],
      ['bt2idx', 'bt2_very-sensitive'],
      ['bwaidx', 'bwa'],
      ['bwa', 'byname'],
      ['byname', 'all'],
      ['sidx', 'salmon_U'],
      ['sidx', 'salmon_SF'],
      ['sidx', 'salmon_SR'],
    ],
  },
  {
    name: 'salmon',
    files: ['transcripts.fa', 'rna_se.fastq.gz'],
    nodes: [
      {
        key: 'idx',
        raw: {
          label: 'Salmon index',
          tool: 'salmon',
          command: 'salmon index -t {input} -i salmon_index -k 11 -p {threads}',
          threads: 2,
        },
        input: 'transcripts.fa',
        output: 'salmon_index/info.json',
      },
      {
        key: 'quant',
        catalog: 'salmon-quant',
        params: { index: 'salmon_index' },
        input: 'rna_se.fastq.gz',
        output: 'salmon_out/quant.sf',
      },
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
];

/** Read counts of the data rows of a featureCounts table (last column). */
function countsPerGene(table: string): number[] {
  return table
    .split('\n')
    .filter((l) => l && !l.startsWith('#') && !l.startsWith('Geneid'))
    .map((l) => Number(l.split('\t').pop()));
}

function sandboxEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  // HOME is the sandbox so the engine's $HOME/.rustrunner never touches the real home.
  return { ...process.env, HOME, PATH: `${BIN}:${process.env.PATH}`, ...extra };
}

function run(cmd: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}) {
  return spawnSync(cmd, args, { encoding: 'utf8', cwd: opts.cwd ?? REPO, env: opts.env ?? sandboxEnv(), maxBuffer: 1 << 28 });
}

function ensureMicromamba(): void {
  const target = path.join(BIN, 'micromamba');
  if (fs.existsSync(target)) return;
  const arch = run('uname', ['-m']).stdout.trim();
  const os = process.platform === 'darwin' ? 'osx' : 'linux';
  const plat = os === 'osx' ? (arch === 'arm64' ? 'osx-arm64' : 'osx-64') : arch === 'aarch64' ? 'linux-aarch64' : 'linux-64';
  const tmp = path.join(SANDBOX, 'tmp', 'mm-download');
  fs.mkdirSync(tmp, { recursive: true });
  const archive = path.join(tmp, 'mm.tar.bz2');
  const dl = run('curl', ['-fsSL', `https://micro.mamba.pm/api/micromamba/${plat}/latest`, '-o', archive]);
  if (dl.status !== 0) throw new Error(`micromamba download failed: ${dl.stderr}`);
  const ex = run('tar', ['-xjf', archive, '-C', tmp, 'bin/micromamba']);
  if (ex.status !== 0) throw new Error(`micromamba extract failed: ${ex.stderr}`);
  fs.copyFileSync(path.join(tmp, 'bin', 'micromamba'), target);
  fs.chmodSync(target, 0o755);
}

/**
 * Builds the engine and copies it into the sandbox next to micromamba and an
 * empty env_map.json. The engine looks for both beside its own executable
 * first, so the repository's runtime/env_map.json is never rewritten.
 */
function installEngine(): string {
  // cargo/rustup need the real HOME for the toolchain; the build only writes into target/.
  const build = run('cargo', ['build', '--manifest-path', path.join(ENGINE_DIR, 'Cargo.toml')], { env: process.env });
  if (build.status !== 0) throw new Error(`cargo build failed:\n${build.stderr}`);
  const exe = path.join(BIN, 'rustrunner');
  fs.copyFileSync(path.join(ENGINE_DIR, 'target', 'debug', 'rustrunner'), exe);
  fs.chmodSync(exe, 0o755);
  fs.writeFileSync(path.join(BIN, 'env_map.json'), JSON.stringify({ map: {} }));
  return exe;
}

/** Fallback for packages with no native build: install the osx-64 build (Rosetta). */
function createRosettaEnv(pkg: string): boolean {
  const res = run(
    path.join(BIN, 'micromamba'),
    ['create', '-y', '-n', pkg, '-c', 'bioconda', '-c', 'conda-forge', pkg],
    { env: sandboxEnv({ MAMBA_ROOT_PREFIX: MAMBA_ROOT, CONDA_SUBDIR: 'osx-64' }) }
  );
  return res.status === 0;
}

/** Installs the pinned older builds on macOS (osx-64, i.e. Rosetta on Apple silicon). */
function installMacosPins(): void {
  if (process.platform !== 'darwin') return;
  for (const [pkg, pin] of Object.entries(MACOS_PINS)) {
    if (!fs.existsSync(path.join(MAMBA_ROOT, 'envs', pkg))) {
      const res = run(
        path.join(BIN, 'micromamba'),
        ['create', '-y', '-n', pkg, '-c', 'bioconda', '-c', 'conda-forge', pin.spec],
        { env: sandboxEnv({ MAMBA_ROOT_PREFIX: MAMBA_ROOT, CONDA_SUBDIR: 'osx-64' }) }
      );
      if (res.status !== 0) throw new Error(`could not install ${pin.spec}: ${res.stderr}`);
    }
    pinned.set(pkg, pin.note);
  }
}

interface RunResult {
  ok: boolean;
  log: string;
  /** step id -> final event ('step_succeeded' | 'step_failed' | 'step_skipped') */
  steps: Record<string, string>;
}

function execute(exe: string, workflowPath: string, dir: string): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(exe, [workflowPath, '--json-events', '--working-dir', dir], { env: sandboxEnv(), cwd: dir });
    let log = '';
    child.stdout.on('data', (d) => (log += d));
    child.stderr.on('data', (d) => (log += d));
    child.on('error', reject);
    child.on('close', (code) => {
      const steps: Record<string, string> = {};
      for (const line of log.split('\n')) {
        if (!line.startsWith('RUSTRUNNER_EVENT ')) continue;
        const ev = JSON.parse(line.slice('RUSTRUNNER_EVENT '.length));
        if (['step_succeeded', 'step_failed', 'step_skipped'].includes(ev.event)) steps[ev.step] = ev.event;
      }
      resolve({ ok: code === 0, log, steps });
    });
  });
}

/** Builds the canvas nodes the way the palette does, then converts them with the GUI code. */
function buildWorkflow(chain: Chain): { workflow: any; stepOf: Record<string, string>; toolOf: Record<string, string> } {
  const labels: string[] = [];
  const nodes = chain.nodes.map((spec) => {
    let data: Record<string, any>;
    if (spec.catalog) {
      const tool = findTool(spec.catalog);
      if (!tool) throw new Error(`no catalog tool ${spec.catalog}`);
      data = buildCatalogNodeData(tool, labels);
      const params = { ...defaultParams(tool), ...spec.params };
      data.catalogParams = params;
      data.command = renderCommand(tool, params, tool.defaultThreads);
    } else {
      const raw = spec.raw!;
      data = {
        label: uniqueLabel(raw.label, labels),
        tool: raw.tool,
        command: raw.command.replace('{threads}', String(raw.threads ?? 1)),
        threads: raw.threads ?? 1,
      };
    }
    data.input = spec.input;
    data.output = spec.output;
    // The GUI's "Outputs must exist / be non-empty" checkboxes: the engine then
    // fails a step whose declared output is not what the tool really wrote.
    data.checkExists = true;
    data.checkNonEmpty = true;
    labels.push(data.label);
    return { id: spec.key, data };
  });
  const problems = validateCatalogNodes(nodes);
  if (problems.length) throw new Error(problems.join('; '));
  const edges = chain.edges.map(([source, target]) => ({ source, target }));
  const workflow = convertNodesToWorkflow(nodes, edges, {}, { name: chain.name });
  const errors = validateWorkflow(workflow);
  if (errors.length) throw new Error(errors.join('; '));
  const stepOf: Record<string, string> = {};
  const toolOf: Record<string, string> = {};
  chain.nodes.forEach((spec, i) => {
    const step = labelToId(nodes[i].data.label);
    stepOf[spec.key] = step;
    if (spec.catalog) toolOf[step] = spec.catalog;
  });
  return { workflow, stepOf, toolOf };
}

interface ToolResult {
  status: 'pass' | 'fail' | 'unavailable';
  note: string;
}
const results = new Map<string, ToolResult>();

function record(id: string, status: ToolResult['status'], note: string) {
  const prev = results.get(id);
  // A failure anywhere wins over a pass elsewhere.
  if (prev && prev.status !== 'pass' && status === 'pass') return;
  results.set(id, { status, note });
}

describe.skipIf(!ENABLED)('real tools (opt-in, set RUSTRUNNER_REAL_TOOLS=1)', () => {
  let exe = '';

  beforeAll(() => {
    fs.mkdirSync(HOME, { recursive: true });
    fs.mkdirSync(BIN, { recursive: true });
    fs.mkdirSync(DATA, { recursive: true });
    ensureMicromamba();
    exe = installEngine();
    installMacosPins();
    const gen = run('python3', ['-I', path.join(__dirname, 'make_data.py'), DATA]);
    if (gen.status !== 0) throw new Error(`make_data.py failed: ${gen.stderr}`);
    fs.rmSync(RUNS, { recursive: true, force: true });
    fs.mkdirSync(RUNS, { recursive: true });
  });

  for (const chain of CHAINS) {
    it(`chain: ${chain.name}`, async () => {
      const dir = path.join(RUNS, chain.name);
      fs.mkdirSync(dir, { recursive: true });
      for (const f of chain.files) fs.copyFileSync(path.join(DATA, f), path.join(dir, f));

      const { workflow, stepOf, toolOf } = buildWorkflow(chain);
      const workflowPath = path.join(dir, `${chain.name}.yaml`);
      fs.writeFileSync(workflowPath, yaml.dump(workflow));

      let outcome = await execute(exe, workflowPath, dir);
      // Packages without a native build: retry through Rosetta, once per package.
      if (!outcome.ok && /Failed to create environment|No conda environment configured/.test(outcome.log)) {
        const packages = [...new Set(workflow.steps.map((s: any) => s.tool))] as string[];
        let created = false;
        for (const pkg of packages) {
          if (fs.existsSync(path.join(MAMBA_ROOT, 'envs', pkg))) continue;
          if (createRosettaEnv(pkg)) {
            rosetta.add(pkg);
            created = true;
          }
        }
        if (created) {
          fs.rmSync(path.join(dir, '.rustrunner'), { recursive: true, force: true });
          outcome = await execute(exe, workflowPath, dir);
        }
      }
      fs.writeFileSync(path.join(dir, 'engine.log'), outcome.log);

      const failures: string[] = [];
      for (const [stepId, catalogId] of Object.entries(toolOf)) {
        const ok = outcome.steps[stepId] === 'step_succeeded';
        const pkg = findTool(catalogId)!.conda.package;
        if (ok) record(catalogId, 'pass', pinned.get(pkg) ?? (rosetta.has(pkg) ? 'rosetta' : ''));
        else if (/No conda environment configured/.test(outcome.log) && !fs.existsSync(path.join(MAMBA_ROOT, 'envs', pkg)))
          record(catalogId, 'unavailable', 'no conda package for this platform');
        else record(catalogId, 'fail', `step ${stepId} ${outcome.steps[stepId] ?? 'did not run'}`);
        if (!ok) failures.push(`${stepId}: ${outcome.steps[stepId] ?? 'did not run'}`);
      }
      for (const [stepId, event] of Object.entries(outcome.steps)) {
        if (event !== 'step_succeeded' && !(stepId in toolOf)) failures.push(`${stepId}: ${event}`);
      }
      if (outcome.ok && chain.verify) {
        for (const check of chain.verify(dir)) {
          if (!check.ok) {
            failures.push(`check failed: ${check.message}`);
            if (check.tool) record(check.tool, 'fail', check.message);
          }
        }
      }
      expect(failures, `${failures.join('\n')}\n--- engine log tail ---\n${outcome.log.slice(-4000)}`).toEqual([]);
      expect(outcome.ok).toBe(true);
    });
  }

  it('exercised every catalog entry and wrote the results table', () => {
    const lines = ['| Tool | Status | Note |', '|---|---|---|'];
    for (const tool of CATALOG.tools) {
      const r = results.get(tool.id);
      lines.push(`| ${tool.id} | ${r?.status ?? 'not exercised'} | ${r?.note ?? ''} |`);
    }
    const table = lines.join('\n');
    fs.writeFileSync(path.join(SANDBOX, 'tools-report.md'), `${table}\n`);
    console.log(`\n${table}\n`);
    const missing = CATALOG.tools.filter((t) => !results.has(t.id)).map((t) => t.id);
    expect(missing, 'catalog entries no chain exercised').toEqual([]);
    const bad = CATALOG.tools.filter((t) => results.get(t.id)?.status === 'fail').map((t) => t.id);
    expect(bad).toEqual([]);
  });
});
