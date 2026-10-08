/**
 * Fresh conda environments for the real-tool suite.
 *
 * The suite used to take whatever environment the engine found in the sandbox.
 * That let a hand-installed package hide a gap in the catalog: riboWaltz's
 * entry lacked txdbmaker, the suite passed because someone had installed
 * txdbmaker into the sandbox environment, and a real user's fresh install
 * failed. So now:
 *
 * - every conda `install` block of a chain is built FRESH from its spec (the
 *   catalog's own packages, channels and platform, nothing else) into a clean
 *   prefix `.sandbox/envs/<hash>/<name>`, where `<hash>` is a hash of that spec and
 *   `<name>` the name the engine gives the environment. The same spec is built
 *   once and reused, so repeat runs stay fast;
 * - a prefix is never reused if it was modified after it was created: a
 *   conda environment records each command that changed it as a `# cmd:` line in
 *   `conda-meta/history`, so more than one means someone ran `install`, `update`
 *   or `remove` on it, and the suite stops with a message instead;
 * - the engine finds the prefix by its name: `.sandbox/envs/<hash>` is handed to
 *   micromamba as an extra environment folder (`CONDA_ENVS_DIRS`), where `micromamba
 *   env list` and `run -n <name>` see it. So the engine runs the chain's steps in
 *   the fresh environment and does not build one. (A symbolic link inside the
 *   engine's own environment folder does not work: micromamba lists a link by its
 *   target's path, not by its name.)
 *
 * This file is plain logic and file handling, with micromamba passed in, so it
 * is unit-tested without touching conda (`envs.test.ts`).
 */
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

/** A catalog `install` block of kind conda, as written in a workflow's YAML. */
export interface CondaInstall {
  kind: 'conda';
  package: string;
  version?: string;
  channel?: string;
  osx64?: boolean;
  constraints?: string[];
}

export function isCondaInstall(install: unknown): install is CondaInstall {
  return (
    typeof install === 'object' &&
    install !== null &&
    (install as { kind?: unknown }).kind === 'conda' &&
    typeof (install as { package?: unknown }).package === 'string'
  );
}

/** The platform name the engine uses (`current_platform` in install.rs). */
export function currentPlatform(platform: string = process.platform, arch: string = process.arch): string {
  if (platform === 'darwin') return arch === 'arm64' ? 'osx-arm64' : 'osx-64';
  if (platform === 'linux') return arch === 'arm64' ? 'linux-aarch64' : 'linux-64';
  if (platform === 'win32') return 'win-64';
  return `${platform}-${arch}`;
}

/** Same as `sanitize` in install.rs. */
function sanitize(text: string): string {
  return text.replace(/[^A-Za-z0-9._-]/g, '_');
}

const sha256Hex = (text: string): string => createHash('sha256').update(text).digest('hex');

/**
 * The name the engine gives the environment of `install` (`conda_env_name` in
 * install.rs): package and version, a hash of the extra packages, `-osx64` for
 * the Intel build on Apple silicon. The engine looks the environment up by this
 * name, so it must match; `envs.test.ts` checks it against the catalog and
 * `ensureEngineFoundIt` checks the engine's log on every run.
 */
export function engineEnvName(install: CondaInstall, platform: string): string {
  let name = sanitize(install.package);
  if (install.version) name += `-${sanitize(install.version)}`;
  if (install.constraints && install.constraints.length > 0) {
    name += `-x${sha256Hex(install.constraints.join('\n')).slice(0, 8)}`;
  }
  if (install.osx64 && platform === 'osx-arm64') name += '-osx64';
  return name;
}

/** What micromamba is asked to install, from where, for which platform. */
export interface EnvRecipe {
  specs: string[];
  channels: string[];
  /** `CONDA_SUBDIR` when not the native platform; null otherwise. */
  subdir: string | null;
}

/** The recipe of an install block, the same one the engine uses (`conda_specs`, `conda_channels`, `conda_subdir`). */
export function recipeOf(install: CondaInstall, platform: string): EnvRecipe {
  const specs = [install.version ? `${install.package}==${install.version}` : install.package, ...(install.constraints ?? [])];
  const channels = [install.channel ?? 'bioconda'];
  if (!channels.includes('conda-forge')) channels.push('conda-forge');
  return { specs, channels, subdir: install.osx64 && platform === 'osx-arm64' ? 'osx-64' : null };
}

/** A short key for a recipe: the same recipe always gives the same key, any change gives another. */
export function recipeHash(recipe: EnvRecipe): string {
  return sha256Hex(JSON.stringify({ specs: recipe.specs, channels: recipe.channels, subdir: recipe.subdir })).slice(0, 16);
}

/** How many commands created or changed the environment: the `# cmd:` lines of its history. */
export function countHistoryCommands(history: string): number {
  return history.split('\n').filter((line) => line.startsWith('# cmd:')).length;
}

/** Thrown when an environment was changed after it was created. */
export class ModifiedEnvError extends Error {}

/**
 * Stops unless the environment at `prefix` is exactly as its creation left it:
 * one `# cmd:` line in `conda-meta/history`. An environment that someone added
 * a package to is not what a user gets from the catalog, so a test that passes
 * in it proves nothing.
 */
export function assertUntouched(prefix: string): void {
  const history = path.join(prefix, 'conda-meta', 'history');
  if (!fs.existsSync(history)) {
    throw new ModifiedEnvError(`${prefix} has no conda-meta/history, so it cannot be checked. Delete it (rm -rf ${prefix}) and run again.`);
  }
  const text = fs.readFileSync(history, 'utf8');
  const count = countHistoryCommands(text);
  if (count > 1) {
    const commands = text
      .split('\n')
      .filter((l) => l.startsWith('# cmd:'))
      .map((l) => `    ${l}`)
      .join('\n');
    throw new ModifiedEnvError(
      `The conda environment ${prefix} was modified after it was created ` +
        `(${count} commands in conda-meta/history, expected 1):\n${commands}\n` +
        `A tool test that passes in a hand-patched environment can hide a missing package in the catalog. ` +
        `Delete it (rm -rf ${prefix}) and run again; it is rebuilt from the catalog spec.`
    );
  }
}

/** Runs micromamba; passed in so this file does not depend on the harness. */
export type MambaRunner = (args: string[], env: Record<string, string>) => { status: number | null; stderr: string };

export interface PreparedEnv {
  /** The clean prefix, `<envsDir>/<hash>/<name>`. */
  prefix: string;
  /** The folder holding it, `<envsDir>/<hash>`: what goes into `CONDA_ENVS_DIRS`. */
  envsDir: string;
  /** The name the engine looks it up by. */
  name: string;
  hash: string;
  /** True when an earlier build was reused. */
  reused: boolean;
}

const COMPLETE_MARKER = '.rustrunner-env-complete';

/**
 * Builds the environment of `install` from its spec into `<envsDir>/<hash>/<name>`
 * (or reuses the one already built from the same spec, after checking it is
 * untouched). Anything of that name in the engine's own environment folder (an
 * environment the engine made earlier, a hand-patched one) is removed first, so
 * micromamba cannot find it before the fresh one: the sandbox owns that folder.
 * The caller puts the returned `envsDir` into `CONDA_ENVS_DIRS` for the engine.
 */
export function prepareEnv(opts: {
  install: CondaInstall;
  platform: string;
  /** Where the fresh prefixes live, `.sandbox/envs`. */
  envsDir: string;
  /** The engine's environment folder, `$HOME/.rustrunner/micromamba/envs`. */
  engineEnvsDir: string;
  mamba: MambaRunner;
  /** Environment for micromamba (HOME, MAMBA_ROOT_PREFIX). */
  env: Record<string, string>;
}): PreparedEnv {
  const recipe = recipeOf(opts.install, opts.platform);
  const hash = recipeHash(recipe);
  const name = engineEnvName(opts.install, opts.platform);
  const hashDir = path.join(opts.envsDir, hash);
  const prefix = path.join(hashDir, name);

  let reused = false;
  if (fs.existsSync(path.join(prefix, COMPLETE_MARKER))) {
    assertUntouched(prefix);
    reused = true;
  } else {
    // A folder without the marker is a build that was interrupted: not a modified
    // environment, just an unfinished one.
    fs.rmSync(hashDir, { recursive: true, force: true });
    fs.mkdirSync(hashDir, { recursive: true });
    const args = ['create', '-y', '-p', prefix, ...recipe.channels.flatMap((c) => ['-c', c]), ...recipe.specs];
    const env = recipe.subdir ? { ...opts.env, CONDA_SUBDIR: recipe.subdir } : opts.env;
    const result = opts.mamba(args, env);
    if (result.status !== 0) {
      fs.rmSync(hashDir, { recursive: true, force: true });
      throw new Error(`Could not build the environment for ${recipe.specs.join(' ')} (${recipe.channels.join(', ')}): ${result.stderr.trim().split('\n').slice(-3).join(' | ')}`);
    }
    assertUntouched(prefix);
    fs.writeFileSync(path.join(prefix, COMPLETE_MARKER), `${JSON.stringify(recipe)}\n`);
  }

  fs.rmSync(path.join(opts.engineEnvsDir, name), { recursive: true, force: true });
  return { prefix, envsDir: hashDir, name, hash, reused };
}

/**
 * Checks the engine's log: it must have found the environment under the name
 * the suite prepared (it logs "Environment '<name>' already exists"). If the
 * names ever drift apart the engine would build an environment of its own and
 * the test would run in something nobody checked.
 */
export function ensureEngineFoundIt(log: string, names: string[]): string[] {
  return names
    .filter((name) => !log.includes(`Environment '${name}' already exists`))
    .map((name) => `the engine did not use the prepared environment '${name}' (the harness and the engine disagree about its name)`);
}
