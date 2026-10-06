/**
 * Shared Playwright fixtures: launches the built Electron app against the
 * real engine binary in a throwaway sandbox, and offers small helpers for the
 * editor UI.
 */

import { test as base, expect, _electron, type ElectronApplication, type Page } from '@playwright/test';
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';

export { expect };

const DESKTOP_DIR = path.resolve(__dirname, '..');
const ENGINE_BIN = path.resolve(DESKTOP_DIR, '../RustRunner/target/debug/rustrunner');
/** Scratch space lives inside the repo (gitignored), never in the real home. */
const TMP_ROOT = path.join(__dirname, '.tmp');

export interface Sandbox {
  /** Directory the workflow runs in (set through the mocked directory dialog). */
  workDir: string;
}

export interface Fixtures {
  sandbox: Sandbox;
  app: ElectronApplication;
  page: Page;
  /** console.error output and uncaught page errors seen so far. */
  consoleErrors: string[];
}

export const test = base.extend<Fixtures>({
  sandbox: async ({}, use) => {
    fs.mkdirSync(TMP_ROOT, { recursive: true });
    const root = fs.mkdtempSync(path.join(TMP_ROOT, 'run-'));
    const workDir = path.join(root, 'work');
    fs.mkdirSync(workDir);
    await use({ workDir });
    fs.rmSync(root, { recursive: true, force: true });
  },

  app: async ({ sandbox }, use) => {
    expect(fs.existsSync(ENGINE_BIN), `engine binary missing: ${ENGINE_BIN} (run cargo build)`).toBe(true);
    const root = path.dirname(sandbox.workDir);
    // HOME, TMPDIR and the profile all point into the sandbox so a test run
    // leaves nothing in the real user directories.
    const home = path.join(root, 'home');
    const tmp = path.join(root, 'tmp');
    fs.mkdirSync(home);
    fs.mkdirSync(tmp);

    const app = await _electron.launch({
      args: [DESKTOP_DIR, `--user-data-dir=${path.join(root, 'profile')}`],
      cwd: DESKTOP_DIR,
      env: {
        ...(process.env as Record<string, string>),
        HOME: home,
        TMPDIR: tmp,
        NODE_ENV: 'production',
        RUSTRUNNER_BIN: ENGINE_BIN,
      },
    });

    // Native dialogs cannot be driven from the page: answer the directory
    // picker with the sandbox, and "Discard" for any unsaved-changes prompt.
    await app.evaluate(({ dialog }, workDir) => {
      dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [workDir] })) as any;
      dialog.showMessageBox = (async () => ({ response: 0, checkboxChecked: false })) as any;
    }, sandbox.workDir);

    await use(app);

    // Never leave the engine or its steps behind, whatever the test did.
    try {
      await app.evaluate(({ app: a }) => a.quit());
    } catch {
      /* already closed */
    }
    await app.close().catch(() => undefined);
  },

  consoleErrors: async ({}, use) => {
    await use([]);
  },

  page: async ({ app, consoleErrors }, use) => {
    const page = await app.firstWindow();
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });
    page.on('pageerror', (err) => consoleErrors.push(`pageerror: ${err.message}`));
    await page.waitForSelector('.workflow-editor');
    await use(page);
  },
});

// -----------------------------------------------------------------------------
// Editor helpers
// -----------------------------------------------------------------------------

export const nodes = (page: Page) => page.getByTestId('workflow-node');

/** Adds a node and returns once it is on the canvas. */
export async function addNode(page: Page): Promise<void> {
  const before = await nodes(page).count();
  await page.getByTestId('add-node').click();
  await expect(nodes(page)).toHaveCount(before + 1);
}

/** Selects the node showing `label` and waits for its properties to load. */
export async function selectNode(page: Page, label: string): Promise<void> {
  await nodes(page).filter({ hasText: label }).first().click();
  await expect(page.getByTestId('prop-label')).toHaveValue(label);
}

/** Drags from `from`'s output handle to `to`'s input handle. */
export async function connect(page: Page, from: string, to: string): Promise<void> {
  const src = nodes(page).filter({ hasText: from }).first().locator('.react-flow__handle.source');
  const dst = nodes(page).filter({ hasText: to }).first().locator('.react-flow__handle.target');
  const a = (await src.boundingBox())!;
  const b = (await dst.boundingBox())!;
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 10 });
  await page.mouse.up();
  await expect(page.locator('.react-flow__edge')).not.toHaveCount(0);
}

export interface NodeSpec {
  label: string;
  tool?: string;
  command: string;
  input?: string;
  output?: string;
}

/** Fills the properties panel of the currently selected node. */
export async function fillNode(page: Page, spec: NodeSpec): Promise<void> {
  await page.getByTestId('prop-label').fill(spec.label);
  await page.getByTestId('prop-tool').fill(spec.tool ?? 'bash');
  await page.getByTestId('prop-command').fill(spec.command);
  await page.getByTestId('prop-input').fill(spec.input ?? '');
  await page.getByTestId('prop-output').fill(spec.output ?? '');
}

/**
 * Builds a linear chain of nodes (one per spec, connected in order) and leaves
 * the canvas ready to run.
 */
export async function buildChain(page: Page, specs: NodeSpec[]): Promise<void> {
  for (let i = 0; i < specs.length; i++) {
    await addNode(page);
    // React Flow's DOM order is not creation order, so find the node by the
    // default label it was given.
    await nodes(page).filter({ hasText: `Node ${i + 1}` }).first().click();
    await expect(page.getByTestId('prop-label')).toHaveValue(`Node ${i + 1}`);
    await fillNode(page, specs[i]);
    await expect(nodes(page).filter({ hasText: specs[i].label })).toHaveCount(1);
  }
  for (let i = 0; i + 1 < specs.length; i++) {
    await connect(page, specs[i].label, specs[i + 1].label);
  }
}

export async function openStepStatus(page: Page): Promise<void> {
  await page.getByTestId('tab-steps').click();
  await expect(page.getByTestId('tab-steps')).toHaveAttribute('aria-selected', 'true');
}

export const stepRow = (page: Page, id: string) =>
  page.locator(`[data-testid="step-row"][data-step-id="${id}"]`);

/** PIDs of processes whose command line contains `needle`. */
export function pidsMatching(needle: string): number[] {
  try {
    const out = execFileSync('pgrep', ['-f', needle], { encoding: 'utf-8' });
    return out
      .split('\n')
      .filter(Boolean)
      .map(Number)
      .filter((pid) => pid !== process.pid);
  } catch {
    return []; // pgrep exits 1 when nothing matches
  }
}

