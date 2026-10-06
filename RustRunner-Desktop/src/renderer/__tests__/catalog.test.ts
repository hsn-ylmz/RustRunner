import { describe, expect, it } from 'vitest';
import {
  CATALOG,
  ENGINE_PLACEHOLDERS,
  PARAM_TYPES,
  applyParamChange,
  buildCatalogNodeData,
  checkConnection,
  checkEdge,
  coerceNumber,
  defaultParams,
  findTool,
  missingRequiredParams,
  renderCommand,
  searchTools,
  shellQuote,
  templatePlaceholders,
  uniqueLabel,
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
  it('has a schema version, a catalog version and 12 to 15 tools', () => {
    expect(CATALOG.schemaVersion).toBe(1);
    expect(CATALOG.version).toMatch(/^\d{4}\.\d+\.\d+$/);
    expect(CATALOG.tools.length).toBeGreaterThanOrEqual(12);
    expect(CATALOG.tools.length).toBeLessThanOrEqual(15);
  });

  it('has unique tool ids made of lowercase letters, digits and dashes', () => {
    const ids = CATALOG.tools.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
  });

  it('has a unique, non-empty name for every tool', () => {
    const names = CATALOG.tools.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    for (const t of CATALOG.tools) expect(t.description.trim()).not.toBe('');
  });

  it('only uses declared file types, and declares each only once', () => {
    expect(new Set(CATALOG.fileTypes).size).toBe(CATALOG.fileTypes.length);
    for (const t of CATALOG.tools) {
      expect(t.inputTypes.length, `${t.id} input types`).toBeGreaterThan(0);
      expect(t.outputTypes.length, `${t.id} output types`).toBeGreaterThan(0);
      for (const type of [...t.inputTypes, ...t.outputTypes]) {
        expect(CATALOG.fileTypes, `${t.id} uses unknown type ${type}`).toContain(type);
      }
    }
  });

  it('puts every tool in a declared category with a colour', () => {
    for (const t of CATALOG.tools) {
      expect(Object.keys(CATALOG.categories), `${t.id} category`).toContain(t.category);
    }
    for (const [id, category] of Object.entries(CATALOG.categories)) {
      expect(category.label, id).not.toBe('');
      expect(isNodeColorId(category.color), `${id} colour ${category.color}`).toBe(true);
    }
  });

  it('names a bioconda package and a positive whole default thread count', () => {
    for (const t of CATALOG.tools) {
      expect(t.conda.package, t.id).toMatch(/^[a-z0-9][a-z0-9._-]*$/);
      expect(Number.isInteger(t.defaultThreads) && t.defaultThreads >= 1, t.id).toBe(true);
    }
  });

  it('defines every placeholder of every command template', () => {
    for (const t of CATALOG.tools) {
      const defined = new Set([...ENGINE_PLACEHOLDERS, 'threads', ...t.params.map((p) => p.id)]);
      for (const name of templatePlaceholders(t.command)) {
        expect(defined.has(name), `${t.id}: {${name}} is not defined`).toBe(true);
      }
    }
  });

  it('uses every parameter in its template, with unique ids and no reserved names', () => {
    for (const t of CATALOG.tools) {
      const ids = t.params.map((p) => p.id);
      expect(new Set(ids).size, `${t.id} param ids`).toBe(ids.length);
      const used = templatePlaceholders(t.command);
      for (const id of ids) {
        expect(id, t.id).toMatch(/^[a-z][a-z0-9_]*$/);
        expect([...ENGINE_PLACEHOLDERS, 'threads'], `${t.id}: ${id} is reserved`).not.toContain(id);
        expect(used, `${t.id}: ${id} is never used`).toContain(id);
      }
    }
  });

  it('gives every tool an input and an output path when its command needs them', () => {
    for (const t of CATALOG.tools) {
      const used = templatePlaceholders(t.command);
      expect(used, t.id).toContain('input');
      expect(t.defaultInput.trim(), `${t.id} default input`).not.toBe('');
      if (used.includes('output')) expect(t.defaultOutput.trim(), `${t.id} default output`).not.toBe('');
      // Plain file names: a `{...}` wildcard would need selected files to run.
      expect(t.defaultInput + t.defaultOutput).not.toMatch(/[{}]/);
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
            // A required parameter with a default is fine; one without must start empty.
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

  it('renders every default command with only the engine placeholders and required gaps left', () => {
    for (const t of CATALOG.tools) {
      const command = renderCommand(t, defaultParams(t), t.defaultThreads);
      const gaps = missingRequiredParams(t, defaultParams(t));
      for (const name of templatePlaceholders(command)) {
        expect(
          [...ENGINE_PLACEHOLDERS, ...gaps].includes(name),
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
});

describe('renderCommand', () => {
  it('fills threads and parameters but leaves {input} and {output} to the engine', () => {
    expect(renderCommand(tool('samtools-sort'), defaultParams(tool('samtools-sort')), 8)).toBe(
      'samtools sort -@ 8 -m 768M -o {output} {input}'
    );
  });

  it('renders an unticked flag as nothing and a ticked flag as its text', () => {
    const t = tool('samtools-sort');
    const on = renderCommand(t, { by_name: true, memory_per_thread: '2G' }, 2);
    expect(on).toBe('samtools sort -@ 2 -n -m 2G -o {output} {input}');
    const off = renderCommand(t, { by_name: false, memory_per_thread: '2G' }, 2);
    expect(off).toBe('samtools sort -@ 2 -m 2G -o {output} {input}');
  });

  it('keeps no double space when a flag at the end of a template is off', () => {
    const t = tool('featurecounts');
    const text = renderCommand(t, { ...defaultParams(t), annotation: 'genes.gtf', paired: true }, 4);
    expect(text).toContain('-g gene_id -p --countReadPairs -o {output}');
    expect(renderCommand(t, { ...defaultParams(t), annotation: 'genes.gtf', paired: false }, 4)).toContain(
      '-g gene_id -o {output}'
    );
  });

  it('renders a select value and ignores one that is not an option', () => {
    const t = tool('bowtie2');
    expect(renderCommand(t, { index: 'idx', preset: 'very-fast' }, 4)).toContain('--very-fast -x idx');
    expect(renderCommand(t, { index: 'idx', preset: 'rm -rf /' }, 4)).toContain('--sensitive -x idx');
  });

  it('shell-quotes string values that are not plain', () => {
    const t = tool('bwa-mem');
    const text = renderCommand(t, { ref: 'my genome; rm -rf ~.fa' }, 4);
    expect(text).toContain(" 'my genome; rm -rf ~.fa' ");
    expect(shellQuote("it's")).toBe(`'it'\\''s'`);
    expect(shellQuote('refs/hg38.fa')).toBe('refs/hg38.fa');
  });

  it('leaves the placeholder of an empty required parameter so the gap is visible', () => {
    const t = tool('bwa-mem');
    expect(renderCommand(t, defaultParams(t), 4)).toBe(
      'bwa mem -t 4 -M -k 19 {ref} {input} > {output}'
    );
    expect(renderCommand(t, { ref: '  ' }, 4)).toContain('{ref}');
    expect(renderCommand(t, { ref: 'hg38.fa' }, 4)).toBe(
      'bwa mem -t 4 -M -k 19 hg38.fa {input} > {output}'
    );
  });

  it('turns an unusable thread count into 1 and clamps numbers to their bounds', () => {
    const t = tool('samtools-index');
    expect(renderCommand(t, {}, '')).toBe('samtools index -@ 1 {input} {output}');
    expect(renderCommand(t, {}, 'abc')).toBe('samtools index -@ 1 {input} {output}');
    expect(renderCommand(t, {}, '6')).toBe('samtools index -@ 6 {input} {output}');

    const view = tool('samtools-view');
    expect(renderCommand(view, { min_mapq: 999, mapped_only: false }, 2)).toContain('-q 255 -o');
    expect(renderCommand(view, { min_mapq: -3, mapped_only: false }, 2)).toContain('-q 0 -o');
    expect(renderCommand(view, { min_mapq: '', mapped_only: false }, 2)).toContain('-q 20 -o');
    const param = view.params.find((p) => p.id === 'min_mapq')!;
    expect(coerceNumber(param, '37')).toBe(37);
  });

  it('does not expand placeholders inside a value', () => {
    const t = tool('bwa-mem');
    const text = renderCommand(t, { ref: '{threads}.fa' }, 4);
    expect(text).toContain("'{threads}.fa'");
  });

  it('falls back to defaults when parameters are missing (old or partial node data)', () => {
    const t = tool('fastp');
    expect(renderCommand(t, undefined, 4)).toBe(
      'fastp -i {input} -o {output} -w 4 -q 15 -l 15 --html fastp.html --json fastp.json'
    );
  });

  it('keeps a pipe command intact', () => {
    const t = tool('bcftools-call');
    const text = renderCommand(t, { ref: 'ref.fa', min_mapq: 30 }, 2);
    expect(text).toBe(
      'set -o pipefail; bcftools mpileup --threads 2 -Ou -f ref.fa -q 30 {input} | bcftools call --threads 2 -mv -Ov -o {output}'
    );
  });
});

describe('required parameters', () => {
  it('lists the empty required parameters', () => {
    expect(missingRequiredParams(tool('bwa-mem'), defaultParams(tool('bwa-mem')))).toEqual(['ref']);
    expect(missingRequiredParams(tool('bwa-mem'), { ref: 'a.fa' })).toEqual([]);
    expect(missingRequiredParams(tool('fastqc'), {})).toEqual([]);
  });

  it('reports catalog steps with a gap before a run, but not edited commands', () => {
    const gap = { id: 'n1', data: { label: 'BWA MEM', catalogId: 'bwa-mem', catalogParams: { ref: '' } } };
    expect(validateCatalogNodes([gap])).toEqual(['Step bwa_mem: fill in Reference FASTA']);

    const edited = { id: 'n2', data: { ...gap.data, catalogCommandCustom: true } };
    expect(validateCatalogNodes([edited])).toEqual([]);

    const filled = { id: 'n3', data: { ...gap.data, catalogParams: { ref: 'a.fa' } } };
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
    expect(searchTools('bwa').map((t) => t.id)).toEqual(['bwa-mem']);
  });

  it('finds tools by category id and by category label', () => {
    const byId = searchTools('alignment').map((t) => t.id);
    expect(byId).toEqual(expect.arrayContaining(['bwa-mem', 'bowtie2', 'star']));
    expect(searchTools('variant calling').map((t) => t.id)).toEqual(['bcftools-call']);
  });

  it('requires every word and can narrow by category', () => {
    expect(searchTools('samtools index').map((t) => t.id)).toEqual(['samtools-index']);
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
  it('prefills label, tool, command, threads, files and the parameter form', () => {
    const t = tool('fastqc');
    const data = buildCatalogNodeData(t, []);
    expect(data).toMatchObject({
      label: 'FastQC',
      tool: 'fastqc',
      command: 'mkdir -p qc && fastqc -t 2 --outdir qc {input}',
      input: 'reads.fastq.gz',
      output: 'qc/reads_fastqc.html',
      threads: 2,
      catalogId: 'fastqc',
      catalogParams: { outdir: 'qc' },
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

  it('becomes a normal engine step: the catalog fields never reach the YAML', () => {
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
      command: 'samtools sort -@ 4 -m 768M -o {output} {input}',
      input: ['aligned.sam'],
      output: ['sorted.bam'],
      previous: [],
      next: [],
      threads: 4,
    });
  });
});

describe('editing parameters re-renders the command', () => {
  const t = tool('samtools-sort');

  it('renders again when a parameter changes', () => {
    const data: Record<string, any> = buildCatalogNodeData(t, []);
    const patch = applyParamChange(t, data, {
      params: { ...data.catalogParams, memory_per_thread: '4G', by_name: true },
    });
    expect(patch.command).toBe('samtools sort -@ 4 -n -m 4G -o {output} {input}');
    expect(patch.catalogParams).toEqual({ memory_per_thread: '4G', by_name: true });
  });

  it('renders again when the thread count changes', () => {
    const data: Record<string, any> = buildCatalogNodeData(t, []);
    const patch = applyParamChange(t, data, { threads: '12' });
    expect(patch.command).toBe('samtools sort -@ 12 -m 768M -o {output} {input}');
    expect(patch).not.toHaveProperty('catalogParams');
  });

  it('keeps a command the user edited by hand, but still stores the parameters', () => {
    const data: Record<string, any> = {
      ...buildCatalogNodeData(t, []),
      command: 'samtools sort -T /scratch -o {output} {input}',
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

  it('is directional: sorted BAM into BWA would not match', () => {
    expect(checkConnection(tool('samtools-sort'), tool('bwa-mem')).status).toBe('mismatch');
  });

  it('works on a catalog passed in, so a newer catalog needs no code change', () => {
    const extra: Catalog = {
      ...CATALOG,
      tools: [
        ...CATALOG.tools,
        { ...tool('fastqc'), id: 'x', inputTypes: ['zip'], outputTypes: ['html'] },
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
    expect(cmd).toContain('--outdir qc');
    expect(cmd).not.toMatch(/ -o /);
  });

  it('star unpacks reads with gzip -cdf, never zcat (macOS zcat wants .Z files)', () => {
    const cmd = renderCommand(tool('star'), { genome_dir: 'idx' }, 4);
    expect(cmd).toContain('--readFilesCommand gzip -cdf');
    expect(cmd).not.toContain('zcat');
  });

  it('featurecounts counts read pairs when paired-end is ticked (-p alone counts reads)', () => {
    const on = renderCommand(tool('featurecounts'), { annotation: 'g.gtf', paired: true }, 1);
    expect(on).toContain('-p --countReadPairs');
    const off = renderCommand(tool('featurecounts'), { annotation: 'g.gtf', paired: false }, 1);
    expect(off).not.toContain('-p');
  });
});
