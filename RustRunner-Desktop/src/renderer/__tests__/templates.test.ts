import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import { CATALOG } from '../tools/catalog';
import { BUNDLED_SOURCES, bundledTemplates } from '../templates/registry';
import {
  DIFFICULTIES,
  TEMPLATE_DOMAINS,
  TEMPLATE_FORMAT_VERSION,
  compareVersions,
  databaseNeeds,
  parseVersion,
  stepLabels,
  toolsUsed,
  topologicalOrder,
  validateTemplate,
  type WorkflowTemplate,
} from '../templates/schema';

const TEMPLATES_DIR = path.join(__dirname, '..', 'templates');
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value));
const basic = (): WorkflowTemplate => clone(BUNDLED_SOURCES[0].raw as WorkflowTemplate);

describe('bundled templates', () => {
  it('lists every template file in the registry', () => {
    const files = fs.readdirSync(TEMPLATES_DIR).filter((f) => f.endsWith('.json')).sort();
    expect(BUNDLED_SOURCES.map((s) => s.file).sort()).toEqual(files);
  });

  it('has at least the basic read quality check', () => {
    expect(bundledTemplates().map((t) => t.id)).toContain('basic-read-qc');
  });

  describe.each(BUNDLED_SOURCES.map((s) => [s.file, s.raw] as const))('%s', (file, raw) => {
    const template = raw as WorkflowTemplate;
    const catalogIds = new Set(CATALOG.tools.map((t) => t.id));

    it('passes the schema check against the catalog', () => {
      expect(validateTemplate(raw)).toEqual([]);
    });

    it('is named after its file', () => {
      expect(`${template.id}.json`).toBe(file);
      expect(template.formatVersion).toBe(TEMPLATE_FORMAT_VERSION);
    });

    it('uses only catalog tools', () => {
      for (const step of template.steps) expect(catalogIds.has(step.tool), step.tool).toBe(true);
    });

    it('gives every required slot a source: a connection, a template input or a default', () => {
      for (const step of template.steps) {
        const tool = CATALOG.tools.find((t) => t.id === step.tool)!;
        for (const slot of tool.inputs.filter((s) => s.required)) {
          const connected = template.edges.some(
            (e) => e.to === step.key && (e.bind ?? []).some((b) => b.slot === slot.name)
          );
          const asked = template.inputs.some((i) => i.targets.some((t) => t.step === step.key && t.slot === slot.name));
          const fixed = typeof step.files?.[slot.name] === 'string';
          expect(connected || asked || fixed, `${step.key}.${slot.name}`).toBe(true);
        }
      }
    });

    it('has no loop and a layout that does not overlap', () => {
      expect(topologicalOrder(template.steps.map((s) => s.key), template.edges)).not.toBeNull();
      const errors = validateTemplate(raw).filter((e) => /overlap|loop/.test(e));
      expect(errors).toEqual([]);
    });

    it('describes itself for people', () => {
      expect(template.name.length).toBeGreaterThan(3);
      expect(template.details.length).toBeGreaterThan(template.description.length);
      expect(template.domain in TEMPLATE_DOMAINS).toBe(true);
      expect(template.difficulty in DIFFICULTIES).toBe(true);
      expect(template.outputs.length).toBeGreaterThan(0);
      expect(template.references.length).toBeGreaterThan(0);
      for (const ref of template.references) if (ref.url) expect(ref.url.startsWith('https://')).toBe(true);
    });

    it('does not need a newer catalog than the app has', () => {
      expect(compareVersions(template.minCatalogVersion, CATALOG.version)).toBeLessThanOrEqual(0);
    });
  });

  it('uses unique ids', () => {
    const ids = BUNDLED_SOURCES.map((s) => (s.raw as WorkflowTemplate).id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('basic read quality check', () => {
  const t = basic();

  it('is FastQC, fastp, FastQC and MultiQC', () => {
    expect(t.steps.map((s) => s.tool)).toEqual(['fastqc', 'fastp', 'fastqc', 'multiqc']);
    expect(toolsUsed(t)).toEqual(['FastQC', 'fastp', 'MultiQC']);
  });

  it('keeps the two FastQC reports in different folders', () => {
    const folders = t.steps.filter((s) => s.tool === 'fastqc').map((s) => s.files?.report_dir);
    expect(new Set(folders).size).toBe(2);
  });

  it('asks for one set of reads that feeds both the first FastQC and fastp', () => {
    expect(t.inputs).toHaveLength(1);
    expect(t.inputs[0].targets.map((x) => x.step).sort()).toEqual(['fastp', 'fastqc_raw']);
  });

  it('needs no database', () => {
    expect(databaseNeeds(t)).toEqual([]);
  });

  it('names its steps distinctly', () => {
    const labels = Object.values(stepLabels(t));
    expect(new Set(labels).size).toBe(4);
  });
});

describe('validateTemplate catches mistakes', () => {
  const problems = (mutate: (t: any) => void): string[] => {
    const t: any = basic();
    mutate(t);
    return validateTemplate(t);
  };

  it('accepts the unchanged template', () => {
    expect(validateTemplate(basic())).toEqual([]);
  });

  it('rejects something that is not an object', () => {
    expect(validateTemplate(null)).toHaveLength(1);
    expect(validateTemplate([])).toHaveLength(1);
    expect(validateTemplate('x')).toHaveLength(1);
  });

  it('rejects another format version', () => {
    expect(problems((t) => (t.formatVersion = 2)).join()).toMatch(/formatVersion/);
  });

  it('rejects a bad id, name or description', () => {
    expect(problems((t) => (t.id = 'Bad Id')).join()).toMatch(/id must be/);
    expect(problems((t) => (t.name = '  ')).join()).toMatch(/name is required/);
    expect(problems((t) => (t.description = '')).join()).toMatch(/description is required/);
    expect(problems((t) => (t.details = '')).join()).toMatch(/details is required/);
  });

  it('rejects an unknown domain or difficulty', () => {
    expect(problems((t) => (t.domain = 'astrology')).join()).toMatch(/domain must be/);
    expect(problems((t) => (t.difficulty = 'impossible')).join()).toMatch(/difficulty must be/);
  });

  it('rejects a template that needs a newer catalog', () => {
    expect(problems((t) => (t.minCatalogVersion = '2999.1.0')).join()).toMatch(/needs tool catalog 2999\.1\.0/);
    expect(problems((t) => (t.minCatalogVersion = 'new')).join()).toMatch(/minCatalogVersion/);
  });

  it('rejects a tool that is not in the catalog', () => {
    expect(problems((t) => (t.steps[0].tool = 'no-such-tool')).join()).toMatch(/not in the tool catalog/);
  });

  it('rejects duplicate keys and duplicate names', () => {
    expect(problems((t) => (t.steps[1].key = t.steps[0].key)).join()).toMatch(/share the key/);
    expect(problems((t) => (t.steps[1].label = t.steps[0].label)).join()).toMatch(/same name/);
  });

  it('rejects an option the tool does not have, or a value out of range', () => {
    expect(problems((t) => (t.steps[1].params = { nope: 1 })).join()).toMatch(/no option "nope"/);
    expect(problems((t) => (t.steps[1].params = { min_quality: 500 })).join()).toMatch(/above its maximum/);
    expect(problems((t) => (t.steps[1].params = { min_quality: '5' })).join()).toMatch(/must be a number/);
  });

  it('accepts a valid option value', () => {
    expect(problems((t) => (t.steps[1].params = { min_quality: 20, min_length: 30 }))).toEqual([]);
  });

  it('rejects a file for a slot the tool does not have, or for a derived output', () => {
    expect(problems((t) => (t.steps[0].files = { nothing: 'x' })).join()).toMatch(/no file slot "nothing"/);
    expect(problems((t) => (t.steps[3].files = { report: 'x.html' })).join()).toMatch(/follows another output/);
  });

  it('rejects a step without a position', () => {
    expect(problems((t) => delete t.steps[0].position).join()).toMatch(/position/);
  });

  it('rejects a connection to a missing step, to itself, twice, or in a loop', () => {
    expect(problems((t) => (t.edges[0].to = 'ghost')).join()).toMatch(/does not exist/);
    expect(problems((t) => (t.edges[0].to = t.edges[0].from)).join()).toMatch(/cannot run after itself/);
    expect(problems((t) => t.edges.push({ ...t.edges[0] })).join()).toMatch(/appears twice/);
    expect(problems((t) => t.edges.push({ from: 'multiqc', to: 'fastp' })).join()).toMatch(/loop/);
  });

  it('rejects a binding that names a missing slot or output, or does not fit', () => {
    expect(problems((t) => (t.edges[0].bind[0].slot = 'nope')).join()).toMatch(/no input "nope"/);
    expect(problems((t) => (t.edges[0].bind[0].output = 'nope')).join()).toMatch(/no output "nope"/);
    // FastQC reads FASTQ; fastp's JSON report is not.
    expect(problems((t) => (t.edges[0].bind[0].output = 'json_report')).join()).toMatch(/does not fit/);
  });

  it('rejects a required slot that gets no file', () => {
    expect(problems((t) => (t.inputs[0].targets = [t.inputs[0].targets[0]])).join()).toMatch(/gets no file/);
  });

  it('rejects a one-file slot that is filled twice', () => {
    expect(
      problems((t) => (t.steps[1].files = { reads: 'again.fastq' })).join()
    ).toMatch(/takes one file but is filled in 2 ways/);
  });

  it('rejects inputs that do not fit their target', () => {
    expect(problems((t) => (t.inputs[0].types = ['bam'])).join()).toMatch(/does not fit/);
    expect(problems((t) => (t.inputs[0].targets[0].slot = 'nope')).join()).toMatch(/not an input slot/);
    expect(problems((t) => (t.inputs[0].targets = [])).join()).toMatch(/at least one step slot/);
    expect(problems((t) => (t.inputs[0].types = ['nonsense'])).join()).toMatch(/types must list/);
  });

  it('rejects an optional input for a slot the tool needs, and several files for a one-file slot', () => {
    expect(problems((t) => (t.inputs[0].required = false)).join()).toMatch(/is optional but/);
    expect(problems((t) => (t.inputs[0].multiple = true)).join()).toMatch(/takes several files but/);
  });

  it('rejects duplicate input ids', () => {
    expect(problems((t) => t.inputs.push({ ...t.inputs[0] })).join()).toMatch(/appears twice/);
  });

  it('rejects steps that overlap on the canvas', () => {
    expect(problems((t) => (t.steps[1].position = { x: 20, y: 10 })).join()).toMatch(/overlap/);
  });

  it('rejects outputs and references that point nowhere', () => {
    expect(problems((t) => (t.outputs[0].slot = 'nope')).join()).toMatch(/not an output/);
    expect(problems((t) => (t.outputs[0].step = 'ghost')).join()).toMatch(/not an output/);
    expect(problems((t) => (t.references[0].url = 'http://insecure.example')).join()).toMatch(/https/);
    expect(problems((t) => (t.references[0].url = 'javascript:alert(1)')).join()).toMatch(/https/);
  });

  it('rejects a required option that is empty', () => {
    // Any catalog tool with a required text option will do.
    const tool = CATALOG.tools.find((t) => t.params.some((p) => p.required && p.type === 'string'));
    if (!tool) return;
    const errors = problems((t) => {
      t.steps = [{ key: 'one', tool: tool.id, position: { x: 0, y: 0 }, files: {} }];
      t.edges = [];
      t.inputs = [];
      t.outputs = [];
    });
    expect(errors.join()).toMatch(/must be filled in|gets no file/);
  });
});

describe('versions', () => {
  it('parses dotted numbers only', () => {
    expect(parseVersion('2026.15.0')).toEqual([2026, 15, 0]);
    expect(parseVersion('1')).toEqual([1]);
    expect(parseVersion('1.x')).toBeNull();
    expect(parseVersion(3)).toBeNull();
  });

  it('compares numerically, not as text', () => {
    expect(compareVersions('2026.9.0', '2026.15.0')).toBeLessThan(0);
    expect(compareVersions('2026.15.0', '2026.15')).toBe(0);
    expect(compareVersions('2027.0.0', '2026.99.99')).toBeGreaterThan(0);
  });
});
