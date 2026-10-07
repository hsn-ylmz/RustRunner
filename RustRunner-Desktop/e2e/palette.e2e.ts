/**
 * The tool palette at 79 tools: keyboard navigation, the preview, favourites
 * and recently used tools that survive a restart, the "fits after" filter;
 * plus the run-feedback fixes that shipped with it (failure card buttons,
 * the Run button while running, the overview map).
 */

import fs from 'fs';
import path from 'path';
import type { Page } from '@playwright/test';
import {
  test,
  expect,
  launchApp,
  buildChain,
  nodes,
  openSection,
  selectNode,
  type Sandbox,
} from './fixtures';

const items = (page: Page) => page.locator('[data-testid^="palette-item-"]');

async function setWindow(app: any, width: number, height: number) {
  await app.evaluate(({ BrowserWindow }: any, size: number[]) => {
    BrowserWindow.getAllWindows()[0].setContentSize(size[0], size[1]);
  }, [width, height]);
  await new Promise((r) => setTimeout(r, 300));
}

const activeId = (page: Page) =>
  page.getByTestId('palette-search').getAttribute('aria-activedescendant');

test('the palette can be driven from the keyboard: search, move, preview, add', async ({ page }) => {
  await page.getByTestId('open-palette').click();
  await expect(page.getByTestId('palette-search')).toBeFocused();

  await page.keyboard.type('samtools');
  // The best match is under the cursor and previewed before anything is pressed.
  const first = await activeId(page);
  expect(first).toBeTruthy();
  const firstName = await page.getByTestId('palette-preview-name').textContent();

  await page.keyboard.press('ArrowDown');
  const second = await activeId(page);
  expect(second).not.toBe(first);
  await expect(page.getByTestId('palette-preview-name')).not.toHaveText(firstName ?? '');
  await expect(page.locator(`#${second}`)).toHaveAttribute('aria-selected', 'true');

  await page.keyboard.press('ArrowUp');
  expect(await activeId(page)).toBe(first);
  // The cursor does not wrap past the first row.
  await page.keyboard.press('ArrowUp');
  expect(await activeId(page)).toBe(first);

  // Enter adds the tool under the cursor and closes the palette.
  await page.keyboard.press('ArrowDown');
  const wanted = (await page.getByTestId('palette-preview-name').textContent()) ?? '';
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('tool-palette')).toHaveCount(0);
  await expect(nodes(page)).toHaveCount(1);
});

test('categories fold and open with the keys, and the preview says what a tool needs', async ({ page, app }) => {
  await page.getByTestId('open-palette').click();
  await expect(items(page)).toHaveCount(0);
  // The first row is a category heading: Right opens it, Left folds it again.
  await page.keyboard.press('ArrowRight');
  await expect(items(page).first()).toBeVisible();
  await expect(page.getByTestId('palette-category-qc')).toHaveAttribute('aria-expanded', 'true');
  await page.keyboard.press('ArrowLeft');
  await expect(items(page)).toHaveCount(0);

  // A tool that needs a database says so, with a documentation link that goes through the safe opener.
  await app.evaluate(({ shell }) => {
    (globalThis as any).__opened = [];
    shell.openExternal = (async (url: string) => {
      (globalThis as any).__opened.push(url);
    }) as any;
  });
  await page.getByTestId('palette-search').fill('kraken2');
  await page.getByTestId('palette-item-kraken2').hover();
  await expect(page.getByTestId('palette-preview-database')).toContainText('Needs');
  await expect(page.getByTestId('palette-preview-version')).toContainText(/version \d/);
  await page.getByTestId('palette-preview-database-docs').click();
  await expect.poll(() => app.evaluate(() => (globalThis as any).__opened as string[])).toHaveLength(1);
  const opened = await app.evaluate(() => (globalThis as any).__opened as string[]);
  expect(opened[0]).toMatch(/^https:\/\//);
});

async function relaunch(sandbox: Sandbox, app: any) {
  const root = path.dirname(sandbox.workDir);
  // A step is on the canvas, so a normal quit would ask about unsaved changes: leave directly.
  await app.evaluate(({ app: a }: any) => a.exit(0)).catch(() => undefined);
  await app.waitForEvent('close').catch(() => undefined);
  const next = await launchApp(root);
  const page = await next.firstWindow();
  await page.waitForSelector('.workflow-editor');
  return { next, page, root };
}

test('favourites and recently used tools are saved in the app settings and survive a restart', async ({
  page,
  app,
  sandbox,
}) => {
  await page.getByTestId('open-palette').click();
  await page.getByTestId('palette-search').fill('fastqc');
  await page.getByTestId('palette-favourite').click();
  await expect(page.getByTestId('palette-favourite')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('palette-favourite')).toContainText('Remove from favourites');
  // Use another tool, so it is listed as recent.
  await page.getByTestId('palette-search').fill('fastp');
  await page.getByTestId('palette-item-fastp').click();
  await expect(nodes(page)).toHaveCount(1);

  const settingsFile = path.join(path.dirname(sandbox.workDir), 'profile', 'settings.json');
  await expect.poll(() => fs.existsSync(settingsFile)).toBe(true);
  const saved = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  expect(saved.palette.favourites).toEqual(['fastqc']);
  expect(saved.palette.recent).toEqual(['fastp']);

  // A fresh start of the app (same profile), not a reload: the lists come from the file.
  const { next, page: again } = await relaunch(sandbox, app);
  try {
    await again.getByTestId('open-palette').click();
    await expect(again.getByTestId('palette-fav-fastqc')).toBeVisible();
    await expect(again.getByTestId('palette-recent-fastp')).toBeVisible();
    // Keyboard: the first row is the favourite; its preview offers to remove it.
    await expect(again.getByTestId('palette-favourite')).toContainText('Remove from favourites');
    // Removing it saves too.
    await again.getByTestId('palette-favourite').click();
    await expect(again.getByTestId('palette-fav-fastqc')).toHaveCount(0);
    await expect
      .poll(() => JSON.parse(fs.readFileSync(settingsFile, 'utf8')).palette.favourites)
      .toEqual([]);
  } finally {
    await next.close().catch(() => undefined);
  }
});

test('"fits after the selected step" keeps the tools that read what the step makes', async ({ page }) => {
  await page.getByTestId('open-palette').click();
  // Nothing selected: the filter is off and says why.
  await expect(page.getByTestId('palette-fits-after')).toBeDisabled();
  await page.getByTestId('palette-search').fill('bwa mem');
  await page.getByTestId('palette-item-bwa-mem').click();
  await expect(nodes(page)).toHaveCount(1);

  await page.getByTestId('open-palette').click();
  await expect(page.getByTestId('palette-fits-after')).toBeEnabled();
  await page.getByTestId('palette-fits-after').check();
  // BWA MEM makes a SAM file: samtools sort reads it, FastQC does not.
  await page.getByTestId('palette-search').fill('sort');
  await expect(page.getByTestId('palette-item-samtools-sort')).toBeVisible();
  await page.getByTestId('palette-search').fill('fastqc');
  await expect(page.getByTestId('palette-empty')).toBeVisible();
  await page.getByTestId('palette-search').fill('');
  await expect(page.getByTestId('palette-item-samtools-sort')).toBeVisible();
  await expect(page.getByTestId('palette-item-fastqc')).toHaveCount(0);
});

const FAILING_CHAIN = [
  { label: 'Empty', command: 'touch {output}', output: 'empty.txt' },
  { label: 'Next', command: 'cp {input} {output}', input: 'empty.txt', output: 'next.txt' },
];

for (const size of [
  { width: 1440, height: 900 },
  { width: 1024, height: 700 },
]) {
  test(`the failure card's buttons are fully visible at ${size.width}x${size.height}`, async ({ page, app }) => {
    await setWindow(app, size.width, size.height);
    await buildChain(page, FAILING_CHAIN);
    await selectNode(page, 'Empty');
    await openSection(page, 'checks');
    await page.getByTestId('prop-check-non-empty').check();
    await page.mouse.click(size.width / 2, size.height / 2 - 60);
    await page.getByTestId('run-from-scratch').click();
    await expect(page.getByTestId('failure-card')).toBeVisible();

    const body = (await page.getByTestId('execution-body').boundingBox())!;
    for (const id of ['failure-show-report', 'failure-show-logs', 'failure-edit-step']) {
      const box = (await page.getByTestId(id).boundingBox())!;
      expect(box.y, `${id} top`).toBeGreaterThanOrEqual(body.y - 1);
      expect(box.y + box.height, `${id} bottom`).toBeLessThanOrEqual(body.y + body.height + 1);
      await expect(page.getByTestId(id)).toBeInViewport({ ratio: 1 });
    }
    // The rest of the panel is still reachable: scroll the body to its end.
    await page.getByTestId('execution-body').evaluate((el) => (el.scrollTop = el.scrollHeight));
    await expect(page.getByTestId('tab-steps')).toBeVisible();
  });
}

test('Run reads "Running…" while a run is under way, and says so to assistive technology', async ({ page }) => {
  await buildChain(page, [{ label: 'Slow', command: 'sleep 6; echo done > {output}', output: 'slow.txt' }]);
  const run = page.getByTestId('run');
  await expect(run).toHaveText('Run');
  await run.click();
  await expect(run).toHaveText('Running…');
  await expect(run).toHaveAttribute('aria-busy', 'true');
  await expect(page.getByRole('button', { name: 'Running…' })).toBeVisible();
  await page.getByTestId('stop').click();
  await expect(run).toHaveText('Run');
  await expect(run).not.toHaveAttribute('aria-busy', 'true');
});

test('the overview map is small, themed, and can be hidden', async ({ page }) => {
  await buildChain(page, [{ label: 'One', command: 'echo a > {output}', output: 'a.txt' }]);
  const map = page.locator('.react-flow__minimap');
  await expect(map).toBeVisible();
  const box = (await map.boundingBox())!;
  expect(box.width).toBeLessThanOrEqual(140);
  expect(box.height).toBeLessThanOrEqual(90);

  await page.getByTestId('minimap-toggle').click();
  await expect(map).toHaveCount(0);
  await expect(page.getByTestId('minimap-toggle')).toContainText('Show overview');
  await page.getByTestId('minimap-toggle').click();
  await expect(map).toBeVisible();
});
