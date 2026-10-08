/**
 * Brings steps saved with the version 1 tool catalog up to schema v2.
 *
 * A v1 catalog step had one main Input and one main Output, and its reference
 * genome, index, annotation and output folders were text options of the form.
 * In v2 every file is a named slot, so the same information now lives in
 * `slotFiles`: the old Input becomes the tool's reads (or alignments) slot, the
 * old Output becomes its output slot, and the file options move to their slots.
 * What the person typed is carried over, so a saved workflow keeps meaning the
 * same files and the same command.
 *
 * Rules:
 *  - Only a step that has a `catalogId` and no `catalogSchema: 2` is touched, so
 *    migrating twice changes nothing.
 *  - A step whose command was never edited by hand gets its command rebuilt
 *    from the new template and the carried-over options.
 *  - A step whose command was edited by hand keeps that command and its main
 *    Input and Output as they were (the command still says `{input}`), and
 *    only gets the schema mark. The one repair applied to hand-edited text is
 *    STAR's old `--readFilesCommand zcat`, which cannot read .gz files on
 *    macOS: it becomes `gzip -cdf`, which reads plain and gzip FASTQ everywhere.
 *  - Nothing else about the step (name, position, colour, checks, retries,
 *    timeout, mock, wildcard name) changes.
 *
 * Pure, so it is unit-tested; App.tsx calls it when a workflow file is opened.
 */

import {
  CATALOG,
  CATALOG_SCHEMA_VERSION,
  catalogToolName,
  defaultParams,
  defaultSlotFiles,
  findTool,
  renderCommand,
  type Catalog,
  type CatalogTool,
} from './catalog';
import { declaredOutputs } from '../stepNames';

interface V1Plan {
  /** The v2 input slots the old main Input fills, in order (extra files go to the last). */
  input: string[];
  /** The v2 output slot the old main Output fills, if it still has one. */
  output?: string;
  /** Old option id -> the slot that took it over (`dir`: it names a folder). */
  params: Record<string, { slot: string; dir?: boolean }>;
}

/** What each v1 catalog tool's fields became in v2. */
const V1_PLANS: Record<string, V1Plan> = {
  fastqc: { input: ['reads'], params: { outdir: { slot: 'report_dir', dir: true } } },
  multiqc: { input: ['reports'], params: { outdir: { slot: 'report_dir', dir: true } } },
  fastp: {
    input: ['reads'],
    output: 'trimmed',
    params: { html_report: { slot: 'html_report' }, json_report: { slot: 'json_report' } },
  },
  cutadapt: { input: ['reads'], output: 'trimmed', params: {} },
  'bwa-mem': { input: ['reads1', 'reads2'], output: 'sam', params: { ref: { slot: 'ref' } } },
  bowtie2: { input: ['reads'], output: 'sam', params: { index: { slot: 'index' } } },
  star: {
    input: ['reads'],
    params: { genome_dir: { slot: 'index' }, prefix: { slot: 'out_dir', dir: true } },
  },
  'samtools-sort': { input: ['alignments'], output: 'bam', params: {} },
  'samtools-index': { input: ['bam'], output: 'bai', params: {} },
  'samtools-view': { input: ['alignments'], output: 'filtered', params: {} },
  'samtools-flagstat': { input: ['alignments'], output: 'report', params: {} },
  'bcftools-call': { input: ['bam'], output: 'vcf', params: { ref: { slot: 'ref' } } },
  'salmon-quant': {
    input: ['reads'],
    params: { index: { slot: 'index' }, outdir: { slot: 'out_dir', dir: true } },
  },
  featurecounts: {
    input: ['bams'],
    output: 'counts',
    params: { annotation: { slot: 'annotation' } },
  },
};

/** STAR's old decompression command, which macOS's zcat cannot run on .gz files. */
const OLD_STAR_READ_COMMAND = /--readFilesCommand\s+zcat\b/g;
const NEW_STAR_READ_COMMAND = '--readFilesCommand gzip -cdf';

/** A folder name as a path that ends in one slash. */
function asFolder(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, '');
  return trimmed === '' ? '' : `${trimmed}/`;
}

/** Replaces STAR's zcat decompression in a command text. */
export function repairStarReadCommand(command: string): string {
  return command.replace(OLD_STAR_READ_COMMAND, NEW_STAR_READ_COMMAND);
}

/** True for a step made from the catalog that has not been brought to the current schema. */
export function needsMigration(data: any, catalog: Catalog = CATALOG): boolean {
  return (
    data !== null &&
    typeof data === 'object' &&
    findTool(data.catalogId, catalog) !== undefined &&
    data.catalogSchema !== CATALOG_SCHEMA_VERSION
  );
}

/** Spreads the old Input over the slots it now belongs to. */
function distributeInputs(raw: unknown, slots: string[]): Record<string, string> {
  const files = declaredOutputs(raw);
  const out: Record<string, string> = {};
  if (files.length === 0 || slots.length === 0) return out;
  slots.forEach((slot, index) => {
    const mine = index === slots.length - 1 ? files.slice(index) : files.slice(index, index + 1);
    if (mine.length > 0) out[slot] = mine.join(', ');
  });
  return out;
}

/** The v2 data of a step saved with the v1 catalog. */
function migrateData(data: Record<string, any>, tool: CatalogTool): Record<string, any> {
  const plan = V1_PLANS[tool.id];
  const oldParams: Record<string, unknown> =
    data.catalogParams && typeof data.catalogParams === 'object' ? data.catalogParams : {};

  // Options that still exist keep their value; the ones that became file slots leave the form.
  const params = defaultParams(tool);
  for (const param of tool.params) {
    if (param.id in oldParams) params[param.id] = oldParams[param.id] as any;
  }

  const custom = data.catalogCommandCustom === true;
  const next: Record<string, any> = {
    ...data,
    tool: typeof data.tool === 'string' && data.tool.trim() !== '' ? data.tool : catalogToolName(tool),
    catalogSchema: CATALOG_SCHEMA_VERSION,
    catalogParams: params,
  };

  if (custom || !plan) {
    // The person's own command stays as it is, with its `{input}` and `{output}`.
    if (tool.id === 'star') next.command = repairStarReadCommand(String(data.command ?? ''));
    return next;
  }

  // Carry the old files over into their slots.
  const slotFiles: Record<string, string> = { ...defaultSlotFiles(tool) };
  if (data.slotFiles && typeof data.slotFiles === 'object') Object.assign(slotFiles, data.slotFiles);
  Object.assign(slotFiles, distributeInputs(data.input, plan.input));
  const mainOutput = typeof data.output === 'string' ? data.output.trim() : '';
  if (plan.output && mainOutput !== '') slotFiles[plan.output] = mainOutput;
  for (const [paramId, target] of Object.entries(plan.params)) {
    const raw = oldParams[paramId];
    if (typeof raw !== 'string' || raw.trim() === '') continue;
    slotFiles[target.slot] = target.dir ? asFolder(raw) : raw.trim();
  }
  next.slotFiles = slotFiles;
  next.input = '';
  next.output = '';
  next.command = renderCommand(tool, params, data.threads ?? tool.threads);

  // A check aimed at a file the step no longer has as such would be reported
  // as stale; point it at all outputs instead.
  const outputs = new Set(
    tool.outputs.flatMap((s) =>
      s.derived
        ? declaredOutputs(slotFiles[s.derived.from]).map((f) => f + s.derived!.suffix)
        : declaredOutputs(slotFiles[s.name])
    )
  );
  for (const key of ['checkExistsTarget', 'checkNonEmptyTarget', 'checkMinLinesTarget']) {
    const target = data[key];
    if (typeof target === 'string' && target.trim() !== '' && !outputs.has(target.trim())) {
      next[key] = undefined;
    }
  }
  return next;
}

/** The nodes with every v1 catalog step brought to schema v2, and how many changed. */
export function migrateNodes<N extends { data?: any }>(
  nodes: N[],
  catalog: Catalog = CATALOG
): { nodes: N[]; migrated: number } {
  let migrated = 0;
  const result = nodes.map((node) => {
    if (!needsMigration(node.data, catalog)) return node;
    const tool = findTool(node.data.catalogId, catalog)!;
    migrated++;
    return { ...node, data: migrateData(node.data, tool) };
  });
  return { nodes: result, migrated };
}
