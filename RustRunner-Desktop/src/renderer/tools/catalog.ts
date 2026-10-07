/**
 * The bundled tool catalog (schema version 2): types, validation, search,
 * command rendering and file-type matching. Pure logic, no React or Electron
 * imports, so it is unit-testable.
 *
 * `catalog.json` is data only. A catalog entry becomes an ordinary node: its
 * `tool` is the command the install provides (the conda package, or the
 * binary), and the node keeps `catalogId`, `catalogParams` and
 * `catalogSchema` so the Properties panel can show the option form and
 * re-render the command. At run time the YAML step also carries the tool's
 * `install` block (see `installYaml`) so the engine installs exactly the
 * pinned version.
 *
 * Schema v2, per tool:
 *   id, name, description, category, subcategory, docs
 *   install   conda { package, channel, version (pinned), osx64? }
 *             | external { binary, version, url{platform}, sha256{platform}, license }
 *             | system { binary }
 *   inputs    [{ name, label, description, types, required, multiple, example? }]
 *   outputs   [{ name, label, description, types, pattern, is_dir }]
 *             or a derived output { ..., derived: { from, suffix } } whose file
 *             is another output's file plus a suffix (STAR's BAM in its folder)
 *   params    [{ id, label, type, default, description, ... }]
 *   command   template using slot names, parameter ids and `{threads}`
 *   threads   default thread count
 *   needs_database?  { label, hint, link? }  the tool needs reference data to be set up
 * File types come from `file_types`; an input slot may also say `any`.
 */

import catalogJson from './catalog.json';
import { labelToId, normalizeThreads } from '../stepNames';

export type ParamType = 'number' | 'string' | 'boolean' | 'select';

export type ParamValue = string | number | boolean;

export interface ToolParam {
  id: string;
  label: string;
  type: ParamType;
  default: ParamValue;
  description: string;
  /** Allowed values of a `select` parameter. */
  options?: string[];
  /**
   * What the form shows for an option whose value is not plain words (a flag
   * like `--rf`, or `2`): `{ '--rf': 'Reverse-stranded (dUTP kits)' }`. An
   * option without a label shows its value. The value is what the command gets.
   */
  option_labels?: Record<string, string>;
  /** Bounds of a `number` parameter. */
  min?: number;
  max?: number;
  /** Size of one step of the number field's arrows; 1 when absent. Use a fraction for options like 0.05. */
  step?: number;
  /** What a ticked `boolean` parameter adds to the command; unticked adds nothing. */
  flag?: string;
  /** A `string` parameter that must be filled in before the tool can run. */
  required?: boolean;
}

/** A file a tool reads. The command refers to it as `{name}`. */
export interface InputSlot {
  /** The placeholder name used in the command: letters, digits, underscores. */
  name: string;
  /** What the person sees above the field, in plain words. */
  label: string;
  /** One or two short lines: what the file is and where to get it. */
  description: string;
  /** File types it takes (from `Catalog.file_types`), or `any`. */
  types: string[];
  /** False: the step runs without it and `{name}` expands to nothing. */
  required: boolean;
  /** True: several files (or several connected steps) can fill it. */
  multiple: boolean;
  /** A file name shown as the field's placeholder text, never used as a value. */
  example?: string;
}

/** A file or folder a tool writes. The command refers to it as `{name}`. */
export interface OutputSlot {
  name: string;
  label: string;
  description: string;
  /** File types it makes; for a folder, the types of what it holds. */
  types: string[];
  /** The file name a new step starts with (a folder ends in `/`). Absent for a derived output. */
  pattern?: string;
  /** The output is a folder. */
  is_dir: boolean;
  /**
   * The file is another output plus a suffix: `{ from: 'out_dir', suffix:
   * 'quant.sf' }` makes `salmon_out/quant.sf` from `salmon_out/`. It follows
   * that output and has no field of its own.
   */
  derived?: { from: string; suffix: string };
}

export type Platform = 'linux-64' | 'linux-aarch64' | 'osx-64' | 'osx-arm64' | 'win-64';

export const PLATFORMS: Platform[] = ['linux-64', 'linux-aarch64', 'osx-64', 'osx-arm64', 'win-64'];

/** How a platform is named for the person. */
export const PLATFORM_NAMES: Record<Platform, string> = {
  'linux-64': 'Linux (Intel or AMD)',
  'linux-aarch64': 'Linux (ARM)',
  'osx-64': 'macOS on Intel',
  'osx-arm64': 'macOS on Apple silicon',
  'win-64': 'Windows',
};

export interface CondaInstall {
  kind: 'conda';
  package: string;
  channel: string;
  /** One exact version: the engine installs `package==version` into its own environment. */
  version: string;
  /** Install the Intel build on Apple silicon (runs under Rosetta). */
  osx64?: boolean;
  /**
   * Extra packages installed beside the tool, each a name with a version limit
   * such as `polars<2`. For a dependency whose newest release breaks the pinned
   * tool; the engine gives such a set an environment of its own.
   */
  constraints?: string[];
}

export interface ExternalInstall {
  kind: 'external';
  /** The executable the command runs. */
  binary: string;
  version: string;
  /** Download address per platform; `{version}` is filled in. */
  url: Partial<Record<Platform, string>>;
  /** Hex SHA-256 of that download, per platform. */
  sha256: Partial<Record<Platform, string>>;
  /** The licence, in a few words, shown to the person. */
  license: string;
}

export interface SystemInstall {
  kind: 'system';
  /** A program the computer must already have on its PATH. */
  binary: string;
}

export type Install = CondaInstall | ExternalInstall | SystemInstall;

export interface NeedsDatabase {
  /** What to prepare, in plain words: "Kraken2 database". */
  label: string;
  /** Where to get it and how big it is. Short enough to read in a few lines. */
  hint: string;
  /** A page to download or read about it, shown as a short labelled link. */
  link?: { label: string; url: string };
}

export interface CatalogTool {
  id: string;
  name: string;
  description: string;
  category: string;
  subcategory: string;
  /** Link to the tool's own documentation (https). */
  docs: string;
  install: Install;
  inputs: InputSlot[];
  outputs: OutputSlot[];
  params: ToolParam[];
  /**
   * Command template. Slot names stay in the command for the engine to fill
   * with files; `{threads}` and `{<param id>}` are filled by the editor.
   */
  command: string;
  /** Default thread count. */
  threads: number;
  needs_database?: NeedsDatabase;
}

export interface Catalog {
  schema_version: number;
  version: string;
  file_types: string[];
  categories: Record<string, { label: string; color: string }>;
  tools: CatalogTool[];
}

/** The schema version this code reads. */
export const CATALOG_SCHEMA_VERSION = 2;

export const CATALOG: Catalog = catalogJson as unknown as Catalog;

/** The parameter types the form can render. */
export const PARAM_TYPES: ParamType[] = ['number', 'string', 'boolean', 'select'];

/** An input slot with this type takes a file of any type. */
export const ANY_TYPE = 'any';

/** Names the engine fills itself; a slot or parameter cannot use them. */
export const RESERVED_NAMES = ['input', 'output', 'inputs', 'outputs', 'threads'];

/** Longest slot name the engine accepts. */
export const MAX_SLOT_NAME = 40;

/** What the node's Tool field holds: the conda package, or the binary. */
export function catalogToolName(tool: CatalogTool): string {
  return tool.install.kind === 'conda' ? tool.install.package : tool.install.binary;
}

/** The names of a tool's file slots, inputs first. */
export function slotNames(tool: CatalogTool): string[] {
  return [...tool.inputs, ...tool.outputs].map((s) => s.name);
}

/** The file types a tool reads, without repeats (`any` when a slot takes anything). */
export function inputTypesOf(tool: CatalogTool): string[] {
  return [...new Set(tool.inputs.flatMap((s) => s.types))];
}

/** The file types a tool makes, without repeats. */
export function outputTypesOf(tool: CatalogTool): string[] {
  return [...new Set(tool.outputs.flatMap((s) => s.types))];
}

/** Whether two lists of file types share one, where `any` fits every type. */
export function typesFit(a: string[], b: string[]): boolean {
  if (a.length === 0 || b.length === 0) return false;
  if (a.includes(ANY_TYPE) || b.includes(ANY_TYPE)) return true;
  return a.some((t) => b.includes(t));
}

/**
 * The `install` block the engine reads for a step made from `tool`, in the
 * YAML's own spelling. Nothing else of the catalog reaches the YAML.
 */
export function installYaml(install: Install): Record<string, unknown> {
  switch (install.kind) {
    case 'conda': {
      const out: Record<string, unknown> = {
        kind: 'conda',
        package: install.package,
        version: install.version,
        channel: install.channel,
      };
      if (install.osx64) out.osx64 = true;
      if (install.constraints && install.constraints.length > 0) out.constraints = [...install.constraints];
      return out;
    }
    case 'external':
      return {
        kind: 'external',
        binary: install.binary,
        version: install.version,
        url: { ...install.url },
        sha256: { ...install.sha256 },
        license: install.license,
      };
    case 'system':
      return { kind: 'system', binary: install.binary };
  }
}

/** One line for the Properties panel: where the tool comes from. */
export function describeInstall(install: Install): string {
  switch (install.kind) {
    case 'conda':
      return `Installed from ${install.channel} (conda): ${install.package} ${install.version}${
        install.osx64 ? ', Intel build on Apple silicon' : ''
      }${install.constraints?.length ? `, with ${install.constraints.join(' ')}` : ''}.`;
    case 'external': {
      const platforms = PLATFORMS.filter((p) => p in install.url);
      const where =
        platforms.length < PLATFORMS.length
          ? ` Available for ${platforms.map((p) => PLATFORM_NAMES[p]).join(', ')} only.`
          : '';
      return `Downloaded and checked on first use: ${install.binary} ${install.version} (${install.license}).${where}`;
    }
    case 'system':
      return `Uses ${install.binary} from your computer. Install it yourself and make sure it is on your PATH.`;
  }
}

// -----------------------------------------------------------------------------
// Schema validation
// -----------------------------------------------------------------------------

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const nonEmpty = (value: unknown): value is string => typeof value === 'string' && value.trim() !== '';

const PLAIN_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
/** One exact version: no ranges, wildcards or comparison operators. */
const EXACT_VERSION = /^[0-9][A-Za-z0-9._+-]*$/;
const SHA256 = /^[0-9a-f]{64}$/;
/** An extra package spec: a plain name, an operator, then plain version text (same rule as the engine). */
const CONSTRAINT = /^[A-Za-z0-9][A-Za-z0-9._-]*[<>=!~][A-Za-z0-9._+*,<>=!~-]*$/;
const SLOT_NAME = /^[a-z][a-z0-9_]*$/;

/** Matches `{name}` placeholders, with the one space before it (see `renderCommand`). */
const PLACEHOLDER = / ?\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

/** The placeholder names a template uses, in order, without repeats. */
export function templatePlaceholders(template: string): string[] {
  const names: string[] = [];
  for (const match of template.matchAll(PLACEHOLDER)) {
    if (!names.includes(match[1])) names.push(match[1]);
  }
  return names;
}

function validateInstall(where: string, install: unknown, errors: string[]): void {
  if (!isRecord(install)) {
    errors.push(`${where}: install is missing`);
    return;
  }
  switch (install.kind) {
    case 'conda': {
      if (!nonEmpty(install.package) || !PLAIN_NAME.test(install.package)) {
        errors.push(`${where}: conda package must be a plain package name`);
      }
      if (!nonEmpty(install.channel) || !PLAIN_NAME.test(install.channel)) {
        errors.push(`${where}: conda channel must be a plain channel name`);
      }
      if (!nonEmpty(install.version) || !EXACT_VERSION.test(install.version)) {
        errors.push(`${where}: conda version must be pinned to one exact version such as 1.24`);
      }
      if (install.osx64 !== undefined && typeof install.osx64 !== 'boolean') {
        errors.push(`${where}: osx64 must be true or false`);
      }
      if (install.constraints !== undefined) {
        if (!Array.isArray(install.constraints)) {
          errors.push(`${where}: constraints must be a list of package limits such as polars<2`);
        } else {
          for (const spec of install.constraints) {
            if (typeof spec !== 'string' || !CONSTRAINT.test(spec)) {
              errors.push(`${where}: constraint ${JSON.stringify(spec)} must be a package name with a version limit such as polars<2`);
            }
          }
        }
      }
      break;
    }
    case 'external': {
      if (!nonEmpty(install.binary) || !/^[A-Za-z0-9._-]+$/.test(install.binary)) {
        errors.push(`${where}: external binary must be a file name without folders`);
      }
      if (!nonEmpty(install.version) || !EXACT_VERSION.test(install.version)) {
        errors.push(`${where}: external version must be one exact version`);
      }
      if (!nonEmpty(install.license)) errors.push(`${where}: external install needs a license note`);
      const url = isRecord(install.url) ? install.url : {};
      const sha = isRecord(install.sha256) ? install.sha256 : {};
      if (Object.keys(url).length === 0) errors.push(`${where}: external install needs a download url per platform`);
      for (const [platform, address] of Object.entries(url)) {
        if (!(PLATFORMS as string[]).includes(platform)) errors.push(`${where}: unknown platform ${platform}`);
        if (typeof address !== 'string' || !address.startsWith('https://')) {
          errors.push(`${where}: the ${platform} download must be an https:// address`);
        }
        if (typeof sha[platform] !== 'string' || !SHA256.test(sha[platform] as string)) {
          errors.push(`${where}: the ${platform} download needs a 64-character lower-case sha256`);
        }
      }
      for (const platform of Object.keys(sha)) {
        if (!(platform in url)) errors.push(`${where}: sha256 given for ${platform} without a url`);
      }
      break;
    }
    case 'system': {
      if (!nonEmpty(install.binary) || !/^[A-Za-z0-9._-]+$/.test(install.binary)) {
        errors.push(`${where}: system binary must be a program name`);
      }
      break;
    }
    default:
      errors.push(`${where}: install kind must be conda, external or system`);
  }
}

function validateParams(where: string, params: unknown, errors: string[]): ToolParam[] {
  if (!Array.isArray(params)) {
    errors.push(`${where}: params must be a list`);
    return [];
  }
  const valid: ToolParam[] = [];
  const seen = new Set<string>();
  for (const raw of params) {
    if (!isRecord(raw) || !nonEmpty(raw.id)) {
      errors.push(`${where}: a parameter has no id`);
      continue;
    }
    const at = `${where}.${raw.id}`;
    if (!SLOT_NAME.test(raw.id)) errors.push(`${at}: parameter ids use lower-case letters, digits and underscores`);
    if (RESERVED_NAMES.includes(raw.id)) errors.push(`${at}: is a reserved name`);
    if (seen.has(raw.id)) errors.push(`${at}: duplicate parameter id`);
    seen.add(raw.id);
    if (!nonEmpty(raw.label)) errors.push(`${at}: needs a label`);
    if (!nonEmpty(raw.description)) errors.push(`${at}: needs a description`);
    if (!(PARAM_TYPES as string[]).includes(raw.type as string)) {
      errors.push(`${at}: type must be one of ${PARAM_TYPES.join(', ')}`);
      continue;
    }
    const param = raw as unknown as ToolParam;
    switch (param.type) {
      case 'number':
        if (typeof param.default !== 'number') errors.push(`${at}: default must be a number`);
        if (param.min !== undefined && typeof param.default === 'number' && param.default < param.min) {
          errors.push(`${at}: default is below min`);
        }
        if (param.max !== undefined && typeof param.default === 'number' && param.default > param.max) {
          errors.push(`${at}: default is above max`);
        }
        if (param.step !== undefined && !(typeof param.step === 'number' && Number.isFinite(param.step) && param.step > 0)) {
          errors.push(`${at}: step must be a number above 0`);
        }
        break;
      case 'boolean':
        if (typeof param.default !== 'boolean') errors.push(`${at}: default must be true or false`);
        if (!nonEmpty(param.flag)) errors.push(`${at}: a checkbox needs the flag it adds`);
        break;
      case 'select':
        if (!Array.isArray(param.options) || param.options.length === 0) {
          errors.push(`${at}: a choice needs options`);
        } else if (!param.options.includes(param.default as string)) {
          errors.push(`${at}: default is not one of the options`);
        }
        if (param.option_labels !== undefined) {
          const labels = param.option_labels as unknown;
          if (!isRecord(labels)) {
            errors.push(`${at}: option_labels must map option values to text`);
          } else {
            for (const [value, text] of Object.entries(labels)) {
              if (!param.options?.includes(value)) errors.push(`${at}: option_labels names "${value}", which is not an option`);
              else if (!nonEmpty(text)) errors.push(`${at}: the label of option "${value}" is empty`);
            }
          }
        }
        break;
      case 'string':
        if (typeof param.default !== 'string') errors.push(`${at}: default must be text`);
        break;
    }
    valid.push(param);
  }
  return valid;
}

/**
 * Everything wrong with a catalog document, one plain sentence each; empty
 * when it is valid. Checks the schema version, unique tool ids, the install
 * block of every tool (conda tools must be pinned to an exact version), slot
 * and parameter names, file types, derived outputs, and that every placeholder
 * of every command is defined and every slot and parameter is used.
 */
export function validateCatalog(raw: unknown): string[] {
  const errors: string[] = [];
  if (!isRecord(raw)) return ['the catalog is not an object'];
  if (raw.schema_version !== CATALOG_SCHEMA_VERSION) {
    errors.push(`schema_version must be ${CATALOG_SCHEMA_VERSION}`);
  }
  if (!nonEmpty(raw.version)) errors.push('the catalog needs a version');

  const fileTypes = Array.isArray(raw.file_types) ? (raw.file_types as unknown[]) : [];
  if (fileTypes.length === 0 || !fileTypes.every(nonEmpty)) errors.push('file_types must be a list of names');
  if (new Set(fileTypes).size !== fileTypes.length) errors.push('file_types has a repeat');
  if (fileTypes.includes(ANY_TYPE)) errors.push(`"${ANY_TYPE}" is reserved and cannot be a file type`);

  const categories = isRecord(raw.categories) ? raw.categories : {};
  for (const [id, category] of Object.entries(categories)) {
    if (!isRecord(category) || !nonEmpty(category.label) || !nonEmpty(category.color)) {
      errors.push(`category ${id} needs a label and a color`);
    }
  }

  if (!Array.isArray(raw.tools) || raw.tools.length === 0) {
    errors.push('the catalog has no tools');
    return errors;
  }
  const ids = new Set<string>();
  const names = new Set<string>();

  for (const entry of raw.tools) {
    if (!isRecord(entry) || !nonEmpty(entry.id)) {
      errors.push('a tool has no id');
      continue;
    }
    const where = entry.id;
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(entry.id)) errors.push(`${where}: id uses lower-case letters, digits and dashes`);
    if (ids.has(entry.id)) errors.push(`${where}: duplicate tool id`);
    ids.add(entry.id);
    if (!nonEmpty(entry.name)) errors.push(`${where}: needs a name`);
    else if (names.has(entry.name)) errors.push(`${where}: another tool has the name ${entry.name}`);
    else names.add(entry.name);
    if (!nonEmpty(entry.description)) errors.push(`${where}: needs a description`);
    if (!nonEmpty(entry.category) || !(entry.category in categories)) {
      errors.push(`${where}: category is not one of the catalog's categories`);
    }
    if (!nonEmpty(entry.subcategory)) errors.push(`${where}: needs a subcategory`);
    if (!nonEmpty(entry.docs) || !entry.docs.startsWith('https://')) errors.push(`${where}: docs must be an https:// link`);
    if (!Number.isInteger(entry.threads) || (entry.threads as number) < 1) {
      errors.push(`${where}: threads must be a whole number of at least 1`);
    }
    if (entry.needs_database !== undefined) {
      const db = entry.needs_database;
      if (!isRecord(db) || !nonEmpty(db.label) || !nonEmpty(db.hint)) {
        errors.push(`${where}: needs_database needs a label and a hint`);
      } else if (db.link !== undefined) {
        const link = db.link;
        if (!isRecord(link) || !nonEmpty(link.label) || !nonEmpty(link.url) || !link.url.startsWith('https://')) {
          errors.push(`${where}: needs_database link needs a label and an https:// url`);
        }
      }
    }
    validateInstall(where, entry.install, errors);
    const params = validateParams(where, entry.params, errors);

    // Slots.
    const slotNamesSeen = new Set<string>();
    const checkSlotName = (name: unknown, at: string): name is string => {
      if (!nonEmpty(name) || !SLOT_NAME.test(name)) {
        errors.push(`${at}: slot names use lower-case letters, digits and underscores`);
        return false;
      }
      if (name.length > MAX_SLOT_NAME) errors.push(`${at}: slot name is longer than ${MAX_SLOT_NAME} characters`);
      if (RESERVED_NAMES.includes(name)) errors.push(`${at}: ${name} is a reserved placeholder`);
      if (slotNamesSeen.has(name)) errors.push(`${at}: slot name used twice`);
      if (params.some((p) => p.id === name)) errors.push(`${at}: slot name is also a parameter`);
      slotNamesSeen.add(name);
      return true;
    };
    const checkTypes = (types: unknown, at: string, allowAny: boolean) => {
      if (!Array.isArray(types) || types.length === 0) {
        errors.push(`${at}: needs at least one file type`);
        return;
      }
      for (const type of types) {
        if (allowAny && type === ANY_TYPE) continue;
        if (!fileTypes.includes(type)) errors.push(`${at}: unknown file type ${String(type)}`);
      }
    };

    const inputs = Array.isArray(entry.inputs) ? entry.inputs : [];
    if (inputs.length === 0) errors.push(`${where}: a tool needs at least one input slot`);
    for (const slot of inputs) {
      if (!isRecord(slot)) continue;
      const at = `${where}.${String(slot.name)}`;
      if (!checkSlotName(slot.name, at)) continue;
      if (!nonEmpty(slot.label)) errors.push(`${at}: needs a label`);
      if (!nonEmpty(slot.description)) errors.push(`${at}: needs a description`);
      checkTypes(slot.types, at, true);
      if (typeof slot.required !== 'boolean') errors.push(`${at}: required must be true or false`);
      if (typeof slot.multiple !== 'boolean') errors.push(`${at}: multiple must be true or false`);
      if (slot.example !== undefined && !nonEmpty(slot.example)) errors.push(`${at}: example must be text`);
    }

    const outputs = Array.isArray(entry.outputs) ? entry.outputs : [];
    if (outputs.length === 0) errors.push(`${where}: a tool needs at least one output slot`);
    const derivedNames: string[] = [];
    for (const slot of outputs) {
      if (!isRecord(slot)) continue;
      const at = `${where}.${String(slot.name)}`;
      if (!checkSlotName(slot.name, at)) continue;
      if (!nonEmpty(slot.label)) errors.push(`${at}: needs a label`);
      if (!nonEmpty(slot.description)) errors.push(`${at}: needs a description`);
      checkTypes(slot.types, at, false);
      if (typeof slot.is_dir !== 'boolean') errors.push(`${at}: is_dir must be true or false`);
      const hasPattern = slot.pattern !== undefined;
      const hasDerived = slot.derived !== undefined;
      if (hasPattern === hasDerived) errors.push(`${at}: give either a pattern or a derived rule, not both and not neither`);
      if (hasPattern) {
        if (!nonEmpty(slot.pattern) || /[{}\s]/.test(slot.pattern)) {
          errors.push(`${at}: pattern must be a plain file name without braces or spaces`);
        } else if (slot.pattern.endsWith('/') !== (slot.is_dir === true)) {
          errors.push(`${at}: a folder's pattern ends in / and a file's does not`);
        }
      }
      if (hasDerived) {
        derivedNames.push(slot.name as string);
        const rule = slot.derived;
        if (!isRecord(rule) || !nonEmpty(rule.from) || !nonEmpty(rule.suffix)) {
          errors.push(`${at}: derived needs from and suffix`);
        } else {
          const source = outputs.find((o) => isRecord(o) && o.name === rule.from);
          if (!source || !isRecord(source) || source.derived !== undefined) {
            errors.push(`${at}: derived.from must name another output that is not itself derived`);
          } else if (source.is_dir === true && /^[\\/]/.test(rule.suffix)) {
            errors.push(`${at}: the suffix goes straight after the folder's /`);
          }
          if (/\s/.test(rule.suffix)) errors.push(`${at}: derived.suffix must not contain spaces`);
        }
      }
    }

    // Command: every placeholder defined, every parameter and slot used.
    if (!nonEmpty(entry.command)) {
      errors.push(`${where}: needs a command`);
      continue;
    }
    const defined = new Set<string>(['threads', ...slotNamesSeen, ...params.map((p) => p.id)]);
    const used = templatePlaceholders(entry.command);
    for (const name of used) {
      if (!defined.has(name)) errors.push(`${where}: {${name}} in the command is not defined`);
    }
    for (const p of params) {
      if (!used.includes(p.id)) errors.push(`${where}: parameter ${p.id} is never used in the command`);
    }
    for (const name of slotNamesSeen) {
      // A derived output is a file the tool writes by its own name; the command need not mention it.
      if (derivedNames.includes(name)) continue;
      if (!used.includes(name)) errors.push(`${where}: slot ${name} is never used in the command`);
    }
  }
  return errors;
}

// -----------------------------------------------------------------------------
// Lookup and search
// -----------------------------------------------------------------------------

export function findTool(id: unknown, catalog: Catalog = CATALOG): CatalogTool | undefined {
  return typeof id === 'string' ? catalog.tools.find((t) => t.id === id) : undefined;
}

export function categoryLabel(category: string, catalog: Catalog = CATALOG): string {
  return catalog.categories[category]?.label ?? category;
}

/**
 * Tools matching `query`, in catalog order. Every word of the query must occur
 * in the tool's name, id, category, subcategory, tool name or description
 * (case insensitive). `category` narrows the result to one category.
 */
export function searchTools(
  query: string,
  category: string = '',
  catalog: Catalog = CATALOG
): CatalogTool[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return catalog.tools.filter((tool) => {
    if (category && tool.category !== category) return false;
    const haystack = [
      tool.name,
      tool.id,
      tool.category,
      categoryLabel(tool.category, catalog),
      tool.subcategory,
      catalogToolName(tool),
      tool.description,
    ]
      .join(' ')
      .toLowerCase();
    return words.every((word) => haystack.includes(word));
  });
}

/** The parameter values a new node starts with. */
export function defaultParams(tool: CatalogTool): Record<string, ParamValue> {
  const values: Record<string, ParamValue> = {};
  for (const param of tool.params) values[param.id] = param.default;
  return values;
}

/** Quotes a value for bash unless it only holds characters that are safe unquoted. */
export function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** The number a `number` parameter stands for: its default when `raw` is unusable, clamped to its bounds. */
export function coerceNumber(param: ToolParam, raw: unknown): number {
  let n = typeof raw === 'number' ? raw : raw === '' || raw == null ? NaN : Number(raw);
  if (!Number.isFinite(n)) n = Number(param.default);
  if (param.min !== undefined) n = Math.max(n, param.min);
  if (param.max !== undefined) n = Math.min(n, param.max);
  return n;
}

/**
 * The text a parameter adds to the command, or null when it is a required
 * string that is still empty (the placeholder then stays in the command so the
 * gap is visible).
 */
function renderParam(param: ToolParam, raw: unknown): string | null {
  switch (param.type) {
    case 'number':
      return String(coerceNumber(param, raw));
    case 'boolean': {
      const on = raw === true || raw === 'true';
      return on ? param.flag ?? '' : '';
    }
    case 'select': {
      const value = typeof raw === 'string' ? raw : String(raw ?? '');
      return param.options?.includes(value) ? value : String(param.default);
    }
    case 'string': {
      const value = typeof raw === 'string' ? raw.trim() : '';
      if (value === '') return param.required ? null : '';
      return shellQuote(value);
    }
  }
}

/**
 * Fills a catalog command template. `{threads}` and the tool's parameters are
 * replaced; the file slots and any unknown placeholder stay as they are, for
 * the engine to fill with the step's files.
 * A parameter that renders empty (an unticked flag, an empty optional string)
 * also removes the space before it, so no double spaces are left behind.
 */
export function renderCommand(
  tool: CatalogTool,
  params: Record<string, unknown> = {},
  threads: unknown = tool.threads
): string {
  return tool.command.replace(PLACEHOLDER, (match: string, name: string) => {
    const lead = match.startsWith(' ') ? ' ' : '';
    if (name === 'threads') return lead + String(normalizeThreads(threads));
    const param = tool.params.find((p) => p.id === name);
    if (!param) return match;
    const text = renderParam(param, name in params ? params[name] : param.default);
    if (text === null) return match;
    return text === '' ? '' : lead + text;
  });
}

/** Ids of required parameters that are still empty. */
export function missingRequiredParams(
  tool: CatalogTool,
  params: Record<string, unknown> = {}
): string[] {
  return tool.params
    .filter((p) => p.required && p.type === 'string')
    .filter((p) => {
      const value = p.id in params ? params[p.id] : p.default;
      return typeof value !== 'string' || value.trim() === '';
    })
    .map((p) => p.id);
}

/**
 * A label for a new node that no other node uses. Two labels clash when they
 * give the same step id, so "FastQC" and "fastqc 2" count as different but
 * "FastQC" and "fastqc" do not.
 */
export function uniqueLabel(base: string, existingLabels: string[]): string {
  const taken = new Set(existingLabels.map((l) => labelToId(l)));
  if (!taken.has(labelToId(base))) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base} ${n}`;
    if (!taken.has(labelToId(candidate))) return candidate;
  }
}

/** The file names a new node starts with for its (non-derived) output slots. */
export function defaultSlotFiles(tool: CatalogTool): Record<string, string> {
  const files: Record<string, string> = {};
  for (const slot of tool.outputs) {
    if (slot.pattern !== undefined) files[slot.name] = slot.pattern;
  }
  return files;
}

/** The data of a node freshly made from a catalog tool. */
export function buildCatalogNodeData(
  tool: CatalogTool,
  existingLabels: string[],
  catalog: Catalog = CATALOG
): Record<string, unknown> {
  const params = defaultParams(tool);
  return {
    label: uniqueLabel(tool.name, existingLabels),
    tool: catalogToolName(tool),
    command: renderCommand(tool, params, tool.threads),
    input: '',
    output: '',
    threads: tool.threads,
    color: catalog.categories[tool.category]?.color,
    catalogId: tool.id,
    catalogSchema: CATALOG_SCHEMA_VERSION,
    catalogParams: params,
    slotFiles: defaultSlotFiles(tool),
  };
}

/**
 * A node's data after a parameter or the thread count changed. The command is
 * rendered again unless the user has edited it by hand (`catalogCommandCustom`),
 * so typing in the command box is never overwritten behind their back.
 */
export function applyParamChange(
  tool: CatalogTool,
  data: Record<string, any>,
  change: { params?: Record<string, ParamValue>; threads?: unknown }
): Record<string, unknown> {
  const params = change.params ?? data.catalogParams ?? defaultParams(tool);
  const threads = 'threads' in change ? change.threads : data.threads;
  const patch: Record<string, unknown> = {};
  if (change.params) patch.catalogParams = params;
  if (data.catalogCommandCustom !== true) patch.command = renderCommand(tool, params, threads);
  return patch;
}

/** Run-time check: catalog steps whose generated command still has a gap. */
export function validateCatalogNodes(nodes: any[], catalog: Catalog = CATALOG): string[] {
  const errors: string[] = [];
  for (const node of nodes) {
    const data = node.data ?? {};
    const tool = findTool(data.catalogId, catalog);
    if (!tool || data.catalogCommandCustom === true) continue;
    const missing = missingRequiredParams(tool, data.catalogParams);
    if (missing.length > 0) {
      const names = missing
        .map((id) => tool.params.find((p) => p.id === id)?.label ?? id)
        .join(', ');
      errors.push(`Step ${labelToId(data.label || '')}: fill in ${names}`);
    }
  }
  return errors;
}

export type TypeCheckStatus = 'match' | 'mismatch' | 'unknown';

export interface TypeCheck {
  status: TypeCheckStatus;
  /** The file types both ends agree on (only for `match`). */
  shared: string[];
  /** One sentence for the edge tooltip. */
  message: string;
  /** For `mismatch`: what the source makes and what the target expects. */
  made?: string[];
  expected?: string[];
}

/**
 * Galaxy-style check of a connection: does something `source` produces fit
 * something `target` accepts? Never blocks; it only informs. When either end is
 * not a catalog tool its types are unknown and the edge stays neutral. An input
 * slot that takes `any` file fits everything.
 */
export function checkConnection(
  source: CatalogTool | undefined,
  target: CatalogTool | undefined
): TypeCheck {
  if (!source || !target) {
    return {
      status: 'unknown',
      shared: [],
      message: 'File types are not checked: one of the steps is not a catalog tool.',
    };
  }
  const made = outputTypesOf(source);
  const expected = inputTypesOf(target);
  if (typesFit(made, expected)) {
    const shared = expected.includes(ANY_TYPE) ? made : made.filter((t) => expected.includes(t));
    return {
      status: 'match',
      shared,
      message: `Types match: ${source.name} makes ${shared.join(', ')}, which ${target.name} accepts.`,
    };
  }
  return {
    status: 'mismatch',
    shared: [],
    made,
    expected,
    message:
      `Types differ: ${source.name} makes ${made.join(', ')}, ` +
      `but ${target.name} expects ${expected.join(', ')}. The connection still works.`,
  };
}

/** The check of one edge, looked up from the nodes it joins. */
export function checkEdge(edge: any, nodes: any[], catalog: Catalog = CATALOG): TypeCheck {
  const source = nodes.find((n: any) => n.id === edge.source);
  const target = nodes.find((n: any) => n.id === edge.target);
  return checkConnection(
    findTool(source?.data?.catalogId, catalog),
    findTool(target?.data?.catalogId, catalog)
  );
}
