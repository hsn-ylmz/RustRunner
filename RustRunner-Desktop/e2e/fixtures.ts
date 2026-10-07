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

/**
 * Chromium's SUID sandbox is unavailable on CI runners and in containers, and
 * there is no GPU under Xvfb. Only Linux needs these; macOS runs unchanged.
 */
function headlessLinuxArgs(): string[] {
  if (process.platform !== 'linux') return [];
  return ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'];
}

/** Screenshots for the UX review are taken at 1x so the PNGs stay small. */
function captureArgs(): string[] {
  return process.env.UX_OUT ? ['--force-device-scale-factor=1'] : [];
}

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

/**
 * Starts the app with HOME, TMPDIR and the profile (the app's data folder)
 * inside `root`. Calling it again with the same root is a restart: the second
 * run finds what the first saved.
 */
export function launchApp(root: string): Promise<ElectronApplication> {
  return _electron.launch({
    args: [DESKTOP_DIR, `--user-data-dir=${path.join(root, 'profile')}`, ...headlessLinuxArgs(), ...captureArgs()],
    cwd: DESKTOP_DIR,
    env: {
      ...(process.env as Record<string, string>),
      HOME: path.join(root, 'home'),
      TMPDIR: path.join(root, 'tmp'),
      NODE_ENV: 'production',
      RUSTRUNNER_BIN: ENGINE_BIN,
    },
  });
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

  app: async ({ sandbox }, use, testInfo) => {
    expect(fs.existsSync(ENGINE_BIN), `engine binary missing: ${ENGINE_BIN} (run cargo build)`).toBe(true);
    const root = path.dirname(sandbox.workDir);
    // HOME, TMPDIR and the profile all point into the sandbox so a test run
    // leaves nothing in the real user directories.
    fs.mkdirSync(path.join(root, 'home'));
    fs.mkdirSync(path.join(root, 'tmp'));

    const app = await launchApp(root);

    // Native dialogs cannot be driven from the page: answer the directory
    // picker with the sandbox, and "Discard" for any unsaved-changes prompt.
    await app.evaluate(({ dialog }, workDir) => {
      dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [workDir] })) as any;
      dialog.showMessageBox = (async () => ({ response: 0, checkboxChecked: false })) as any;
    }, sandbox.workDir);

    // Trace every test, keep the trace only when it failed (CI uploads them).
    const tracing = app.context().tracing;
    await tracing.start({ screenshots: true, snapshots: true }).catch(() => undefined);

    await use(app);

    const failed = testInfo.status !== testInfo.expectedStatus;
    await tracing
      .stop(failed ? { path: testInfo.outputPath('trace.zip') } : undefined)
      .catch(() => undefined);

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

  page: async ({ app, consoleErrors }, use, testInfo) => {
    const page = await app.firstWindow();
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });
    page.on('pageerror', (err) => consoleErrors.push(`pageerror: ${err.message}`));
    await page.waitForSelector('.workflow-editor');
    await use(page);

    if (testInfo.status !== testInfo.expectedStatus) {
      await page
        .screenshot({ path: testInfo.outputPath('failure.png') })
        .catch(() => undefined);
    }
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

export type PanelSection = 'basics' | 'io' | 'reliability' | 'checks' | 'advanced';

/**
 * Opens a collapsible section of the properties panel (a no-op when it is open
 * already). The open state is remembered by the app, so it stays open when
 * another node is selected.
 */
export async function openSection(page: Page, section: PanelSection): Promise<void> {
  const toggle = page.getByTestId(`section-${section}-toggle`);
  await expect(toggle).toBeVisible();
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
}

export async function openStepStatus(page: Page): Promise<void> {
  await page.getByTestId('tab-steps').click();
  await expect(page.getByTestId('tab-steps')).toHaveAttribute('aria-selected', 'true');
}

/**
 * Hovers the Run button and returns the tooltip that opens beside it. The
 * explanation of what Run will do lives there (and on keyboard focus), not in a
 * title attribute that only a hovering mouse can reach.
 */
export async function showRunTooltip(page: Page) {
  await page.getByTestId('run').hover();
  const tip = page.getByRole('tooltip');
  await expect(tip).toBeVisible();
  return tip;
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

