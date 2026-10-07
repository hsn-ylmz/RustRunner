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
const written = new Set<string>();

function shooter(page: Page, scheme: Scheme, group: string) {
  fs.mkdirSync(OUT, { recursive: true });
  let n = 0;
  return async (name: string) => {
    // Let transitions (0.2 s) and focus rings settle.
    await page.waitForTimeout(350);
    n += 1;
    const file = `${group}-${String(n).padStart(2, '0')}-${name}-${scheme}.png`;
    // Every name is unique within a capture: a repeat would overwrite a screenshot silently.
    if (written.has(file)) throw new Error(`duplicate screenshot name ${file}`);
    written.add(file);
    await page.screenshot({ path: path.join(OUT, file) });
  };
}

async function prepare(page: Page, app: any, scheme: Scheme, size = { width: 1440, height: 900 }) {
  await app.evaluate(({ BrowserWindow }: any, { width, height }: { width: number; height: number }) => {
    const w = BrowserWindow.getAllWindows()[0];
    w.setContentSize(width, height);
    w.center();
  }, size);
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
    // A category opened with the keyboard, the way a person browses.
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowDown');
    await shoot('catalog-palette-browse-category');
    await page.getByTestId('palette-toggle-all').click();
    await shoot('catalog-palette-all-open');
    await page.getByTestId('palette-toggle-all').click();
    // A favourite and a recent tool fill the two sections at the top.
    await page.getByTestId('palette-search').fill('fastqc');
    await page.getByTestId('palette-favourite').click();
    await shoot('catalog-palette-search-favourite');
    await page.getByTestId('palette-search').fill('sam');
    await shoot('catalog-palette-search');
    await page.getByTestId('palette-search').fill('qqqzzz');
    await expect(page.getByTestId('palette-empty')).toBeVisible();
    await shoot('catalog-palette-no-results');
    await page.getByTestId('palette-search').press('Escape');

    await addFromPalette(page, 'bwa', 'bwa-mem');
    await shoot('node-selected-catalog-tool');

    // With a catalog step selected: the favourites and recent sections, the
    // filter for tools that fit after it, and a tool that needs a database.
    await page.getByTestId('open-palette').click();
    await shoot('catalog-palette-favourites-recent');
    await page.getByTestId('palette-fits-after').check();
    await shoot('catalog-palette-fits-after');
    await page.getByTestId('palette-fits-after').uncheck();
    await page.getByTestId('palette-search').fill('kraken2');
    await page.getByTestId('palette-item-kraken2').hover();
    await shoot('catalog-palette-needs-database');
    await page.getByTestId('palette-search').press('Escape');
    await page.getByTestId('minimap-toggle').click();
    await shoot('overview-map-hidden');
    await page.getByTestId('minimap-toggle').click();
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

    // Adding a step closed the problem list, so it does not cover the new step.
    await expect(page.getByTestId('problems-panel')).toHaveCount(0);
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

  test(`${scheme}: compact window (1024x700)`, async ({ page, app }) => {
    await prepare(page, app, scheme, { width: 1024, height: 700 });
    const shoot = shooter(page, scheme, 'compact');

    await shoot('empty-canvas');
    await page.getByTestId('open-palette').click();
    await shoot('catalog-palette');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowDown');
    await shoot('catalog-palette-category-open');
    // A tool that needs a database: the note is whole and the buttons stay in view.
    await page.getByTestId('palette-search').fill('kraken2');
    await page.getByTestId('palette-item-kraken2').hover();
    await expect(page.getByTestId('palette-preview-add')).toBeInViewport({ ratio: 1 });
    await shoot('catalog-palette-needs-database');
    await page.getByTestId('palette-search').press('Escape');

    await buildChain(page, [
      { label: 'Empty', command: 'touch {output}', output: 'empty.txt' },
      { label: 'Next', command: 'cp {input} {output}', input: 'empty.txt', output: 'next.txt' },
    ]);
    await selectNode(page, 'Empty');
    await shoot('node-selected');
    await openSection(page, 'checks');
    await page.getByTestId('prop-check-non-empty').check();
    await page.keyboard.press('Escape');

    await page.getByTestId('run-from-scratch').click();
    await expect(page.getByTestId('failure-card')).toBeVisible();
    await shoot('failed-run');

    await selectNode(page, 'Empty');
    await shoot('failed-node-selected');

    await page.getByTestId('details').click();
    await shoot('dialog-details');
    await page.getByRole('button', { name: 'Cancel' }).click();
  });

  test(`${scheme}: named file slots and the command preview`, async ({ page, app }) => {
    await prepare(page, app, scheme);
    const shoot = shooter(page, scheme, 'slots');

    await buildChain(page, [
      { label: 'Trim reads', command: 'cp {input} {output}', input: 'raw.fastq', output: 'trimmed.fastq' },
      { label: 'Align', command: 'bwa mem {ref} {reads} > {output}', output: 'aligned.sam' },
      { label: 'Pair', command: 'merge {reads1} {reads2} > {output}', output: 'pair.txt' },
    ]);
    // buildChain connected Trim reads -> Align -> Pair; start from open slots.
    await selectNode(page, 'Align');
    await page.getByTestId('prop-slots').scrollIntoViewIfNeeded();
    await shoot('slots-bound-by-connection');
    await page.getByTestId('prop-slot-reads-unlink').click();
    await shoot('slots-unlinked-preview-marks-open-files');

    await selectNode(page, 'Pair');
    await shoot('slots-pair-from-align');
    await page.getByTestId('prop-upstream').getByRole('checkbox', { name: 'Trim reads' }).check();
    await expect(page.getByTestId('binding-prompt')).toBeVisible();
    await page.getByTestId('binding-prompt').scrollIntoViewIfNeeded();
    await shoot('slots-binding-question');
  });

  test(`${scheme}: named file slots in the compact window (1024x700)`, async ({ page, app }) => {
    await prepare(page, app, scheme, { width: 1024, height: 700 });
    const shoot = shooter(page, scheme, 'slots-compact');
    await buildChain(page, [
      { label: 'Trim reads', command: 'cp {input} {output}', input: 'raw.fastq', output: 'trimmed.fastq' },
      { label: 'Align', command: 'bwa mem {ref} {reads} > {output}', output: 'aligned.sam' },
    ]);
    await selectNode(page, 'Align');
    await shoot('slots');
    // A catalog step: its file slots lead, batch mode follows.
    await addFromPalette(page, 'bwa', 'bwa-mem');
    await shoot('catalog-step-inputs');
    await selectNode(page, 'Align');
    await openSection(page, 'advanced');
    await page.getByTestId('command-preview').scrollIntoViewIfNeeded();
    await shoot('preview');
  });

  for (const compact of [false, true]) {
    test(`${scheme}: templates${compact ? ' in the compact window (1024x700)' : ''}`, async ({ page, app }) => {
      await prepare(page, app, scheme, compact ? { width: 1024, height: 700 } : { width: 1440, height: 900 });
      const shoot = shooter(page, scheme, compact ? 'templates-compact' : 'templates');

      await shoot('empty-canvas');
      await page.getByTestId('empty-templates').click();
      await expect(page.getByTestId('template-card-basic-read-qc')).toBeVisible();
      await shoot('gallery');
      await page.getByTestId('template-search').fill('zzzz');
      await shoot('gallery-no-match');
      await page.getByTestId('template-search').fill('');
      await page.getByTestId('template-card-basic-read-qc').click();
      await shoot('setup-empty');
      await page.getByTestId('template-input-field-reads').fill('/data/run1.bam');
      await shoot('setup-file-of-another-kind');
      await page.getByTestId('template-input-field-reads').fill('/data/run1.fastq.gz');
      await page.getByTestId('template-create').click();
      await expect(nodes(page)).toHaveCount(4);
      await shoot('created-canvas');

      await page.getByTestId('new-from-template').click();
      await page.getByTestId('template-save-current').click();
      await shoot('save-as-template');
      await page.getByTestId('save-template-name').fill('My lab QC');
      await page.getByTestId('save-template-confirm').click();
      await page.getByTestId('new-from-template').click();
      await expect(page.getByTestId('template-grid-user')).toBeVisible();
      await shoot('gallery-my-templates');
      await page.keyboard.press('Escape');

      // Left empty: the workflow says what is missing.
      await page.getByTestId('new-from-template').click();
      await page.getByTestId('template-card-basic-read-qc').click();
      await page.getByTestId('template-create').click();
      await page.getByTestId('confirm-accept').click();
      await expect(page.getByTestId('problems-toggle')).toBeVisible();
      if (compact) {
        // A narrow window keeps the list closed so it never hides the steps.
        await expect(page.getByTestId('problems-panel')).toHaveCount(0);
        await shoot('created-with-missing-file-list-closed');
        await page.getByTestId('problems-toggle').click();
      }
      await expect(page.getByTestId('problems-panel')).toBeVisible();
      await shoot('created-with-missing-file');
    });
  }
}

