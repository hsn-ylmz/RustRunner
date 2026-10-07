/**
 * The long-read, assembly, metagenomics and Nanopore tools of the catalog
 * (minimap2 for long reads, NanoPlot, Filtlong, chopper, Flye, SPAdes, QUAST,
 * seqkit, Kraken2, Bracken, the POD5 tools and Dorado). The real tools are run
 * by `npm run test:tools` (test-tools/chains/longread, metagenomics and
 * nanopore); these tests pin the parts that run without them: the entries, the
 * commands they render, the shell logic of the commands (run against stand-ins
 * for the tools), and how connecting two of them fills the file slots.
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
  describeInstall,
  findTool,
  installYaml,
  renderCommand,
  searchTools,
  validateCatalog,
  type CatalogTool,
} from '../tools/catalog';
import { connectWithBinding, outputItems, typesOfPath } from '../slots';

const NEW_TOOLS = [
  'minimap2-long',
  'nanoplot',
  'filtlong',
  'chopper',
  'flye',
  'spades',
  'quast',
  'seqkit-stats',
  'seqkit-seq',
  'seqkit-grep',
  'kraken2-build',
  'kraken2',
  'bracken-build',
  'bracken',
  'pod5-view',
  'pod5-inspect',
  'pod5-filter',
  'pod5-subset',
  'pod5-merge',
  'pod5-convert-fast5',
  'dorado-basecaller',
  'dorado-summary',
];

const tool = (id: string): CatalogTool => {
  const found = findTool(id);
  if (!found) throw new Error(`catalog has no tool ${id}`);
  return found;
};

function catalogNode(id: string, toolId: string, files: Record<string, string> = {}, params: Record<string, any> = {}) {
  const t = tool(toolId);
  const data = buildCatalogNodeData(t, []);
  data.catalogParams = { ...defaultParams(t), ...params };
  data.slotFiles = { ...(data.slotFiles as Record<string, string>), ...files };
  return { id, data: data as Record<string, any> };
}

type TestNode = ReturnType<typeof catalogNode>;

/** Draws the connections one by one, as a person would, and returns the nodes and every plan. */
function wire(nodes: TestNode[], pairs: Array<[string, string]>) {
  const edges: Array<{ source: string; target: string }> = [];
  const plans: Array<{ pair: string; kind: string; options: string[] }> = [];
  let current = nodes;
  for (const [from, to] of pairs) {
    const before = [...edges];
    edges.push({ source: from, target: to });
    const out = connectWithBinding(current, before, edges, from, to);
    plans.push({
      pair: `${from}>${to}`,
      kind: out.plan.kind,
      options: out.plan.kind === 'ask' ? out.plan.options.map((o) => `${o.slot}<-${o.outputKey}`) : [],
    });
    current = out.nodes as TestNode[];
  }
  return { nodes: current, edges, plans };
}

/** What a slot follows: one link for a slot for one file, a list for a slot for several; always as a list here. */
const linkOf = (nodes: TestNode[], id: string, slot: string) => ([] as unknown[]).concat((nodes.find((n) => n.id === id)!.data.slotLinks ?? {})[slot]);

describe('the long-read, assembly, metagenomics and Nanopore tools in the catalog', () => {
  it('has every tool of the phase, and the catalog is still valid', () => {
    for (const id of NEW_TOOLS) expect(findTool(id), id).toBeDefined();
    expect(CATALOG.tools.length).toBeGreaterThanOrEqual(79);
    expect(validateCatalog(CATALOG)).toEqual([]);
  });

  it('pins each tool to the version it was run with, and says which ones need the Intel build or an extra package limit', () => {
    const pins = Object.fromEntries(
      NEW_TOOLS.map((id) => {
        const install = tool(id).install;
        if (install.kind === 'external') return [id, `${install.binary} ${install.version} (download)`];
        if (install.kind !== 'conda') throw new Error(`${id} is not a conda or download tool`);
        const extra = [install.osx64 ? 'Intel build' : '', ...(install.constraints ?? [])].filter(Boolean).join(', ');
        return [id, `${install.package}==${install.version}${extra ? ` (${extra})` : ''}`];
      })
    );
    expect(pins).toEqual({
      'minimap2-long': 'minimap2==2.30',
      nanoplot: 'nanoplot==1.48.0',
      filtlong: 'filtlong==0.3.1',
      chopper: 'chopper==0.14.1',
      flye: 'flye==2.9.6',
      spades: 'spades==4.2.0',
      quast: 'quast==5.3.0 (Intel build, python<3.12)',
      'seqkit-stats': 'seqkit==2.14.0',
      'seqkit-seq': 'seqkit==2.14.0',
      'seqkit-grep': 'seqkit==2.14.0',
      'kraken2-build': 'kraken2==2.17.1',
      kraken2: 'kraken2==2.17.1',
      'bracken-build': 'bracken==2.6.1 (Intel build)',
      bracken: 'bracken==2.6.1 (Intel build)',
      'pod5-view': 'pod5==0.3.48 (polars<2)',
      'pod5-inspect': 'pod5==0.3.48 (polars<2)',
      'pod5-filter': 'pod5==0.3.48 (polars<2)',
      'pod5-subset': 'pod5==0.3.48 (polars<2)',
      'pod5-merge': 'pod5==0.3.48 (polars<2)',
      'pod5-convert-fast5': 'pod5==0.3.48 (polars<2)',
      'dorado-basecaller': 'dorado 1.4.0 (download)',
      'dorado-summary': 'dorado 1.4.0 (download)',
    });
  });

  it('shares one environment between the tools of one package, so a chain installs each only once', () => {
    const installs = (ids: string[]) => ids.map((id) => JSON.stringify(tool(id).install));
    for (const group of [
      NEW_TOOLS.filter((id) => id.startsWith('pod5-')),
      NEW_TOOLS.filter((id) => id.startsWith('seqkit-')),
      NEW_TOOLS.filter((id) => id.startsWith('dorado-')),
      ['bracken-build', 'bracken'],
      ['kraken2-build', 'kraken2'],
    ]) {
      expect(new Set(installs(group)).size, group.join()).toBe(1);
    }
    // The long-read aligner uses the environment the short-read minimap2 already has.
    expect(JSON.stringify(tool('minimap2-long').install)).toBe(JSON.stringify(tool('minimap2').install));
  });

  it('downloads Dorado from the maker, checks it, and says it is there for Apple silicon only', () => {
    const install = tool('dorado-basecaller').install;
    if (install.kind !== 'external') throw new Error('Dorado is a download');
    expect(Object.keys(install.url)).toEqual(['osx-arm64']);
    expect(install.url['osx-arm64']).toBe('https://cdn.oxfordnanoportal.com/software/analysis/dorado-{version}-osx-arm64.zip');
    expect(install.sha256['osx-arm64']).toBe('3d0d511313f5c99158906ad6b2cd5df4ba013d7e454beefc613fe03525b8dc5f');
    expect(install.license).toMatch(/Oxford Nanopore/);
    expect(describeInstall(install)).toContain('Available for macOS on Apple silicon only.');
    const yaml = installYaml(install) as any;
    expect(yaml.kind).toBe('external');
    expect(yaml.sha256).toEqual(install.sha256);
  });

  it('gives every new tool a plain description and a plain label and hint on each file and option', () => {
    for (const id of NEW_TOOLS) {
      const t = tool(id);
      expect(t.description.length, id).toBeGreaterThan(20);
      expect(t.description, id).toMatch(/\.$/);
      for (const slot of [...t.inputs, ...t.outputs]) {
        expect(slot.label, `${id}.${slot.name}`).toMatch(/^[A-Za-z][A-Za-z0-9 ()-]+$/);
        expect(slot.description, `${id}.${slot.name}`).toMatch(/\.$/);
      }
      for (const p of t.params) {
        expect(p.label, `${id}.${p.id}`).toMatch(/^[A-Za-z][A-Za-z0-9 ()-]+$/);
        expect(p.description, `${id}.${p.id}`).toMatch(/\.$/);
      }
    }
  });

  it('declares a type for every file and uses only types the catalog lists', () => {
    for (const id of NEW_TOOLS) {
      for (const slot of [...tool(id).inputs, ...tool(id).outputs]) {
        expect(slot.types.length, `${id}.${slot.name}`).toBeGreaterThan(0);
        for (const type of slot.types) expect(CATALOG.file_types, `${id}.${slot.name} ${type}`).toContain(type);
      }
    }
  });

  it('gives every choice a default that is one of its options, and a label for options that are not plain words', () => {
    for (const id of NEW_TOOLS) {
      for (const p of tool(id).params.filter((q) => q.type === 'select')) {
        expect(p.options, `${id}.${p.id}`).toContain(p.default);
        for (const option of p.options!) {
          if (!/^[A-Za-z][A-Za-z -]*$/.test(option)) {
            expect(p.option_labels?.[option], `${id}.${p.id} option "${option}" needs a label`).toBeTruthy();
          }
        }
      }
    }
  });

  it('puts the new tools in the right groups of the palette', () => {
    const group = (id: string) => `${tool(id).category}/${tool(id).subcategory}`;
    expect(group('minimap2-long')).toBe('alignment/Long-read aligners');
    expect(group('nanoplot')).toBe('qc/Long-read QC');
    expect(group('seqkit-stats')).toBe('qc/Sequence statistics');
    expect(group('filtlong')).toBe('trimming/Long-read filtering');
    expect(group('chopper')).toBe('trimming/Long-read filtering');
    expect(group('flye')).toBe('assembly/Long-read assemblers');
    expect(group('spades')).toBe('assembly/Short-read assemblers');
    expect(group('quast')).toBe('assembly/Assembly quality');
    expect(group('seqkit-seq')).toBe('sequences/Filter and convert');
    expect(group('seqkit-grep')).toBe('sequences/Pick sequences');
    expect(group('kraken2')).toBe('metagenomics/Classification');
    expect(group('bracken')).toBe('metagenomics/Abundance');
    expect(group('kraken2-build')).toBe('metagenomics/Databases');
    expect(group('pod5-merge')).toBe('nanopore/POD5 files');
    expect(group('dorado-basecaller')).toBe('nanopore/Basecalling');
    for (const id of ['sequences', 'assembly', 'metagenomics', 'nanopore']) expect(CATALOG.categories[id].label, id).toBeTruthy();
  });

  it('can be found by the words a biologist searches for', () => {
    const find = (q: string) => searchTools(q).map((t) => t.id);
    expect(find('assembl')).toEqual(expect.arrayContaining(['flye', 'spades', 'quast']));
    expect(find('nanopore')).toEqual(expect.arrayContaining(['filtlong', 'chopper', 'nanoplot', 'dorado-basecaller', 'minimap2-long']));
    expect(find('pod5')).toEqual(expect.arrayContaining(['pod5-view', 'pod5-merge', 'pod5-filter', 'pod5-subset', 'pod5-convert-fast5', 'pod5-inspect']));
    expect(find('metagenom')).toEqual(expect.arrayContaining(['kraken2', 'bracken', 'kraken2-build', 'bracken-build']));
    expect(find('basecall')).toEqual(expect.arrayContaining(['dorado-basecaller', 'dorado-summary']));
    expect(find('taxonom')).toEqual(expect.arrayContaining(['kraken2', 'kraken2-build']));
    expect(find('kraken')).toEqual(expect.arrayContaining(['kraken2', 'kraken2-build', 'bracken-build', 'bracken']));
  });

  it('keeps the optional files optional and names the ones that take several', () => {
    const slot = (id: string, name: string) => tool(id).inputs.find((s) => s.name === name)!;
    expect(slot('filtlong', 'short1').required).toBe(false);
    expect(slot('filtlong', 'short2').required).toBe(false);
    expect(slot('spades', 'reads2').required).toBe(false);
    expect(slot('kraken2', 'reads2').required).toBe(false);
    expect(slot('quast', 'reference').required).toBe(false);
    expect(slot('seqkit-grep', 'names').required).toBe(false);
    expect(slot('kraken2', 'db').required).toBe(true);
    expect(slot('bracken', 'db').required).toBe(true);
    for (const [id, name] of [
      ['nanoplot', 'reads'],
      ['flye', 'reads'],
      ['quast', 'assemblies'],
      ['seqkit-stats', 'sequences'],
      ['kraken2-build', 'genomes'],
      ['pod5-view', 'pods'],
      ['pod5-merge', 'pods'],
      ['pod5-filter', 'pods'],
      ['pod5-subset', 'pods'],
      ['pod5-convert-fast5', 'fast5'],
    ]) {
      expect(slot(id, name).multiple, `${id}.${name}`).toBe(true);
    }
  });

  it('names the files each assembler leaves in its folder, so the next step can take them', () => {
    const flye = tool('flye');
    expect(flye.outputs.find((o) => o.is_dir)!.pattern).toBe('flye/');
    expect(flye.outputs.filter((o) => o.derived).map((o) => [o.name, o.derived!.suffix])).toEqual([
      ['assembly', 'assembly.fasta'],
      ['graph', 'assembly_graph.gfa'],
      ['info', 'assembly_info.txt'],
      ['log', 'flye.log'],
    ]);
    const node = catalogNode('f', 'flye', { reads: 'reads.fastq.gz' });
    const files = Object.fromEntries(outputItems(node).map((o) => [o.key, o.files]));
    expect(files.assembly).toEqual(['flye/assembly.fasta']);
    const spades = Object.fromEntries(outputItems(catalogNode('s', 'spades', { reads1: 'r.fastq' })).map((o) => [o.key, o.files]));
    expect(spades.contigs).toEqual(['spades/contigs.fasta']);
    expect(spades.scaffolds).toEqual(['spades/scaffolds.fasta']);
    expect(spades.graph).toEqual(['spades/assembly_graph_with_scaffolds.gfa']);
    const quast = Object.fromEntries(outputItems(catalogNode('q', 'quast', { assemblies: 'a.fa' })).map((o) => [o.key, o.files]));
    expect(quast.table).toEqual(['quast/report.tsv']);
    const nano = Object.fromEntries(outputItems(catalogNode('n', 'nanoplot', { reads: 'r.fastq' })).map((o) => [o.key, o.files]));
    expect(nano.report).toEqual(['nanoplot/NanoPlot-report.html']);
    expect(nano.stats).toEqual(['nanoplot/NanoStats.txt']);
  });

  it('tells the person what a database tool needs before it can run', () => {
    expect(tool('kraken2').needs_database?.label).toBe('Kraken2 database');
    expect(tool('kraken2').needs_database?.hint).toMatch(/Kraken2 build database/);
    expect(tool('bracken').needs_database?.hint).toMatch(/Bracken prepare database/);
    expect(tool('bracken-build').needs_database).toBeDefined();
    expect(tool('dorado-basecaller').needs_database?.label).toBe('Basecalling model');
    expect(tool('dorado-basecaller').needs_database?.hint).toMatch(/internet/);
  });
});

describe('file types of the long-read and Nanopore files', () => {
  it('recognises the new extensions when a path is typed', () => {
    expect(typesOfPath('run.pod5')).toEqual(['pod5']);
    expect(typesOfPath('batch_0.fast5')).toEqual(['fast5']);
    expect(typesOfPath('batch_0.fast5.gz')).toEqual(['fast5']);
    expect(typesOfPath('flye/assembly_graph.gfa')).toEqual(['gfa']);
    expect(typesOfPath('taxonomy/names.dmp')).toEqual(['taxonomy']);
    expect(typesOfPath('reads.fastq.gz')).toEqual(['fastq']);
    expect(typesOfPath('basecalled.bam')).toEqual(['bam']);
  });

  it('lists the new types in the catalog', () => {
    for (const type of ['pod5', 'fast5', 'gfa', 'taxonomy']) expect(CATALOG.file_types).toContain(type);
  });
});

describe('commands of the long-read tools', () => {
  const render = (id: string, params: Record<string, unknown> = {}, threads?: number) => renderCommand(tool(id), params, threads ?? tool(id).threads);

  it('calls minimap2 with the preset of the form and a read group only when a sample name is typed', () => {
    expect(render('minimap2-long')).toContain('minimap2 -ax map-ont -t 4 --secondary=no');
    expect(render('minimap2-long', { preset: 'splice:hq', primary_only: false })).toContain('-ax splice:hq -t 4 {ref}'.replace(' {ref}', ''));
    expect(render('minimap2-long', { preset: 'splice:hq', primary_only: false })).not.toContain('--secondary');
    expect(render('minimap2-long', { sample_name: 'patient1' })).toContain('S=patient1;');
    expect(render('minimap2-long')).toContain('S=;');
  });

  it('turns the Flye form into flags, leaving out what is empty', () => {
    const cmd = render('flye', { read_type: '--pacbio-hifi', iterations: 2, meta: true, genome_size: '5m', min_overlap: '3000' });
    expect(cmd).toContain('flye --pacbio-hifi {reads} --out-dir {out_dir} --threads 4 --iterations 2 --meta');
    expect(cmd).toContain('G=5m; O=3000;');
    expect(render('flye')).toContain('flye --nano-raw {reads} --out-dir {out_dir} --threads 4 --iterations 1 ${G:+');
    expect(render('flye')).not.toContain('--meta');
  });

  it('keeps the slot names the form shows out of the rendered commands as plain placeholders', () => {
    for (const id of NEW_TOOLS) {
      const cmd = render(id);
      expect(cmd, id).not.toMatch(/\{(input|output|inputs|outputs)\}/);
      for (const p of tool(id).params) expect(cmd, `${id}.${p.id}`).not.toContain(`{${p.id}}`);
    }
  });

  it('gives every thread-using tool the thread count of the step', () => {
    expect(render('chopper', {}, 8)).toContain('--threads 8');
    expect(render('flye', {}, 8)).toContain('--threads 8');
    expect(render('spades', {}, 8)).toContain('-t 8');
    expect(render('kraken2', {}, 8)).toContain('--threads 8');
    expect(render('seqkit-stats', {}, 8)).toContain('-j 8');
  });

  it('runs Dorado with a model folder in the tool folder of the home directory, so models are downloaded once', () => {
    const cmd = render('dorado-basecaller', { model: 'sup', min_qscore: 12, device: 'cpu' });
    expect(cmd).toContain('M="$HOME/.rustrunner/dorado-models"');
    expect(cmd).toContain('dorado basecaller sup {pod} --models-directory "$M" --device cpu --min-qscore 12 --recursive > {calls}');
    expect(render('dorado-basecaller')).toContain('basecaller hac {pod}');
  });
});

describe.skipIf(process.platform === 'win32')('the shell logic of the commands', () => {
  type Files = string | string[];

  /** Runs a command with every slot filled and the tools replaced by stand-ins that print their arguments. */
  function run(toolId: string, slots: Record<string, Files>, params: Record<string, any> = {}, prelude = '', env: Record<string, string> = {}) {
    const command = renderCommand(tool(toolId), params, 2).replace(/\{([A-Za-z_]\w*)\}/g, (_m, name) => {
      if (!(name in slots)) throw new Error(`no value for {${name}}`);
      const files = ([] as string[]).concat(slots[name]).filter((f) => f !== '');
      return files.map((f) => `'${f}'`).join(' ');
    });
    // The engine fills placeholders inside double quotes without the single quotes; do the same.
    const script = `${prelude}\n${command.replace(/"'([^']*)'"/g, '"$1"')}`;
    return spawnSync('bash', ['-c', script], { encoding: 'utf8', env: { ...process.env, ...env } });
  }
  const echoTool = (name: string) => `${name}() { printf '%s\\n' "$@"; }`;
  const args = (toolId: string, toolName: string, slots: Record<string, Files>, params: Record<string, any> = {}, prelude = ''): string[] => {
    const result = run(toolId, slots, params, `${echoTool(toolName)}\n${prelude}`);
    if (result.status !== 0) throw new Error(result.stderr);
    return result.stdout.trim().split('\n');
  };
  /** The value after a flag. */
  const after = (list: string[], flag: string) => list[list.indexOf(flag) + 1];
  /**
   * Runs `use` with a fresh file to stand in for an output slot. A command that
   * redirects to /dev/stdout fails on CI runners whose stdout is a socket.
   */
  const withOutputFile = <T,>(use: (file: string) => T): T => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lr-out-'));
    try {
      return use(path.join(dir, 'out.txt'));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };

  it('gives Filtlong a limit only when it is above zero, and short reads and a base target only when given', () => {
    const slots = { reads: 'r.fastq', short1: '', short2: '', filtered: '/dev/null' };
    const out = (params: Record<string, any>, extra: Record<string, Files> = {}) => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lr-'));
      try {
        const file = path.join(dir, 'out.gz');
        const result = run('filtlong', { ...slots, ...extra, filtered: file }, params, `${echoTool('filtlong')}`);
        if (result.status !== 0) throw new Error(result.stderr);
        return spawnSync('gzip', ['-dc', file], { encoding: 'utf8' }).stdout.trim().split('\n');
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    };
    const plain = out({});
    expect(after(plain, '--min_length')).toBe('1000');
    expect(after(plain, '--min_mean_q')).toBe('90');
    expect(plain).not.toContain('--keep_percent');
    expect(plain).not.toContain('--max_length');
    expect(plain).not.toContain('--target_bases');
    expect(plain).not.toContain('-1');
    expect(plain[plain.length - 1]).toBe('r.fastq');
    const off = out({ min_length: 0, min_accuracy: 0 });
    expect(off).not.toContain('--min_length');
    expect(off).not.toContain('--min_mean_q');
    const full = out({ keep_percent: 50, max_length: 20000, target_bases: '500m' }, { short1: 's1.fq', short2: 's2.fq' });
    expect(after(full, '--keep_percent')).toBe('50');
    expect(after(full, '--max_length')).toBe('20000');
    expect(after(full, '--target_bases')).toBe('500m');
    expect(after(full, '-1')).toBe('s1.fq');
    expect(after(full, '-2')).toBe('s2.fq');
  });

  it('stops when the filter fails instead of writing an empty file as if it had worked', () => {
    const result = run('filtlong', { reads: 'r.fastq', short1: '', short2: '', filtered: '/dev/null' }, {}, 'filtlong() { echo "boom" >&2; return 3; }');
    expect(result.status).not.toBe(0);
    const chopper = run('chopper', { reads: 'r.fastq', filtered: '/dev/null' }, {}, 'chopper() { return 3; }');
    expect(chopper.status).not.toBe(0);
  });

  it('gives chopper a cut only when one is asked for, and a longest read only when above zero', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lr-'));
    try {
      const out = (params: Record<string, any>) => {
        const file = path.join(dir, 'out.gz');
        const result = run('chopper', { reads: 'r.fastq', filtered: file }, params, echoTool('chopper'));
        if (result.status !== 0) throw new Error(result.stderr);
        return spawnSync('gzip', ['-dc', file], { encoding: 'utf8' }).stdout.trim().split('\n');
      };
      const plain = out({});
      expect(after(plain, '-q')).toBe('10');
      expect(after(plain, '-l')).toBe('500');
      expect(plain).not.toContain('--trim-approach');
      expect(plain).not.toContain('--maxlength');
      const cut = out({ head_crop: 30, max_length: 9000 });
      expect(after(cut, '--trim-approach')).toBe('fixed-crop');
      expect(after(cut, '--headcrop')).toBe('30');
      expect(after(cut, '--tailcrop')).toBe('0');
      expect(after(cut, '--maxlength')).toBe('9000');
      expect(after(out({ tail_crop: 5 }), '--tailcrop')).toBe('5');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('gives NanoPlot a limit only when above zero, picture files only when asked for, and a title only when typed', () => {
    const slots = { reads: ['a.fastq', 'b.fastq'], out_dir: 'np/' };
    const plain = args('nanoplot', 'NanoPlot', slots);
    expect(plain.slice(0, 3)).toEqual(['--fastq', 'a.fastq', 'b.fastq']);
    expect(plain).toContain('--no_static');
    expect(plain).not.toContain('--minlength');
    expect(plain).not.toContain('--minqual');
    expect(plain).not.toContain('--title');
    const full = args('nanoplot', 'NanoPlot', slots, { format: '--ubam', plot_files: '', min_length: 500, min_quality: 8, title: 'Run 12' });
    expect(full[0]).toBe('--ubam');
    expect(full).not.toContain('--no_static');
    expect(after(full, '--minlength')).toBe('500');
    expect(after(full, '--minqual')).toBe('8');
    expect(after(full, '--title')).toBe('Run 12');
  });

  it('gives Flye a genome size and an overlap only when they are typed', () => {
    const plain = args('flye', 'flye', { reads: ['a.fq', 'b.fq'], out_dir: 'flye/' });
    expect(plain.slice(0, 3)).toEqual(['--nano-raw', 'a.fq', 'b.fq']);
    expect(plain).not.toContain('--genome-size');
    expect(plain).not.toContain('--min-overlap');
    const full = args('flye', 'flye', { reads: 'a.fq', out_dir: 'flye/' }, { genome_size: '4.6m', min_overlap: '2500' });
    expect(after(full, '--genome-size')).toBe('4.6m');
    expect(after(full, '--min-overlap')).toBe('2500');
  });

  it('runs SPAdes on one file as single reads and on two as a pair, with word sizes only when typed', () => {
    const base = { out_dir: 'sp/' };
    const single = args('spades', 'spades.py', { ...base, reads1: 'a.fq', reads2: '' });
    expect(single[0]).toBe('--isolate');
    expect(after(single, '-s')).toBe('a.fq');
    expect(single).not.toContain('-1');
    expect(single).not.toContain('-k');
    expect(after(single, '-m')).toBe('8');
    const pair = args('spades', 'spades.py', { ...base, reads1: 'a.fq', reads2: 'b.fq' }, { mode: '', kmers: '21,33' });
    expect(after(pair, '-1')).toBe('a.fq');
    expect(after(pair, '-2')).toBe('b.fq');
    expect(pair).not.toContain('-s');
    expect(pair[0]).toBe('-o');
    expect(after(pair, '-k')).toBe('21,33');
  });

  it('gives QUAST a reference and names only when they are given', () => {
    const slots = { assemblies: ['a.fa', 'b.fa'], reference: '', out_dir: 'q/' };
    const plain = args('quast', 'quast.py', slots);
    expect(plain.slice(0, 2)).toEqual(['a.fa', 'b.fa']);
    expect(plain).not.toContain('-r');
    expect(plain).not.toContain('--labels');
    expect(plain).toContain('--no-icarus');
    const full = args('quast', 'quast.py', { ...slots, reference: 'ref.fa' }, { labels: 'flye,spades', browser: '' });
    expect(after(full, '-r')).toBe('ref.fa');
    expect(after(full, '--labels')).toBe('flye,spades');
    expect(full).not.toContain('--no-icarus');
  });

  it('gives seqkit seq each limit only when above zero', () => {
    const slots = { sequences: 'r.fq', result: 'out.fq.gz' };
    const plain = args('seqkit-seq', 'seqkit', slots);
    expect(plain.slice(0, 3)).toEqual(['seq', '-j', '2']);
    for (const flag of ['--min-len', '--max-len', '--min-qual', '--reverse', '--complement', '--upper-case']) expect(plain, flag).not.toContain(flag);
    const full = args('seqkit-seq', 'seqkit', slots, { min_length: 100, max_length: 900, min_quality: 7, reverse_complement: true, upper_case: true });
    expect(after(full, '--min-len')).toBe('100');
    expect(after(full, '--max-len')).toBe('900');
    expect(after(full, '--min-qual')).toBe('7');
    expect(full).toEqual(expect.arrayContaining(['--reverse', '--complement', '--upper-case']));
  });

  it('refuses to run seqkit grep with nothing to look for, and says what to do', () => {
    const result = run('seqkit-grep', { sequences: 'r.fq', names: '', matched: 'out.fq' }, {}, echoTool('seqkit'));
    expect(result.status).toBe(1);
    expect(result.stderr).toBe('Type a name or pattern, or connect a list of names.\n');
    expect(result.stdout).toBe('');
  });

  it('gives seqkit grep the typed pattern, the list or both, and the way to look', () => {
    const slots = { sequences: 'r.fq', matched: 'out.fq' };
    const typed = args('seqkit-grep', 'seqkit', { ...slots, names: '' }, { pattern: 'read 7' });
    expect(after(typed, '-p')).toBe('read 7');
    expect(typed).not.toContain('-f');
    const listed = args('seqkit-grep', 'seqkit', { ...slots, names: 'ids.txt' }, { invert: true, regex: true, ignore_case: true, search_in: '-s' });
    expect(after(listed, '-f')).toBe('ids.txt');
    expect(listed).not.toContain('-p');
    expect(listed).toEqual(expect.arrayContaining(['--invert-match', '--use-regexp', '--ignore-case', '-s']));
    const both = args('seqkit-grep', 'seqkit', { ...slots, names: 'ids.txt' }, { pattern: 'x' });
    expect(after(both, '-p')).toBe('x');
    expect(after(both, '-f')).toBe('ids.txt');
  });

  it('classifies a pair with --paired and one file without', () => {
    const slots = { db: 'db/', report: 'r.tsv', assignments: 'a.tsv' };
    const single = args('kraken2', 'kraken2', { ...slots, reads1: 'a.fq', reads2: '' });
    expect(single).not.toContain('--paired');
    expect(single[single.length - 1]).toBe('a.fq');
    expect(after(single, '--db')).toBe('db/');
    expect(after(single, '--confidence')).toBe('0');
    expect(after(single, '--minimum-hit-groups')).toBe('2');
    expect(single).not.toContain('--memory-mapping');
    const pair = args('kraken2', 'kraken2', { ...slots, reads1: 'a.fq', reads2: 'b.fq' }, { confidence: 0.4, memory_mapping: true });
    expect(pair.slice(-3)).toEqual(['--paired', 'a.fq', 'b.fq']);
    expect(after(pair, '--confidence')).toBe('0.4');
    expect(pair).toContain('--memory-mapping');
  });

  it('builds a Kraken2 database: the taxonomy is copied, every genome added once, and an old library is cleared first', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lr-'));
    try {
      const db = path.join(dir, 'db');
      fs.mkdirSync(path.join(db, 'library', 'old'), { recursive: true });
      fs.writeFileSync(path.join(db, 'library', 'old', 'x.fna'), 'old');
      fs.writeFileSync(path.join(db, 'seqid2taxid.map'), 'old');
      fs.writeFileSync(path.join(dir, 'names.dmp'), 'names');
      fs.writeFileSync(path.join(dir, 'nodes.dmp'), 'nodes');
      const log = path.join(dir, 'calls.log');
      const result = run(
        'kraken2-build',
        { genomes: ['A.fa', 'B C.fa'], names: path.join(dir, 'names.dmp'), nodes: path.join(dir, 'nodes.dmp'), db },
        { kmer_length: 31, minimizer_length: 25, minimizer_spaces: 4 },
        `kraken2-build() { echo "$*" >> '${log}'; }`
      );
      expect(result.status, result.stderr).toBe(0);
      expect(fs.existsSync(path.join(db, 'library'))).toBe(false);
      expect(fs.existsSync(path.join(db, 'seqid2taxid.map'))).toBe(false);
      expect(fs.readFileSync(path.join(db, 'taxonomy', 'names.dmp'), 'utf8')).toBe('names');
      expect(fs.readFileSync(path.join(db, 'taxonomy', 'nodes.dmp'), 'utf8')).toBe('nodes');
      expect(fs.readFileSync(log, 'utf8').trim().split('\n')).toEqual([
        `--add-to-library A.fa --db ${db}`,
        `--add-to-library B C.fa --db ${db}`,
        `--build --db ${db} --threads 2 --kmer-len 31 --minimizer-len 25 --minimizer-spaces 4`,
      ]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('prepares a Bracken database next to the original and leaves the original alone', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lr-'));
    try {
      const db = path.join(dir, 'db');
      const prepared = path.join(dir, 'prepared');
      fs.mkdirSync(path.join(db, 'library'), { recursive: true });
      fs.mkdirSync(path.join(db, 'taxonomy'));
      for (const f of ['hash.k2d', 'opts.k2d', 'taxo.k2d', 'seqid2taxid.map']) fs.writeFileSync(path.join(db, f), f);
      // A previous run left Bracken files in the prepared folder; they must not be reused.
      fs.mkdirSync(prepared);
      fs.writeFileSync(path.join(prepared, 'database.kraken'), 'stale');
      fs.writeFileSync(path.join(prepared, 'database150mers.kmer_distrib'), 'stale');
      const log = path.join(dir, 'calls.log');
      const result = run(
        'bracken-build',
        { db, bracken_db: prepared },
        { read_length: 100, kmer_length: 31 },
        `bracken-build() { echo "$*" >> '${log}'; ls "${prepared}" | sort | tr '\\n' ' ' >> '${log}'; }`
      );
      expect(result.status, result.stderr).toBe(0);
      const [call, listing] = fs.readFileSync(log, 'utf8').split('\n');
      expect(call).toBe(`-d ${prepared} -t 2 -k 31 -l 100`);
      expect(listing.trim()).toBe('hash.k2d library opts.k2d seqid2taxid.map taxo.k2d taxonomy');
      for (const f of ['hash.k2d', 'opts.k2d', 'taxo.k2d', 'seqid2taxid.map', 'library', 'taxonomy']) {
        expect(fs.lstatSync(path.join(prepared, f)).isSymbolicLink(), f).toBe(true);
        expect(fs.realpathSync(path.join(prepared, f))).toBe(fs.realpathSync(path.join(db, f)));
      }
      expect(fs.readdirSync(db).sort()).toEqual(['hash.k2d', 'library', 'opts.k2d', 'seqid2taxid.map', 'taxo.k2d', 'taxonomy']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('will not prepare a Bracken database in the folder of the original', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lr-'));
    try {
      fs.writeFileSync(path.join(dir, 'hash.k2d'), 'x');
      const result = run('bracken-build', { db: dir, bracken_db: dir }, {}, 'bracken-build() { echo ran; }');
      expect(result.status).toBe(1);
      expect(result.stdout).not.toContain('ran');
      expect(result.stderr).toContain('Choose a new folder for the prepared database.');
      expect(fs.readdirSync(dir)).toEqual(['hash.k2d']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('runs pod5 view with a column list only when typed, and pod5 inspect on the summary', () => {
    const plain = args('pod5-view', 'pod5', { pods: ['a.pod5', 'b.pod5'], table: 'reads.tsv' });
    expect(plain.slice(0, 3)).toEqual(['view', 'a.pod5', 'b.pod5']);
    expect(plain).not.toContain('--include');
    const cols = args('pod5-view', 'pod5', { pods: 'a.pod5', table: 'reads.tsv' }, { columns: 'read_id,channel' });
    expect(after(cols, '--include')).toBe('read_id,channel');
    const inspected = withOutputFile((report) => {
      const result = run('pod5-inspect', { pod: 'a.pod5', report }, {}, echoTool('pod5'));
      expect(result.status, result.stderr).toBe(0);
      return fs.readFileSync(report, 'utf8');
    });
    expect(inspected.trim().split('\n')).toEqual(['inspect', 'summary', 'a.pod5']);
  });

  it('keeps the Dorado models in the home folder and passes the form on', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lr-'));
    try {
      const calls = path.join(home, 'calls.txt');
      const result = run('dorado-basecaller', { pod: 'run.pod5', calls }, { model: 'fast', min_qscore: 0 }, echoTool('dorado'), { HOME: home });
      expect(result.status, result.stderr).toBe(0);
      const list = fs.readFileSync(calls, 'utf8').trim().split('\n');
      expect(list.slice(0, 3)).toEqual(['basecaller', 'fast', 'run.pod5']);
      expect(after(list, '--models-directory')).toBe(path.join(home, '.rustrunner', 'dorado-models'));
      expect(after(list, '--min-qscore')).toBe('0');
      expect(after(list, '--device')).toBe('auto');
      expect(fs.existsSync(path.join(home, '.rustrunner', 'dorado-models'))).toBe(true);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('connections between the long-read and Nanopore tools', () => {
  const makes = (from: string, to: string) => checkConnection(tool(from), tool(to)).status;

  it('match by file type along the assembly, metagenomics and Nanopore paths', () => {
    for (const [from, to] of [
      ['chopper', 'flye'],
      ['filtlong', 'flye'],
      ['filtlong', 'chopper'],
      ['chopper', 'nanoplot'],
      ['chopper', 'seqkit-stats'],
      ['chopper', 'minimap2-long'],
      ['seqkit-seq', 'flye'],
      ['seqkit-grep', 'chopper'],
      ['fastp', 'spades'],
      ['flye', 'quast'],
      ['spades', 'quast'],
      ['quast', 'multiqc'],
      ['flye', 'minimap2'],
      ['flye', 'kraken2'],
      ['flye', 'seqkit-stats'],
      ['minimap2-long', 'samtools-sort'],
      ['samtools-sort', 'nanoplot'],
      ['kraken2-build', 'kraken2'],
      ['kraken2-build', 'bracken-build'],
      ['bracken-build', 'kraken2'],
      ['bracken-build', 'bracken'],
      ['kraken2', 'bracken'],
      ['kraken2', 'multiqc'],
      ['bracken', 'multiqc'],
      ['pod5-convert-fast5', 'pod5-merge'],
      ['pod5-merge', 'pod5-filter'],
      ['pod5-merge', 'pod5-view'],
      ['pod5-view', 'pod5-subset'],
      ['pod5-view', 'pod5-filter'],
      ['pod5-subset', 'dorado-basecaller'],
      ['pod5-filter', 'dorado-basecaller'],
      ['dorado-basecaller', 'dorado-summary'],
      ['dorado-basecaller', 'nanoplot'],
      ['dorado-basecaller', 'samtools-flagstat'],
      ['dorado-basecaller', 'samtools-sort'],
      ['dorado-summary', 'nanoplot'],
      ['dorado-summary', 'pod5-subset'],
    ]) {
      expect(makes(from, to), `${from} to ${to}`).toBe('match');
    }
  });

  it('flag a connection that cannot work', () => {
    expect(makes('dorado-basecaller', 'flye')).toBe('mismatch');
    expect(makes('pod5-merge', 'nanoplot')).toBe('mismatch');
    expect(makes('kraken2', 'pod5-view')).toBe('mismatch');
    expect(makes('flye', 'dorado-basecaller')).toBe('mismatch');
    expect(makes('bracken', 'kraken2')).toBe('mismatch');
    expect(makes('quast', 'flye')).toBe('mismatch');
  });

  it('binds the filtered reads to Flye and the assembly (not its folder) to QUAST without asking', () => {
    const { nodes, plans } = wire(
      [catalogNode('chop', 'chopper'), catalogNode('flye', 'flye'), catalogNode('quast', 'quast')],
      [
        ['chop', 'flye'],
        ['flye', 'quast'],
      ]
    );
    expect(plans.map((p) => `${p.pair}:${p.kind}`)).toEqual(['chop>flye:auto', 'flye>quast:auto']);
    expect(linkOf(nodes, 'flye', 'reads')).toEqual([{ from: 'chop', output: 'filtered' }]);
    expect(linkOf(nodes, 'quast', 'assemblies')).toEqual([{ from: 'flye', output: 'assembly' }]);
  });

  it('asks which SPAdes file goes to QUAST, and lets two assemblies share one comparison', () => {
    const { nodes, plans } = wire(
      [catalogNode('flye', 'flye'), catalogNode('sp', 'spades', { reads1: 'a.fq' }), catalogNode('quast', 'quast')],
      [
        ['flye', 'quast'],
        ['sp', 'quast'],
      ]
    );
    expect(plans[0].kind).toBe('auto');
    expect(plans[1].kind).toBe('ask');
    expect(plans[1].options.sort()).toEqual(['assemblies<-contigs', 'assemblies<-scaffolds']);
    expect(linkOf(nodes, 'quast', 'assemblies')).toEqual([{ from: 'flye', output: 'assembly' }]);
  });

  it('asks which Kraken2 file Bracken takes, and fills its database without asking', () => {
    const { nodes, plans } = wire(
      [catalogNode('prep', 'bracken-build'), catalogNode('k', 'kraken2', { reads1: 'r.fq' }), catalogNode('b', 'bracken')],
      [
        ['prep', 'k'],
        ['k', 'b'],
        ['prep', 'b'],
      ]
    );
    expect(plans.map((p) => `${p.pair}:${p.kind}`)).toEqual(['prep>k:auto', 'k>b:ask', 'prep>b:auto']);
    expect(plans[1].options.sort()).toEqual(['report<-assignments', 'report<-report']);
    expect(linkOf(nodes, 'k', 'db')).toEqual([{ from: 'prep', output: 'bracken_db' }]);
    expect(linkOf(nodes, 'b', 'db')).toEqual([{ from: 'prep', output: 'bracken_db' }]);
  });

  it('feeds the POD5 files and tables along the Nanopore path without a question', () => {
    const { nodes, plans } = wire(
      [
        catalogNode('conv', 'pod5-convert-fast5', { fast5: 'run.fast5' }),
        catalogNode('merge', 'pod5-merge'),
        catalogNode('view', 'pod5-view'),
        catalogNode('subset', 'pod5-subset'),
        catalogNode('dorado', 'dorado-basecaller'),
        catalogNode('sum', 'dorado-summary'),
        catalogNode('plot', 'nanoplot'),
      ],
      [
        ['conv', 'merge'],
        ['merge', 'view'],
        ['merge', 'subset'],
        ['view', 'subset'],
        ['merge', 'dorado'],
        ['dorado', 'sum'],
        ['sum', 'plot'],
      ]
    );
    expect(plans.map((p) => p.kind)).toEqual(['auto', 'auto', 'auto', 'auto', 'auto', 'auto', 'auto']);
    expect(linkOf(nodes, 'merge', 'pods')).toEqual([{ from: 'conv', output: 'converted' }]);
    expect(linkOf(nodes, 'subset', 'pods')).toEqual([{ from: 'merge', output: 'merged' }]);
    expect(linkOf(nodes, 'subset', 'table')).toEqual([{ from: 'view', output: 'table' }]);
    expect(linkOf(nodes, 'dorado', 'pod')).toEqual([{ from: 'merge', output: 'merged' }]);
    expect(linkOf(nodes, 'sum', 'calls')).toEqual([{ from: 'dorado', output: 'calls' }]);
    expect(linkOf(nodes, 'plot', 'reads')).toEqual([{ from: 'sum', output: 'summary' }]);
  });
});
