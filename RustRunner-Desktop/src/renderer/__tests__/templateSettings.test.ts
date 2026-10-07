import { describe, expect, it } from 'vitest';
import { CATALOG, findTool } from '../tools/catalog';
import { BUNDLED_SOURCES, bundledTemplates } from '../templates/registry';
import {
  READ_LAYOUTS,
  adaptToCatalog,
  newerThanApp,
  settingDefault,
  settingParam,
  validateTemplate,
  type WorkflowTemplate,
} from '../templates/schema';
import {
  initialSettingTexts,
  instantiateTemplate,
  settingProblems,
  settingValues,
  templateNodeId,
} from '../templates/instantiate';
import { filterEntries, readLayoutLabel, type GalleryEntry } from '../templates/gallery';

const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value));
const byId = (id: string): WorkflowTemplate => clone(bundledTemplates().find((t) => t.id === id)!);
const basic = (): WorkflowTemplate => clone(BUNDLED_SOURCES[0].raw as WorkflowTemplate);

/** The command a step of `template` gets, made with these setting texts. */
function commandOf(template: WorkflowTemplate, key: string, settings: Record<string, string | boolean> = {}): string {
  const made = instantiateTemplate(template, {}, { settings });
  if (made.ok === false) throw new Error(made.errors.join('; '));
  return made.nodes.find((n) => n.id === templateNodeId(key))!.data.command as string;
}

describe('template settings: format', () => {
  const withSetting = (setting: unknown): unknown => ({ ...basic(), settings: [setting] });
  const good = { id: 'min_length', label: 'Shortest read', hint: 'Shorter reads are dropped.', targets: [{ step: 'fastp', param: 'min_length' }] };

  it('accepts a template without settings and one with a sound setting', () => {
    expect(validateTemplate(basic())).toEqual([]);
    expect(validateTemplate(withSetting(good))).toEqual([]);
  });

  it('rejects a setting that names a missing step or option, or has no targets', () => {
    expect(validateTemplate(withSetting({ ...good, targets: [{ step: 'nope', param: 'min_length' }] })).join()).toMatch(
      /nope\.min_length is not an option/
    );
    expect(validateTemplate(withSetting({ ...good, targets: [{ step: 'fastp', param: 'nope' }] })).join()).toMatch(
      /fastp\.nope is not an option/
    );
    expect(validateTemplate(withSetting({ ...good, targets: [] })).join()).toMatch(/at least one step option/);
    expect(validateTemplate(withSetting({ ...good, id: 'Bad id' })).join()).toMatch(/Setting 1: id/);
    expect(validateTemplate(withSetting({ ...good, label: '' })).join()).toMatch(/label is required/);
    expect(validateTemplate({ ...basic(), settings: 'x' }).join()).toMatch(/settings must be a list/);
  });

  it('rejects two settings with one id, or one option set by two settings', () => {
    const t = { ...basic(), settings: [good, { ...good }] };
    const errors = validateTemplate(t).join(' ');
    expect(errors).toMatch(/appears twice/);
    expect(errors).toMatch(/set by more than one setting/);
  });

  it('rejects a setting whose targets are different kinds of option', () => {
    // Both are fastp numbers, but only the quality has an upper bound (60): one field cannot serve both.
    const mixed = { ...good, targets: [{ step: 'fastp', param: 'min_length' }, { step: 'fastp', param: 'min_quality' }] };
    expect(validateTemplate(withSetting(mixed)).join(' ')).toMatch(/fastp\.min_quality is a different kind of option/);
  });

  it('accepts the three read layouts and rejects others', () => {
    for (const layout of Object.keys(READ_LAYOUTS)) expect(validateTemplate({ ...basic(), readLayout: layout })).toEqual([]);
    expect(validateTemplate({ ...basic(), readLayout: 'long' }).join()).toMatch(/readLayout must be one of/);
  });

  it('starts a setting at the step value in the template, or the tool default', () => {
    const t = { ...basic(), settings: [good] } as WorkflowTemplate;
    expect(settingParam(t, good)?.id).toBe('min_length');
    expect(settingDefault(t, good)).toBe(findTool('fastp')!.params.find((p) => p.id === 'min_length')!.default);
    t.steps.find((s) => s.key === 'fastp')!.params = { min_length: 36 };
    expect(settingDefault(t, good)).toBe(36);
    expect(initialSettingTexts(t)).toEqual({ min_length: '36' });
  });
});

describe('template settings: values and the workflow made from them', () => {
  it('puts the genome size typed in the setup step into the MACS3 command', () => {
    const chip = byId('chipseq-macs3');
    expect(commandOf(chip, 'macs3')).toContain('-g hs ');
    expect(commandOf(chip, 'macs3', { genome_size: 'mm' })).toContain('-g mm ');
    expect(commandOf(chip, 'macs3', { genome_size: '12000000' })).toContain('-g 12000000 ');
  });

  it('keeps the template value for a setting the person did not touch', () => {
    const made = instantiateTemplate(byId('chipseq-macs3'), {}, { settings: {} });
    expect(made.ok && made.nodes.find((n) => n.id === templateNodeId('macs3'))!.data.catalogParams.genome_size).toBe('hs');
  });

  it('turns number fields into numbers and says what is wrong with a bad one', () => {
    const t = byId('variants-bcftools');
    expect(settingValues(t, { min_depth: ' 5 ' })).toEqual({ min_depth: 5 });
    expect(commandOf(t, 'filter', { min_depth: '5' })).toContain('INFO/DP>=5');
    expect(settingProblems(t, { min_depth: '' })).toEqual({ min_depth: 'Enter a number, for example 10.' });
    expect(settingProblems(t, { min_depth: 'ten' }).min_depth).toMatch(/Enter a number/);
    expect(settingProblems(t, { min_depth: '-1' })).toEqual({ min_depth: 'Use 0 or more.' });
    expect(settingProblems(t, { min_depth: '3' })).toEqual({});
    const made = instantiateTemplate(t, {}, { settings: { min_depth: '-1' } });
    expect(made.ok === false && made.errors).toEqual(['Minimum read depth: Use 0 or more.']);
  });

  it('accepts only the listed choices of a choice setting', () => {
    const t = byId('rnaseq-hisat2-counts');
    expect(settingProblems(t, { strand: '2' })).toEqual({});
    expect(commandOf(t, 'featurecounts', { strand: '2' })).toContain('-s 2 ');
    expect(settingProblems(t, { strand: 'reverse' })).toEqual({ strand: 'Pick one of the choices.' });
  });

  it('lets an optional text setting stay empty', () => {
    const flye = byId('assembly-flye-quast');
    expect(settingProblems(flye, { genome_size: '' })).toEqual({});
    expect(commandOf(flye, 'flye', { genome_size: '', read_type: '--nano-hq' })).toMatch(/^G=; .*flye --nano-hq /);
    expect(commandOf(flye, 'flye', { genome_size: '5m' })).toMatch(/^G=5m; /);
  });
});

describe('bundled templates: choices a biologist must make are asked for', () => {
  const settingFor = (id: string, step: string, param: string) =>
    (byId(id).settings ?? []).find((s) => s.targets.some((t) => t.step === step && t.param === param));

  it.each([
    ['chipseq-macs3', 'macs3', 'genome_size'],
    ['atacseq-genrich', 'genrich', 'skip_chroms'],
    ['rnaseq-hisat2-counts', 'featurecounts', 'strand'],
    ['variants-bcftools', 'filter', 'min_depth'],
    ['variants-bcftools-paired', 'filter', 'min_depth'],
    ['variants-gatk', 'hc', 'ploidy'],
    ['metagenomics-kraken2-bracken', 'bracken', 'read_length'],
    ['assembly-flye-quast', 'flye', 'read_type'],
  ])('%s asks for %s.%s in the setup step', (id, step, param) => {
    const setting = settingFor(id, step, param);
    expect(setting).toBeDefined();
    expect(setting!.hint.length).toBeGreaterThan(30);
  });

  it.each(bundledTemplates().map((t) => [t.id] as const))('%s starts every setting at a usable value', (id) => {
    const t = byId(id);
    expect(settingProblems(t, initialSettingTexts(t))).toEqual({});
    expect(Object.keys(initialSettingTexts(t)).sort()).toEqual((t.settings ?? []).map((s) => s.id).sort());
  });

  it('keeps the unfiltered calls of the bcftools templates, so the depth filter never loses data silently', () => {
    for (const id of ['variants-bcftools', 'variants-bcftools-paired']) {
      const t = byId(id);
      expect(t.outputs.some((o) => o.step === 'call' && o.slot === 'vcf'), id).toBe(true);
      expect(t.outputs.some((o) => o.step === 'filter'), id).toBe(true);
    }
  });

  it('says how every short-read template wants its reads', () => {
    for (const t of bundledTemplates()) {
      const shortReads = t.inputs.some((i) => i.types.includes('fastq') && !/long|nanopore/i.test(i.label));
      expect(Boolean(t.readLayout), t.id).toBe(shortReads);
      if (t.readLayout === 'paired') {
        expect(t.inputs.filter((i) => i.types.includes('fastq') && i.required).length, t.id).toBe(2);
      }
      if (t.readLayout === 'single') {
        // One required reads file per sample (a ChIP and its control are two samples).
        for (const input of t.inputs.filter((i) => i.types.includes('fastq'))) expect(input.hint, t.id).toMatch(/single-end|one fastq/i);
      }
    }
  });

  it('never tells the person to pair trimmed reads with untrimmed mates', () => {
    const meta = byId('metagenomics-kraken2-bracken');
    expect(meta.details).not.toMatch(/add the second file/i);
    expect(meta.inputs[0].hint).toMatch(/R1/);
  });
});

describe('read layout on the card', () => {
  it('names the layout, and none for long-read templates', () => {
    expect(readLayoutLabel(byId('atacseq-genrich'))).toBe('Paired-end reads');
    expect(readLayoutLabel(byId('basic-read-qc'))).toBe('Single-end reads');
    expect(readLayoutLabel(byId('assembly-spades-quast'))).toBe('Single- or paired-end reads');
    expect(readLayoutLabel(byId('nanopore-fastq'))).toBeNull();
  });

  it('files both assembly templates under one topic, whatever the read length', () => {
    const entries: GalleryEntry[] = bundledTemplates().map((template) => ({ template, source: 'bundled' }));
    expect(filterEntries(entries, '', 'assembly').map((e) => e.template.id)).toEqual(['assembly-spades-quast', 'assembly-flye-quast']);
    expect(filterEntries(entries, '', 'longread').map((e) => e.template.id)).toEqual(['nanopore-signal', 'nanopore-fastq']);
  });

  it('is found by search', () => {
    const entries: GalleryEntry[] = bundledTemplates().map((template) => ({ template, source: 'bundled' }));
    const found = filterEntries(entries, 'paired-end', '').map((e) => e.template.id);
    expect(found).toContain('atacseq-genrich');
    expect(found).toContain('variants-bcftools-paired');
  });
});

describe('templates from another version of the app', () => {
  it('says a newer app wrote the file, for a newer format or tool list', () => {
    expect(newerThanApp(basic())).toBeNull();
    expect(newerThanApp({ ...basic(), formatVersion: 2 })).toMatch(/newer version of RustRunner/);
    expect(newerThanApp({ ...basic(), minCatalogVersion: '2999.1.0' })).toMatch(/needs a newer tool list \(2999\.1\.0; this app has /);
    expect(newerThanApp('not a template')).toBeNull();
  });

  it('leaves a template made for this tool list alone', () => {
    const t = {
      ...basic(),
      minCatalogVersion: CATALOG.version,
      steps: basic().steps.map((s) => (s.key === 'fastp' ? { ...s, params: { gone: 1 } } : s)),
    };
    const adapted = adaptToCatalog(t);
    expect(adapted.notes).toEqual([]);
    expect(adapted.raw).toBe(t);
    expect(validateTemplate(adapted.raw).join()).toMatch(/has no option "gone"/);
  });

  it('drops options an older template set that the tools no longer have or accept, and says so', () => {
    const old: any = { ...basic(), minCatalogVersion: '2026.1.0' };
    old.steps = old.steps.map((s: any) =>
      s.key === 'fastp' ? { ...s, params: { gone: 1, min_length: -5, min_quality: 20 } } : s
    );
    old.settings = [{ id: 'gone', label: 'Old option', hint: '', targets: [{ step: 'fastp', param: 'gone' }] }];
    expect(validateTemplate(old)).not.toEqual([]);
    const { raw, notes } = adaptToCatalog(old);
    expect(validateTemplate(raw)).toEqual([]);
    expect((raw as any).steps.find((s: any) => s.key === 'fastp').params).toEqual({ min_quality: 20 });
    expect((raw as any).settings).toEqual([]);
    expect(notes).toEqual([
      'Trim reads (fastp): the option "gone" no longer exists and was left out.',
      `Trim reads (fastp): "${findTool('fastp')!.params.find((p) => p.id === 'min_length')!.label}" no longer accepts -5; its default is used.`,
      'The setting "Old option" no longer applies and was left out.',
    ]);
    // The file itself is not changed.
    expect(old.steps.find((s: any) => s.key === 'fastp').params.gone).toBe(1);
  });

  it('keeps the settings of an older template that still apply', () => {
    const old: any = { ...byId('chipseq-macs3'), minCatalogVersion: '2026.1.0' };
    old.steps = old.steps.map((s: any) => (s.key === 'macs3' ? { ...s, params: { ...s.params, removed: true } } : s));
    const { raw, notes } = adaptToCatalog(old);
    expect(notes).toHaveLength(1);
    expect((raw as any).settings).toEqual(old.settings);
    expect(validateTemplate(raw, CATALOG)).toEqual([]);
  });
});
