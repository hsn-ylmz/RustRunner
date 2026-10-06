import { describe, expect, it } from 'vitest';
import {
  SECTION_ORDER,
  defaultOpen,
  formatTimeout,
  isSectionOpen,
  parseOpenState,
  sectionForField,
  sectionSummary,
  testIdForField,
} from '../panelSections';
import { buildCatalogNodeData, findTool } from '../tools/catalog';

const custom = { label: 'A', tool: 'bash', command: 'x', threads: 1 };
const catalogData = () => buildCatalogNodeData(findTool('fastqc')!, []);

describe('defaults', () => {
  it('opens what a first step needs and folds the rest', () => {
    for (const s of ['basics', 'io', 'options'] as const) expect(defaultOpen(s, custom)).toBe(true);
    for (const s of ['reliability', 'checks'] as const) expect(defaultOpen(s, custom)).toBe(false);
  });

  it('opens Advanced for a hand-written step (its command lives there) but not a catalog step', () => {
    expect(defaultOpen('advanced', custom)).toBe(true);
    expect(defaultOpen('advanced', catalogData())).toBe(false);
  });

  it('prefers what the person chose', () => {
    expect(isSectionOpen('reliability', {}, custom)).toBe(false);
    expect(isSectionOpen('reliability', { reliability: true }, custom)).toBe(true);
    expect(isSectionOpen('basics', { basics: false }, custom)).toBe(false);
  });
});

describe('fields', () => {
  it('maps a field to its section and control', () => {
    expect(sectionForField('label')).toBe('basics');
    expect(sectionForField('tool')).toBe('basics');
    expect(sectionForField('input')).toBe('io');
    expect(sectionForField('output')).toBe('io');
    expect(sectionForField('param:threads')).toBe('options');
    expect(sectionForField('command')).toBe('advanced');
    expect(sectionForField('checkExistsTarget')).toBe('checks');
    expect(testIdForField('label')).toBe('prop-label');
    expect(testIdForField('param:outdir')).toBe('catalog-param-outdir');
    expect(testIdForField('checkMinLinesTarget')).toBe('prop-check-min-lines-target');
  });
});

describe('formatTimeout', () => {
  it('says seconds, minutes and hours the way a person would', () => {
    expect(formatTimeout(45)).toBe('45 s');
    expect(formatTimeout(600)).toBe('10 min');
    expect(formatTimeout(90)).toBe('1 min 30 s');
    expect(formatTimeout(3600)).toBe('1 h');
    expect(formatTimeout(5400)).toBe('1 h 30 min');
  });
});

describe('summaries', () => {
  it('reliability reads like the task example', () => {
    expect(sectionSummary('reliability', { retries: 2, timeoutSecs: 600 })).toBe('2 retries, 10 min timeout');
    expect(sectionSummary('reliability', { retries: 1 })).toBe('1 retry, no time limit');
    expect(sectionSummary('reliability', {})).toBe('No retries, no time limit');
  });

  it('basics shows the tool and threads', () => {
    expect(sectionSummary('basics', { tool: 'fastqc', threads: 4 })).toBe('fastqc, 4 threads');
    expect(sectionSummary('basics', { tool: '', threads: 1 })).toBe('No tool yet, 1 thread');
  });

  it('inputs and outputs shows files or patterns', () => {
    expect(sectionSummary('io', { input: 'a.txt', output: 'b.txt' })).toBe('in: a.txt, out: b.txt');
    expect(sectionSummary('io', { input: '', output: '' })).toBe('no input, no output');
    expect(sectionSummary('io', { output: 'o' }, { fileCount: 3 })).toBe('3 files, out: o');
    expect(sectionSummary('io', { input: 'a', output: 'b' }, { upstreamCount: 1 })).toBe('after 1 step, in: a, out: b');
    expect(sectionSummary('io', { output: 'b' }, { upstreamCount: 2 })).toMatch(/^after 2 steps, /);
    expect(sectionSummary('io', { input: 'x'.repeat(60), output: '' })).toMatch(/…/);
  });

  it('checks lists what is on, and says when there is nothing to check', () => {
    expect(sectionSummary('checks', { output: '' })).toBe('Needs an output');
    expect(sectionSummary('checks', { output: 'o' })).toBe('None');
    expect(sectionSummary('checks', { output: 'o', checkExists: true, checkNonEmpty: true })).toBe(
      'exists, non-empty'
    );
    expect(sectionSummary('checks', { output: 'o', checkExists: true, checkBlocking: false })).toBe(
      'exists (warn only)'
    );
  });

  it('advanced and options say what is not default', () => {
    expect(sectionSummary('advanced', { ...custom, mock: true })).toBe('Mocked');
    expect(sectionSummary('advanced', custom)).toBe('Command');
    expect(sectionSummary('advanced', { ...catalogData(), catalogCommandCustom: true })).toBe('Command edited');
    expect(sectionSummary('options', catalogData())).toBe('Defaults');
    expect(sectionSummary('options', custom)).toBe('');
  });

  it('has a summary for every section', () => {
    for (const s of SECTION_ORDER) expect(typeof sectionSummary(s, custom)).toBe('string');
  });
});

describe('remembered state', () => {
  it('keeps known sections with boolean values and drops the rest', () => {
    expect(parseOpenState(JSON.stringify({ basics: false, checks: true, junk: true, io: 'yes' }))).toEqual({
      basics: false,
      checks: true,
    });
  });

  it('survives missing or broken storage', () => {
    expect(parseOpenState(null)).toEqual({});
    expect(parseOpenState('{nope')).toEqual({});
    expect(parseOpenState('[1,2]')).toEqual({});
    expect(parseOpenState('"x"')).toEqual({});
  });
});
