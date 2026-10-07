import { describe, expect, it } from 'vitest';
import {
  CATALOG,
  PARAM_TYPES,
  RESERVED_NAMES,
  applyParamChange,
  buildCatalogNodeData,
  catalogToolName,
  checkConnection,
  checkEdge,
  coerceNumber,
  defaultParams,
  findTool,
  inputTypesOf,
  installYaml,
  missingRequiredParams,
  outputTypesOf,
  renderCommand,
  searchTools,
  shellQuote,
  slotNames,
  templatePlaceholders,
  uniqueLabel,
  validateCatalog,
  validateCatalogNodes,
  type Catalog,
  type CatalogTool,
} from '../tools/catalog';
import { convertNodesToWorkflow } from '../workflowConversion';
import { isNodeColorId } from '../nodeColors';

const tool = (id: string): CatalogTool => {
  const found = findTool(id);
  if (!found) throw new Error(`catalog has no tool ${id}`);
  return found;
};

describe('catalog structure', () => {
  it('has schema version 2, a catalog version and 12 to 100 tools', () => {
    expect(CATALOG.schema_version).toBe(2);
    expect(CATALOG.version).toMatch(/^\d{4}\.\d+\.\d+$/);
    expect(CATALOG.tools.length).toBeGreaterThanOrEqual(12);
    expect(CATALOG.tools.length).toBeLessThanOrEqual(100);
  });

  it('passes the schema check (the same one the CI test uses on every future catalog)', () => {
    expect(validateCatalog(CATALOG)).toEqual([]);
  });

  it('has unique tool ids made of lowercase letters, digits and dashes', () => {
    const ids = CATALOG.tools.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
  });

  it('has a unique, non-empty name and description for every tool', () => {
    const names = CATALOG.tools.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    for (const t of CATALOG.tools) expect(t.description.trim()).not.toBe('');
  });

  it('only uses declared file types, and declares each only once', () => {
    expect(new Set(CATALOG.file_types).size).toBe(CATALOG.file_types.length);
    for (const t of CATALOG.tools) {
      expect(inputTypesOf(t).length, `${t.id} input types`).toBeGreaterThan(0);
      expect(outputTypesOf(t).length, `${t.id} output types`).toBeGreaterThan(0);
      for (const type of [...inputTypesOf(t), ...outputTypesOf(t)]) {
        if (type === 'any') continue;
        expect(CATALOG.file_types, `${t.id} uses unknown type ${type}`).toContain(type);
      }
    }
  });

  it('puts every tool in a declared category and a subcategory, with a colour for each category', () => {
    for (const t of CATALOG.tools) {
      expect(Object.keys(CATALOG.categories), `${t.id} category`).toContain(t.category);
      expect(t.subcategory.trim(), `${t.id} subcategory`).not.toBe('');
    }
    for (const [id, category] of Object.entries(CATALOG.categories)) {
      expect(category.label, id).not.toBe('');
      expect(isNodeColorId(category.color), `${id} colour ${category.color}`).toBe(true);
    }
  });

  it('pins every conda tool to one exact version and names a plain package', () => {
    for (const t of CATALOG.tools) {
      if (t.install.kind !== 'conda') continue;
      expect(t.install.package, t.id).toMatch(/^[a-z0-9][a-z0-9._-]*$/);
      expect(t.install.version, `${t.id} must be pinned`).toMatch(/^[0-9][A-Za-z0-9._+-]*$/);
      expect(t.install.channel, t.id).toBe('bioconda');
    }
  });

  it('pins STAR to 2.7.10b and installs the Intel build on Apple silicon', () => {
    const star = tool('star');
    expect(star.install).toMatchObject({ kind: 'conda', package: 'star', version: '2.7.10b', osx64: true });
  });

  it('gives every tool a positive whole default thread count and an https docs link', () => {
    for (const t of CATALOG.tools) {
      expect(Number.isInteger(t.threads) && t.threads >= 1, t.id).toBe(true);
      expect(t.docs, t.id).toMatch(/^https:\/\//);
    }
  });

  it('defines every placeholder of every command template and uses every slot and option', () => {
    for (const t of CATALOG.tools) {
      const defined = new Set(['threads', ...slotNames(t), ...t.params.map((p) => p.id)]);
      const used = templatePlaceholders(t.command);
      for (const name of used) expect(defined.has(name), `${t.id}: {${name}} is not defined`).toBe(true);
      for (const p of t.params) expect(used, `${t.id}: ${p.id} is never used`).toContain(p.id);
      for (const slot of [...t.inputs, ...t.outputs]) {
        if ('derived' in slot && slot.derived) continue;
        expect(used, `${t.id}: ${slot.name} is never used`).toContain(slot.name);
      }
    }
  });

  it('names slots plainly, uniquely and never like an engine placeholder or an option', () => {
    for (const t of CATALOG.tools) {
      const names = slotNames(t);
      expect(new Set(names).size, `${t.id} slot names`).toBe(names.length);
      for (const name of names) {
        const where = `${t.id}.${name}`;
        expect(name, where).toMatch(/^[a-z][a-z0-9_]*$/);
        expect(name.length, where).toBeLessThanOrEqual(40);
        expect(RESERVED_NAMES, `${where} is reserved`).not.toContain(name);
        expect(t.params.map((p) => p.id), `${where} is also an option`).not.toContain(name);
      }
      for (const slot of [...t.inputs, ...t.outputs]) {
        expect(slot.label.trim(), `${t.id}.${slot.name}`).not.toBe('');
        expect(slot.description.trim(), `${t.id}.${slot.name}`).not.toBe('');
      }
    }
  });

  it('gives every output a file name pattern (a folder ends in a slash) or a derived rule', () => {
    for (const t of CATALOG.tools) {
      for (const out of t.outputs) {
        const where = `${t.id}.${out.name}`;
        if (out.derived) {
          expect(out.pattern, where).toBeUndefined();
          const source = t.outputs.find((o) => o.name === out.derived!.from);
          expect(source, `${where} follows an output of the same tool`).toBeDefined();
          expect(source!.derived, `${where} follows a derived output`).toBeUndefined();
        } else {
          expect(out.pattern!.endsWith('/'), where).toBe(out.is_dir);
          expect(out.pattern, where).not.toMatch(/[{}\s]/);
        }
      }
    }
  });

  it('makes tools take their reads and references through input slots, not a main Input', () => {
    for (const t of CATALOG.tools) {
      const used = templatePlaceholders(t.command);
      expect(used, t.id).not.toContain('input');
      expect(used, t.id).not.toContain('output');
      expect(t.inputs.length, t.id).toBeGreaterThan(0);
    }
  });

  it('describes every parameter with a known type and a valid default', () => {
    for (const t of CATALOG.tools) {
      for (const p of t.params) {
        const where = `${t.id}.${p.id}`;
        expect(PARAM_TYPES, where).toContain(p.type);
        expect(p.label.trim(), where).not.toBe('');
        expect(p.description.trim(), where).not.toBe('');
        switch (p.type) {
          case 'number':
            expect(typeof p.default, where).toBe('number');
            if (p.min !== undefined) expect(p.default as number, where).toBeGreaterThanOrEqual(p.min);
            if (p.max !== undefined) expect(p.default as number, where).toBeLessThanOrEqual(p.max);
            break;
          case 'string':
            expect(typeof p.default, where).toBe('string');
            break;
          case 'boolean':
            expect(typeof p.default, where).toBe('boolean');
            expect(p.flag?.trim(), `${where} needs a flag`).toBeTruthy();
            break;
          case 'select':
            expect(p.options?.length, `${where} options`).toBeGreaterThan(1);
            expect(p.options, where).toContain(p.default);
            break;
        }
      }
    }
  });

  it('renders every default command with only the file slots and required gaps left', () => {
    for (const t of CATALOG.tools) {
      const command = renderCommand(t, defaultParams(t), t.threads);
      const gaps = missingRequiredParams(t, defaultParams(t));
      for (const name of templatePlaceholders(command)) {
        expect(
          [...slotNames(t), ...gaps].includes(name),
          `${t.id}: {${name}} left in "${command}"`
        ).toBe(true);
      }
      expect(command, t.id).not.toMatch(/ {2}/);
      expect(command, t.id).toBe(command.trim());
    }
  });

  it('covers the tools the roadmap asks for', () => {
    const ids = CATALOG.tools.map((t) => t.id);
    for (const id of [
      'fastqc',
      'multiqc',
      'fastp',
      'bwa-mem',
      'bowtie2',
      'samtools-sort',
      'samtools-index',
      'samtools-view',
      'bcftools-call',
      'star',
      'salmon-quant',
      'featurecounts',
    ]) {
      expect(ids).toContain(id);
    }
  });

  it('migrates the 14 version 1 tools: cutadapt and samtools flagstat are still there', () => {
    const ids = CATALOG.tools.map((t) => t.id);
    expect(ids).toEqual(expect.arrayContaining(['cutadapt', 'samtools-flagstat']));
  });

  it('describes the files of the tools the migration brief names', () => {
    const inputs = (id: string) => tool(id).inputs.map((s) => `${s.name}${s.required ? '' : '?'}${s.multiple ? '*' : ''}`);
    expect(inputs('bwa-mem')).toEqual(['ref', 'reads1', 'reads2?']);
    expect(inputs('featurecounts')).toEqual(['bams*', 'annotation']);
    expect(inputs('salmon-quant')).toEqual(['index', 'reads']);
    expect(inputs('star')).toEqual(['index', 'reads', 'reads2?']);
    expect(inputs('bcftools-call')).toEqual(['ref', 'bam']);
    expect(inputs('multiqc')).toEqual(['reports*']);
    expect(tool('multiqc').inputs[0].types).toEqual(['any']);
  });
});

describe('renderCommand', () => {
  it('fills threads and parameters but leaves the file slots to the engine', () => {
    expect(renderCommand(tool('samtools-sort'), defaultParams(tool('samtools-sort')), 8)).toBe(
      'samtools sort -@ 8 -m 768M -o {bam} {alignments}'
    );
  });

  it('renders an unticked flag as nothing and a ticked flag as its text', () => {
    const t = tool('samtools-sort');
    const on = renderCommand(t, { by_name: true, memory_per_thread: '2G' }, 2);
    expect(on).toBe('samtools sort -@ 2 -n -m 2G -o {bam} {alignments}');
    const off = renderCommand(t, { by_name: false, memory_per_thread: '2G' }, 2);
    expect(off).toBe('samtools sort -@ 2 -m 2G -o {bam} {alignments}');
  });

  it('keeps no double space when a flag at the end of a template is off', () => {
    const t = tool('featurecounts');
    const text = renderCommand(t, { ...defaultParams(t), paired: true }, 4);
    expect(text).toContain('-g gene_id -p --countReadPairs -o {counts}');
    expect(renderCommand(t, { ...defaultParams(t), paired: false }, 4)).toContain(
      '-g gene_id -o {counts}'
    );
  });

  it('renders a select value and ignores one that is not an option', () => {
    const t = tool('bowtie2');
    expect(renderCommand(t, { preset: 'very-fast' }, 4)).toContain('--very-fast -x {index}');
    expect(renderCommand(t, { preset: 'rm -rf /' }, 4)).toContain('--sensitive -x {index}');
  });

  it('shell-quotes string values that are not plain', () => {
    const t = tool('cutadapt');
    const text = renderCommand(t, { adapter: 'AGAT; rm -rf ~' }, 4);
    expect(text).toContain(" -a 'AGAT; rm -rf ~' ");
    expect(shellQuote("it's")).toBe(`'it'\\''s'`);
    expect(shellQuote('refs/hg38.fa')).toBe('refs/hg38.fa');
  });

  it('leaves the placeholder of an empty required parameter so the gap is visible', () => {
    const t = tool('cutadapt');
    expect(renderCommand(t, defaultParams(t), 4)).toContain('-a AGATCGGAAGAGC ');
    expect(renderCommand(t, { adapter: '  ' }, 4)).toContain('-a {adapter} ');
    // A read group is always written (GATK and Picard need one); an emptied name leaves the gap visible.
    expect(renderCommand(tool('bwa-mem'), defaultParams(tool('bwa-mem')), 4)).toBe(
      'sample=sample; bwa mem -t 4 -M -k 19 -R "@RG\\tID:$sample\\tSM:$sample" {ref} {reads1} {reads2} > {sam}'
    );
    expect(renderCommand(tool('bwa-mem'), { sample_name: '' }, 4)).toContain('sample={sample_name};');
  });

  it('turns an unusable thread count into 1 and clamps numbers to their bounds', () => {
    const t = tool('samtools-index');
    expect(renderCommand(t, {}, '')).toBe('samtools index -@ 1 {bam} {bai}');
    expect(renderCommand(t, {}, 'abc')).toBe('samtools index -@ 1 {bam} {bai}');
    expect(renderCommand(t, {}, '6')).toBe('samtools index -@ 6 {bam} {bai}');

    const view = tool('samtools-view');
    expect(renderCommand(view, { min_mapq: 999, mapped_only: false }, 2)).toContain('-q 255 -o');
    expect(renderCommand(view, { min_mapq: -3, mapped_only: false }, 2)).toContain('-q 0 -o');
    expect(renderCommand(view, { min_mapq: '', mapped_only: false }, 2)).toContain('-q 20 -o');
    const param = view.params.find((p) => p.id === 'min_mapq')!;
    expect(coerceNumber(param, '37')).toBe(37);
  });

  it('does not expand placeholders inside a value', () => {
    const t = tool('cutadapt');
    const text = renderCommand(t, { adapter: '{threads}' }, 4);
    expect(text).toContain("-a '{threads}' ");
  });

  it('falls back to defaults when parameters are missing (old or partial node data)', () => {
    const t = tool('fastp');
    expect(renderCommand(t, undefined, 4)).toBe(
      'fastp -i {reads} -o {trimmed} -w 4 -q 15 -l 15 --html {html_report} --json {json_report}'
    );
  });

  it('keeps a pipe command intact', () => {
    const t = tool('bcftools-call');
    const text = renderCommand(t, { min_mapq: 30 }, 2);
    expect(text).toBe(
      'set -o pipefail; bcftools mpileup --threads 2 -Ou -f {ref} -q 30 {bam} | bcftools call --threads 2 -mv -Ov -o {vcf}'
    );
  });
});

describe('required parameters', () => {
  it('lists the empty required parameters', () => {
    expect(missingRequiredParams(tool('cutadapt'), defaultParams(tool('cutadapt')))).toEqual([]);
    expect(missingRequiredParams(tool('cutadapt'), { adapter: '' })).toEqual(['adapter']);
    expect(missingRequiredParams(tool('cutadapt'), { adapter: 'AGAT' })).toEqual([]);
    expect(missingRequiredParams(tool('fastqc'), {})).toEqual([]);
  });

  it('reports catalog steps with a gap before a run, but not edited commands', () => {
    const gap = { id: 'n1', data: { label: 'Cutadapt', catalogId: 'cutadapt', catalogParams: { adapter: '' } } };
    expect(validateCatalogNodes([gap])).toEqual(["Step cutadapt: fill in 3' adapter sequence"]);

    const edited = { id: 'n2', data: { ...gap.data, catalogCommandCustom: true } };
    expect(validateCatalogNodes([edited])).toEqual([]);

    const filled = { id: 'n3', data: { ...gap.data, catalogParams: { adapter: 'AGAT' } } };
    expect(validateCatalogNodes([filled])).toEqual([]);

    const free = { id: 'n4', data: { label: 'Custom', tool: 'bash' } };
    expect(validateCatalogNodes([free])).toEqual([]);
  });
});

describe('search', () => {
  it('returns every tool for an empty query', () => {
    expect(searchTools('')).toHaveLength(CATALOG.tools.length);
  });

  it('finds tools by name, ignoring case', () => {
    expect(searchTools('FASTQC').map((t) => t.id)).toEqual(['fastqc']);
    expect(searchTools('bwa').map((t) => t.id)).toEqual(['bwa-index', 'bwa-mem']);
  });

  it('finds tools by category id and by category label', () => {
    const byId = searchTools('alignment').map((t) => t.id);
    expect(byId).toEqual(expect.arrayContaining(['bwa-mem', 'bowtie2', 'star']));
    expect(searchTools('variant calling').map((t) => t.id)).toEqual(
      expect.arrayContaining(['bcftools-call', 'freebayes', 'gatk-haplotypecaller'])
    );
    expect(searchTools('variant calling').map((t) => t.id)).not.toContain('bwa-mem');
  });

  it('requires every word and can narrow by category', () => {
    expect(searchTools('samtools index').map((t) => t.id)).toEqual(['samtools-faidx', 'samtools-index']);
    expect(searchTools('samtools index', 'processing').map((t) => t.id)).toEqual(['samtools-index']);
    expect(searchTools('zzz')).toEqual([]);
    const processing = searchTools('', 'processing').map((t) => t.id);
    expect(processing).toEqual(expect.arrayContaining(['samtools-sort', 'samtools-index']));
    expect(processing).not.toContain('fastqc');
    expect(searchTools('bwa', 'qc')).toEqual([]);
  });

  it('finds a tool by its conda package', () => {
    expect(searchTools('subread').map((t) => t.id)).toEqual(['featurecounts']);
  });
});

describe('new catalog nodes', () => {
  it('prefills label, tool, command, threads, output names and the parameter form', () => {
    const t = tool('fastqc');
    const data = buildCatalogNodeData(t, []);
    expect(data).toMatchObject({
      label: 'FastQC',
      tool: 'fastqc',
      command: 'fastqc -t 2 --outdir {report_dir} {reads}',
      input: '',
      output: '',
      threads: 2,
      catalogId: 'fastqc',
      catalogSchema: 2,
      catalogParams: {},
      slotFiles: { report_dir: 'qc/' },
    });
    expect(data.color).toBe(CATALOG.categories[t.category].color);
  });

  it('uses the conda package as the tool, so samtools steps share one environment', () => {
    expect(buildCatalogNodeData(tool('samtools-sort'), []).tool).toBe('samtools');
    expect(buildCatalogNodeData(tool('samtools-index'), []).tool).toBe('samtools');
    expect(buildCatalogNodeData(tool('featurecounts'), []).tool).toBe('subread');
    expect(buildCatalogNodeData(tool('star'), []).tool).toBe('star');
  });

  it('numbers the label when the name is taken, ignoring case and punctuation', () => {
    expect(uniqueLabel('FastQC', ['fastqc'])).toBe('FastQC 2');
    expect(uniqueLabel('FastQC', ['fastqc', 'FastQC 2'])).toBe('FastQC 3');
    expect(uniqueLabel('FastQC', ['Node 1'])).toBe('FastQC');
    expect(buildCatalogNodeData(tool('fastqc'), ['FastQC']).label).toBe('FastQC 2');
  });

  it('starts every output slot with its default name, but not the derived ones', () => {
    expect(buildCatalogNodeData(tool('star'), []).slotFiles).toEqual({ out_dir: 'star/' });
    expect(buildCatalogNodeData(tool('fastp'), []).slotFiles).toEqual({
      trimmed: 'trimmed.fastq.gz',
      html_report: 'fastp.html',
      json_report: 'fastp.json',
    });
  });

  it('becomes a normal engine step: only the install block and the file slots are added', () => {
    const data = buildCatalogNodeData(tool('samtools-sort'), []);
    const workflow = convertNodesToWorkflow(
      [{ id: 'n1', position: { x: 0, y: 0 }, data }],
      [],
      {},
      {}
    );
    expect(workflow.steps[0]).toEqual({
      id: 'samtools_sort',
      tool: 'samtools',
      command: 'samtools sort -@ 4 -m 768M -o {bam} {alignments}',
      input: [],
      output: [],
      previous: [],
      next: [],
      threads: 4,
      install: { kind: 'conda', package: 'samtools', version: '1.24', channel: 'bioconda' },
      named_inputs: { alignments: [] },
      named_outputs: { bam: ['sorted.bam'] },
    });
  });

  it('writes the install block, with the Intel flag only where the catalog sets it', () => {
    const star = convertNodesToWorkflow(
      [{ id: 'n1', position: { x: 0, y: 0 }, data: buildCatalogNodeData(tool('star'), []) }],
      [],
      {},
      {}
    ).steps[0];
    expect(star.install).toEqual({
      kind: 'conda',
      package: 'star',
      version: '2.7.10b',
      channel: 'bioconda',
      osx64: true,
    });
    expect(installYaml(tool('bwa-mem').install)).not.toHaveProperty('osx64');
  });

  it('writes no install block once the Tool field was edited away from the catalog', () => {
    const data = { ...buildCatalogNodeData(tool('fastqc'), []), tool: 'my-own-fastqc' };
    const step = convertNodesToWorkflow([{ id: 'n1', position: { x: 0, y: 0 }, data }], [], {}, {}).steps[0];
    expect(step).not.toHaveProperty('install');
  });

  it('marks optional inputs for the engine so an empty second read file is fine', () => {
    const data = buildCatalogNodeData(tool('bwa-mem'), []);
    const step = convertNodesToWorkflow([{ id: 'n1', position: { x: 0, y: 0 }, data }], [], {}, {}).steps[0];
    expect(step.optional_slots).toEqual(['reads2']);
    expect(step.named_inputs.reads2).toEqual([]);
  });
});

describe('editing parameters re-renders the command', () => {
  const t = tool('samtools-sort');

  it('renders again when a parameter changes', () => {
    const data: Record<string, any> = buildCatalogNodeData(t, []);
    const patch = applyParamChange(t, data, {
      params: { ...data.catalogParams, memory_per_thread: '4G', by_name: true },
    });
    expect(patch.command).toBe('samtools sort -@ 4 -n -m 4G -o {bam} {alignments}');
    expect(patch.catalogParams).toEqual({ memory_per_thread: '4G', by_name: true });
  });

  it('renders again when the thread count changes', () => {
    const data: Record<string, any> = buildCatalogNodeData(t, []);
    const patch = applyParamChange(t, data, { threads: '12' });
    expect(patch.command).toBe('samtools sort -@ 12 -m 768M -o {bam} {alignments}');
    expect(patch).not.toHaveProperty('catalogParams');
  });

  it('keeps a command the user edited by hand, but still stores the parameters', () => {
    const data: Record<string, any> = {
      ...buildCatalogNodeData(t, []),
      command: 'samtools sort -T /scratch -o {bam} {alignments}',
      catalogCommandCustom: true,
    };
    const patch = applyParamChange(t, data, { params: { by_name: true, memory_per_thread: '1G' } });
    expect(patch).not.toHaveProperty('command');
    expect(patch.catalogParams).toEqual({ by_name: true, memory_per_thread: '1G' });
  });
});

describe('file type matching', () => {
  it('matches when an output type is accepted as an input type', () => {
    const check = checkConnection(tool('bwa-mem'), tool('samtools-sort'));
    expect(check.status).toBe('match');
    expect(check.shared).toEqual(['sam']);
    expect(check.message).toContain('sam');
  });

  it('matches a longer chain: sort, then index, then call', () => {
    expect(checkConnection(tool('samtools-sort'), tool('samtools-index')).status).toBe('match');
    expect(checkConnection(tool('samtools-sort'), tool('bcftools-call')).status).toBe('match');
    expect(checkConnection(tool('fastqc'), tool('multiqc')).status).toBe('match');
    expect(checkConnection(tool('fastp'), tool('bwa-mem')).status).toBe('match');
    expect(checkConnection(tool('star'), tool('featurecounts')).status).toBe('match');
  });

  it('reports a mismatch with both sides named, and says it does not block', () => {
    const check = checkConnection(tool('fastqc'), tool('samtools-sort'));
    expect(check.status).toBe('mismatch');
    expect(check.shared).toEqual([]);
    expect(check.message).toContain('FastQC');
    expect(check.message).toContain('samtools sort');
    expect(check.message).toContain('still works');
    expect(check.made).toEqual(outputTypesOf(tool('fastqc')));
    expect(check.expected).toEqual(inputTypesOf(tool('samtools-sort')));
    expect(checkConnection(tool('bwa-mem'), tool('samtools-index')).status).toBe('mismatch');
  });

  it('stays neutral when either end is not a catalog tool', () => {
    expect(checkConnection(undefined, tool('samtools-sort')).status).toBe('unknown');
    expect(checkConnection(tool('bwa-mem'), undefined).status).toBe('unknown');
    expect(checkConnection(undefined, undefined).status).toBe('unknown');
  });

  it('looks the ends of an edge up from the nodes, and ignores unknown catalog ids', () => {
    const nodes = [
      { id: 'a', data: { catalogId: 'bwa-mem' } },
      { id: 'b', data: { catalogId: 'samtools-sort' } },
      { id: 'c', data: { tool: 'bash' } },
      { id: 'd', data: { catalogId: 'removed-from-catalog' } },
    ];
    expect(checkEdge({ source: 'a', target: 'b' }, nodes).status).toBe('match');
    expect(checkEdge({ source: 'a', target: 'c' }, nodes).status).toBe('unknown');
    expect(checkEdge({ source: 'd', target: 'b' }, nodes).status).toBe('unknown');
    expect(checkEdge({ source: 'a', target: 'missing' }, nodes).status).toBe('unknown');
  });

  it('lets an input that takes any file (MultiQC) accept every tool', () => {
    for (const source of ['fastp', 'cutadapt', 'samtools-flagstat', 'star', 'salmon-quant']) {
      expect(checkConnection(tool(source), tool('multiqc')).status, source).toBe('match');
    }
  });

  it('is directional: sorted BAM into BWA would not match', () => {
    expect(checkConnection(tool('samtools-sort'), tool('bwa-mem')).status).toBe('mismatch');
  });

  it('works on a catalog passed in, so a newer catalog needs no code change', () => {
    const extra: Catalog = {
      ...CATALOG,
      tools: [
        ...CATALOG.tools,
        { ...tool('fastqc'), id: 'x', name: 'Extra' },
      ],
    };
    expect(findTool('x', extra)).toBeDefined();
    expect(findTool('x')).toBeUndefined();
  });
});

// Regressions found by running every entry against the real tool (`npm run test:tools`).
describe('flags verified against the real tools', () => {
  it('fastqc uses --outdir (FastQC 0.13 dropped -o)', () => {
    const cmd = renderCommand(tool('fastqc'), {}, 2);
    expect(cmd).toContain('--outdir {report_dir}');
    expect(cmd).not.toMatch(/ -o /);
  });

  it('star unpacks reads with gzip -cdf, never zcat (macOS zcat wants .Z files)', () => {
    const cmd = renderCommand(tool('star'), {}, 4);
    expect(cmd).toContain('--readFilesCommand gzip -cdf');
    expect(cmd).not.toContain('zcat');
  });

  it('featurecounts counts read pairs when paired-end is ticked (-p alone counts reads)', () => {
    const on = renderCommand(tool('featurecounts'), { paired: true }, 1);
    expect(on).toContain('-p --countReadPairs');
    const off = renderCommand(tool('featurecounts'), { paired: false }, 1);
    expect(off).not.toContain('-p');
  });
});
