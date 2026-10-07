/**
 * The RNA-seq tools of the catalog (index builders, HISAT2, STAR, kallisto,
 * StringTie, gffread, RSeQC). The real tools are run by `npm run test:tools`
 * (test-tools/chains/rna.tools.ts); these tests pin the parts that run without
 * them: the entries, the commands they render, the shell logic of the commands
 * (run against stand-ins for the tools), and how connecting two of them fills
 * the file slots.
 */
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
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
import { connectWithBinding, outputItems, slotStates, slotYaml, typesOfPath } from '../slots';

const NEW_TOOLS = [
  'hisat2-build',
  'hisat2',
  'salmon-index',
  'star-genomegenerate',
  'kallisto-index',
  'kallisto-quant',
  'stringtie-assemble',
  'stringtie-quantify',
  'gffread',
  'gffread-bed',
  'rseqc-infer-experiment',
  'rseqc-read-distribution',
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

describe('the RNA-seq tools in the catalog', () => {
  it('has every tool of the phase, and the catalog is still valid', () => {
    for (const id of NEW_TOOLS) expect(findTool(id), id).toBeDefined();
    expect(CATALOG.tools.length).toBeGreaterThanOrEqual(46);
    expect(validateCatalog(CATALOG)).toEqual([]);
  });

  it('pins each tool to the version it was run with, natively on Apple silicon except STAR', () => {
    const pins = Object.fromEntries(
      [...NEW_TOOLS, 'star'].map((id) => {
        const install = tool(id).install;
        if (install.kind !== 'conda') throw new Error(`${id} is not a conda tool`);
        return [id, `${install.package}==${install.version}${install.osx64 ? ' (Intel build)' : ''}`];
      })
    );
    expect(pins).toEqual({
      'hisat2-build': 'hisat2==2.2.3',
      hisat2: 'hisat2==2.2.3',
      'salmon-index': 'salmon==2.8.0',
      'star-genomegenerate': 'star==2.7.10b (Intel build)',
      star: 'star==2.7.10b (Intel build)',
      'kallisto-index': 'kallisto==0.52.0',
      'kallisto-quant': 'kallisto==0.52.0',
      'stringtie-assemble': 'stringtie==3.0.3',
      'stringtie-quantify': 'stringtie==3.0.3',
      gffread: 'gffread==0.12.9',
      'gffread-bed': 'gffread==0.12.9',
      'rseqc-infer-experiment': 'rseqc==5.0.5',
      'rseqc-read-distribution': 'rseqc==5.0.5',
    });
  });

  it('shares one environment between tools of one package, so a chain installs each only once', () => {
    expect(tool('hisat2-build').install).toEqual(tool('hisat2').install);
    expect(tool('salmon-index').install).toEqual(tool('salmon-quant').install);
    expect(tool('star-genomegenerate').install).toEqual(tool('star').install);
    expect(tool('kallisto-index').install).toEqual(tool('kallisto-quant').install);
    expect(tool('stringtie-assemble').install).toEqual(tool('stringtie-quantify').install);
    expect(tool('gffread').install).toEqual(tool('gffread-bed').install);
    expect(tool('rseqc-infer-experiment').install).toEqual(tool('rseqc-read-distribution').install);
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

  it('declares a type for every file and uses only types a person can recognise', () => {
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
    const fc = tool('featurecounts').params.find((p) => p.id === 'strand')!;
    expect(fc.options).toEqual(['0', '1', '2']);
    expect(fc.option_labels!['2']).toMatch(/^Reverse-stranded/);
  });

  it('puts the new tools in the right groups of the palette', () => {
    const group = (id: string) => `${tool(id).category}/${tool(id).subcategory}`;
    expect(group('hisat2-build')).toBe('reference/Aligner indexes');
    expect(group('salmon-index')).toBe('reference/Aligner indexes');
    expect(group('star-genomegenerate')).toBe('reference/Aligner indexes');
    expect(group('kallisto-index')).toBe('reference/Aligner indexes');
    expect(group('gffread')).toBe('reference/Annotation files');
    expect(group('gffread-bed')).toBe('reference/Annotation files');
    expect(group('hisat2')).toBe('alignment/RNA-seq aligners');
    expect(group('star')).toBe('alignment/RNA-seq aligners');
    expect(group('kallisto-quant')).toBe('quantification/Transcript abundance');
    expect(group('stringtie-assemble')).toBe('quantification/Transcript assembly');
    expect(group('stringtie-quantify')).toBe('quantification/Transcript assembly');
    expect(group('rseqc-infer-experiment')).toBe('qc/RNA-seq QC');
    expect(group('rseqc-read-distribution')).toBe('qc/RNA-seq QC');
  });

  it('makes each index builder write a folder (or one file for kallisto) the aligner takes whole', () => {
    for (const id of ['hisat2-build', 'salmon-index', 'star-genomegenerate']) {
      const outputs = tool(id).outputs;
      expect(outputs.length, id).toBe(1);
      expect(outputs[0].is_dir, id).toBe(true);
      expect(outputs[0].pattern!.endsWith('/'), id).toBe(true);
      expect(outputs[0].types, id).toEqual(['index']);
    }
    expect(tool('kallisto-index').outputs[0].is_dir).toBe(false);
    expect(typesOfPath('kallisto.idx')).toEqual(['index']);
  });

  it('keeps the second read file and the optional annotation optional', () => {
    const optional = (id: string) => tool(id).inputs.filter((i) => !i.required).map((i) => i.name);
    expect(optional('hisat2')).toEqual(['reads2']);
    expect(optional('kallisto-quant')).toEqual(['reads2']);
    expect(optional('star')).toEqual(['reads2']);
    expect(optional('star-genomegenerate')).toEqual(['annotation']);
    expect(optional('stringtie-assemble')).toEqual(['annotation']);
    expect(optional('stringtie-quantify')).toEqual([]);
    const node = catalogNode('h', 'hisat2', { reads1: 'a.fq.gz' });
    expect(slotYaml(node, [node], []).optional_slots).toEqual(['reads2']);
  });
});

describe('commands of the RNA-seq tools', () => {
  it('builds the indexes with the threads and word sizes from the form', () => {
    expect(renderCommand(tool('hisat2-build'), {}, 4)).toBe('hisat2-build -p 4 {genome} {index_dir}genome');
    expect(renderCommand(tool('salmon-index'), {}, 4)).toBe('salmon index -t {transcripts} -i {index_dir} -k 31 -p 4');
    expect(renderCommand(tool('salmon-index'), { kmer: 21 }, 2)).toContain('-k 21 -p 2');
    expect(renderCommand(tool('kallisto-index'), { kmer: 25 }, 1)).toBe('kallisto index -i {index} -k 25 {transcripts}');
  });

  it('turns the HISAT2 form into flags: Prepare for StringTie and the longest intron', () => {
    const off = renderCommand(tool('hisat2'), {}, 4);
    expect(off).toContain('hisat2 -p 4 --max-intronlen 500000 -x {index}/genome "$@" -S {sam} --new-summary --summary-file {summary}');
    expect(off).not.toContain('--dta');
    expect(renderCommand(tool('hisat2'), { dta: true, max_intron: 100000 }, 2)).toContain('hisat2 -p 2 --dta --max-intronlen 100000 -x');
  });

  it('renders the strandedness choices as the flag each tool wants, and nothing when unstranded', () => {
    expect(renderCommand(tool('stringtie-assemble'), {}, 1)).toContain('-f 0.01 ${G:+');
    expect(renderCommand(tool('stringtie-assemble'), { strand: '--rf' }, 1)).toContain('-f 0.01 --rf ${G:+');
    expect(renderCommand(tool('stringtie-quantify'), { strand: '--fr' }, 2)).toBe(
      'stringtie {bam} -e -B -p 2 -G {annotation} -o {out_dir}transcripts.gtf -A {out_dir}gene_abundances.tsv --fr'
    );
    expect(renderCommand(tool('stringtie-quantify'), {}, 2).endsWith('gene_abundances.tsv')).toBe(true);
    expect(renderCommand(tool('kallisto-quant'), { strand: '--rf-stranded' }, 4)).toContain('-t 4 "$@" --rf-stranded -b 0 {reads1}');
    expect(renderCommand(tool('featurecounts'), { strand: '2', paired: true }, 4)).toContain('-a {annotation} -s 2 -t exon -g gene_id -p --countReadPairs -o {counts}');
    expect(renderCommand(tool('featurecounts'), {}, 4)).toContain('-a {annotation} -s 0 -t exon');
  });

  it('fills the kallisto fragment length from the form and decides single or paired in the shell', () => {
    expect(renderCommand(tool('kallisto-quant'), {}, 4)).toBe(
      'set -- --single -l 200 -s 20; if [ -n "{reads2}" ]; then set --; fi; ' +
        'kallisto quant -i {index} -o {out_dir} -t 4 "$@" -b 0 {reads1} {reads2} 2> {log} || (cat {log} >&2; false)'
    );
    expect(renderCommand(tool('kallisto-quant'), { fragment_length: 180, fragment_sd: 30, bootstrap_samples: 10 }, 4)).toContain(
      'set -- --single -l 180 -s 30;'
    );
    expect(tool('kallisto-quant').params.map((p) => p.id)).not.toContain('single_end');
  });

  it('lets STAR take the second read file by position, and keeps the gzip reader', () => {
    const cmd = renderCommand(tool('star'), {}, 4);
    expect(cmd).toContain('--readFilesIn {reads} {reads2} --readFilesCommand gzip -cdf');
  });

  it('runs the RSeQC scripts on the BAM and the BED12 gene model and keeps their text', () => {
    expect(renderCommand(tool('rseqc-infer-experiment'), {}, 1)).toBe(
      'infer_experiment.py -r {gene_model} -i {bam} -s 200000 -q 30 > {report}'
    );
    expect(renderCommand(tool('rseqc-read-distribution'), {}, 1)).toBe('read_distribution.py -i {bam} -r {gene_model} > {report}');
    expect(renderCommand(tool('gffread'), {}, 1)).toBe('gffread -w {transcripts} -g {genome} {annotation}');
    expect(renderCommand(tool('gffread-bed'), {}, 1)).toBe('gffread --bed {annotation} -o {bed}');
  });

  it('only gives STAR the junction overhang when there is an annotation', () => {
    const cmd = renderCommand(tool('star-genomegenerate'), { sjdb_overhang: 74, sa_index_nbases: 4 }, 2);
    expect(cmd).toContain('--genomeSAindexNbases 4');
    expect(cmd).toContain('${ANN:+--sjdbGTFfile "$ANN" --sjdbOverhang 74}');
    expect(cmd.indexOf('--sjdbOverhang')).toBeGreaterThan(cmd.indexOf('${ANN:+'));
  });
});

/**
 * The commands that choose their flags in the shell (an optional file decides
 * between two ways to call the tool) are run here against stand-ins that print
 * their arguments, one per line, so the choice is tested without the tools.
 */
describe.skipIf(process.platform === 'win32')('the shell logic of the commands', () => {
  /** What the stand-in tool received for the command with these slot values and options. */
  function argsGiven(toolId: string, standIn: string, slots: Record<string, string>, params: Record<string, any> = {}): string[] {
    const command = renderCommand(tool(toolId), params, 2).replace(/\{([A-Za-z_]\w*)\}/g, (_m, name) => {
      if (!(name in slots)) throw new Error(`no value for {${name}}`);
      return slots[name] === '' ? '' : `'${slots[name]}'`;
    });
    // The engine fills placeholders inside double quotes without the single quotes; do the same.
    const script = `${standIn}() { printf '%s\\n' "$@"; }\n${command.replace(/"'([^']*)'"/g, '"$1"')}`;
    const run = spawnSync('bash', ['-c', script], { encoding: 'utf8' });
    if (run.status !== 0) throw new Error(`${command}\n${run.stderr}`);
    return run.stdout.trim().split('\n');
  }

  const hisat = { index: 'idx/', reads1: 'a_R1.fq.gz', reads2: '', sam: 'out.sam', summary: 'sum.txt' };

  it('calls HISAT2 with -U for one read file and with -1 and -2 for a pair', () => {
    const single = argsGiven('hisat2', 'hisat2', hisat);
    expect(single).toContain('-U');
    expect(single[single.indexOf('-U') + 1]).toBe('a_R1.fq.gz');
    expect(single).not.toContain('-1');
    const pair = argsGiven('hisat2', 'hisat2', { ...hisat, reads2: 'a_R2.fq.gz' });
    expect(pair[pair.indexOf('-1') + 1]).toBe('a_R1.fq.gz');
    expect(pair[pair.indexOf('-2') + 1]).toBe('a_R2.fq.gz');
    expect(pair).not.toContain('-U');
    expect(pair[pair.indexOf('-x') + 1]).toBe('idx//genome');
  });

  it('keeps a file name with a space as one argument', () => {
    const pair = argsGiven('hisat2', 'hisat2', { ...hisat, reads1: 'my reads 1.fq', reads2: 'my reads 2.fq' });
    expect(pair[pair.indexOf('-1') + 1]).toBe('my reads 1.fq');
    expect(pair[pair.indexOf('-2') + 1]).toBe('my reads 2.fq');
  });

  it('gives STAR the annotation and the overhang together, or neither', () => {
    const slots = { genome: 'g.fa', index_dir: 'idx/', annotation: '' };
    const without = argsGiven('star-genomegenerate', 'STAR', slots);
    expect(without).not.toContain('--sjdbGTFfile');
    expect(without).not.toContain('--sjdbOverhang');
    const withGtf = argsGiven('star-genomegenerate', 'STAR', { ...slots, annotation: 'genes.gtf' }, { sjdb_overhang: 74 });
    expect(withGtf[withGtf.indexOf('--sjdbGTFfile') + 1]).toBe('genes.gtf');
    expect(withGtf[withGtf.indexOf('--sjdbOverhang') + 1]).toBe('74');
  });

  it('tells kallisto a single-end run its fragment length, and a paired run nothing', () => {
    const slots = { index: 'k.idx', out_dir: 'out/', reads1: 'a.fq.gz', reads2: '', log: 'k.log' };
    const single = argsGiven('kallisto-quant', 'kallisto', slots, { fragment_length: 180, fragment_sd: 30 });
    expect(single.slice(single.indexOf('--single'), single.indexOf('--single') + 5)).toEqual(['--single', '-l', '180', '-s', '30']);
    expect(single.slice(-1)).toEqual(['a.fq.gz']);
    const paired = argsGiven('kallisto-quant', 'kallisto', { ...slots, reads2: 'b.fq.gz' });
    expect(paired).not.toContain('--single');
    expect(paired).not.toContain('-l');
    expect(paired.slice(-2)).toEqual(['a.fq.gz', 'b.fq.gz']);
  });

  it('gives StringTie a guide only when there is one', () => {
    const slots = { bam: 's.bam', gtf: 'o.gtf', genes: 'g.tsv', annotation: '' };
    expect(argsGiven('stringtie-assemble', 'stringtie', slots)).not.toContain('-G');
    const guided = argsGiven('stringtie-assemble', 'stringtie', { ...slots, annotation: 'genes.gtf' }, { strand: '--rf' });
    expect(guided[guided.indexOf('-G') + 1]).toBe('genes.gtf');
    expect(guided).toContain('--rf');
  });
});

describe('connections between the RNA-seq tools', () => {
  const makes = (from: string, to: string) => checkConnection(tool(from), tool(to)).status;

  it('match by file type along the RNA-seq paths', () => {
    for (const [from, to] of [
      ['hisat2-build', 'hisat2'],
      ['star-genomegenerate', 'star'],
      ['salmon-index', 'salmon-quant'],
      ['kallisto-index', 'kallisto-quant'],
      ['gffread', 'salmon-index'],
      ['gffread', 'kallisto-index'],
      ['gffread-bed', 'rseqc-infer-experiment'],
      ['gffread-bed', 'rseqc-read-distribution'],
      ['hisat2', 'samtools-sort'],
      ['hisat2', 'featurecounts'],
      ['samtools-sort', 'stringtie-assemble'],
      ['samtools-sort', 'stringtie-quantify'],
      ['stringtie-assemble', 'stringtie-quantify'],
      ['star', 'rseqc-infer-experiment'],
      ['star', 'stringtie-quantify'],
      ['samtools-sort', 'rseqc-read-distribution'],
      ['fastp', 'hisat2'],
      ['fastp', 'kallisto-quant'],
      ['cutadapt', 'star'],
      ['kallisto-quant', 'multiqc'],
      ['hisat2', 'multiqc'],
      ['rseqc-infer-experiment', 'multiqc'],
      ['rseqc-read-distribution', 'multiqc'],
    ]) {
      expect(makes(from, to), `${from} to ${to}`).toBe('match');
    }
  });

  it('flag a connection that cannot work', () => {
    expect(makes('gffread-bed', 'hisat2')).toBe('mismatch');
    expect(makes('rseqc-infer-experiment', 'featurecounts')).toBe('mismatch');
    expect(makes('kallisto-quant', 'stringtie-quantify')).toBe('mismatch');
  });

  it('binds a transcript FASTA to both index builders, and each index to its quantifier, without asking', () => {
    const { nodes, plans } = wire(
      [
        catalogNode('gff', 'gffread', { genome: 'g.fa', annotation: 'g.gtf' }),
        catalogNode('sidx', 'salmon-index'),
        catalogNode('squant', 'salmon-quant', { reads: 'r.fq.gz' }),
        catalogNode('kidx', 'kallisto-index'),
        catalogNode('kq', 'kallisto-quant', { reads1: 'r.fq.gz' }),
      ],
      [
        ['gff', 'sidx'],
        ['sidx', 'squant'],
        ['gff', 'kidx'],
        ['kidx', 'kq'],
      ]
    );
    expect(plans.map((p) => p.kind)).toEqual(['auto', 'auto', 'auto', 'auto']);
    expect(linkOf(nodes, 'sidx', 'transcripts')).toEqual({ from: 'gff', output: 'transcripts' });
    expect(linkOf(nodes, 'kidx', 'transcripts')).toEqual({ from: 'gff', output: 'transcripts' });
    expect(linkOf(nodes, 'squant', 'index')).toEqual({ from: 'sidx', output: 'index_dir' });
    expect(linkOf(nodes, 'kq', 'index')).toEqual({ from: 'kidx', output: 'index' });
    const sidx = nodes.find((n) => n.id === 'sidx')!;
    expect(slotStates(sidx, nodes, [edge('gff', 'sidx')]).find((s) => s.def.id === 'transcripts')!.files).toEqual(['transcripts.fa']);
  });

  it('feeds HISAT2 the index folder and samtools sort the SAM, not the summary', () => {
    const { nodes, plans } = wire(
      [
        catalogNode('b', 'hisat2-build', { genome: 'g.fa' }),
        catalogNode('h', 'hisat2', { reads1: 'r1.fq.gz', reads2: 'r2.fq.gz' }),
        catalogNode('s', 'samtools-sort'),
      ],
      [
        ['b', 'h'],
        ['h', 's'],
      ]
    );
    expect(plans.map((p) => p.kind)).toEqual(['auto', 'auto']);
    expect(linkOf(nodes, 'h', 'index')).toEqual({ from: 'b', output: 'index_dir' });
    expect(linkOf(nodes, 's', 'alignments')).toEqual({ from: 'h', output: 'sam' });
  });

  it("binds STAR's BAM and the BED12 gene model to the RSeQC steps, and assembled transcripts to the annotation of StringTie quantify", () => {
    const { nodes, plans } = wire(
      [
        catalogNode('star', 'star', { index: 'idx/', reads: 'r.fq.gz' }),
        catalogNode('bed', 'gffread-bed', { annotation: 'g.gtf' }),
        catalogNode('infer', 'rseqc-infer-experiment'),
        catalogNode('asm', 'stringtie-assemble'),
        catalogNode('quant', 'stringtie-quantify'),
      ],
      [
        ['star', 'infer'],
        ['bed', 'infer'],
        ['star', 'asm'],
        ['star', 'quant'],
        ['asm', 'quant'],
      ]
    );
    expect(plans.map((p) => p.kind)).toEqual(['auto', 'auto', 'auto', 'auto', 'auto']);
    expect(linkOf(nodes, 'infer', 'bam')).toEqual({ from: 'star', output: 'bam' });
    expect(linkOf(nodes, 'infer', 'gene_model')).toEqual({ from: 'bed', output: 'bed' });
    expect(linkOf(nodes, 'quant', 'bam')).toEqual({ from: 'star', output: 'bam' });
    expect(linkOf(nodes, 'quant', 'annotation')).toEqual({ from: 'asm', output: 'gtf' });
    // The optional guide of StringTie assemble is never filled by a guess.
    expect(linkOf(nodes, 'asm', 'annotation')).toBeUndefined();
  });

  it('asks which STAR file MultiQC should read, because STAR makes several', () => {
    const { plans } = wire([catalogNode('star', 'star', { index: 'idx/', reads: 'r.fq.gz' }), catalogNode('mq', 'multiqc')], [['star', 'mq']]);
    expect(plans[0].kind).toBe('ask');
  });

  it('lists the derived files of StringTie quantify so the next step can take them', () => {
    const quant = catalogNode('q', 'stringtie-quantify', { annotation: 'g.gtf', out_dir: 'st/' });
    const files = Object.fromEntries(outputItems(quant).map((o) => [o.key, o.files]));
    expect(files).toEqual({
      out_dir: ['st/'],
      transcripts: ['st/transcripts.gtf'],
      genes: ['st/gene_abundances.tsv'],
    });
  });
});

describe('the older RNA tools after this phase', () => {
  it('lets STAR take a pair, and says where the index and the strand choice come from', () => {
    expect(tool('star').inputs.map((i) => `${i.name}${i.required ? '' : '?'}`)).toEqual(['index', 'reads', 'reads2?']);
    expect(tool('star').inputs[0].description).toContain('STAR genome index');
    expect(tool('salmon-quant').inputs[0].description).toContain('Salmon index');
  });

  it('counts unstranded unless the form says otherwise, which is the featureCounts default', () => {
    const strand = tool('featurecounts').params.find((p) => p.id === 'strand')!;
    expect(strand.default).toBe('0');
    expect(tool('featurecounts').params.map((p) => p.id)).toEqual(['strand', 'feature_type', 'attribute', 'paired']);
  });

  it('tells MultiQC about the new report formats it reads', () => {
    const text = tool('multiqc').inputs[0].description;
    for (const name of ['HISAT2', 'kallisto', 'RSeQC', 'STAR', 'featureCounts']) expect(text).toContain(name);
  });
});
