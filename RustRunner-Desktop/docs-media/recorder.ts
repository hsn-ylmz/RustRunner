/**
 * Records the real app for the documentation GIFs.
 *
 * The app is the built one (dist/), started the way the e2e tests start it
 * (HOME, TMPDIR and the profile inside a throwaway folder), at a fixed
 * 1280x800 window in the light theme, with the real engine. Playwright records
 * the window to a video; `scripts/docs-gifs.js` turns the video into a GIF.
 *
 * Three things make a recording followable:
 *   - a visible cursor (a ring that grows when a button is pressed) and a small
 *     caption at the bottom of the window, both added to the page for the
 *     recording only;
 *   - deliberate pauses, and mouse moves in steps, so the eye can follow;
 *   - long waits (installing tools, a step that runs for a minute) are CUT
 *     from the video, not faked: nothing in the app is simulated. A cut is
 *     announced by a caption for the second before it, and its length is
 *     written to the manifest.
 */

import fs from 'fs';
import path from 'path';
import { _electron, type ElectronApplication, type Locator, type Page } from '@playwright/test';

export const DESKTOP_DIR = path.resolve(__dirname, '..');
export const REPO = path.resolve(DESKTOP_DIR, '..');
/**
 * Where recordings run. DOCS_SANDBOX lets the GIFs be made through a short,
 * neutral path (for example a symlink to .sandbox) so no personal folder names
 * appear in the logs, file fields or reports that end up in public GIFs.
 */
export const SANDBOX = process.env.DOCS_SANDBOX || path.join(REPO, '.sandbox');
export const OUT_DIR = path.join(SANDBOX, 'docs-media');
export const WIDTH = 1280;
export const HEIGHT = 800;

/** The engine, with micromamba, env_map.json and app_resources beside it (as in the packaged app). */
export function prepareEngineDir(): string {
  const dir = path.join(SANDBOX, 'docs-bin');
  fs.mkdirSync(dir, { recursive: true });
  const exe = path.join(dir, 'rustrunner');
  fs.copyFileSync(path.join(REPO, 'RustRunner', 'target', 'debug', 'rustrunner'), exe);
  fs.chmodSync(exe, 0o755);
  const mamba = path.join(REPO, 'RustRunner', 'runtime', 'micromamba');
  if (!fs.existsSync(mamba)) throw new Error(`micromamba is missing: ${mamba}`);
  fs.copyFileSync(mamba, path.join(dir, 'micromamba'));
  fs.chmodSync(path.join(dir, 'micromamba'), 0o755);
  fs.writeFileSync(path.join(dir, 'env_map.json'), JSON.stringify({ map: {} }));
  fs.rmSync(path.join(dir, 'app_resources'), { recursive: true, force: true });
  fs.cpSync(path.join(REPO, 'RustRunner', 'runtime', 'app_resources'), path.join(dir, 'app_resources'), { recursive: true });
  return exe;
}

/** Folders of prepared tool environments (built by the real-tool suite), for CONDA_ENVS_DIRS. */
export function preparedEnvDirs(): string[] {
  const root = path.join(SANDBOX, 'envs');
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root)
    .map((d) => path.join(root, d))
    .filter((d) => fs.statSync(d).isDirectory());
}

/** A folder whose `java` refuses to run (see Recording.start). */
function prepareJavaGuard(): string {
  const dir = path.join(SANDBOX, 'docs-bin', 'java-guard');
  fs.mkdirSync(dir, { recursive: true });
  const java = path.join(dir, 'java');
  fs.writeFileSync(java, '#!/bin/sh\necho "docs recording: a step reached a plain java outside its conda environment" >&2\nexit 97\n');
  fs.chmodSync(java, 0o755);
  return dir;
}

/**
 * Nothing may open a dialog on the person's screen while recording. An uncaught exception in the main
 * process makes Electron show "A JavaScript error occurred in the main process"; a handler is registered
 * instead, and error boxes are replaced, so both are recorded and the recording is stopped on the first.
 */
async function guardAgainstDialogs(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ dialog }) => {
    const g = globalThis as unknown as { __docsMainErrors?: string[] };
    g.__docsMainErrors = [];
    process.on('uncaughtException', (err) => g.__docsMainErrors!.push(`uncaughtException: ${err?.stack ?? err}`));
    process.on('unhandledRejection', (err) => g.__docsMainErrors!.push(`unhandledRejection: ${(err as Error)?.stack ?? err}`));
    dialog.showErrorBox = (title: string, content: string) => {
      g.__docsMainErrors!.push(`error box: ${title}: ${content}`);
    };
  });
}

interface Cut {
  /** Seconds from the start of the recording. */
  from: number;
  to: number;
  reason: string;
}

const CURSOR_SCRIPT = `
(() => {
  if (window.__docsOverlay) return;
  window.__docsOverlay = true;
  const style = document.createElement('style');
  style.textContent = \`
    #docs-cursor { position: fixed; z-index: 2147483647; left: 0; top: 0; width: 26px; height: 26px; margin: -13px 0 0 -13px;
      border: 3px solid #d9480f; border-radius: 50%; background: rgba(217,72,15,0.18); pointer-events: none;
      transition: transform 90ms ease-out, background 90ms; }
    #docs-cursor.down { transform: scale(0.7); background: rgba(217,72,15,0.5); }
    #docs-caption { position: fixed; z-index: 2147483646; left: 50%; bottom: 14px; transform: translateX(-50%);
      max-width: 80%; padding: 8px 16px; border-radius: 8px; background: rgba(24,28,36,0.92); color: #fff;
      font: 600 15px -apple-system, 'Segoe UI', sans-serif; pointer-events: none; display: none; text-align: center; }
  \`;
  document.head.appendChild(style);
  const cursor = document.createElement('div'); cursor.id = 'docs-cursor'; cursor.style.display = 'none';
  const caption = document.createElement('div'); caption.id = 'docs-caption';
  document.body.append(cursor, caption);
  addEventListener('mousemove', (e) => { cursor.style.display = 'block'; cursor.style.left = e.clientX + 'px'; cursor.style.top = e.clientY + 'px'; }, true);
  addEventListener('mousedown', () => cursor.classList.add('down'), true);
  addEventListener('mouseup', () => cursor.classList.remove('down'), true);
  window.__docsCaption = (text) => { caption.textContent = text || ''; caption.style.display = text ? 'block' : 'none'; };
})();
`;

export class Recording {
  readonly cuts: Cut[] = [];
  private t0 = Date.now();

  private constructor(
    readonly name: string,
    readonly app: ElectronApplication,
    readonly page: Page,
    readonly root: string,
    readonly workDir: string
  ) {}

  /** Starts the recorded app. `env` adds to the app's (and so the engine's) environment. */
  static async start(name: string, env: Record<string, string> = {}): Promise<Recording> {
    fs.mkdirSync(OUT_DIR, { recursive: true });
    const root = fs.mkdtempSync(path.join(OUT_DIR, `${name}-`));
    const workDir = path.join(root, 'results');
    for (const d of [workDir, path.join(root, 'home'), path.join(root, 'tmp')]) fs.mkdirSync(d, { recursive: true });
    const exe = prepareEngineDir();
    const home = path.join(root, 'home');
    const app = await _electron.launch({
      args: [DESKTOP_DIR, `--user-data-dir=${path.join(root, 'profile')}`, '--force-device-scale-factor=1'],
      cwd: DESKTOP_DIR,
      env: {
        ...(process.env as Record<string, string>),
        HOME: home,
        TMPDIR: path.join(root, 'tmp'),
        MPLCONFIGDIR: path.join(home, '.matplotlib'),
        XDG_CACHE_HOME: path.join(home, '.cache'),
        MAMBA_ROOT_PREFIX: path.join(home, '.rustrunner', 'micromamba'),
        NODE_ENV: 'production',
        RUSTRUNNER_BIN: exe,
        // A guard `java` first on PATH: a step that reaches a plain 'java' fails loudly here instead of
        // reaching the macOS stub, which opens an "install Java" dialog on the person's screen. Steps in a
        // conda environment put the environment's own Java ahead of this one.
        PATH: `${prepareJavaGuard()}${path.delimiter}${process.env.PATH ?? ''}`,
        ...env,
      },
      recordVideo: { dir: path.join(root, 'video'), size: { width: WIDTH, height: HEIGHT } },
    });
    const page = await app.firstWindow();
    await app.evaluate(({ BrowserWindow, nativeTheme }, size) => {
      nativeTheme.themeSource = 'light';
      const w = BrowserWindow.getAllWindows()[0];
      w.setContentSize(size[0], size[1]);
      w.center();
    }, [WIDTH, HEIGHT]);
    await page.waitForSelector('.workflow-editor');
    await page.emulateMedia({ colorScheme: 'light' });
    await guardAgainstDialogs(app);
    const rec = new Recording(name, app, page, root, workDir);
    rec.t0 = Date.now();
    await page.waitForTimeout(800);
    await page.evaluate(CURSOR_SCRIPT);
    // Native dialogs cannot be driven: unsaved-changes prompts answer "Discard".
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = (async () => ({ response: 0, checkboxChecked: false })) as never;
    });
    await page.mouse.move(WIDTH / 2, HEIGHT / 2);
    return rec;
  }

  /** Seconds since the recording started. */
  now(): number {
    return (Date.now() - this.t0) / 1000;
  }

  /** Throws if the main process raised an error that Electron would have shown as a dialog. */
  async assertNoMainErrors(): Promise<void> {
    const errors = await this.app
      .evaluate(() => (globalThis as unknown as { __docsMainErrors?: string[] }).__docsMainErrors ?? [])
      .catch(() => [] as string[]);
    if (errors.length > 0) throw new Error(`the app's main process reported an error:\n${errors.join('\n')}`);
  }

  async pause(ms = 900): Promise<void> {
    await this.page.waitForTimeout(ms);
    await this.assertNoMainErrors();
  }

  async caption(text: string): Promise<void> {
    await this.page.evaluate((t) => (window as unknown as { __docsCaption?: (s: string) => void }).__docsCaption?.(t), text).catch(() => undefined);
  }

  /** Moves the visible cursor to the middle of `target` in steps, so the eye can follow. */
  async moveTo(target: Locator): Promise<{ x: number; y: number }> {
    await target.scrollIntoViewIfNeeded();
    const box = await target.boundingBox();
    if (!box) throw new Error('nothing to point at');
    const x = box.x + Math.min(box.width / 2, 120);
    const y = box.y + box.height / 2;
    await this.page.mouse.move(x, y, { steps: 22 });
    await this.page.waitForTimeout(250);
    return { x, y };
  }

  async click(target: Locator, after = 600): Promise<void> {
    const { x, y } = await this.moveTo(target);
    await this.page.mouse.down();
    await this.page.waitForTimeout(90);
    await this.page.mouse.up();
    void x;
    void y;
    await this.page.waitForTimeout(after);
  }

  /** Types like a person: one key at a time. */
  async type(target: Locator, text: string, delay = 70): Promise<void> {
    await this.click(target, 200);
    await target.fill('');
    await target.pressSequentially(text, { delay });
    await this.page.waitForTimeout(500);
  }

  /** Drags from the middle of `from` to the middle of `to`, slowly. */
  async drag(from: Locator, to: Locator): Promise<void> {
    const a = (await from.boundingBox())!;
    const b = (await to.boundingBox())!;
    await this.page.mouse.move(a.x + a.width / 2, a.y + a.height / 2, { steps: 20 });
    await this.page.waitForTimeout(250);
    await this.page.mouse.down();
    await this.page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 30 });
    await this.page.waitForTimeout(250);
    await this.page.mouse.up();
    await this.page.waitForTimeout(700);
  }

  /** Cuts the time `work` takes from the video (setup the viewer does not need to watch). */
  async hidden<T>(reason: string, work: () => Promise<T>): Promise<T> {
    const from = this.now();
    const result = await work();
    this.cuts.push({ from, to: this.now(), reason });
    return result;
  }

  /**
   * Waits until `done` is true while the video shows only what changes. `signature` returns a text that
   * changes whenever something on screen worth watching changes (a step started or finished). When it has
   * not changed for `idleSeconds`, a caption says the wait is being cut, one more second is kept, and the
   * rest of the quiet time is cut until the next change.
   */
  async watch(opts: {
    signature: () => Promise<string>;
    done: () => Promise<boolean>;
    idleSeconds?: number;
    timeoutSeconds: number;
    cutCaption: (seconds: number) => string;
  }): Promise<void> {
    const idle = opts.idleSeconds ?? 3;
    const deadline = Date.now() + opts.timeoutSeconds * 1000;
    let last = await opts.signature();
    let changedAt = this.now();
    let cutFrom: number | null = null;
    while (Date.now() < deadline) {
      await this.page.waitForTimeout(300);
      await this.assertNoMainErrors();
      if (await opts.done()) break;
      const sig = await opts.signature();
      const t = this.now();
      if (sig !== last) {
        if (cutFrom !== null) {
          const to = t - 0.4;
          if (to - cutFrom > 1) this.cuts.push({ from: cutFrom, to, reason: 'waiting for the tools' });
          await this.caption('');
          cutFrom = null;
        }
        last = sig;
        changedAt = t;
      } else if (cutFrom === null && t - changedAt > idle) {
        await this.caption(opts.cutCaption(0));
        cutFrom = t + 1;
      }
    }
    if (cutFrom !== null) {
      this.cuts.push({ from: cutFrom, to: this.now() - 0.4, reason: 'waiting for the tools' });
      await this.caption('');
    }
    if (!(await opts.done())) throw new Error(`${this.name}: the run did not finish in ${opts.timeoutSeconds}s`);
  }

  /** After a failure: keeps a screenshot, closes the app so nothing is left running, removes the scratch folder. */
  async abort(error: unknown): Promise<void> {
    const dir = path.join(OUT_DIR, 'failed');
    fs.mkdirSync(dir, { recursive: true });
    await this.page.screenshot({ path: path.join(dir, `${this.name}.png`) }).catch(() => undefined);
    fs.writeFileSync(path.join(dir, `${this.name}.txt`), String((error as Error)?.stack ?? error));
    await this.app.evaluate(({ app }) => app.exit(1)).catch(() => undefined);
    await this.app.close().catch(() => undefined);
    fs.rmSync(this.root, { recursive: true, force: true });
  }

  /** Closes the app, finalises the video and writes the manifest the converter reads. */
  async finish(opts: { trimStart?: number; fps?: number } = {}): Promise<string> {
    const video = this.page.video();
    const total = this.now();
    await this.app.evaluate(({ app }) => app.exit(0)).catch(() => undefined);
    await this.app.close().catch(() => undefined);
    const videoPath = video ? await video.path() : '';
    if (!videoPath || !fs.existsSync(videoPath)) throw new Error('no video was recorded');
    const kept = path.join(OUT_DIR, `${this.name}.webm`);
    fs.copyFileSync(videoPath, kept);
    const manifest = {
      name: this.name,
      video: kept,
      trimStart: opts.trimStart ?? 1.2,
      fps: opts.fps ?? 12,
      durationSeconds: total,
      cuts: this.cuts.filter((c) => c.to > c.from),
    };
    fs.writeFileSync(path.join(OUT_DIR, `${this.name}.json`), JSON.stringify(manifest, null, 2));
    fs.rmSync(this.root, { recursive: true, force: true });
    return kept;
  }
}
