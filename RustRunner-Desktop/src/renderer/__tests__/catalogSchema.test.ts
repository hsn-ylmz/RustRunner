/**
 * The catalog schema (v2) as a gate: `validateCatalog` accepts the bundled
 * catalog and rejects each way a catalog entry can be wrong. Every future tool
 * added to `catalog.json` passes through the same checks, so a typo in a
 * placeholder, an unpinned conda version or a duplicate id fails here, not
 * when a biologist clicks Run.
 */

import { describe, expect, it } from 'vitest';
import { CATALOG, installYaml, validateCatalog, type Catalog, type CatalogTool } from '../tools/catalog';

/** A deep copy of the bundled catalog that a test may break. */
function copy(): any {
  return JSON.parse(JSON.stringify(CATALOG));
}

const tool = (catalog: any, id: string): any => catalog.tools.find((t: any) => t.id === id);

const errorsOf = (catalog: unknown) => validateCatalog(catalog).join('\n');

const SHA = 'a'.repeat(64);

describe('the bundled catalog', () => {
  it('is valid', () => {
    expect(validateCatalog(CATALOG)).toEqual([]);
  });

  it('has the version-2 shape: install, slots, params, command, threads, docs on every tool', () => {
    for (const t of CATALOG.tools as CatalogTool[]) {
      expect(['conda', 'external', 'system'], t.id).toContain(t.install.kind);
      expect(Array.isArray(t.inputs), t.id).toBe(true);
      expect(Array.isArray(t.outputs), t.id).toBe(true);
      expect(Array.isArray(t.params), t.id).toBe(true);
      expect(typeof t.command, t.id).toBe('string');
      expect(typeof t.threads, t.id).toBe('number');
      expect(typeof t.docs, t.id).toBe('string');
      for (const input of t.inputs) {
        expect(typeof input.required, `${t.id}.${input.name}`).toBe('boolean');
        expect(typeof input.multiple, `${t.id}.${input.name}`).toBe('boolean');
      }
      for (const output of t.outputs) expect(typeof output.is_dir, `${t.id}.${output.name}`).toBe('boolean');
    }
  });
});

describe('catalog-level rules', () => {
  it('rejects a catalog that is not version 2', () => {
    const c = copy();
    c.schema_version = 1;
    expect(errorsOf(c)).toContain('schema_version must be 2');
    expect(errorsOf(null)).toContain('not an object');
  });

  it('rejects duplicate tool ids and duplicate names', () => {
    const c = copy();
    c.tools.push({ ...tool(c, 'fastqc') });
    const text = errorsOf(c);
    expect(text).toContain('fastqc: duplicate tool id');
    expect(text).toContain('another tool has the name FastQC');
  });

  it('rejects an unknown category and a missing subcategory', () => {
    const c = copy();
    tool(c, 'fastqc').category = 'nonsense';
    delete tool(c, 'fastqc').subcategory;
    const text = errorsOf(c);
    expect(text).toContain('fastqc: category is not one of the catalog');
    expect(text).toContain('fastqc: needs a subcategory');
  });

  it('rejects a repeated file type and the reserved name "any" as a file type', () => {
    const c = copy();
    c.file_types.push('fastq', 'any');
    const text = errorsOf(c);
    expect(text).toContain('file_types has a repeat');
    expect(text).toContain('"any" is reserved');
  });

  it('rejects a docs link that is not https and a bad thread count', () => {
    const c = copy();
    tool(c, 'fastqc').docs = 'http://example.org';
    tool(c, 'fastp').threads = 0;
    const text = errorsOf(c);
    expect(text).toContain('fastqc: docs must be an https:// link');
    expect(text).toContain('fastp: threads must be a whole number');
  });

  it('checks the optional needs_database block', () => {
    const c = copy();
    tool(c, 'fastqc').needs_database = { label: 'Kraken2 database', hint: 'About 50 GB. Download it from the Kraken2 site.' };
    expect(validateCatalog(c)).toEqual([]);
    tool(c, 'fastqc').needs_database = { label: 'Kraken2 database' };
    expect(errorsOf(c)).toContain('needs_database needs a label and a hint');
  });
});

describe('install rules', () => {
  it('requires every conda tool to be pinned to one exact version', () => {
    for (const bad of [undefined, '', '1.*', '>=1.2', '1.2,1.3', '=1.2', 'latest', '1.2 ']) {
      const c = copy();
      if (bad === undefined) delete tool(c, 'samtools-sort').install.version;
      else tool(c, 'samtools-sort').install.version = bad;
      expect(errorsOf(c), String(bad)).toContain('samtools-sort: conda version must be pinned');
    }
  });

  it('requires a plain package and channel name', () => {
    const c = copy();
    tool(c, 'fastqc').install.package = 'fast qc; rm';
    tool(c, 'fastqc').install.channel = '';
    const text = errorsOf(c);
    expect(text).toContain('conda package must be a plain package name');
    expect(text).toContain('conda channel must be a plain channel name');
  });

  it('only accepts true or false for the osx64 flag', () => {
    const c = copy();
    tool(c, 'star').install.osx64 = 'yes';
    expect(errorsOf(c)).toContain('osx64 must be true or false');
  });

  it('rejects an unknown install kind', () => {
    const c = copy();
    tool(c, 'fastqc').install = { kind: 'docker', image: 'x' };
    expect(errorsOf(c)).toContain('install kind must be conda, external or system');
    delete tool(c, 'fastqc').install;
    expect(errorsOf(c)).toContain('install is missing');
  });

  it('accepts an external tool with a download and a checksum per platform', () => {
    const c = copy();
    tool(c, 'fastqc').install = {
      kind: 'external',
      binary: 'fastqc',
      version: '1.0.0',
      url: { 'linux-64': 'https://example.org/v{version}/t.tgz', 'osx-arm64': 'https://example.org/v{version}/t-mac.tgz' },
      sha256: { 'linux-64': SHA, 'osx-arm64': 'b'.repeat(64) },
      license: 'MIT',
    };
    expect(validateCatalog(c)).toEqual([]);
    expect(installYaml(tool(c, 'fastqc').install)).toMatchObject({ kind: 'external', binary: 'fastqc' });
  });

  it('rejects external installs without a checksum, over plain http, or for an unknown platform', () => {
    const base = () => ({
      kind: 'external',
      binary: 'tool',
      version: '1.0',
      url: { 'linux-64': 'https://example.org/t' },
      sha256: { 'linux-64': SHA },
      license: 'MIT',
    });
    const check = (patch: (i: any) => void, expected: string) => {
      const c = copy();
      const install: any = base();
      patch(install);
      tool(c, 'fastqc').install = install;
      expect(errorsOf(c), expected).toContain(expected);
    };
    check((i) => delete i.sha256['linux-64'], 'needs a 64-character lower-case sha256');
    check((i) => (i.sha256['linux-64'] = 'abc'), 'needs a 64-character lower-case sha256');
    check((i) => (i.url['linux-64'] = 'http://example.org/t'), 'must be an https:// address');
    check((i) => (i.url['plan9'] = 'https://example.org/t'), 'unknown platform plan9');
    check((i) => (i.url = {}), 'needs a download url per platform');
    check((i) => (i.binary = '../x'), 'binary must be a file name without folders');
    check((i) => delete i.license, 'needs a license note');
    check((i) => (i.sha256['osx-64'] = SHA), 'sha256 given for osx-64 without a url');
  });

  it('accepts a system tool and rejects one with a path', () => {
    const c = copy();
    tool(c, 'fastqc').install = { kind: 'system', binary: 'fastqc' };
    expect(validateCatalog(c)).toEqual([]);
    tool(c, 'fastqc').install = { kind: 'system', binary: '/usr/bin/fastqc' };
    expect(errorsOf(c)).toContain('system binary must be a program name');
  });
});

describe('slot rules', () => {
  it('rejects a placeholder that nothing defines', () => {
    const c = copy();
    tool(c, 'samtools-sort').command += ' {typo}';
    expect(errorsOf(c)).toContain('samtools-sort: {typo} in the command is not defined');
  });

  it('rejects the old {input} and {output} placeholders, since every file is a slot now', () => {
    const c = copy();
    tool(c, 'samtools-sort').command = 'samtools sort -o {output} {input}';
    const text = errorsOf(c);
    expect(text).toContain('{input} in the command is not defined');
    expect(text).toContain('{output} in the command is not defined');
  });

  it('rejects a slot or an option the command never uses', () => {
    const c = copy();
    tool(c, 'samtools-sort').command = 'samtools sort -@ {threads} -o {bam} {alignments}';
    expect(errorsOf(c)).toContain('parameter by_name is never used');
    const d = copy();
    tool(d, 'samtools-sort').command = 'samtools sort -@ {threads} {by_name} -m {memory_per_thread} {alignments}';
    expect(errorsOf(d)).toContain('slot bam is never used');
  });

  it('does not ask for a derived output to appear in the command', () => {
    expect(tool(copy(), 'star').outputs.some((o: any) => o.derived)).toBe(true);
    expect(validateCatalog(copy())).toEqual([]);
  });

  it('rejects types outside the declared set, and "any" on an output', () => {
    const c = copy();
    tool(c, 'samtools-sort').inputs[0].types = ['bam', 'cram'];
    tool(c, 'samtools-sort').outputs[0].types = ['any'];
    const text = errorsOf(c);
    expect(text).toContain('samtools-sort.alignments: unknown file type cram');
    expect(text).toContain('samtools-sort.bam: unknown file type any');
  });

  it('rejects a slot with no types, no label or no description', () => {
    const c = copy();
    const slot = tool(c, 'samtools-sort').inputs[0];
    slot.types = [];
    slot.label = '';
    delete slot.description;
    const text = errorsOf(c);
    expect(text).toContain('needs at least one file type');
    expect(text).toContain('needs a label');
    expect(text).toContain('needs a description');
  });

  it('requires required and multiple to be true or false', () => {
    const c = copy();
    delete tool(c, 'samtools-sort').inputs[0].required;
    tool(c, 'samtools-sort').inputs[0].multiple = 'no';
    const text = errorsOf(c);
    expect(text).toContain('required must be true or false');
    expect(text).toContain('multiple must be true or false');
  });

  it('rejects duplicate slot names, reserved names and a slot named like an option', () => {
    const c = copy();
    tool(c, 'samtools-sort').outputs[0].name = 'alignments';
    expect(errorsOf(c)).toContain('slot name used twice');
    const d = copy();
    tool(d, 'samtools-sort').inputs[0].name = 'inputs';
    expect(errorsOf(d)).toContain('inputs is a reserved placeholder');
    const e = copy();
    tool(e, 'samtools-sort').inputs[0].name = 'by_name';
    expect(errorsOf(e)).toContain('slot name is also a parameter');
    const f = copy();
    tool(f, 'samtools-sort').inputs[0].name = 'Bad-Name';
    expect(errorsOf(f)).toContain('slot names use lower-case letters');
  });

  it('rejects a slot name longer than the engine accepts', () => {
    const c = copy();
    tool(c, 'samtools-sort').inputs[0].name = 'a'.repeat(41);
    expect(errorsOf(c)).toContain('longer than 40 characters');
  });

  it('keeps patterns plain: folders end in a slash, files do not, no braces or spaces', () => {
    const c = copy();
    tool(c, 'fastqc').outputs[0].pattern = 'qc';
    tool(c, 'samtools-sort').outputs[0].pattern = 'out/{sample}.bam';
    tool(c, 'samtools-view').outputs[0].pattern = 'my file.bam';
    const text = errorsOf(c);
    expect(text).toContain("fastqc.report_dir: a folder's pattern ends in /");
    expect(text).toContain('samtools-sort.bam: pattern must be a plain file name');
    expect(text).toContain('samtools-view.filtered: pattern must be a plain file name');
  });

  it('wants either a pattern or a derived rule, and the rule must follow another output', () => {
    const c = copy();
    const outputs = tool(c, 'star').outputs;
    outputs.find((o: any) => o.name === 'out_dir').derived = { from: 'bam', suffix: 'x' };
    expect(errorsOf(c)).toContain('give either a pattern or a derived rule');
    const d = copy();
    const bam = tool(d, 'star').outputs.find((o: any) => o.name === 'bam');
    bam.derived.from = 'nowhere';
    expect(errorsOf(d)).toContain('derived.from must name another output');
    const e = copy();
    const log = tool(e, 'star').outputs.find((o: any) => o.name === 'log');
    log.derived.from = 'bam';
    expect(errorsOf(e)).toContain('derived.from must name another output that is not itself derived');
  });

  it('needs at least one input and one output', () => {
    const c = copy();
    tool(c, 'fastqc').inputs = [];
    tool(c, 'fastqc').outputs = [];
    const text = errorsOf(c);
    expect(text).toContain('needs at least one input slot');
    expect(text).toContain('needs at least one output slot');
  });
});

describe('option rules', () => {
  it('rejects a duplicate option id and a reserved option name', () => {
    const c = copy();
    tool(c, 'fastp').params.push({ ...tool(c, 'fastp').params[0] });
    tool(c, 'fastp').params.push({ id: 'threads', label: 'x', type: 'number', default: 1, description: 'x' });
    const text = errorsOf(c);
    expect(text).toContain('duplicate parameter id');
    expect(text).toContain('is a reserved name');
  });

  it('rejects a default that does not fit the option', () => {
    const c = copy();
    const fastp = tool(c, 'fastp');
    fastp.params[0].default = 99;
    fastp.params[1].default = 'ten';
    const text = errorsOf(c);
    expect(text).toContain('default is above max');
    expect(text).toContain('default must be a number');
    const d = copy();
    tool(d, 'bowtie2').params[0].default = 'turbo';
    expect(errorsOf(d)).toContain('default is not one of the options');
    const e = copy();
    delete tool(e, 'samtools-sort').params[0].flag;
    expect(errorsOf(e)).toContain('a checkbox needs the flag it adds');
  });

  it('rejects an option without a label or description, and an unknown option type', () => {
    const c = copy();
    tool(c, 'fastp').params[0].label = '';
    delete tool(c, 'fastp').params[1].description;
    tool(c, 'fastp').params.push({ id: 'weird', label: 'W', type: 'date', default: '', description: 'w' });
    const text = errorsOf(c);
    expect(text).toContain('needs a label');
    expect(text).toContain('needs a description');
    expect(text).toContain('type must be one of');
  });
});

describe('number steps', () => {
  it('accepts a fractional step and rejects one that is not above zero', () => {
    const ok = copy();
    tool(ok, 'freebayes').params.find((p: any) => p.id === 'min_alt_fraction').step = 0.001;
    expect(errorsOf(ok)).toBe('');
    for (const bad of [0, -1, 'fine', null]) {
      const c = copy();
      tool(c, 'freebayes').params.find((p: any) => p.id === 'min_alt_fraction').step = bad;
      expect(errorsOf(c), `step ${String(bad)}`).toContain('freebayes.min_alt_fraction: step must be a number above 0');
    }
  });
});

describe('a minimal new tool passes', () => {
  it('lets a domain add a system tool with one input and one output', () => {
    const c: Catalog = copy();
    c.tools.push({
      id: 'minimap2-long',
      name: 'minimap2 for long reads',
      description: 'Aligns long reads.',
      category: 'alignment',
      subcategory: 'Long-read aligners',
      docs: 'https://github.com/lh3/minimap2',
      install: { kind: 'system', binary: 'minimap2' },
      inputs: [
        { name: 'reads', label: 'Reads', description: 'Long reads.', types: ['fastq'], required: true, multiple: false },
      ],
      outputs: [
        { name: 'sam', label: 'Alignments', description: 'SAM file.', types: ['sam'], pattern: 'long.sam', is_dir: false },
      ],
      params: [],
      command: 'minimap2 -t {threads} -a {reads} > {sam}',
      threads: 4,
    });
    expect(validateCatalog(c)).toEqual([]);
  });
});
