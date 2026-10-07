import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CATALOG } from '../src/renderer/tools/catalog';
import {
  ModifiedEnvError,
  assertUntouched,
  countHistoryCommands,
  currentPlatform,
  engineEnvName,
  ensureEngineFoundIt,
  isCondaInstall,
  prepareEnv,
  recipeHash,
  recipeOf,
  type CondaInstall,
  type MambaRunner,
} from './envs';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'envs-test-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

/** The install block of the catalog tool that installs conda package `pkg`. */
function catalogInstall(pkg: string): CondaInstall {
  const tool = CATALOG.tools.find((t) => (t.install as CondaInstall | undefined)?.package === pkg);
  if (!tool) throw new Error(`no catalog tool installs ${pkg}`);
  return tool.install as CondaInstall;
}

const RIBOWALTZ: CondaInstall = {
  kind: 'conda',
  package: 'ribowaltz',
  channel: 'bioconda',
  version: '2.0',
  constraints: ['bioconductor-txdbmaker==1.2.0'],
};

const HISTORY_ONE = '==> 2026-01-01 00:00:00 <==\n# cmd: micromamba create -y -p x ribowaltz==2.0\n# update specs: []\n';
const HISTORY_TWO = `${HISTORY_ONE}==> 2026-01-02 00:00:00 <==\n# cmd: micromamba install -y -p x txdbmaker\n`;

/** A micromamba that makes a prefix with one history line, as `create` does. */
function fakeMamba(calls: string[][] = []): MambaRunner {
  return (args) => {
    calls.push(args);
    const prefix = args[args.indexOf('-p') + 1];
    fs.mkdirSync(path.join(prefix, 'conda-meta'), { recursive: true });
    fs.writeFileSync(path.join(prefix, 'conda-meta', 'history'), HISTORY_ONE);
    return { status: 0, stderr: '' };
  };
}

describe('engineEnvName mirrors the engine', () => {
  it('names a pin, extra packages and the Intel build like conda_env_name', () => {
    expect(engineEnvName({ kind: 'conda', package: 'samtools', version: '1.24' }, 'osx-arm64')).toBe('samtools-1.24');
    expect(engineEnvName({ kind: 'conda', package: 'bracken', version: '2.6.1', osx64: true }, 'osx-arm64')).toBe('bracken-2.6.1-osx64');
    expect(engineEnvName({ kind: 'conda', package: 'bracken', version: '2.6.1', osx64: true }, 'linux-64')).toBe('bracken-2.6.1');
    expect(engineEnvName({ kind: 'conda', package: 'a b', version: '1+x' }, 'linux-64')).toBe('a_b-1_x');
  });

  it('gives the names of the environments the engine really made for the catalog', () => {
    // Taken from a real run: the 8 hex digits are the engine's hash of the extra packages.
    const quast = catalogInstall('quast');
    expect(engineEnvName(quast, 'osx-arm64')).toBe('quast-5.3.0-xac6b8717-osx64');
    const pod5 = catalogInstall('pod5');
    expect(engineEnvName(pod5, 'osx-arm64')).toBe('pod5-0.3.48-x6a12bfa6');
  });

  it('gives riboWaltz a name with the hash of its extra package, so the old environment is never found', () => {
    const catalog = catalogInstall('ribowaltz');
    expect(catalog.constraints).toContain('bioconductor-txdbmaker==1.2.0');
    expect(engineEnvName(catalog, 'osx-arm64')).toMatch(/^ribowaltz-2\.0-x[0-9a-f]{8}$/);
  });
});

describe('recipes', () => {
  it('lists the pin, the extra packages, bioconda then conda-forge, and the Intel subdir on Apple silicon', () => {
    expect(recipeOf(RIBOWALTZ, 'linux-64')).toEqual({
      specs: ['ribowaltz==2.0', 'bioconductor-txdbmaker==1.2.0'],
      channels: ['bioconda', 'conda-forge'],
      subdir: null,
    });
    const intel = { kind: 'conda', package: 'x', osx64: true } as CondaInstall;
    expect(recipeOf(intel, 'osx-arm64').subdir).toBe('osx-64');
    expect(recipeOf(intel, 'linux-64').subdir).toBeNull();
    expect(recipeOf({ kind: 'conda', package: 'x', channel: 'conda-forge' }, 'linux-64').channels).toEqual(['conda-forge']);
  });

  it('changes the hash when anything the environment is built from changes', () => {
    const base = recipeOf(RIBOWALTZ, 'linux-64');
    const same = recipeOf({ ...RIBOWALTZ }, 'linux-64');
    expect(recipeHash(same)).toBe(recipeHash(base));
    expect(recipeHash(recipeOf({ ...RIBOWALTZ, constraints: [] }, 'linux-64'))).not.toBe(recipeHash(base));
    expect(recipeHash(recipeOf({ ...RIBOWALTZ, version: '2.1' }, 'linux-64'))).not.toBe(recipeHash(base));
    expect(recipeHash(recipeOf({ ...RIBOWALTZ, channel: 'conda-forge' }, 'linux-64'))).not.toBe(recipeHash(base));
    expect(recipeHash(recipeOf({ ...RIBOWALTZ, osx64: true }, 'osx-arm64'))).not.toBe(recipeHash(recipeOf(RIBOWALTZ, 'osx-arm64')));
  });

  it('recognises conda install blocks only', () => {
    expect(isCondaInstall(RIBOWALTZ)).toBe(true);
    expect(isCondaInstall({ kind: 'system', binary: 'sh' })).toBe(false);
    expect(isCondaInstall(undefined)).toBe(false);
    expect(currentPlatform('darwin', 'arm64')).toBe('osx-arm64');
    expect(currentPlatform('linux', 'x64')).toBe('linux-64');
  });
});

describe('the history guard', () => {
  const prefixWith = (history: string | null): string => {
    const prefix = path.join(dir, 'env');
    fs.mkdirSync(path.join(prefix, 'conda-meta'), { recursive: true });
    if (history !== null) fs.writeFileSync(path.join(prefix, 'conda-meta', 'history'), history);
    return prefix;
  };

  it('counts the # cmd: lines', () => {
    expect(countHistoryCommands('')).toBe(0);
    expect(countHistoryCommands(HISTORY_ONE)).toBe(1);
    expect(countHistoryCommands(HISTORY_TWO)).toBe(2);
    // A package name that contains the words is not a command line.
    expect(countHistoryCommands('+libfoo-# cmd: x\n# update specs: ["# cmd: x"]\n')).toBe(0);
  });

  it('accepts an environment made by one command', () => {
    expect(() => assertUntouched(prefixWith(HISTORY_ONE))).not.toThrow();
  });

  it('refuses an environment that something was installed into, and says how to fix it', () => {
    const prefix = prefixWith(HISTORY_TWO);
    expect(() => assertUntouched(prefix)).toThrow(ModifiedEnvError);
    expect(() => assertUntouched(prefix)).toThrow(/2 commands in conda-meta\/history, expected 1/);
    expect(() => assertUntouched(prefix)).toThrow(/micromamba install -y -p x txdbmaker/);
    expect(() => assertUntouched(prefix)).toThrow(/rm -rf /);
  });

  it('refuses an environment it cannot check', () => {
    expect(() => assertUntouched(path.join(dir, 'none'))).toThrow(/no conda-meta\/history/);
  });
});

describe('prepareEnv', () => {
  const setup = (calls: string[][] = [], mamba: MambaRunner = fakeMamba(calls)) => {
    const envsDir = path.join(dir, 'envs');
    const engineEnvsDir = path.join(dir, 'home', 'envs');
    const go = (install: CondaInstall = RIBOWALTZ) =>
      prepareEnv({ install, platform: 'linux-64', envsDir, engineEnvsDir, mamba, env: { HOME: dir } });
    return { envsDir, engineEnvsDir, go };
  };

  it('builds a fresh prefix keyed by the recipe from exactly the catalog spec, in a folder of its own', () => {
    const calls: string[][] = [];
    const { envsDir, engineEnvsDir, go } = setup(calls);
    const env = go();
    expect(env.reused).toBe(false);
    expect(env.prefix).toBe(path.join(envsDir, env.hash, env.name));
    expect(env.envsDir).toBe(path.join(envsDir, env.hash));
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual([
      'create', '-y', '-p', env.prefix, '-c', 'bioconda', '-c', 'conda-forge', 'ribowaltz==2.0', 'bioconductor-txdbmaker==1.2.0',
    ]);
    // Nothing is put into the engine's own environment folder.
    expect(fs.existsSync(path.join(engineEnvsDir, env.name))).toBe(false);
  });

  it('reuses the prefix of the same recipe without building again', () => {
    const calls: string[][] = [];
    const { go } = setup(calls);
    go();
    const again = go();
    expect(again.reused).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it('builds a different prefix for a different recipe', () => {
    const calls: string[][] = [];
    const { go } = setup(calls);
    const a = go();
    const b = go({ ...RIBOWALTZ, constraints: [] });
    expect(a.prefix).not.toBe(b.prefix);
    expect(calls).toHaveLength(2);
  });

  it('never reuses a prefix that was modified after it was built', () => {
    const { go } = setup();
    const env = go();
    fs.writeFileSync(path.join(env.prefix, 'conda-meta', 'history'), HISTORY_TWO);
    expect(() => go()).toThrow(ModifiedEnvError);
  });

  it('removes an environment of that name from the engine\'s own folder, a hand-patched one included, so it cannot be found first', () => {
    const { engineEnvsDir, go } = setup();
    const old = path.join(engineEnvsDir, engineEnvName(RIBOWALTZ, 'linux-64'));
    fs.mkdirSync(path.join(old, 'conda-meta'), { recursive: true });
    fs.writeFileSync(path.join(old, 'conda-meta', 'history'), HISTORY_TWO);
    go();
    expect(fs.existsSync(old)).toBe(false);
  });

  it('rebuilds a build that was interrupted instead of reusing it', () => {
    const calls: string[][] = [];
    const { envsDir, go } = setup(calls);
    const half = path.join(envsDir, recipeHash(recipeOf(RIBOWALTZ, 'linux-64')), 'ribowaltz-2.0-x0ad66132', 'conda-meta');
    fs.mkdirSync(half, { recursive: true });
    fs.writeFileSync(path.join(half, 'history'), HISTORY_ONE);
    expect(go().reused).toBe(false);
    expect(calls).toHaveLength(1);
  });

  it('removes the prefix and explains when micromamba fails', () => {
    const failing: MambaRunner = (args) => {
      fs.mkdirSync(args[args.indexOf('-p') + 1], { recursive: true });
      return { status: 1, stderr: 'line one\nnothing provides txdbmaker' };
    };
    const { envsDir, go } = setup([], failing);
    expect(() => go()).toThrow(/nothing provides txdbmaker/);
    expect(fs.readdirSync(envsDir)).toEqual([]);
    expect(go).toThrow(/nothing provides txdbmaker/);
  });

  it('passes CONDA_SUBDIR for the Intel build on Apple silicon only', () => {
    let seen: Record<string, string> = {};
    const mamba: MambaRunner = (args, env) => {
      seen = env;
      return fakeMamba()(args, env);
    };
    const { envsDir, engineEnvsDir } = setup();
    prepareEnv({ install: { kind: 'conda', package: 'x', osx64: true }, platform: 'osx-arm64', envsDir, engineEnvsDir, mamba, env: { HOME: dir } });
    expect(seen.CONDA_SUBDIR).toBe('osx-64');
  });
});

describe('ensureEngineFoundIt', () => {
  it('passes when the engine logged finding every prepared environment', () => {
    const log = "Preparing tool: conda x\nEnvironment 'a-1' already exists\nEnvironment 'b-2' already exists\n";
    expect(ensureEngineFoundIt(log, ['a-1', 'b-2'])).toEqual([]);
  });

  it('names an environment the engine did not find, such as one it built itself', () => {
    const log = "Creating environment 'a-1' with: [..]\n";
    expect(ensureEngineFoundIt(log, ['a-1'])).toEqual([expect.stringContaining("'a-1'")]);
  });
});
