/**
 * The properties panel is a stack of collapsible sections. This holds what is
 * not React: which section a field lives in, which sections start open, the
 * one-line summary shown on a collapsed header, and the remembered open state.
 */

import {
  isBlocking,
  normalizeRetries,
  normalizeThreads,
  normalizeTimeout,
} from './workflowConversion';
import { defaultParams, findTool, missingRequiredParams } from './tools/catalog';
import type { IssueField } from './validation';

export type SectionId = 'basics' | 'io' | 'options' | 'reliability' | 'checks' | 'advanced';

/** Top to bottom as drawn. `options` only exists for steps made from the catalog. */
export const SECTION_ORDER: SectionId[] = ['basics', 'io', 'options', 'reliability', 'checks', 'advanced'];

export const SECTION_TITLES: Record<SectionId, string> = {
  basics: 'Basics',
  io: 'Inputs and outputs',
  options: 'Options',
  reliability: 'Reliability',
  checks: 'Output checks',
  advanced: 'Advanced',
};

const isOn = (value: unknown) => value === true || value === 'true';

/**
 * Whether a section starts open, before the person has opened or closed it.
 * Everything a first step needs is open; the rest waits. A hand-written step
 * keeps its command in Advanced, which is the one thing it cannot do without,
 * so there Advanced starts open.
 */
export function defaultOpen(section: SectionId, data: Record<string, any>): boolean {
  switch (section) {
    case 'basics':
    case 'io':
    case 'options':
      return true;
    case 'advanced':
      return !findTool(data.catalogId);
    default:
      return false;
  }
}

/** The section a field belongs to, so a problem on it can open the right one. */
export function sectionForField(field: IssueField): SectionId {
  if (field === 'label' || field === 'tool') return 'basics';
  if (field === 'input' || field === 'output') return 'io';
  if (field === 'command') return 'advanced';
  if (field.startsWith('param:')) return 'options';
  return 'checks';
}

/** The data-testid of the control for a field. */
export function testIdForField(field: IssueField): string {
  if (field.startsWith('param:')) return `catalog-param-${field.slice('param:'.length)}`;
  switch (field) {
    case 'label':
      return 'prop-label';
    case 'tool':
      return 'prop-tool';
    case 'command':
      return 'prop-command';
    case 'input':
      return 'prop-input';
    case 'output':
      return 'prop-output';
    case 'checkExistsTarget':
      return 'prop-check-exists-target';
    case 'checkNonEmptyTarget':
      return 'prop-check-non-empty-target';
    default:
      return 'prop-check-min-lines-target';
  }
}

/** "30 s", "10 min", "1 h 30 min": a timeout as a person would say it. */
export function formatTimeout(secs: number): string {
  if (secs < 60) return `${secs} s`;
  if (secs < 3600) {
    const m = Math.floor(secs / 60);
    const s = secs % 60;
    return s === 0 ? `${m} min` : `${m} min ${s} s`;
  }
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  return m === 0 ? `${h} h` : `${h} h ${m} min`;
}

function clip(text: string, max = 28): string {
  const t = text.trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** The one-line summary of a section, shown while it is collapsed. */
export function sectionSummary(
  section: SectionId,
  data: Record<string, any>,
  extra: { fileCount?: number; upstreamCount?: number } = {}
): string {
  switch (section) {
    case 'basics': {
      const threads = normalizeThreads(data.threads);
      const tool = String(data.tool ?? '').trim();
      return `${tool || 'No tool yet'}, ${threads} thread${threads === 1 ? '' : 's'}`;
    }
    case 'io': {
      const parts: string[] = [];
      if (extra.upstreamCount) {
        parts.push(`after ${extra.upstreamCount} step${extra.upstreamCount === 1 ? '' : 's'}`);
      }
      if (extra.fileCount) parts.push(`${extra.fileCount} file${extra.fileCount === 1 ? '' : 's'}`);
      else if (data.input) parts.push(`in: ${clip(String(data.input))}`);
      else parts.push('no input');
      parts.push(data.output ? `out: ${clip(String(data.output))}` : 'no output');
      return parts.join(', ');
    }
    case 'options': {
      const tool = findTool(data.catalogId);
      if (!tool) return '';
      const missing = missingRequiredParams(tool, data.catalogParams).length;
      if (missing > 0) return `${missing} to fill in`;
      const defaults = defaultParams(tool);
      const values = { ...defaults, ...(data.catalogParams ?? {}) };
      const changed = tool.params.filter((p) => String(values[p.id]) !== String(defaults[p.id])).length;
      return changed === 0 ? 'Defaults' : `${changed} changed`;
    }
    case 'reliability': {
      const retries = normalizeRetries(data.retries);
      const timeout = normalizeTimeout(data.timeoutSecs);
      const r = retries === 0 ? 'No retries' : `${retries} ${retries === 1 ? 'retry' : 'retries'}`;
      const t = timeout === undefined ? 'no time limit' : `${formatTimeout(timeout)} timeout`;
      return `${r}, ${t}`;
    }
    case 'checks': {
      if (!data.output) return 'Needs an output';
      const on: string[] = [];
      if (isOn(data.checkExists)) on.push('exists');
      if (isOn(data.checkNonEmpty)) on.push('non-empty');
      if (isOn(data.checkMinLinesEnabled)) on.push('line count');
      if (on.length === 0) return 'None';
      return `${on.join(', ')}${isBlocking(data.checkBlocking) ? '' : ' (warn only)'}`;
    }
    case 'advanced': {
      const parts: string[] = [];
      if (isOn(data.mock)) parts.push('Mocked');
      if (findTool(data.catalogId) && data.catalogCommandCustom === true) parts.push('Command edited');
      return parts.length > 0 ? parts.join(', ') : findTool(data.catalogId) ? 'Defaults' : 'Command';
    }
  }
}

// -----------------------------------------------------------------------------
// Remembered open state
// -----------------------------------------------------------------------------

const STORAGE_KEY = 'rustrunner.panelSections.v1';

export type OpenState = Partial<Record<SectionId, boolean>>;

/** Keeps only known section ids with boolean values. */
export function parseOpenState(raw: unknown): OpenState {
  if (typeof raw !== 'string') return {};
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: OpenState = {};
    for (const id of SECTION_ORDER) {
      if (typeof parsed[id] === 'boolean') out[id] = parsed[id];
    }
    return out;
  } catch {
    return {};
  }
}

/** Storage can be missing or throw (private window, blocked data): then nothing is remembered. */
export function loadOpenState(): OpenState {
  try {
    return parseOpenState(window.localStorage.getItem(STORAGE_KEY));
  } catch {
    return {};
  }
}

export function saveOpenState(state: OpenState): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    /* not remembered; the panel still works */
  }
}

/** Whether a section is open: what the person chose, else its default. */
export function isSectionOpen(
  section: SectionId,
  chosen: OpenState,
  data: Record<string, any>
): boolean {
  return chosen[section] ?? defaultOpen(section, data);
}
