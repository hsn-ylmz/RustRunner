/**
 * Shared machinery of the real-tool suite (`npm run test:tools`, opt-in).
 *
 * A "chain" is a small workflow built the way the app builds it: catalog nodes
 * come from `buildCatalogNodeData`, connections are bound with
 * `connectWithBinding` (the same code the canvas runs when two steps are
 * joined), the canvas is converted with `convertNodesToWorkflow` and written as
 * YAML exactly like main.ts does. The YAML is then run through the real
 * `rustrunner` binary against the real bioconda tools on small synthetic data
 * (`make_data.py`). Every chain switches on "outputs must exist" and "outputs
 * must be non-empty", so a declared output that is not what the tool really
 * writes fails the step.
 *
 * Each domain keeps its chains in its own file, `chains/<domain>.tools.ts`,
 * and registers them with `defineDomain`. To run some domains only:
 *
 *     TOOLS_DOMAIN=dna npm run test:tools
 *     TOOLS_DOMAIN=dna,rna npm run test:tools
 *     TOOLS_CHAIN=salmon npm run test:tools       (chains whose name contains it)
 *
 * Everything lives in `<repo>/.sandbox` (gitignored): micromamba, the conda
 * environments and downloaded tools (the engine's `$HOME/.rustrunner`, with
 * HOME pointed at `.sandbox/home`), the data, the run directories and the
 * results. Nothing is written to the real home directory.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
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
import {
  applyBinding,
  connectWithBinding,
  type BindingOption,
} from '../src/renderer/slots';
import { convertNodesToWorkflow, labelToId, validateWorkflow } from '../src/renderer/workflowConversion';

export const ENABLED = process.env.RUSTRUNNER_REAL_TOOLS === '1';

const DESKTOP = path.resolve(__dirname, '..');
export const REPO = path.resolve(DESKTOP, '..');
const ENGINE_DIR = path.join(REPO, 'RustRunner');
export const SANDBOX = path.join(REPO, '.sandbox');
export const HOME = path.join(SANDBOX, 'home');
const BIN = path.join(SANDBOX, 'bin');
export const DATA = path.join(SANDBOX, 'data');
const RUNS = path.join(SANDBOX, 'runs');
const RESULTS = path.join(SANDBOX, 'tools-results');

// -----------------------------------------------------------------------------
// Chain description
// -----------------------------------------------------------------------------

/** One step of a chain: a catalog tool with its options and files, or a plain command. */
export interface NodeSpec {
  key: string;
  /** Catalog tool id; its command is rendered by the GUI code. */
  catalog?: string;
  /** Option values of the catalog tool (everything else keeps its default). */
  params?: Record<string, string | number | boolean>;
  /**
   * Files typed into the tool's slots, by slot name. A slot left out is filled
   * by a connection (see `edges`) or keeps the default of an output slot.
   */
  files?: Record<string, string>;
  /** A plain step for something the catalog does not have (an index builder). */
  raw?: {
    label: string;
    tool: string;
    command: string;
    threads?: number;
    input?: string;
    output?: string;
    /** The step's `install` block, written to the YAML as it is. */
    install?: Record<string, unknown>;
  };
}

/** `[from, to]`: the connection is drawn and binds a file; `[from, to, 'after']`: only an ordering. */
export type EdgeSpec = [string, string] | [string, string, 'after'];

export interface Check {
  /** The catalog tool the check speaks for (a failure is recorded against it). */
  tool?: string;
  ok: boolean;
  message: string;
}

export interface Chain {
  name: string;
  /** Files copied from the data folder into the run directory. */
  files: string[];
  nodes: NodeSpec[];
  edges: EdgeSpec[];
  /**
   * Answers to the question the app asks when a connection fits several slots:
   * `'<from>><to>'` -> the slot and the output to use. An unanswered question
   * fails the chain, so a connection that became ambiguous is noticed.
   */
  bindings?: Record<string, Array<{ slot: string; output: string }>>;
  verify?: (dir: string) => Check[];
}

export interface DomainDefinition {
  /** The domain name: also the file name, `chains/<domain>.tools.ts`. */
  domain: string;
  /** Extra data this domain needs, made once before its chains run (after `make_data.py`). */
  prepare?: () => void;
  /** Every catalog tool this domain's chains exercise. */
  covers: string[];
  chains: Chain[];
}

// -----------------------------------------------------------------------------
// Registry (read by coverage.tools.ts without running anything)
// -----------------------------------------------------------------------------

const REGISTRY: DomainDefinition[] = [];
let collectOnly = false;

/** Makes `defineDomain` only record the domain, not register tests (for the coverage file). */
export function setCollectOnly(value: boolean): void {
  collectOnly = value;
}

export function registeredDomains(): DomainDefinition[] {
  return REGISTRY;
}

/** True when TOOLS_DOMAIN is unset, or lists `domain`. */
export function domainSelected(domain: string): boolean {
  const selected = (process.env.TOOLS_DOMAIN ?? '')
    .split(',')
    .map((d) => d.trim())
    .filter(Boolean);
  return selected.length === 0 || selected.includes(domain);
}

function chainSelected(name: string): boolean {
  const wanted = (process.env.TOOLS_CHAIN ?? '').trim();
  return wanted === '' || name.includes(wanted);
}

// -----------------------------------------------------------------------------
// Small helpers for chain verification
// -----------------------------------------------------------------------------

export const read = (dir: string, rel: string): string => fs.readFileSync(path.join(dir, rel), 'utf8');
export const exists = (dir: string, rel: string): boolean => fs.existsSync(path.join(dir, rel));
export const sizeOf = (dir: string, rel: string): number => fs.statSync(path.join(dir, rel)).size;

export function truthSnps(): Array<{ contig: string; pos: number; alt: string }> {
  return fs
    .readFileSync(path.join(DATA, 'truth_snps.tsv'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => {
      const [contig, pos, , alt] = line.split('\t');
      return { contig, pos: Number(pos), alt };
    });
}

/** Read counts of the data rows of a featureCounts table (last column). */
export function countsPerGene(table: string): number[] {
  return table
    .split('\n')
    .filter((l) => l && !l.startsWith('#') && !l.startsWith('Geneid'))
    .map((l) => Number(l.split('\t').pop()));
}

// -----------------------------------------------------------------------------
// Sandbox, micromamba, engine
// -----------------------------------------------------------------------------

/**
 * Makes the synthetic Nanopore signal files (`make_pod5.py`) in the data folder. They need the
 * pod5 and FAST5 Python packages, which are installed into a virtual environment inside the
 * sandbox (`.sandbox/venv-pod5`); nothing is installed into the system Python. Runs again only
 * when `make_pod5.py` has changed.
 */
export function ensurePod5Data(): void {
  const script = path.join(__dirname, 'make_pod5.py');
  const stamp = path.join(DATA, '.pod5-stamp');
  const wanted = createHash('sha256').update(fs.readFileSync(script)).digest('hex');
  const outputs = ['nano_a.pod5', 'nano_b.pod5', 'nano_fast5.fast5', 'nano_ids.txt', 'nano_truth.tsv'];
  if (
    fs.existsSync(stamp) &&
    fs.readFileSync(stamp, 'utf8') === wanted &&
    outputs.every((f) => fs.existsSync(path.join(DATA, f)))
  ) {
    return;
  }
  const venv = path.join(SANDBOX, 'venv-pod5');
  const python = path.join(venv, 'bin', 'python');
  // pip and the venv live in the sandbox: HOME and the pip cache point there.
  const env = sandboxEnv({ PIP_CACHE_DIR: path.join(HOME, '.cache', 'pip'), PIP_DISABLE_PIP_VERSION_CHECK: '1' });
  if (!fs.existsSync(python)) {
    const made = run('python3', ['-m', 'venv', venv], { env });
    if (made.status !== 0) throw new Error(`could not create the pod5 virtual environment: ${made.stderr}`);
  }
  const have = run(python, ['-I', '-W', 'ignore', '-c', 'import pod5, ont_fast5_api'], { env });
  if (have.status !== 0) {
    // ont-fast5-api still imports pkg_resources, which newer setuptools no longer ships.
    const installed = run(python, ['-m', 'pip', 'install', '--quiet', 'pod5', 'ont-fast5-api', 'setuptools<81'], { env });
    if (installed.status !== 0) throw new Error(`could not install pod5 into the sandbox virtual environment: ${installed.stderr}`);
  }
  const gen = run(python, ['-I', '-W', 'ignore', script, DATA], { env });
  if (gen.status !== 0) throw new Error(`make_pod5.py failed: ${gen.stderr}`);
  fs.writeFileSync(stamp, wanted);
}

function sandboxEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  // HOME is the sandbox so the engine's $HOME/.rustrunner never touches the real home.
  return { ...process.env, HOME, PATH: `${BIN}:${process.env.PATH}`, ...extra };
}

export function run(cmd: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}) {
  return spawnSync(cmd, args, {
    encoding: 'utf8',
    cwd: opts.cwd ?? REPO,
    env: opts.env ?? sandboxEnv(),
    maxBuffer: 1 << 28,
  });
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

// -----------------------------------------------------------------------------
// Building a chain the way the app does
// -----------------------------------------------------------------------------

export interface BuiltChain {
  workflow: any;
  /** node key -> step id */
  stepOf: Record<string, string>;
  /** step id -> catalog tool id (catalog steps only) */
  toolOf: Record<string, string>;
}

function optionText(options: BindingOption[]): string {
  return options.map((o) => `${o.slot} <- ${o.outputKey || 'main output'}`).join('; ');
}

export function buildWorkflow(chain: Chain): BuiltChain {
  const labels: string[] = [];
  let canvas: any[] = chain.nodes.map((spec) => {
    let data: Record<string, any>;
    if (spec.catalog) {
      const tool = findTool(spec.catalog);
      if (!tool) throw new Error(`no catalog tool ${spec.catalog}`);
      data = buildCatalogNodeData(tool, labels);
      const params = { ...defaultParams(tool), ...spec.params };
      data.catalogParams = params;
      data.command = renderCommand(tool, params, tool.threads);
      data.slotFiles = { ...data.slotFiles, ...spec.files };
    } else {
      const raw = spec.raw!;
      data = {
        label: uniqueLabel(raw.label, labels),
        tool: raw.tool,
        command: raw.command.replace('{threads}', String(raw.threads ?? 1)),
        threads: raw.threads ?? 1,
        input: raw.input ?? '',
        output: raw.output ?? '',
      };
    }
    // The GUI's "Outputs must exist / be non-empty" checkboxes: the engine then
    // fails a step whose declared output is not what the tool really wrote.
    data.checkExists = true;
    data.checkNonEmpty = true;
    labels.push(data.label);
    return { id: spec.key, position: { x: 0, y: 0 }, data };
  });

  // Draw the connections one by one, as a person would, and let the app bind files.
  const edges: any[] = [];
  for (const [source, target, mode] of chain.edges) {
    const before = [...edges];
    edges.push({ id: `${source}-${target}`, source, target });
    if (mode === 'after') continue;
    const { nodes: bound, plan } = connectWithBinding(canvas, before, edges, source, target);
    canvas = bound;
    if (plan.kind === 'ask') {
      const answers = chain.bindings?.[`${source}>${target}`];
      if (!answers) {
        throw new Error(
          `connecting ${source} to ${target} asks where the file goes (${optionText(plan.options)}); add a bindings entry to the chain`
        );
      }
      for (const answer of answers) {
        const option = plan.options.find((o) => o.slot === answer.slot && o.outputKey === answer.output);
        if (!option) {
          throw new Error(
            `bindings for ${source}>${target}: no option ${answer.slot} <- ${answer.output}; the app offers ${optionText(plan.options)}`
          );
        }
        canvas = applyBinding(canvas, target, source, option);
      }
    }
  }

  const problems = validateCatalogNodes(canvas);
  if (problems.length) throw new Error(problems.join('; '));
  const workflow = convertNodesToWorkflow(canvas, edges, {}, { name: chain.name });
  chain.nodes.forEach((spec, i) => {
    if (spec.raw?.install) workflow.steps[i].install = spec.raw.install;
  });
  const errors = validateWorkflow(workflow);
  if (errors.length) throw new Error(errors.join('; '));
  const stepOf: Record<string, string> = {};
  const toolOf: Record<string, string> = {};
  chain.nodes.forEach((spec, i) => {
    const step = labelToId(canvas[i].data.label);
    stepOf[spec.key] = step;
    if (spec.catalog) toolOf[step] = spec.catalog;
  });
  return { workflow, stepOf, toolOf };
}

// -----------------------------------------------------------------------------
// Results
// -----------------------------------------------------------------------------

export interface ToolResult {
  status: 'pass' | 'fail' | 'unavailable';
  note: string;
  chains: string[];
}

/** The result of every catalog tool recorded so far by the chains of one domain run. */
function writeDomainResults(domain: string, results: Map<string, ToolResult>): void {
  fs.mkdirSync(RESULTS, { recursive: true });
  fs.writeFileSync(
    path.join(RESULTS, `${domain}.json`),
    JSON.stringify(Object.fromEntries(results), null, 2)
  );
}

/** Reads every domain's results and writes `.sandbox/tools-report.md` with a row per catalog tool. */
export function writeReport(): string {
  const merged = new Map<string, ToolResult>();
  if (fs.existsSync(RESULTS)) {
    for (const file of fs.readdirSync(RESULTS).filter((f) => f.endsWith('.json')).sort()) {
      const part = JSON.parse(fs.readFileSync(path.join(RESULTS, file), 'utf8')) as Record<string, ToolResult>;
      for (const [id, result] of Object.entries(part)) {
        const prev = merged.get(id);
        // A failure anywhere wins over a pass elsewhere.
        if (prev && prev.status !== 'pass' && result.status === 'pass') continue;
        merged.set(id, result);
      }
    }
  }
  const lines = ['| Tool | Status | Chains | Note |', '|---|---|---|---|'];
  for (const tool of CATALOG.tools) {
    const r = merged.get(tool.id);
    lines.push(`| ${tool.id} | ${r?.status ?? 'not exercised'} | ${(r?.chains ?? []).join(', ')} | ${r?.note ?? ''} |`);
  }
  const table = lines.join('\n');
  fs.mkdirSync(SANDBOX, { recursive: true });
  fs.writeFileSync(path.join(SANDBOX, 'tools-report.md'), `${table}\n`);
  return table;
}

// -----------------------------------------------------------------------------
// Registering a domain
// -----------------------------------------------------------------------------

/**
 * Registers the chains of one domain as tests. Skipped unless
 * RUSTRUNNER_REAL_TOOLS=1 (set by `npm run test:tools`) and the domain is
 * selected with TOOLS_DOMAIN. After the chains, every tool the domain says it
 * covers must have passed in one of them.
 */
export function defineDomain(definition: DomainDefinition): void {
  REGISTRY.push(definition);
  if (collectOnly) return;

  const { domain, covers, chains } = definition;
  const results = new Map<string, ToolResult>();
  const record = (id: string, status: ToolResult['status'], note: string, chain: string) => {
    const prev = results.get(id);
    // A failure anywhere wins over a pass elsewhere.
    if (prev && prev.status !== 'pass' && status === 'pass') {
      return;
    }
    const chainsSoFar = new Set(prev?.chains ?? []);
    chainsSoFar.add(chain);
    results.set(id, { status, note, chains: [...chainsSoFar] });
  };

  describe.skipIf(!ENABLED || !domainSelected(domain))(`real tools: ${domain} (opt-in, RUSTRUNNER_REAL_TOOLS=1)`, () => {
    let exe = '';

    beforeAll(() => {
      fs.mkdirSync(HOME, { recursive: true });
      fs.mkdirSync(BIN, { recursive: true });
      fs.mkdirSync(DATA, { recursive: true });
      fs.mkdirSync(RUNS, { recursive: true });
      ensureMicromamba();
      exe = installEngine();
      const gen = run('python3', ['-I', path.join(__dirname, 'make_data.py'), DATA]);
      if (gen.status !== 0) throw new Error(`make_data.py failed: ${gen.stderr}`);
      definition.prepare?.();
    });

    for (const chain of chains) {
      it.skipIf(!chainSelected(chain.name))(`chain: ${chain.name}`, async () => {
        const dir = path.join(RUNS, chain.name);
        fs.rmSync(dir, { recursive: true, force: true });
        fs.mkdirSync(dir, { recursive: true });
        for (const f of chain.files) fs.copyFileSync(path.join(DATA, f), path.join(dir, f));

        const { workflow, toolOf } = buildWorkflow(chain);
        const workflowPath = path.join(dir, `${chain.name}.yaml`);
        fs.writeFileSync(workflowPath, yaml.dump(workflow));

        const outcome = await execute(exe, workflowPath, dir);
        fs.writeFileSync(path.join(dir, 'engine.log'), outcome.log);

        const failures: string[] = [];
        for (const [stepId, catalogId] of Object.entries(toolOf)) {
          const ok = outcome.steps[stepId] === 'step_succeeded';
          if (ok) record(catalogId, 'pass', '', chain.name);
          else if (/Failed to create environment/.test(outcome.log)) {
            record(catalogId, 'unavailable', 'the pinned package could not be installed on this platform', chain.name);
          } else if (/has no download for this computer/.test(outcome.log)) {
            record(catalogId, 'unavailable', 'the tool has no download for this platform', chain.name);
          } else record(catalogId, 'fail', `step ${stepId} ${outcome.steps[stepId] ?? 'did not run'}`, chain.name);
          if (!ok) failures.push(`${stepId}: ${outcome.steps[stepId] ?? 'did not run'}`);
        }
        for (const [stepId, event] of Object.entries(outcome.steps)) {
          if (event !== 'step_succeeded' && !(stepId in toolOf)) failures.push(`${stepId}: ${event}`);
        }
        if (outcome.ok && chain.verify) {
          for (const check of chain.verify(dir)) {
            if (!check.ok) {
              failures.push(`check failed: ${check.message}`);
              if (check.tool) record(check.tool, 'fail', check.message, chain.name);
            }
          }
        }
        expect(failures, `${failures.join('\n')}\n--- engine log tail ---\n${outcome.log.slice(-4000)}`).toEqual([]);
        expect(outcome.ok).toBe(true);
      });
    }

    afterAll(() => {
      writeDomainResults(domain, results);
      console.log(`\n${writeReport()}\n`);
    });

    it(`exercised every ${domain} tool and none failed`, () => {
      if (process.env.TOOLS_CHAIN) return; // a partial run proves nothing about coverage
      const missing = covers.filter((id) => !results.has(id));
      expect(missing, `${domain} tools no chain exercised`).toEqual([]);
      const bad = covers.filter((id) => results.get(id)?.status === 'fail');
      expect(bad).toEqual([]);
    });
  });
}
