import { describe, expect, it } from 'vitest';
import {
  applyBinding,
  connectWithBinding,
  kindPatch,
  linkChoices,
  linkPatch,
  outputItems,
  placeholderNames,
  planBinding,
  previewCommand,
  previewForNode,
  scanCommand,
  slotDefsFor,
  slotIssues,
  slotStates,
  slotYaml,
  typedPatch,
  typesOfPath,
  unescapeBraces,
  unlinkPatch,
} from '../slots';
import type { Catalog } from '../tools/catalog';
import { convertNodesToWorkflow } from '../workflowConversion';

const node = (id: string, label: string, data: Record<string, unknown> = {}) => ({
  id,
  position: { x: 0, y: 0 },
  type: 'custom',
  data: <Record<string, any>>{ label, tool: 'bash', command: 'echo', input: '', output: '', threads: 1, ...data },
});
const edge = (source: string, target: string) => ({ id: `e-${source}-${target}`, source, target });

/** A catalog with a tool that declares file slots, so catalog behaviour is tested without touching catalog.json. */
const CATALOG: Catalog = {
  schemaVersion: 1,
  version: '2099.0.0',
  fileTypes: ['fastq', 'fasta', 'bam', 'bai'],
  categories: { alignment: { label: 'Alignment', color: 'sky' } },
  tools: [
    {
      id: 'aligner',
      name: 'Aligner',
      description: 'Aligns reads.',
      category: 'alignment',
      conda: { package: 'aligner' },
      command: 'aligner {ref} {reads1} {reads2} -o {bam}',
      defaultThreads: 1,
      inputTypes: ['fastq'],
      outputTypes: ['bam'],
      defaultInput: '',
      defaultOutput: '',
      params: [],
      inputSlots: [
        { id: 'ref', label: 'Reference genome', types: ['fasta'], description: 'The genome to align to.' },
        { id: 'reads1', label: 'First reads file', types: ['fastq'], description: 'Forward reads.' },
        { id: 'reads2', label: 'Second reads file', types: ['fastq'], description: 'Reverse reads.' },
      ],
      outputSlots: [{ id: 'bam', label: 'Alignments', types: ['bam'], description: 'Sorted BAM.' }],
    },
    {
      id: 'indexer',
      name: 'Indexer',
      description: 'Indexes a BAM.',
      category: 'alignment',
      conda: { package: 'indexer' },
      command: 'indexer {input} {bai}',
      defaultThreads: 1,
      inputTypes: ['bam'],
      outputTypes: ['bam'],
      defaultInput: '',
      defaultOutput: '',
      params: [],
      outputSlots: [{ id: 'bai', label: 'Index', types: ['bai'], description: 'The .bai file.' }],
    },
  ],
};

describe('scanCommand and placeholderNames', () => {
  it('lists placeholders in order without repeats', () => {
    expect(placeholderNames('bwa mem {ref} {reads} > {sam} && ls {ref}')).toEqual(['ref', 'reads', 'sam']);
  });

  it('ignores bash expansions, non-identifiers, escapes and comments', () => {
    expect(placeholderNames('echo ${HOME} ${X:-{ref}} {a,b} {1..3} {print $1} { x }')).toEqual([]);
    expect(placeholderNames('echo {{ref}} # {commented}')).toEqual([]);
    expect(placeholderNames('echo {a} # don\'t use {b}\necho {c}')).toEqual(['a', 'c']);
    expect(placeholderNames('echo a#{b}')).toEqual(['b']);
  });

  it('tracks the quote around each placeholder', () => {
    const quotes = scanCommand(`a {x} 'b {y}' "c {z}" d {w}`)
      .filter((p) => p.kind === 'hole')
      .map((p: any) => [p.name, p.quote]);
    expect(quotes).toEqual([
      ['x', 'none'],
      ['y', 'single'],
      ['z', 'double'],
      ['w', 'none'],
    ]);
  });

  it('flags places that cannot be filled safely', () => {
    const problem = (cmd: string) => (scanCommand(cmd).find((p) => p.kind === 'hole') as any).problem;
    expect(problem("echo $'{a}'")).toMatch(/\$'/);
    expect(problem('cat <<EOF\n{a}\nEOF')).toMatch(/here-document/);
    expect(problem('echo "$(date) {a}"')).toMatch(/double-quoted/);
    expect(problem('cat <<< {a}')).toBeUndefined();
  });

  it('turns {{x}} back into {x} for a step without slots', () => {
    expect(unescapeBraces("awk '{{print}}' {{x}} {y} {{a.b}}")).toBe("awk '{print}' {x} {y} {{a.b}}");
  });
});

describe('file types', () => {
  it('reads the type from the extension, ignoring compression', () => {
    expect(typesOfPath('data/reads.fq.gz')).toEqual(['fastq']);
    expect(typesOfPath('/x/ref.FASTA')).toEqual(['fasta']);
    expect(typesOfPath('a.sorted.bam')).toEqual(['bam']);
    expect(typesOfPath('a.bam.bai')).toEqual(['bai']);
    expect(typesOfPath('Makefile')).toEqual([]);
    expect(typesOfPath('x.unknown')).toEqual([]);
  });
});

describe('slotDefsFor', () => {
  it('uses the placeholders of a hand-written command, labelled in plain words', () => {
    const defs = slotDefsFor({ command: 'bwa mem {ref} {reads1} {my_extra_file} {input} {output} {threads}' });
    expect(defs.map((d) => d.id)).toEqual(['ref', 'reads1', 'my_extra_file']);
    expect(defs[0]).toMatchObject({ label: 'Reference genome', types: ['fasta'], kind: 'input', fromCatalog: false });
    expect(defs[1]).toMatchObject({ label: 'Reads, first of the pair', types: ['fastq'] });
    expect(defs[2]).toMatchObject({ label: 'My extra file', types: [] });
    expect(defs[0].hint).toContain('{ref}');
    expect(defs[0].hint).toContain('fasta');
  });

  it("leaves out the step's own batch-file name", () => {
    expect(slotDefsFor({ command: 'cat {sample} {ref}' }).map((d) => d.id)).toEqual(['ref']);
    expect(slotDefsFor({ command: 'cat {lane} {sample}', wildcardName: 'lane' }).map((d) => d.id)).toEqual(['sample']);
  });

  it('has none for a step that uses only the built-in placeholders', () => {
    expect(slotDefsFor({ command: 'sort {input} > {output}' })).toEqual([]);
    expect(slotDefsFor({ command: "awk '{print $1}' {input}" })).toEqual([]);
  });

  it('takes the role of a hand-written slot from the person', () => {
    const data = { command: 'cp {a} {b}', slotKinds: { b: 'output' } };
    expect(slotDefsFor(data).map((d) => [d.id, d.kind])).toEqual([
      ['a', 'input'],
      ['b', 'output'],
    ]);
    expect(kindPatch(data, 'a', 'output')).toEqual({ slotKinds: { b: 'output', a: 'output' } });
  });

  it('uses only what the tool declares while a catalog command is generated', () => {
    const data = { catalogId: 'aligner', command: 'aligner {ref} {reads1} {reads2} -o {bam} {leftover}' };
    const defs = slotDefsFor(data, CATALOG);
    expect(defs.map((d) => [d.id, d.kind])).toEqual([
      ['ref', 'input'],
      ['reads1', 'input'],
      ['reads2', 'input'],
      ['bam', 'output'],
    ]);
    expect(defs[0]).toMatchObject({ label: 'Reference genome', fromCatalog: true, types: ['fasta'] });
    expect(defs[0].hint).toContain('The genome to align to.');
  });

  it('follows the command once it is edited by hand, keeping what the tool knows', () => {
    const data = { catalogId: 'aligner', catalogCommandCustom: true, command: 'aligner {ref} {mine}' };
    const defs = slotDefsFor(data, CATALOG);
    expect(defs.map((d) => d.id)).toEqual(['ref', 'mine']);
    expect(defs[0].fromCatalog).toBe(true);
    expect(defs[1].fromCatalog).toBe(false);
  });

  it('ignores the declared slots of a tool that is not in the catalog', () => {
    expect(slotDefsFor({ catalogId: 'gone', command: 'x {a}' }, CATALOG).map((d) => d.id)).toEqual(['a']);
  });
});

describe('slot values and links', () => {
  const nodes = [
    node('t', 'Trim', { command: 'trim {input} > {output}', output: 'trimmed.fastq' }),
    node('a', 'Align', { command: 'bwa {ref} {reads}', slotFiles: { ref: 'genome.fa' } }),
  ];

  it('shows what was typed', () => {
    const states = slotStates(nodes[1], nodes, []);
    expect(states.find((s) => s.def.id === 'ref')).toMatchObject({ value: 'genome.fa', link: null, files: ['genome.fa'] });
    expect(states.find((s) => s.def.id === 'reads')).toMatchObject({ value: '', files: [] });
  });

  it('splits several typed files at commas', () => {
    const n = node('a', 'Align', { command: 'x {f}', slotFiles: { f: 'a.fq, b.fq ,' } });
    expect(slotStates(n, [n], [])[0].files).toEqual(['a.fq', 'b.fq']);
  });

  it('follows a link while the connection exists, and ignores it after', () => {
    const linked = {
      ...nodes[1],
      data: { ...nodes[1].data, ...linkPatch(nodes[1].data, 'reads', 't', '') },
    };
    const all = [nodes[0], linked];
    const state = slotStates(linked, all, [edge('t', 'a')]).find((s) => s.def.id === 'reads')!;
    expect(state.link).toEqual({ nodeId: 't', stepLabel: 'Trim', outputLabel: 'Output file' });
    expect(state.files).toEqual(['trimmed.fastq']);

    // The source changes its output: the slot follows.
    const moved = [{ ...nodes[0], data: { ...nodes[0].data, output: 'clean.fastq' } }, linked];
    expect(slotStates(linked, moved, [edge('t', 'a')]).find((s) => s.def.id === 'reads')!.files).toEqual(['clean.fastq']);

    // The connection is gone: the typed value (none) is what is left.
    const gone = slotStates(linked, all, []).find((s) => s.def.id === 'reads')!;
    expect(gone.link).toBeNull();
    expect(gone.files).toEqual([]);
  });

  it('keeps a link whose source has no output yet, with no files', () => {
    const empty = node('t', 'Trim', { output: '' });
    const linked = { ...nodes[1], data: { ...nodes[1].data, ...linkPatch(nodes[1].data, 'reads', 't', '') } };
    const state = slotStates(linked, [empty, linked], [edge('t', 'a')]).find((s) => s.def.id === 'reads')!;
    expect(state.link?.stepLabel).toBe('Trim');
    expect(state.files).toEqual([]);
  });

  it('turns a link into a typed name on unlink, so nothing is lost', () => {
    const linked = { ...nodes[1], data: { ...nodes[1].data, ...linkPatch(nodes[1].data, 'reads', 't', '') } };
    const patch = unlinkPatch(linked, [nodes[0], linked], [edge('t', 'a')], 'reads');
    expect(patch).toEqual({ slotLinks: {}, slotFiles: { ref: 'genome.fa', reads: 'trimmed.fastq' } });
  });

  it('builds typed patches without touching other slots', () => {
    expect(typedPatch({ slotFiles: { a: '1' } }, 'b', '2')).toEqual({ slotFiles: { a: '1', b: '2' } });
    expect(typedPatch({}, 'b', '2')).toEqual({ slotFiles: { b: '2' } });
  });

  it('ignores malformed slot data in an old or damaged file', () => {
    const n = node('a', 'A', { command: 'x {f}', slotFiles: 'nope', slotLinks: { f: { from: 5 } }, slotKinds: [] });
    expect(slotStates(n, [n], [])[0]).toMatchObject({ value: '', link: null, files: [] });
  });
});

describe('outputs a step offers', () => {
  it('lists the main output and each named output that has a file', () => {
    const n = node('x', 'Make', {
      command: 'make {input} {bam} {bai}',
      output: 'main.txt',
      slotKinds: { bam: 'output', bai: 'output' },
      slotFiles: { bam: 'a.bam' },
    });
    expect(outputItems(n).map((o) => [o.key, o.files])).toEqual([
      ['', ['main.txt']],
      ['bam', ['a.bam']],
    ]);
    expect(outputItems(n, undefined, true).map((o) => o.key)).toEqual(['', 'bam', 'bai']);
  });

  it('knows the types: from the tool, the slot or the extension', () => {
    const catalogNode = node('c', 'Aligner', { catalogId: 'aligner', command: 'aligner', output: 'x.out', slotFiles: { bam: 'a.bam' } });
    expect(outputItems(catalogNode, CATALOG).map((o) => [o.key, o.types])).toEqual([
      ['', ['bam']],
      ['bam', ['bam']],
    ]);
    expect(outputItems(node('x', 'X', { output: 'r.fq.gz' }))[0].types).toEqual(['fastq']);
  });
});

describe('binding on connect', () => {
  const trim = node('t', 'Trim', { command: 'trim {input}', output: 'trimmed.fastq' });

  it('binds the one output that matches a slot by file type', () => {
    const align = node('a', 'Align', { command: 'bwa {ref} {reads}' });
    const plan = planBinding([trim, align], [edge('t', 'a')], 't', 'a');
    expect(plan).toMatchObject({ kind: 'auto', option: { slot: 'reads', outputKey: '', typeMatch: true } });
  });

  it('does not touch a slot that already has a file or a link', () => {
    const align = node('a', 'Align', { command: 'bwa {ref} {reads}', slotFiles: { reads: 'mine.fq' } });
    // ref takes fasta: trimmed.fastq does not fit, and reads is taken.
    expect(planBinding([trim, align], [edge('t', 'a')], 't', 'a')).toEqual({ kind: 'none' });
  });

  it('asks when the output fits several slots', () => {
    const align = node('a', 'Align', { command: 'bwa {reads1} {reads2}' });
    const plan = planBinding([trim, align], [edge('t', 'a')], 't', 'a');
    expect(plan.kind).toBe('ask');
    if (plan.kind === 'ask') expect(plan.options.map((o) => o.slot)).toEqual(['reads1', 'reads2']);
  });

  it('asks when several outputs fit one slot', () => {
    const two = node('t', 'Trim', {
      command: 'trim {a} {b}',
      output: 'x.fastq',
      slotKinds: { a: 'output' },
      slotFiles: { a: 'y.fastq' },
    });
    const align = node('a', 'Align', { command: 'bwa {reads}' });
    const plan = planBinding([two, align], [edge('t', 'a')], 't', 'a');
    expect(plan.kind).toBe('ask');
    if (plan.kind === 'ask') expect(plan.options.map((o) => o.outputKey)).toEqual(['', 'a']);
  });

  it('takes the first free slot when types are unknown', () => {
    const src = node('s', 'Src', { output: 'result.dat' });
    const dst = node('d', 'Dst', { command: 'run {first} {second}' });
    const plan = planBinding([src, dst], [edge('s', 'd')], 's', 'd');
    expect(plan).toMatchObject({ kind: 'auto', option: { slot: 'first', outputKey: '' } });
  });

  it('leaves a slot alone when its type is known and different', () => {
    const src = node('s', 'Src', { output: 'variants.vcf' });
    const dst = node('d', 'Dst', { command: 'run {ref}' });
    expect(planBinding([src, dst], [edge('s', 'd')], 's', 'd')).toEqual({ kind: 'none' });
  });

  it('binds an output of unknown type to a typed slot when nothing else fits', () => {
    const src = node('s', 'Src', { output: 'result.dat' });
    const dst = node('d', 'Dst', { command: 'run {ref}' });
    expect(planBinding([src, dst], [edge('s', 'd')], 's', 'd')).toMatchObject({ kind: 'auto', option: { slot: 'ref' } });
  });

  it('does nothing when the earlier step makes no file, or the later one has no free slot', () => {
    const quiet = node('q', 'Quiet', { output: '' });
    const dst = node('d', 'Dst', { command: 'run {ref}' });
    expect(planBinding([quiet, dst], [edge('q', 'd')], 'q', 'd')).toEqual({ kind: 'none' });
    const plain = node('p', 'Plain', { command: 'sort {input}' });
    expect(planBinding([trim, plain], [edge('t', 'p')], 't', 'p')).toEqual({ kind: 'none' });
  });

  it('binds from a named output by type, using catalog slots', () => {
    const aligner = node('c', 'Aligner', { catalogId: 'aligner', command: 'aligner', slotFiles: { bam: 'a.bam' } });
    const indexer = node('i', 'Indexer', { catalogId: 'indexer', command: 'indexer {input} {bai}' });
    // Indexer has no input slots: only its main input (not a slot), so nothing to bind.
    expect(planBinding([aligner, indexer], [edge('c', 'i')], 'c', 'i', CATALOG)).toEqual({ kind: 'none' });
    const caller = node('v', 'Caller', { command: 'call {bam} {bai}' });
    const bamOut = node('c', 'Aligner', { catalogId: 'aligner', command: 'aligner', slotFiles: { bam: 'a.bam' } });
    const plan = planBinding([bamOut, caller], [edge('c', 'v')], 'c', 'v', CATALOG);
    expect(plan).toMatchObject({ kind: 'auto', option: { slot: 'bam', outputKey: 'bam' } });
  });

  it('applies a binding as a link on the later step', () => {
    const align = node('a', 'Align', { command: 'bwa {reads}' });
    const { nodes, plan } = connectWithBinding([trim, align], [], [edge('t', 'a')], 't', 'a');
    expect(plan.kind).toBe('auto');
    expect(nodes[1].data.slotLinks).toEqual({ reads: { from: 't', output: '' } });
    expect(slotStates(nodes[1], nodes, [edge('t', 'a')])[0].files).toEqual(['trimmed.fastq']);
    // The earlier step is untouched.
    expect(nodes[0]).toBe(trim);
  });

  it('forgets links whose connection was removed, so redrawing it does not revive them', () => {
    const stale = node('a', 'Align', { command: 'bwa {reads}', slotLinks: { reads: { from: 'old', output: '' } } });
    const other = node('t', 'Trim', { output: 'trimmed.fastq' });
    const { nodes } = connectWithBinding([other, stale], [], [edge('t', 'a')], 't', 'a');
    expect(nodes[1].data.slotLinks).toEqual({ reads: { from: 't', output: '' } });
  });

  it('keeps links whose connection still exists', () => {
    const kept = node('a', 'Align', {
      command: 'bwa {reads} {ref}',
      slotLinks: { reads: { from: 'x', output: '' } },
    });
    const x = node('x', 'X', { output: 'x.fastq' });
    const src = node('s', 'S', { output: 'genome.fa' });
    const before = [edge('x', 'a')];
    const { nodes } = connectWithBinding([x, src, kept], before, [...before, edge('s', 'a')], 's', 'a');
    expect(nodes[2].data.slotLinks).toEqual({
      reads: { from: 'x', output: '' },
      ref: { from: 's', output: '' },
    });
  });

  it('applyBinding links the chosen pair', () => {
    const align = node('a', 'Align', { command: 'bwa {reads1} {reads2}' });
    const plan = planBinding([trim, align], [edge('t', 'a')], 't', 'a');
    if (plan.kind !== 'ask') throw new Error('expected a question');
    const out = applyBinding([trim, align], 'a', 't', plan.options[1]);
    expect(out[1].data.slotLinks).toEqual({ reads2: { from: 't', output: '' } });
  });
});

describe('keyboard choices', () => {
  it('lists the outputs of the steps before this one, with their files', () => {
    const t = node('t', 'Trim', { output: 'trimmed.fastq' });
    const other = node('o', 'Other', { output: 'other.txt' });
    const a = node('a', 'Align', { command: 'bwa {reads}' });
    const choices = linkChoices(a, [t, other, a], [edge('t', 'a')]);
    expect(choices).toEqual([
      { value: 't|', nodeId: 't', outputKey: '', label: 'Trim: Output file (trimmed.fastq)' },
    ]);
  });

  it('counts several files instead of listing them', () => {
    const t = node('t', 'Trim', { output: 'a.fq, b.fq' });
    const a = node('a', 'Align', { command: 'bwa {reads}' });
    expect(linkChoices(a, [t, a], [edge('t', 'a')])[0].label).toBe('Trim: Output file (2 files)');
  });
});

describe('engine YAML', () => {
  it('writes named inputs and outputs, and nothing for a plain step', () => {
    const t = node('t', 'Trim', { output: 'trimmed.fastq' });
    const a = node('a', 'Align', {
      command: 'bwa {ref} {reads} > {sam}',
      slotFiles: { ref: 'genome.fa', sam: 'out/a b.sam' },
      slotKinds: { sam: 'output' },
      slotLinks: { reads: { from: 't', output: '' } },
    });
    expect(slotYaml(a, [t, a], [edge('t', 'a')])).toEqual({
      named_inputs: { ref: ['genome.fa'], reads: ['trimmed.fastq'] },
      named_outputs: { sam: ['out/a b.sam'] },
    });
    expect(slotYaml(t, [t, a], [edge('t', 'a')])).toEqual({});
  });

  it('writes an unbound slot as an empty list so the engine can name it', () => {
    const a = node('a', 'Align', { command: 'bwa {ref}' });
    expect(slotYaml(a, [a], [])).toEqual({ named_inputs: { ref: [] } });
  });

  it('reaches the converted workflow, with the connection and the escaped braces handled', () => {
    const t = node('t', 'Trim', { command: "awk '{{print}}' {input}", output: 'trimmed.fastq', input: 'raw.fq' });
    const a = node('a', 'Align', {
      command: 'bwa {ref} {reads}',
      slotFiles: { ref: 'genome.fa' },
      slotLinks: { reads: { from: 't', output: '' } },
    });
    const wf = convertNodesToWorkflow([t, a], [edge('t', 'a')], {});
    const [trim, align] = wf.steps;
    // No slots: braces are written the way bash should get them.
    expect(trim.command).toBe("awk '{print}' {input}");
    expect(trim.named_inputs).toBeUndefined();
    expect(trim.named_outputs).toBeUndefined();
    expect(align.named_inputs).toEqual({ ref: ['genome.fa'], reads: ['trimmed.fastq'] });
    expect(align.previous).toEqual(['trim']);
    // With slots the escape is the engine's to handle.
    const b = node('b', 'B', { command: 'echo {{x}} {f}', slotFiles: { f: 'a.txt' } });
    expect(convertNodesToWorkflow([b], [], {}).steps[0].command).toBe('echo {{x}} {f}');
  });
});

describe('preview', () => {
  const ctx = (extra: Partial<Parameters<typeof previewCommand>[1]> = {}) => ({
    structured: true,
    input: ['in.fq'],
    output: ['out.bam'],
    threads: 4,
    slots: { ref: ['genome.fa'], reads: ['r 1.fq', 'r2.fq'] },
    ...extra,
  });

  it('fills every placeholder and quotes only the names that need it', () => {
    const p = previewCommand('bwa mem -t {threads} {ref} {reads} {input} > {output}', ctx());
    expect(p.text).toBe("bwa mem -t 4 genome.fa 'r 1.fq' r2.fq in.fq > out.bam");
    expect(p.missing).toEqual([]);
    expect(p.pieces.filter((x) => x.state === 'filled').map((x) => x.name)).toEqual([
      'threads',
      'ref',
      'reads',
      'input',
      'output',
    ]);
  });

  it('marks placeholders with no file, as text that says so', () => {
    const p = previewCommand('bwa {ref} {reads}', ctx({ slots: { ref: [], reads: ['r.fq'] } }));
    expect(p.text).toBe('bwa {ref} r.fq');
    expect(p.missing).toEqual(['ref']);
    const mark = p.pieces.find((x) => x.state === 'missing')!;
    expect(mark).toMatchObject({ name: 'ref', reason: 'no-file', text: '{ref}' });
  });

  it('marks an empty input or output placeholder too', () => {
    const p = previewCommand('cat {input} > {output}', ctx({ input: [], output: [] }));
    expect(p.missing).toEqual(['input', 'output']);
  });

  it('quotes the way the engine does inside quotes', () => {
    const p = previewCommand(`echo "{f}" '{f}'`, ctx({ slots: { f: [`a "b" $x`] } }));
    expect(p.text).toBe(`echo "a \\"b\\" \\$x" 'a "b" $x'`);
    const single = previewCommand(`echo '{f}'`, ctx({ slots: { f: ["it's"] } }));
    expect(single.text).toBe(`echo 'it'\\''s'`);
  });

  it('flags unknown placeholders in a step with slots, but not in a plain one', () => {
    const strict = previewCommand('run {ref} {typo}', ctx());
    expect(strict.missing).toEqual(['typo']);
    expect(strict.pieces.find((x) => x.name === 'typo')?.reason).toBe('unknown');
    const plain = previewCommand("awk '{print}' {input}", ctx({ structured: false, slots: {} }));
    expect(plain.text).toBe("awk '{print}' in.fq");
    expect(plain.missing).toEqual([]);
  });

  it('marks a placeholder the engine could not quote safely', () => {
    const p = previewCommand('cat <<EOF\n{ref}\nEOF', ctx());
    expect(p.pieces.find((x) => x.name === 'ref')).toMatchObject({ state: 'missing', reason: 'unsafe' });
  });

  it('leaves placeholders in comments and escapes as text', () => {
    const p = previewCommand('echo {ref} # {nothing} {{literal}}', ctx());
    expect(p.text).toBe('echo genome.fa # {nothing} {{literal}}');
  });

  it('resolves a node through its connections', () => {
    const t = node('t', 'Trim', { output: 'trimmed.fastq' });
    const a = node('a', 'Align', {
      command: 'bwa {ref} {reads} > {output}',
      output: 'a.sam',
      slotFiles: { ref: 'genome.fa' },
      slotLinks: { reads: { from: 't', output: '' } },
    });
    expect(previewForNode(a, [t, a], [edge('t', 'a')]).text).toBe('bwa genome.fa trimmed.fastq > a.sam');
    // Without the connection the slot is open.
    const open = previewForNode(a, [t, a], []);
    expect(open.missing).toEqual(['reads']);
  });
});

describe('problems', () => {
  it('reports a slot with no file, in plain words', () => {
    const a = node('a', 'Align', { command: 'bwa {ref}' });
    const issues = slotIssues(a, [a], []);
    expect(issues).toEqual([
      { slot: 'ref', kind: 'missing', message: 'Choose a file for "Reference genome" (written {ref} in the command).' },
    ]);
  });

  it('asks where an output slot is written', () => {
    const a = node('a', 'A', { command: 'x > {out}', slotKinds: { out: 'output' } });
    expect(slotIssues(a, [a], [])[0].message).toBe('Say where "Out" is written (written {out} in the command).');
  });

  it('says so when the file comes from a step that has none yet', () => {
    const t = node('t', 'Trim', { output: '' });
    const a = node('a', 'Align', { command: 'bwa {reads}', slotLinks: { reads: { from: 't', output: '' } } });
    expect(slotIssues(a, [t, a], [edge('t', 'a')])[0].message).toContain('comes from Trim, which has no output file yet');
  });

  it('has none when every slot has a file', () => {
    const a = node('a', 'A', { command: 'bwa {ref}', slotFiles: { ref: 'g.fa' } });
    expect(slotIssues(a, [a], [])).toEqual([]);
  });

  it('refuses a name the engine would', () => {
    const long = 'x'.repeat(41);
    const a = node('a', 'A', { command: `run {${long}}`, slotFiles: { [long]: 'f' } });
    expect(slotIssues(a, [a], []).map((i) => i.kind)).toEqual(['name']);
  });
});
