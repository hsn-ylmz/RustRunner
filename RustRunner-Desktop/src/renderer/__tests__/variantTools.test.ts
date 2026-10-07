/**
 * The DNA-seq and variant tools of the catalog (reference indexes, minimap2,
 * duplicate marking, coverage and QC, FreeBayes, GATK, VCF tools, snpEff).
 * The real tools are run by `npm run test:tools` (test-tools/chains/variants.tools.ts);
 * these tests pin the parts that run without them: the entries, the commands
 * they render, and how connecting two of them fills the file slots.
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  CATALOG,
  buildCatalogNodeData,
  checkConnection,
  defaultParams,
  findTool,
  missingRequiredParams,
  renderCommand,
  validateCatalog,
  type CatalogTool,
} from '../tools/catalog';
import { connectWithBinding, outputItems, slotStates, slotYaml, typesOfPath } from '../slots';

const NEW_TOOLS = [
  'bwa-index',
  'bowtie2-build',
  'minimap2',
  'samtools-faidx',
  'samtools-merge',
  'samtools-markdup',
  'samtools-depth',
  'picard-markduplicates',
  'mosdepth',
  'qualimap-bamqc',
  'freebayes',
  'bcftools-filter',
  'bcftools-norm',
  'bcftools-stats',
  'gatk-haplotypecaller',
  'gatk-createsequencedictionary',
  'bgzip',
  'tabix',
  'snpeff-build',
  'snpeff-annotate',
];

const tool = (id: string): CatalogTool => {
  const found = findTool(id);
  if (!found) throw new Error(`catalog has no tool ${id}`);
  return found;
};

/** A canvas node made the way the palette makes it, with typed files for some slots. */
function catalogNode(id: string, toolId: string, files: Record<string, string> = {}, params: Record<string, any> = {}) {
  const t = tool(toolId);
  const data = buildCatalogNodeData(t, []);
  data.catalogParams = { ...defaultParams(t), ...params };
  data.slotFiles = { ...(data.slotFiles as Record<string, string>), ...files };
  return { id, data: data as Record<string, any> };
}

const edge = (source: string, target: string) => ({ source, target });

/** Connects `from` to `to` on a canvas and returns the nodes and what the app did about the files. */
function connect(nodes: ReturnType<typeof catalogNode>[], from: string, to: string) {
  const edges = [edge(from, to)];
  return connectWithBinding(nodes, [], edges, from, to);
}

const linkOf = (nodes: ReturnType<typeof catalogNode>[], id: string, slot: string) =>
  (nodes.find((n) => n.id === id)!.data.slotLinks ?? {})[slot];

describe('the DNA-seq and variant tools in the catalog', () => {
  it('has every tool the phase promised, and the catalog is still valid', () => {
    for (const id of NEW_TOOLS) expect(findTool(id), id).toBeDefined();
    expect(CATALOG.tools.length).toBeGreaterThanOrEqual(34);
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
      'bwa-index': 'bwa==0.7.19',
      'bowtie2-build': 'bowtie2==2.5.5',
      minimap2: 'minimap2==2.30',
      'samtools-faidx': 'samtools==1.24',
      'samtools-merge': 'samtools==1.24',
      'samtools-markdup': 'samtools==1.24',
      'samtools-depth': 'samtools==1.24',
      'picard-markduplicates': 'picard==3.4.0',
      mosdepth: 'mosdepth==0.3.13',
      'qualimap-bamqc': 'qualimap==2.3',
      freebayes: 'freebayes==1.3.10',
      'bcftools-filter': 'bcftools==1.24',
      'bcftools-norm': 'bcftools==1.24',
      'bcftools-stats': 'bcftools==1.24',
      'gatk-haplotypecaller': 'gatk4==4.6.2.0',
      'gatk-createsequencedictionary': 'gatk4==4.6.2.0',
      bgzip: 'htslib==1.24',
      tabix: 'htslib==1.24',
      'snpeff-build': 'snpeff==5.4.0c',
      'snpeff-annotate': 'snpeff==5.4.0c',
    });
  });

  it('shares one environment between tools of one package, so a chain installs each only once', () => {
    expect(tool('samtools-faidx').install).toEqual(tool('samtools-sort').install);
    expect(tool('bcftools-filter').install).toEqual(tool('bcftools-call').install);
    expect(tool('bwa-index').install).toEqual(tool('bwa-mem').install);
    expect(tool('bowtie2-build').install).toEqual(tool('bowtie2').install);
    expect(tool('gatk-haplotypecaller').install).toEqual(tool('gatk-createsequencedictionary').install);
    expect(tool('snpeff-build').install).toEqual(tool('snpeff-annotate').install);
    expect(tool('bgzip').install).toEqual(tool('tabix').install);
  });

  it('gives every new tool a plain description and a plain label and hint on each file and option', () => {
    for (const id of NEW_TOOLS) {
      const t = tool(id);
      expect(t.description.length, id).toBeGreaterThan(20);
      expect(t.description, id).toMatch(/\.$/);
      for (const slot of [...t.inputs, ...t.outputs]) {
        expect(slot.label, `${id}.${slot.name}`).toMatch(/^[A-Za-z]/);
        expect(slot.label, `${id}.${slot.name}`).not.toMatch(/[:.]$/);
        expect(slot.description, `${id}.${slot.name}`).toMatch(/\.$/);
      }
      for (const p of t.params) {
        expect(p.label, `${id}.${p.id}`).toMatch(/^[A-Za-z]/);
        expect(p.label, `${id}.${p.id}`).not.toMatch(/[:.]$/);
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

  it('puts the new tools in the right groups of the palette', () => {
    const group = (id: string) => `${tool(id).category}/${tool(id).subcategory}`;
    expect(group('bwa-index')).toBe('reference/Aligner indexes');
    expect(group('samtools-faidx')).toBe('reference/Reference indexes');
    expect(group('minimap2')).toBe('alignment/DNA aligners');
    expect(group('picard-markduplicates')).toBe('processing/Duplicates');
    expect(group('mosdepth')).toBe('qc/Coverage');
    expect(group('freebayes')).toBe('variant_calling/SNPs and small indels');
    expect(group('snpeff-annotate')).toBe('annotation/Variant effects');
    expect(Object.keys(CATALOG.categories)).toEqual([
      'qc',
      'trimming',
      'reference',
      'alignment',
      'processing',
      'variant_calling',
      'annotation',
      'quantification',
      'peak_calling',
      'signal',
      'intervals',
    ]);
  });
});

describe('index builders and reference folders', () => {
  it('writes a folder with a copy of the FASTA and exposes the copy as a derived file', () => {
    for (const id of ['bwa-index', 'bowtie2-build', 'samtools-faidx', 'gatk-createsequencedictionary', 'tabix']) {
      const t = tool(id);
      const folder = t.outputs.find((o) => o.is_dir);
      expect(folder, `${id} writes a folder`).toBeDefined();
      expect(folder!.pattern!.endsWith('/'), id).toBe(true);
      const derived = t.outputs.filter((o) => o.derived);
      expect(derived.length, `${id} names its files`).toBeGreaterThan(0);
      for (const d of derived) expect(d.derived!.from, `${id}.${d.name}`).toBe(folder!.name);
    }
  });

  it('uses the same copy name in the command and in the derived outputs', () => {
    expect(renderCommand(tool('bwa-index'), {}, 1)).toBe('cp {ref} {index_dir}reference.fa && bwa index {index_dir}reference.fa');
    expect(tool('bwa-index').outputs.find((o) => o.name === 'indexed_ref')!.derived!.suffix).toBe('reference.fa');
    expect(renderCommand(tool('samtools-faidx'), {}, 1)).toBe(
      'cp {ref} {ref_dir}reference.fa && samtools faidx {ref_dir}reference.fa'
    );
    const faidx = tool('samtools-faidx').outputs.filter((o) => o.derived).map((o) => o.derived!.suffix);
    expect(faidx).toEqual(['reference.fa', 'reference.fa.fai']);
    const dict = tool('gatk-createsequencedictionary').outputs.filter((o) => o.derived).map((o) => o.derived!.suffix);
    expect(dict).toEqual(['reference.fa', 'reference.fa.fai', 'reference.dict']);
    expect(renderCommand(tool('gatk-createsequencedictionary'), {}, 1)).toContain('cp {ref}.fai {ref_dir}reference.fa.fai');
  });

  it('builds the Bowtie2 index under the FASTA copy name, which is the name Bowtie2 reads', () => {
    expect(renderCommand(tool('bowtie2-build'), {}, 4)).toBe(
      'cp {ref} {index_dir}reference.fa && bowtie2-build --threads 4 {index_dir}reference.fa {index_dir}reference.fa'
    );
    expect(renderCommand(tool('bowtie2-build'), { large_index: true }, 4)).toContain('--large-index {index_dir}reference.fa');
  });

  it('lists the derived files of a reference step so the next step can take them', () => {
    const faidx = catalogNode('faidx', 'samtools-faidx', { ref: 'genome.fa', ref_dir: 'ref/' });
    const files = Object.fromEntries(outputItems(faidx).map((o) => [o.key, o.files]));
    expect(files).toEqual({
      ref_dir: ['ref/'],
      fasta: ['ref/reference.fa'],
      fai: ['ref/reference.fa.fai'],
    });
    expect(slotYaml(faidx, [faidx], []).named_outputs).toEqual({
      ref_dir: ['ref/'],
      fasta: ['ref/reference.fa'],
      fai: ['ref/reference.fa.fai'],
    });
  });

  it('binds the indexed FASTA, not the folder, when a reference step is connected to an aligner', () => {
    const bwa = connect(
      [catalogNode('idx', 'bwa-index', { ref: 'genome.fa' }), catalogNode('mem', 'bwa-mem', { reads1: 'r.fq.gz' })],
      'idx',
      'mem'
    );
    expect(bwa.plan.kind).toBe('auto');
    expect(linkOf(bwa.nodes, 'mem', 'ref')).toEqual({ from: 'idx', output: 'indexed_ref' });
    expect(slotStates(bwa.nodes[1], bwa.nodes, [edge('idx', 'mem')]).find((s) => s.def.id === 'ref')!.files).toEqual([
      'bwa_index/reference.fa',
    ]);

    const bt = connect(
      [catalogNode('b', 'bowtie2-build', { ref: 'genome.fa' }), catalogNode('a', 'bowtie2', { reads: 'r.fq.gz' })],
      'b',
      'a'
    );
    expect(bt.plan.kind).toBe('auto');
    expect(linkOf(bt.nodes, 'a', 'index')).toEqual({ from: 'b', output: 'index' });

    const fai = connect(
      [catalogNode('f', 'samtools-faidx', { ref: 'genome.fa' }), catalogNode('c', 'bcftools-call', { bam: 'x.bam' })],
      'f',
      'c'
    );
    expect(fai.plan.kind).toBe('auto');
    expect(linkOf(fai.nodes, 'c', 'ref')).toEqual({ from: 'f', output: 'fasta' });
  });

  it('feeds the GATK-ready copy, the BAM and its index into HaplotypeCaller without asking', () => {
    let nodes = [
      catalogNode('dict', 'gatk-createsequencedictionary', { ref: 'ref/reference.fa' }),
      catalogNode('sort', 'samtools-sort', { alignments: 'a.sam' }),
      catalogNode('index', 'samtools-index'),
      catalogNode('hc', 'gatk-haplotypecaller'),
    ];
    const edges: Array<{ source: string; target: string }> = [];
    for (const [from, to] of [
      ['dict', 'hc'],
      ['sort', 'hc'],
      ['index', 'hc'],
    ]) {
      const before = [...edges];
      edges.push(edge(from, to));
      const out = connectWithBinding(nodes, before, edges, from, to);
      expect(out.plan.kind, `${from} to ${to}`).toBe('auto');
      nodes = out.nodes;
    }
    const slotOf = (slot: string) => linkOf(nodes, 'hc', slot);
    expect(slotOf('ref')).toEqual({ from: 'dict', output: 'fasta' });
    expect(slotOf('bam')).toEqual({ from: 'sort', output: 'bam' });
    expect(slotOf('bai')).toEqual({ from: 'index', output: 'bai' });
  });

  it('hands a snpEff database folder to the annotation step and the VCF to its own slot', () => {
    let nodes = [
      catalogNode('build', 'snpeff-build', { genome: 'g.fa', annotation: 'g.gtf' }),
      catalogNode('call', 'freebayes', { ref: 'g.fa', bams: 'a.bam' }),
      catalogNode('ann', 'snpeff-annotate'),
    ];
    const edges: Array<{ source: string; target: string }> = [];
    for (const [from, to] of [
      ['call', 'ann'],
      ['build', 'ann'],
    ]) {
      const before = [...edges];
      edges.push(edge(from, to));
      const out = connectWithBinding(nodes, before, edges, from, to);
      expect(out.plan.kind).toBe('auto');
      nodes = out.nodes;
    }
    expect(linkOf(nodes, 'ann', 'vcf')).toEqual({ from: 'call', output: 'vcf' });
    expect(linkOf(nodes, 'ann', 'database')).toEqual({ from: 'build', output: 'database' });
  });

  it('keeps the tabix copy and its index as separate named files', () => {
    const tabix = catalogNode('t', 'tabix', { file: 'v.vcf.gz' });
    const files = Object.fromEntries(outputItems(tabix).map((o) => [o.key, o.files]));
    expect(files).toEqual({
      index_dir: ['tabix/'],
      indexed: ['tabix/indexed.gz'],
      index: ['tabix/indexed.gz.tbi'],
    });
  });
});

describe('commands of the new tools', () => {
  it('asks minimap2 for the short-read preset and a read group built from the sample name', () => {
    const cmd = renderCommand(tool('minimap2'), defaultParams(tool('minimap2')), 4);
    expect(cmd).toBe(
      'sample=sample; minimap2 -ax sr -t 4 --secondary=no -R "@RG\\tID:$sample\\tSM:$sample" {ref} {reads1} {reads2} > {sam}'
    );
    expect(renderCommand(tool('minimap2'), { sample_name: 'patient 7', primary_only: false }, 2)).toContain(
      "sample='patient 7'; minimap2 -ax sr -t 2 -R "
    );
  });

  it('refuses to run minimap2 without a sample name', () => {
    const t = tool('minimap2');
    expect(missingRequiredParams(t, { sample_name: '  ' })).toEqual(['sample_name']);
    expect(renderCommand(t, { sample_name: '' }, 1)).toContain('sample={sample_name};');
  });

  it('marks duplicates with fixmate and sort in front, and a second output for the statistics', () => {
    const t = tool('samtools-markdup');
    const cmd = renderCommand(t, defaultParams(t), 4);
    expect(cmd.startsWith('set -o pipefail; samtools sort -n -@ 4 {alignments} | samtools fixmate -m -@ 4 - - | samtools sort -@ 4 - | samtools markdup -@ 4 -d 0 -f {stats} - {marked}')).toBe(true);
    expect(renderCommand(t, { remove_duplicates: true, optical_distance: 100 }, 2)).toContain('markdup -@ 2 -r -d 100 -f');
    expect(t.outputs.map((o) => o.name)).toEqual(['marked', 'stats']);
  });

  it('makes Picard write decimal points whatever the language of the computer', () => {
    const cmd = renderCommand(tool('picard-markduplicates'), {}, 1);
    expect(cmd).toContain('-Duser.language=en -Duser.country=US MarkDuplicates');
    expect(cmd).toContain('--OPTICAL_DUPLICATE_PIXEL_DISTANCE 100');
    expect(renderCommand(tool('picard-markduplicates'), { remove_duplicates: true }, 1)).toContain('--REMOVE_DUPLICATES true');
    expect(cmd).not.toContain('REMOVE_DUPLICATES');
  });

  it('does the same for Qualimap and snpEff, which print numbers in the computer language', () => {
    expect(renderCommand(tool('qualimap-bamqc'), {}, 2)).toContain('-Duser.language=en -Duser.country=US');
    expect(renderCommand(tool('snpeff-annotate'), { genome_name: 'g' }, 1)).toContain('-Duser.language=en -Duser.country=US ann');
    expect(renderCommand(tool('snpeff-build'), { genome_name: 'g' }, 1)).toContain('-Duser.language=en -Duser.country=US build');
  });

  it('keeps the temporary snpEff config in the working folder so a relative database path resolves', () => {
    for (const id of ['snpeff-build', 'snpeff-annotate']) {
      const cmd = renderCommand(tool(id), { genome_name: 'my_genome' }, 1);
      expect(cmd, id).toContain('cfg=$(mktemp ./.snpeff_config.XXXXXX)');
      expect(cmd, id).toContain("printf '%s.genome : %s\\n' my_genome my_genome");
      expect(cmd, id).toContain('rm -f "$cfg"; exit $status');
    }
  });

  it('builds the snpEff database from the GTF without the checks that need CDS and protein files', () => {
    const cmd = renderCommand(tool('snpeff-build'), { genome_name: 'g' }, 1);
    expect(cmd).toContain('build -gtf22 -noCheckCds -noCheckProtein');
    expect(cmd).toContain('{database}g/sequences.fa');
    expect(cmd).toContain('{database}g/genes.gtf');
    expect(tool('snpeff-annotate').needs_database?.label).toBe('snpEff database');
  });

  it('turns the filter form into one include expression, and marks instead of removing when asked', () => {
    const t = tool('bcftools-filter');
    expect(renderCommand(t, {}, 2)).toBe(
      "bcftools filter --threads 2 -i 'QUAL>=20 && INFO/DP>=10' -Ov -o {filtered} {vcf}"
    );
    expect(renderCommand(t, { min_qual: 1500, min_depth: 30, mark_only: true }, 1)).toBe(
      "bcftools filter --threads 1 -s LowQuality -i 'QUAL>=1500 && INFO/DP>=30' -Ov -o {filtered} {vcf}"
    );
  });

  it('renders fractions exactly and keeps them inside their bounds', () => {
    const t = tool('freebayes');
    const fraction = t.params.find((p) => p.id === 'min_alt_fraction')!;
    expect(fraction.step).toBe(0.01);
    expect(renderCommand(t, { min_alt_fraction: 0.1 }, 1)).toContain('--min-alternate-fraction 0.1 ');
    expect(renderCommand(t, { min_alt_fraction: 7 }, 1)).toContain('--min-alternate-fraction 1 ');
    expect(renderCommand(t, {}, 1)).toContain('-f {ref} --ploidy 2 --min-alternate-fraction 0.05 --min-alternate-count 2');
    expect(renderCommand(t, {}, 1).endsWith('{bams} > {vcf}')).toBe(true);
  });

  it('checks that the BAM index is there before the tools that need it run', () => {
    expect(renderCommand(tool('mosdepth'), {}, 2).startsWith('test -s {bai} && mosdepth -t 2 --no-per-base --by 500')).toBe(true);
    expect(renderCommand(tool('gatk-haplotypecaller'), {}, 4).startsWith('test -s {bai} && gatk --java-options -Xmx2g HaplotypeCaller')).toBe(true);
    for (const id of ['mosdepth', 'gatk-haplotypecaller']) {
      const bai = tool(id).inputs.find((i) => i.name === 'bai')!;
      expect(bai.types, id).toEqual(['bai']);
      expect(bai.required, id).toBe(true);
    }
  });

  it('merges, counts depth and compresses with the options as form fields', () => {
    expect(renderCommand(tool('samtools-merge'), {}, 2)).toBe('samtools merge -f -@ 2 {merged} {bams}');
    expect(renderCommand(tool('samtools-merge'), { by_name: true }, 2)).toBe('samtools merge -f -@ 2 -n {merged} {bams}');
    expect(renderCommand(tool('samtools-depth'), { all_positions: true, min_mapq: 20 }, 1)).toBe(
      'samtools depth -a -q 0 -Q 20 -o {depth} {bams}'
    );
    expect(renderCommand(tool('bgzip'), {}, 2)).toBe('bgzip -c -@ 2 -l 6 {file} > {compressed}');
    expect(renderCommand(tool('tabix'), { preset: 'bed' }, 1)).toBe('cp {file} {index_dir}indexed.gz && tabix -f -p bed {index_dir}indexed.gz');
  });

  it('lets several steps feed the slots that take many files', () => {
    for (const [id, slot] of [
      ['samtools-merge', 'bams'],
      ['samtools-depth', 'bams'],
      ['freebayes', 'bams'],
    ]) {
      expect(tool(id).inputs.find((i) => i.name === slot)!.multiple, id).toBe(true);
    }
  });

  it('keeps the second read file of minimap2 optional, like BWA MEM', () => {
    expect(tool('minimap2').inputs.map((i) => `${i.name}${i.required ? '' : '?'}`)).toEqual(['ref', 'reads1', 'reads2?']);
  });
});

describe('connections between the new tools and the older ones', () => {
  const makes = (from: string, to: string) => checkConnection(tool(from), tool(to)).status;

  it('match by file type along the whole DNA-seq path', () => {
    for (const [from, to] of [
      ['minimap2', 'samtools-sort'],
      ['minimap2', 'samtools-markdup'],
      ['samtools-sort', 'picard-markduplicates'],
      ['picard-markduplicates', 'samtools-index'],
      ['picard-markduplicates', 'mosdepth'],
      ['samtools-index', 'mosdepth'],
      ['samtools-index', 'gatk-haplotypecaller'],
      ['samtools-sort', 'qualimap-bamqc'],
      ['samtools-sort', 'samtools-merge'],
      ['samtools-sort', 'samtools-depth'],
      ['samtools-sort', 'freebayes'],
      ['samtools-faidx', 'freebayes'],
      ['samtools-faidx', 'gatk-createsequencedictionary'],
      ['gatk-createsequencedictionary', 'gatk-haplotypecaller'],
      ['freebayes', 'bcftools-filter'],
      ['gatk-haplotypecaller', 'bcftools-norm'],
      ['bcftools-call', 'bcftools-stats'],
      ['bcftools-norm', 'bgzip'],
      ['bgzip', 'tabix'],
      ['freebayes', 'snpeff-annotate'],
      ['snpeff-build', 'snpeff-annotate'],
      ['bwa-index', 'bwa-mem'],
      ['bowtie2-build', 'bowtie2'],
      ['mosdepth', 'multiqc'],
      ['qualimap-bamqc', 'multiqc'],
    ]) {
      expect(makes(from, to), `${from} to ${to}`).toBe('match');
    }
  });

  it('flag a connection that cannot work', () => {
    expect(makes('bgzip', 'samtools-sort')).toBe('mismatch');
    expect(makes('snpeff-build', 'bwa-mem')).toBe('mismatch');
    expect(makes('mosdepth', 'bcftools-filter')).toBe('mismatch');
  });
});

describe('file types of the new outputs', () => {
  it('knows the extensions of index, dictionary, region and tabix files', () => {
    expect(typesOfPath('ref/reference.fa.fai')).toEqual(['fai']);
    expect(typesOfPath('gatk_reference/reference.dict')).toEqual(['dict']);
    expect(typesOfPath('regions.bed')).toEqual(['bed']);
    expect(typesOfPath('sample.regions.bed.gz')).toEqual(['bed']);
    expect(typesOfPath('variants.vcf.gz')).toEqual(['vcf']);
    expect(typesOfPath('variants.vcf.gz.tbi')).toEqual(['tbi']);
  });

  it('lists every one of them as a catalog file type', () => {
    for (const type of ['fai', 'dict', 'bed', 'tbi', 'database']) expect(CATALOG.file_types).toContain(type);
  });
});

describe('every catalog tool is run against the real tool', () => {
  it('is named in a domain of test-tools/chains and used by one of its chains', () => {
    const dir = path.resolve(__dirname, '../../../test-tools/chains');
    const sources = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.tools.ts'))
      .map((f) => fs.readFileSync(path.join(dir, f), 'utf8'))
      .join('\n');
    for (const t of CATALOG.tools) {
      expect(sources, `${t.id} has no real-tool chain: add one, or remove the entry`).toContain(`'${t.id}'`);
      expect(sources, `${t.id} is not used by any chain`).toMatch(new RegExp(`catalog: '${t.id}'`));
    }
  });
});
