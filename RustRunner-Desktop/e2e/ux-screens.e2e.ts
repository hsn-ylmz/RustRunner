/**
 * UX review screenshots. Drives the real app through the standard list of
 * states, in light and dark colour scheme, and writes PNGs into the folder
 * named by UX_OUT. Skipped unless UX_OUT is set, so it never slows the normal
 * e2e run:
 *
 *   npm run ux:screens            # writes to ../ux-review/screens
 *   UX_OUT=/some/dir npx playwright test ux-screens
 */

import fs from 'fs';
import path from 'path';
import type { Page } from '@playwright/test';
import {
  test,
  expect,
  buildChain,
  connect,
  nodes,
  openSection,
  selectNode,
  openStepStatus,
  stepRow,
} from './fixtures';

const OUT = process.env.UX_OUT ? path.resolve(process.env.UX_OUT) : '';
const SCHEMES = ['light', 'dark'] as const;
type Scheme = (typeof SCHEMES)[number];

test.skip(!OUT, 'set UX_OUT to capture UX screenshots');

/** Takes a numbered, descriptive screenshot of the whole window. */
function shooter(page: Page, scheme: Scheme, group: string) {
  fs.mkdirSync(OUT, { recursive: true });
  let n = 0;
  return async (name: string) => {
    // Let transitions (0.2 s) and focus rings settle.
    await page.waitForTimeout(350);
    n += 1;
    const file = `${group}-${String(n).padStart(2, '0')}-${name}-${scheme}.png`;
    await page.screenshot({ path: path.join(OUT, file) });
  };
}

async function prepare(page: Page, app: any, scheme: Scheme) {
  await app.evaluate(({ BrowserWindow }: any) => {
    const w = BrowserWindow.getAllWindows()[0];
    w.setContentSize(1440, 900);
    w.center();
  });
  await page.emulateMedia({ colorScheme: scheme });
  await page.waitForTimeout(300);
}

async function addFromPalette(page: Page, query: string, id: string) {
  await page.getByTestId('open-palette').click();
  await page.getByTestId('palette-search').fill(query);
  await page.getByTestId(`palette-item-${id}`).click();
  await expect(page.getByTestId('tool-palette')).toHaveCount(0);
}

for (const scheme of SCHEMES) {
  test(`${scheme}: empty canvas, palette, properties and dialogs`, async ({ page, app }) => {
    await prepare(page, app, scheme);
    const shoot = shooter(page, scheme, 'editor');

    await shoot('empty-canvas');

    await page.getByTestId('open-palette').click();
    await shoot('catalog-palette');
    await page.getByTestId('palette-search').fill('sam');
    await shoot('catalog-palette-search');
    await page.getByTestId('palette-search').fill('qqqzzz');
    await expect(page.getByTestId('palette-empty')).toBeVisible();
    await shoot('catalog-palette-no-results');
    await page.getByTestId('palette-search').press('Escape');

    await addFromPalette(page, 'bwa', 'bwa-mem');
    await shoot('node-selected-catalog-tool');
    for (const section of ['reliability', 'checks', 'advanced'] as const) {
      await openSection(page, section);
    }
    await shoot('node-selected-catalog-tool-sections-open');
    await page.getByTestId('prop-check-blocking').scrollIntoViewIfNeeded();
    await shoot('node-selected-catalog-tool-scrolled');

    await page.getByTestId('add-node').click();
    await selectNode(page, 'Node 2');
    await shoot('node-selected-custom');
    await page.getByTestId('prop-check-blocking').scrollIntoViewIfNeeded();
    await shoot('node-selected-custom-scrolled');

    await page.getByTestId('open-shortcuts').click();
    await shoot('dialog-shortcuts');
    await page.keyboard.press('Escape');

    await page.getByTestId('details').click();
    await shoot('dialog-details');
    await page.getByRole('button', { name: 'Cancel' }).click();

    await page.getByRole('button', { name: 'New', exact: true }).click();
    await expect(page.getByTestId('confirm-dialog')).toBeVisible();
    await shoot('dialog-confirm-discard');
    await page.getByTestId('confirm-accept').click();
    await expect(page.getByTestId('dialog-name')).toBeVisible();
    await shoot('dialog-new');
  });

  test(`${scheme}: typed edges`, async ({ page, app }) => {
    await prepare(page, app, scheme);
    const shoot = shooter(page, scheme, 'edges');

    await addFromPalette(page, 'fastp', 'fastp');
    await addFromPalette(page, 'cutadapt', 'cutadapt');
    await addFromPalette(page, 'sort', 'samtools-sort');
    await connect(page, 'fastp', 'cutadapt');
    await connect(page, 'cutadapt', 'samtools sort');
    await expect(page.getByTestId('typed-edge')).toHaveCount(2);
    await page.mouse.click(700, 800); // deselect
    await shoot('three-node-typed-edges');

    await selectNode(page, 'samtools sort');
    await shoot('typed-edges-node-selected');
  });

  test(`${scheme}: running, success and history`, async ({ page, app }) => {
    await prepare(page, app, scheme);
    const shoot = shooter(page, scheme, 'run');

    await buildChain(page, [
      { label: 'Make', command: 'echo hello > {output}', output: 'a.txt' },
      {
        label: 'Flaky',
        command: 'if [ -f flaky.ok ]; then sleep 2; cp {input} {output}; else touch flaky.ok; exit 1; fi',
        input: 'a.txt',
        output: 'b.txt',
      },
      { label: 'Copy', command: 'cp {input} {output}', input: 'b.txt', output: 'c.txt' },
    ]);
    await selectNode(page, 'Flaky');
    await openSection(page, 'reliability');
    await page.getByTestId('prop-retries').fill('1');
    await page.getByTestId('prop-retry-delay').fill('6');
    await page.mouse.click(700, 800);

    await page.getByTestId('run-from-scratch').click();
    await openStepStatus(page);
    await expect(stepRow(page, 'flaky')).toHaveAttribute('data-state', 'retrying');
    await shoot('running-step-retrying');
    await page.getByTestId('tab-logs').click();
    await shoot('running-logs');
    await openStepStatus(page);

    await expect(stepRow(page, 'flaky')).toHaveAttribute('data-state', 'running');
    await shoot('running-step-running');

    await expect(stepRow(page, 'copy')).toHaveAttribute('data-state', 'succeeded');
    await expect(page.getByTestId('open-latest-report')).toBeVisible();
    await expect(page.getByTestId('run-summary')).toBeVisible();
    await shoot('finished-success-steps');

    await page.getByTestId('tab-logs').click();
    await shoot('finished-success-logs');

    await page.getByTestId('tab-history').click();
    await expect(page.getByTestId('history-row')).toHaveCount(1);
    await shoot('run-history');
  });

  test(`${scheme}: failed with a blocking check`, async ({ page, app }) => {
    await prepare(page, app, scheme);
    const shoot = shooter(page, scheme, 'failure');

    await buildChain(page, [
      { label: 'Empty', command: 'touch {output}', output: 'empty.txt' },
      { label: 'Next', command: 'cp {input} {output}', input: 'empty.txt', output: 'next.txt' },
    ]);
    await selectNode(page, 'Empty');
    await openSection(page, 'checks');
    await page.getByTestId('prop-check-non-empty').check();
    await page.mouse.click(700, 800);

    await page.getByTestId('run-from-scratch').click();
    await openStepStatus(page);
    await expect(stepRow(page, 'empty')).toHaveAttribute('data-state', 'failed');
    await expect(stepRow(page, 'next')).toHaveAttribute('data-state', 'skipped');
    await expect(page.getByTestId('run-from-scratch')).toBeEnabled();
    await expect(page.getByTestId('failure-card')).toBeVisible();
    await shoot('failed-blocking-check-steps');

    await page.getByTestId('failure-show-logs').click();
    await shoot('failed-show-logs-errors-only');
    await page.getByTestId('log-filter-all').click();

    await page.getByTestId('tab-logs').click();
    await shoot('failed-blocking-check-logs');

    await selectNode(page, 'Empty');
    await page.getByTestId('prop-check-non-empty').scrollIntoViewIfNeeded();
    await shoot('failed-node-properties');
  });

  test(`${scheme}: validation error`, async ({ page, app }) => {
    await prepare(page, app, scheme);
    const shoot = shooter(page, scheme, 'validation');

    await buildChain(page, [
      { label: 'Same', command: 'echo a > {output}', output: 'a.txt' },
    ]);
    await page.getByTestId('add-node').click();
    await nodes(page).filter({ hasText: 'Node 2' }).first().click();
    await page.getByTestId('prop-label').fill('Same');
    await shoot('validation-duplicate-name');

    await page.getByTestId('run').click({ force: true });
    await expect(page.getByTestId('problems-panel')).toBeVisible();
    await shoot('validation-problems-list');

    // An incomplete step: empty tool and command, shown after a run attempt.
    await page.getByTestId('add-node').click();
    await selectNode(page, 'Node 3');
    await shoot('validation-incomplete-step');

    await page.getByTestId('problems-close').click();
    await page.getByTestId('run').hover();
    await shoot('validation-run-disabled-reason');
  });

  test(`${scheme}: log tools, toast and empty states`, async ({ page, app }) => {
    await prepare(page, app, scheme);
    const shoot = shooter(page, scheme, 'states');

    await page.getByTestId('tab-steps').click();
    await shoot('steps-empty');
    await page.getByTestId('tab-history').click();
    await shoot('history-empty');
    await page.getByTestId('tab-logs').click();
    await page.getByRole('button', { name: 'Clear log' }).click();
    await shoot('logs-empty');

    await buildChain(page, [
      { label: 'Make', command: 'echo hello > {output}', output: 'a.txt' },
      { label: 'Break', command: 'echo "boom: no such file" >&2; exit 3', input: 'a.txt', output: 'b.txt' },
    ]);
    await page.getByTestId('run-from-scratch').click();
    await expect(page.getByTestId('failure-card')).toBeVisible();
    await page.getByTestId('tab-logs').click();
    await page.getByTestId('log-search').fill('boom');
    await page.getByTestId('log-copy').click();
    await expect(page.getByTestId('toast').first()).toBeVisible();
    await shoot('logs-search-and-copy-toast');
    await page.getByTestId('log-search').fill('zzz-no-such-text');
    await shoot('logs-no-match');
  });
}
