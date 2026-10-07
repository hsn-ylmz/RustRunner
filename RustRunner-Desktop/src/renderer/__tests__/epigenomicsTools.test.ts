/**
 * The ChIP-seq, ATAC-seq and epigenomics tools of the catalog (MACS3, Genrich,
 * deepTools, bedtools, HOMER). The real tools are run by `npm run test:tools`
 * (test-tools/chains/epigenomics.tools.ts); these tests pin the parts that run
 * without them: the entries, the commands they render, the shell logic of the
 * commands (run against stand-ins for the tools), and how connecting two of
 * them fills the file slots.
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
  validateCatalog,
  type CatalogTool,
} from '../tools/catalog';
import { connectWithBinding, outputItems, slotStates, typesOfPath } from '../slots';

const NEW_TOOLS = [
  'macs3-callpeak',
  'genrich',
  'deeptools-bamcoverage',
  'deeptools-computematrix',
  'deeptools-plotheatmap',
  'deeptools-plotfingerprint',
  'bedtools-intersect',
  'bedtools-merge',
  'bedtools-genomecov',
  'bedtools-getfasta',
  'homer-annotatepeaks',
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

const edge = (source: string, target: string) => ({ source, target });

/** Draws the connections one by one, as a person would, and returns the nodes and every plan. */
function wire(nodes: TestNode[], pairs: Array<[string, string]>) {
  const edges: Array<{ source: string; target: string }> = [];
  const plans: Array<{ pair: string; kind: string }> = [];
  let current = nodes;
  for (const [from, to] of pairs) {
    const before = [...edges];
    edges.push(edge(from, to));
    const out = connectWithBinding(current, before, edges, from, to);
    plans.push({ pair: `${from}>${to}`, kind: out.plan.kind });
    current = out.nodes as TestNode[];
  }
  return { nodes: current, edges, plans };
}

const linkOf = (nodes: TestNode[], id: string, slot: string) => (nodes.find((n) => n.id === id)!.data.slotLinks ?? {})[slot];

describe('the epigenomics tools in the catalog', () => {
  it('has every tool of the phase, and the catalog is still valid', () => {
    for (const id of NEW_TOOLS) expect(findTool(id), id).toBeDefined();
    expect(CATALOG.tools.length).toBeGreaterThanOrEqual(57);
    expect(validateCatalog(CATALOG)).toEqual([]);
  });

  it('pins each tool to the version it was run with, natively on Apple silicon', () => {
    const pins = Object.fromEntries(
      NEW_TOOLS.map((id) => {
        const install = tool(id).install;
        if (install.kind !== 'conda') throw new Error(`${id} is not a conda tool`);
        return [id, `${install.package}==${install.version}${install.osx64 ? ' (Intel build)' : ''}`];
      })
    );
    expect(pins).toEqual({
      'macs3-callpeak': 'macs3==3.0.5',
      genrich: 'genrich==0.6.1',
      'deeptools-bamcoverage': 'deeptools==3.5.6',
      'deeptools-computematrix': 'deeptools==3.5.6',
      'deeptools-plotheatmap': 'deeptools==3.5.6',
      'deeptools-plotfingerprint': 'deeptools==3.5.6',
      'bedtools-intersect': 'bedtools==2.31.1',
      'bedtools-merge': 'bedtools==2.31.1',
      'bedtools-genomecov': 'bedtools==2.31.1',
      'bedtools-getfasta': 'bedtools==2.31.1',
      'homer-annotatepeaks': 'homer==5.1',
    });
  });

  it('shares one environment between the tools of one package, so a chain installs each only once', () => {
    const installs = (ids: string[]) => ids.map((id) => JSON.stringify(tool(id).install));
    expect(new Set(installs(NEW_TOOLS.filter((id) => id.startsWith('deeptools-')))).size).toBe(1);
    expect(new Set(installs(NEW_TOOLS.filter((id) => id.startsWith('bedtools-')))).size).toBe(1);
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
    expect(group('macs3-callpeak')).toBe('peak_calling/Peak calling');
    expect(group('genrich')).toBe('peak_calling/Peak calling');
    expect(group('homer-annotatepeaks')).toBe('peak_calling/Peak annotation');
    expect(group('deeptools-bamcoverage')).toBe('signal/Signal tracks');
    expect(group('deeptools-computematrix')).toBe('signal/Signal around regions');
    expect(group('deeptools-plotheatmap')).toBe('signal/Plots');
    expect(group('deeptools-plotfingerprint')).toBe('qc/Enrichment');
    expect(group('bedtools-intersect')).toBe('intervals/Compare regions');
    expect(group('bedtools-merge')).toBe('intervals/Combine regions');
    expect(group('bedtools-genomecov')).toBe('intervals/Coverage');
    expect(group('bedtools-getfasta')).toBe('intervals/Sequences');
    for (const id of ['peak_calling', 'signal', 'intervals']) {
      expect(CATALOG.categories[id].label, id).toBeTruthy();
    }
  });

  it('can be found by the words a biologist searches for', () => {
    const find = (q: string) => CATALOG.tools.filter((t) => `${t.name} ${t.description} ${t.subcategory}`.toLowerCase().includes(q)).map((t) => t.id);
    expect(find('atac')).toEqual(expect.arrayContaining(['genrich', 'macs3-callpeak']));
    expect(find('heatmap')).toContain('deeptools-plotheatmap');
    expect(find('peak')).toEqual(expect.arrayContaining(['macs3-callpeak', 'genrich', 'homer-annotatepeaks']));
  });

  it('keeps the control, the blacklists and the optional files optional, and the index files required', () => {
    const required = (id: string, slot: string) => tool(id).inputs.find((s) => s.name === slot)!.required;
    expect(required('macs3-callpeak', 'treatment')).toBe(true);
    expect(required('macs3-callpeak', 'control')).toBe(false);
    expect(required('genrich', 'control')).toBe(false);
    expect(required('genrich', 'blacklist')).toBe(false);
    expect(required('deeptools-bamcoverage', 'blacklist')).toBe(false);
    expect(required('deeptools-bamcoverage', 'bai')).toBe(true);
    expect(required('deeptools-plotfingerprint', 'bais')).toBe(true);
    expect(tool('macs3-callpeak').inputs.find((s) => s.name === 'treatment')!.multiple).toBe(false);
    for (const id of ['genrich', 'deeptools-computematrix', 'deeptools-plotfingerprint', 'bedtools-merge']) {
      const multiple = tool(id).inputs.filter((s) => s.multiple).map((s) => s.name);
      expect(multiple.length, id).toBeGreaterThan(0);
    }
  });

  it('names each folder output and the files it holds, so the next step can take them', () => {
    const macs = tool('macs3-callpeak');
    const folder = macs.outputs.find((o) => o.is_dir)!;
    expect(folder.pattern).toBe('macs3/');
    expect(macs.outputs.filter((o) => o.derived).map((o) => [o.name, o.derived!.suffix])).toEqual([
      ['peaks', 'sample_peaks.narrowPeak'],
      ['summits', 'sample_summits.bed'],
      ['table', 'sample_peaks.xls'],
      ['signal', 'sample_treat_pileup.bdg'],
    ]);
    const node = catalogNode('m', 'macs3-callpeak', { treatment: 'chip.bam' });
    const files = Object.fromEntries(outputItems(node).map((o) => [o.key, o.files]));
    expect(files.peaks).toEqual(['macs3/sample_peaks.narrowPeak']);
    expect(files.signal).toEqual(['macs3/sample_treat_pileup.bdg']);
  });

  it('asks for a reference that needs no download: HOMER works from the FASTA and GTF that are connected', () => {
    const homer = tool('homer-annotatepeaks');
    expect(homer.needs_database?.label).toMatch(/FASTA and gene annotation/);
    expect(homer.needs_database?.hint).toMatch(/nothing is downloaded/);
    expect(homer.inputs.map((s) => s.name)).toEqual(['peaks', 'genome', 'annotation']);
    expect(homer.inputs.every((s) => s.required)).toBe(true);
  });
});

describe('file types of the epigenomics files', () => {
  it('recognises the new extensions when a path is typed', () => {
    expect(typesOfPath('sample_peaks.narrowPeak')).toEqual(['peaks']);
    expect(typesOfPath('broad.broadPeak')).toEqual(['peaks']);
    expect(typesOfPath('chip.bw')).toEqual(['bigwig']);
    expect(typesOfPath('chip.bigWig')).toEqual(['bigwig']);
    expect(typesOfPath('coverage.bedgraph')).toEqual(['bedgraph']);
    expect(typesOfPath('treat_pileup.bdg')).toEqual(['bedgraph']);
    expect(typesOfPath('matrix.mat.gz')).toEqual(['matrix']);
    expect(typesOfPath('heatmap.png')).toEqual(['image']);
    expect(typesOfPath('heatmap.pdf')).toEqual(['image']);
    expect(typesOfPath('profile.svg')).toEqual(['image']);
    expect(typesOfPath('peaks.bed')).toEqual(['bed']);
  });

  it('lists the new types in the catalog', () => {
    for (const type of ['peaks', 'bedgraph', 'bigwig', 'matrix', 'image']) expect(CATALOG.file_types).toContain(type);
  });
});

describe('commands of the epigenomics tools', () => {
  const render = (id: string, params: Record<string, unknown> = {}, threads?: number) => renderCommand(tool(id), params, threads ?? tool(id).threads);

  it('calls MACS3 with the settings of the form, always writing the signal track', () => {
    const cmd = render('macs3-callpeak', { genome_size: 'mm', qvalue: 0.01, keep_dup: 'all', call_summits: true });
    expect(cmd).toContain('macs3 callpeak -t {treatment}');
    expect(cmd).toContain('-f BAMPE -g mm -q 0.01 --keep-dup all');
    expect(cmd).toContain('--call-summits -B -n sample --outdir {out_dir}');
    expect(render('macs3-callpeak')).not.toContain('--call-summits');
    expect(render('macs3-callpeak')).toContain('-g hs -q 0.05 --keep-dup 1');
  });

  it('turns the Genrich form into flags: ATAC mode, duplicates and the thresholds', () => {
    const cmd = render('genrich');
    expect(cmd).toContain('-q 0.05 -a 200 -l 200 -g 100 -m 0 -j -r');
    expect(cmd).toContain('E=chrM;');
    const chip = render('genrich', { atac_mode: false, remove_duplicates: false, skip_chroms: '', min_length: 100 });
    expect(chip).not.toMatch(/ -j( |$)/);
    expect(chip).not.toMatch(/ -r( |$)/);
    expect(chip).toContain('E=;');
    expect(chip).toContain('-l 100');
  });

  it('fills bamCoverage and computeMatrix from the form', () => {
    const cov = render('deeptools-bamcoverage', { normalize: 'RPKM', bin_size: 10, extend: '--extendReads', ignore_dup: true });
    expect(cov).toContain('--binSize 10 --normalizeUsing RPKM --minMappingQuality 0 --extendReads --ignoreDuplicates');
    expect(cov).toContain('--numberOfProcessors 2');
    expect(render('deeptools-bamcoverage')).not.toContain('--extendReads');
    const matrix = render('deeptools-computematrix', { reference_point: 'TSS', upstream: 500, downstream: 250, skip_zeros: true, missing_as_zero: false });
    expect(matrix).toContain('computeMatrix reference-point -S {signal} -R {regions} --referencePoint TSS -b 500 -a 250 --binSize 50');
    expect(matrix).toContain('--skipZeros');
    expect(matrix).not.toContain('--missingDataAsZero');
    expect(render('deeptools-computematrix')).toContain('--missingDataAsZero');
  });

  it('draws the heatmap with the colours and order chosen in the form', () => {
    const cmd = render('deeptools-plotheatmap', { color_map: 'viridis', sort_regions: 'ascend', sort_using: 'max', dpi: 100, title: 'My title' });
    expect(cmd).toContain('--colorMap viridis --sortRegions ascend --sortUsing max --dpi 100');
    expect(cmd).toContain("T='My title';");
    expect(cmd.startsWith('T=;')).toBe(false);
    expect(render('deeptools-plotheatmap')).toContain('T=;');
  });

  it('builds the bedtools commands from the form', () => {
    expect(render('bedtools-intersect')).toContain('bedtools intersect -a {a} -b {b} -u ${F:+-f $F} > {result}');
    const strict = render('bedtools-intersect', { mode: '-v', min_overlap: '0.5', reciprocal: true, strand: '-s' });
    expect(strict).toContain('F=0.5;');
    expect(strict).toContain('-v ${F:+-f $F} -r -s');
    expect(render('bedtools-intersect', { mode: '' })).toContain('-b {b} ${F:+-f $F}');
    expect(render('bedtools-merge', { distance: 100, count: true })).toContain('bedtools merge -i - -d 100 -c 1 -o count > {merged}');
    expect(render('bedtools-genomecov', { mode: '-bga', fragments: true, split: true, scale: 2 })).toBe(
      'bedtools genomecov -ibam {bam} -bga -pc -split -scale 2 > {coverage}'
    );
    expect(render('bedtools-getfasta', { names: '-nameOnly', strand: true })).toBe(
      'bedtools getfasta -fi {genome} -bed {regions} -fo {sequences} -nameOnly -s'
    );
  });

  it('runs HOMER on a connected genome and annotation, with a size from the form', () => {
    expect(render('homer-annotatepeaks')).toBe(
      'annotatePeaks.pl {peaks} {genome} -gtf {annotation} -size given -annStats {stats} -cpu 1 > {annotated}'
    );
    expect(render('homer-annotatepeaks', { size: '200' })).toContain('-size 200');
  });

  it('keeps the slot names the form shows out of the rendered commands as plain placeholders', () => {
    for (const id of NEW_TOOLS) {
      const cmd = render(id);
      expect(cmd, id).not.toMatch(/\{(input|output|inputs|outputs)\}/);
      for (const p of tool(id).params) expect(cmd, `${id}.${p.id}`).not.toContain(`{${p.id}}`);
    }
  });
});

describe.skipIf(process.platform === 'win32')('the shell logic of the commands', () => {
  /** Runs a command with every slot filled and `standIn` printing the arguments it is given, one per line. */
  type Files = string | string[];
  function run(toolId: string, standIn: string, slots: Record<string, Files>, params: Record<string, any> = {}, prelude = '') {
    const command = renderCommand(tool(toolId), params, 2).replace(/\{([A-Za-z_]\w*)\}/g, (_m, name) => {
      if (!(name in slots)) throw new Error(`no value for {${name}}`);
      const files = ([] as string[]).concat(slots[name]).filter((f) => f !== '');
      return files.map((f) => `'${f}'`).join(' ');
    });
    // The engine fills placeholders inside double quotes without the single quotes; do the same.
    const script = `${standIn}() { printf '%s\\n' "$@"; }\n${prelude}\n${command.replace(/"'([^']*)'"/g, '"$1"')}`;
    return spawnSync('bash', ['-c', script], { encoding: 'utf8' });
  }
  const argsGiven = (toolId: string, standIn: string, slots: Record<string, Files>, params: Record<string, any> = {}, prelude = ''): string[] => {
    const result = run(toolId, standIn, slots, params, prelude);
    if (result.status !== 0) throw new Error(`${result.stderr}`);
    return result.stdout.trim().split('\n');
  };
  /**
   * Like argsGiven for a command that redirects to its `outSlot`: the slot gets a
   * temporary file whose lines are returned. A redirect to /dev/stdout fails on
   * CI runners whose stdout is a socket.
   */
  const linesWritten = (
    toolId: string,
    standIn: string,
    slots: Record<string, Files>,
    outSlot: string,
    params: Record<string, any> = {},
    prelude = ''
  ): string[] => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'epi-out-'));
    try {
      const file = path.join(dir, 'out.txt');
      const result = run(toolId, standIn, { ...slots, [outSlot]: file }, params, prelude);
      if (result.status !== 0) throw new Error(`${result.stderr}`);
      return fs.readFileSync(file, 'utf8').trim().split('\n');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };

  const macs ={ treatment: 'chip.bam', control: '', out_dir: 'macs3/' };

  it('gives MACS3 a control only when there is one, and fragment settings only for single-end reads', () => {
    const slots = { ...macs };
    const withoutControl = argsGiven('macs3-callpeak', 'macs3', slots).filter((a) => a !== 'callpeak');
    expect(withoutControl).not.toContain('-c');
    expect(withoutControl[withoutControl.indexOf('-t') + 1]).toBe('chip.bam');
    expect(withoutControl[withoutControl.indexOf('-f') + 1]).toBe('BAMPE');
    expect(withoutControl).not.toContain('--nomodel');
    const withControl = argsGiven('macs3-callpeak', 'macs3', { ...slots, control: 'input.bam' });
    expect(withControl[withControl.indexOf('-c') + 1]).toBe('input.bam');
    const single = argsGiven('macs3-callpeak', 'macs3', slots, { format: 'BAM', fragment_length: 180 });
    expect(single).toContain('--nomodel');
    expect(single[single.indexOf('--extsize') + 1]).toBe('180');
  });

  const genrich = { alignments: ['a.bam', 'b c.bam'], control: '', blacklist: '', peaks: 'peaks.narrowPeak' };

  it('joins the alignments of Genrich with commas, and adds control, blacklist and chromosomes only when given', () => {
    const plain = argsGiven('genrich', 'Genrich', genrich);
    expect(plain[plain.indexOf('-t') + 1]).toBe('a.bam,b c.bam');
    expect(plain).not.toContain('-c');
    expect(plain).not.toContain('-E');
    expect(plain[plain.indexOf('-e') + 1]).toBe('chrM');
    const full = argsGiven('genrich', 'Genrich', { ...genrich, control: 'ctrl.bam', blacklist: 'bl.bed' }, { skip_chroms: '' });
    expect(full[full.indexOf('-c') + 1]).toBe('ctrl.bam');
    expect(full[full.indexOf('-E') + 1]).toBe('bl.bed');
    expect(full).not.toContain('-e');
    const one = argsGiven('genrich', 'Genrich', { ...genrich, alignments: 'only.bam' });
    expect(one[one.indexOf('-t') + 1]).toBe('only.bam');
  });

  it('refuses to run bamCoverage and plotFingerprint when a BAM index is missing, and says which', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'epi-'));
    try {
      const have = path.join(dir, 'a.bam.bai');
      fs.writeFileSync(have, 'x');
      const missing = path.join(dir, 'b.bam.bai');
      const cov = run('deeptools-bamcoverage', 'bamCoverage', { bam: 'a.bam', bai: missing, blacklist: '', coverage: 'out.bw' }, {}, 'bamCoverage() { echo ran; }');
      expect(cov.status).not.toBe(0);
      expect(cov.stdout).not.toContain('ran');
      const ok = run('deeptools-bamcoverage', 'bamCoverage', { bam: 'a.bam', bai: have, blacklist: '', coverage: 'out.bw' }, {}, 'bamCoverage() { echo ran; }');
      expect(ok.status).toBe(0);
      expect(ok.stdout).toContain('ran');
      const fp = run('deeptools-plotfingerprint', 'plotFingerprint', { bams: ['a.bam', 'b.bam'], bais: [have, missing], plot: 'p.png', metrics: 'm.tsv' });
      expect(fp.status).not.toBe(0);
      expect(fp.stderr).toContain(`missing BAM index: ${missing}`);
      const fine = run('deeptools-plotfingerprint', 'plotFingerprint', { bams: 'a.bam', bais: have, plot: 'p.png', metrics: 'm.tsv' });
      expect(fine.status).toBe(0);
      expect(fine.stdout).toContain('-b');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('passes a blacklist to bamCoverage only when one is connected', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'epi-'));
    try {
      const bai = path.join(dir, 'a.bam.bai');
      fs.writeFileSync(bai, 'x');
      const slots = { bam: 'a.bam', bai, blacklist: '', coverage: 'out.bw' };
      expect(argsGiven('deeptools-bamcoverage', 'bamCoverage', slots)).not.toContain('--blackListFileName');
      const args = argsGiven('deeptools-bamcoverage', 'bamCoverage', { ...slots, blacklist: 'bl.bed' });
      expect(args[args.indexOf('--blackListFileName') + 1]).toBe('bl.bed');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('gives plotHeatmap a title only when one is typed, even with spaces', () => {
    const slots = { matrix: 'm.gz', heatmap: 'h.png' };
    expect(argsGiven('deeptools-plotheatmap', 'plotHeatmap', slots)).not.toContain('--plotTitle');
    const args = argsGiven('deeptools-plotheatmap', 'plotHeatmap', slots, { title: 'Signal at peaks' });
    expect(args[args.indexOf('--plotTitle') + 1]).toBe('Signal at peaks');
  });

  it('asks bedtools intersect for a minimum overlap only when one is typed', () => {
    const slots = { a: 'a.bed', b: 'b.bed' };
    expect(linesWritten('bedtools-intersect', 'bedtools', slots, 'result')).not.toContain('-f');
    const args = linesWritten('bedtools-intersect', 'bedtools', slots, 'result', { min_overlap: '0.25', mode: '-v' });
    expect(args[args.indexOf('-f') + 1]).toBe('0.25');
    expect(args).toContain('-v');
  });

  it('sorts and trims the regions before merging, so unsorted peaks, header lines and mixed column counts work', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'epi-'));
    try {
      const peaks = path.join(dir, 'peaks.narrowPeak');
      const other = path.join(dir, 'other.bed');
      fs.writeFileSync(peaks, 'track name=peaks\nchr2\t50\t90\tp2\t1\t.\t5\t5\t5\t3\nchr1\t300\t400\tp1\t1\t.\t5\t5\t5\t3\n');
      fs.writeFileSync(other, '#header\nchr1\t100\t200\n');
      const out = linesWritten(
        'bedtools-merge',
        'bedtools',
        { intervals: [peaks, other] },
        'merged',
        { distance: 5 },
        // The stand-in prints its arguments, then passes the sorted regions through.
        'bedtools() { echo "ARGS $*"; cat; }'
      );
      expect(out).toEqual(['ARGS merge -i - -d 5', 'chr1\t100\t200', 'chr1\t300\t400', 'chr2\t50\t90']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('connections between the epigenomics tools', () => {
  const makes = (from: string, to: string) => checkConnection(tool(from), tool(to)).status;

  it('match by file type along the ChIP-seq and ATAC-seq paths', () => {
    for (const [from, to] of [
      ['minimap2', 'samtools-sort'],
      ['samtools-sort', 'macs3-callpeak'],
      ['samtools-sort', 'genrich'],
      ['samtools-sort', 'deeptools-bamcoverage'],
      ['samtools-index', 'deeptools-bamcoverage'],
      ['samtools-index', 'deeptools-plotfingerprint'],
      ['samtools-sort', 'deeptools-plotfingerprint'],
      ['samtools-sort', 'bedtools-genomecov'],
      ['deeptools-bamcoverage', 'deeptools-computematrix'],
      ['macs3-callpeak', 'deeptools-computematrix'],
      ['genrich', 'deeptools-computematrix'],
      ['deeptools-computematrix', 'deeptools-plotheatmap'],
      ['macs3-callpeak', 'bedtools-intersect'],
      ['genrich', 'bedtools-merge'],
      ['bedtools-merge', 'bedtools-getfasta'],
      ['bedtools-intersect', 'bedtools-merge'],
      ['bedtools-intersect', 'homer-annotatepeaks'],
      ['macs3-callpeak', 'homer-annotatepeaks'],
      ['samtools-faidx', 'bedtools-getfasta'],
      ['samtools-faidx', 'homer-annotatepeaks'],
      ['gffread-bed', 'deeptools-computematrix'],
      ['bedtools-genomecov', 'multiqc'],
      ['macs3-callpeak', 'multiqc'],
    ]) {
      expect(makes(from, to), `${from} to ${to}`).toBe('match');
    }
  });

  it('flag a connection that cannot work', () => {
    expect(makes('deeptools-plotheatmap', 'deeptools-computematrix')).toBe('mismatch');
    expect(makes('bedtools-genomecov', 'bedtools-merge')).toBe('mismatch');
    expect(makes('bedtools-genomecov', 'deeptools-computematrix')).toBe('mismatch');
    expect(makes('bedtools-getfasta', 'bedtools-intersect')).toBe('mismatch');
  });

  it('binds the BAM and its index to bamCoverage without asking, and the tracks and peaks to computeMatrix after one question', () => {
    const { nodes, plans } = wire(
      [
        catalogNode('sort', 'samtools-sort'),
        catalogNode('idx', 'samtools-index'),
        catalogNode('cov', 'deeptools-bamcoverage'),
        catalogNode('macs', 'macs3-callpeak', { treatment: 'chip.bam' }),
        catalogNode('mat', 'deeptools-computematrix'),
        catalogNode('heat', 'deeptools-plotheatmap'),
      ],
      [
        ['sort', 'idx'],
        ['sort', 'cov'],
        ['idx', 'cov'],
        ['cov', 'mat'],
        ['macs', 'mat'],
        ['mat', 'heat'],
      ]
    );
    expect(plans.map((p) => `${p.pair}:${p.kind}`)).toEqual([
      'sort>idx:auto',
      'sort>cov:auto',
      'idx>cov:auto',
      'cov>mat:auto',
      // MACS3 makes the peaks and the summits, and both are regions: the person says which.
      'macs>mat:ask',
      'mat>heat:auto',
    ]);
    expect(linkOf(nodes, 'cov', 'bam')).toEqual({ from: 'sort', output: 'bam' });
    expect(linkOf(nodes, 'cov', 'bai')).toEqual({ from: 'idx', output: 'bai' });
    expect(linkOf(nodes, 'mat', 'signal')).toEqual([{ from: 'cov', output: 'coverage' }]);
    expect(linkOf(nodes, 'heat', 'matrix')).toEqual({ from: 'mat', output: 'matrix' });
  });

  it('puts the first BAM into MACS3 as the ChIP and the second as the control, without a question', () => {
    const { nodes, plans } = wire(
      [catalogNode('a', 'samtools-sort'), catalogNode('b', 'samtools-sort'), catalogNode('macs', 'macs3-callpeak')],
      [
        ['a', 'macs'],
        ['b', 'macs'],
      ]
    );
    expect(plans.map((p) => p.kind)).toEqual(['auto', 'auto']);
    expect(linkOf(nodes, 'macs', 'treatment')).toEqual({ from: 'a', output: 'bam' });
    expect(linkOf(nodes, 'macs', 'control')).toEqual({ from: 'b', output: 'bam' });
  });

  it('puts every connected BAM into Genrich as a replicate, so a control is chosen by hand', () => {
    const { nodes } = wire(
      [catalogNode('a', 'samtools-sort'), catalogNode('b', 'samtools-sort'), catalogNode('g', 'genrich')],
      [
        ['a', 'g'],
        ['b', 'g'],
      ]
    );
    expect(linkOf(nodes, 'g', 'alignments')).toEqual([
      { from: 'a', output: 'bam' },
      { from: 'b', output: 'bam' },
    ]);
    expect(linkOf(nodes, 'g', 'control')).toBeUndefined();
  });

  it('asks which of the two region slots of bedtools intersect a peak file should fill', () => {
    const { plans } = wire([catalogNode('g', 'genrich'), catalogNode('i', 'bedtools-intersect', { b: 'genes.bed' })], [['g', 'i']]);
    // B is typed, so the peaks can only be A.
    expect(plans[0].kind).toBe('auto');
    const both = wire([catalogNode('g', 'genrich'), catalogNode('i', 'bedtools-intersect')], [['g', 'i']]);
    expect(both.plans[0].kind).toBe('ask');
  });

  it('lists the files of the merge and the annotation steps so the next step can take them', () => {
    const merge = catalogNode('m', 'bedtools-merge', { intervals: 'peaks.bed' });
    expect(Object.fromEntries(outputItems(merge).map((o) => [o.key, o.files]))).toEqual({ merged: ['merged.bed'] });
    const homer = catalogNode('h', 'homer-annotatepeaks', { peaks: 'p.bed', genome: 'g.fa', annotation: 'g.gtf' });
    expect(slotStates(homer, [homer], []).map((s) => s.def.id)).toEqual(['peaks', 'genome', 'annotation', 'annotated', 'stats']);
  });
});
