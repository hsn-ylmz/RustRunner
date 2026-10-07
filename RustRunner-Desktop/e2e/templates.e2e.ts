/**
 * Workflow templates through the real app: the gallery, the setup step, the
 * workflow it creates, saving the canvas as a template and managing "My
 * templates". The templates folder is <HOME>/.rustrunner/templates, and HOME
 * is the sandbox, so nothing touches the real home.
 */

import fs from 'fs';
import path from 'path';
import type { ElectronApplication, Page } from '@playwright/test';
import { test, expect, nodes, type Sandbox } from './fixtures';

const userTemplatesDir = (sandbox: Sandbox) => path.join(path.dirname(sandbox.workDir), 'home', '.rustrunner', 'templates');

async function openGallery(page: Page) {
  await page.getByTestId('new-from-template').click();
  await expect(page.getByTestId('template-dialog')).toBeVisible();
  await expect(page.getByTestId('template-card-basic-read-qc')).toBeVisible();
}

/** Gallery, pick the basic template, optionally type the reads file, create. */
async function createBasic(page: Page, reads?: string) {
  await openGallery(page);
  await page.getByTestId('template-card-basic-read-qc').click();
  await expect(page.getByTestId('template-setup')).toBeVisible();
  if (reads) await page.getByTestId('template-input-field-reads').fill(reads);
  await page.getByTestId('template-create').click();
  await expect(page.getByTestId('template-dialog')).toHaveCount(0);
  await expect(nodes(page)).toHaveCount(4);
}

async function setWindow(app: ElectronApplication, width: number, height: number) {
  await app.evaluate(({ BrowserWindow }, size) => {
    BrowserWindow.getAllWindows()[0].setContentSize(size[0], size[1]);
  }, [width, height]);
  await new Promise((r) => setTimeout(r, 300));
}

/** Answers the next file picker with `file`. */
async function pickerReturns(app: ElectronApplication, file: string) {
  await app.evaluate(({ dialog }, f) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [f] })) as any;
  }, file);
}

test('the empty canvas offers templates first, and the gallery shows what each one is', async ({ page }) => {
  await expect(page.getByTestId('empty-templates')).toBeVisible();
  await page.getByTestId('empty-templates').click();
  const card = page.getByTestId('template-card-basic-read-qc');
  await expect(card).toBeVisible();
  await expect(card).toContainText('Basic read quality check');
  await expect(card).toContainText('4 steps');
  await expect(card).toContainText('Beginner');
  await expect(card).toContainText('Uses FastQC, fastp, MultiQC');
  await expect(card.getByTestId('template-dag')).toHaveAttribute('aria-label', /Pipeline of 4 steps: FastQC \(raw reads\), then/);
  // No tool of this template needs a database.
  await expect(page.getByTestId('template-needs-database')).toHaveCount(0);
  await expect(page.getByTestId('my-templates-empty')).toBeVisible();
});

test('search and the topic filter narrow the list', async ({ page }) => {
  await openGallery(page);
  await page.getByTestId('template-search').fill('multiqc fastp');
  await expect(page.getByTestId('template-card-basic-read-qc')).toBeVisible();
  await page.getByTestId('template-search').fill('salmon');
  await expect(page.getByTestId('template-card-basic-read-qc')).toHaveCount(0);
  await expect(page.getByTestId('template-empty')).toContainText('No ready-made template matches');
  await page.getByTestId('template-search').fill('');
  await page.getByTestId('template-domain').selectOption('qc');
  await expect(page.getByTestId('template-card-basic-read-qc')).toBeVisible();
  // The select offers only topics that have a template.
  await expect(page.getByTestId('template-domain').locator('option')).toHaveText(['All topics', 'Read quality']);
});

test('gallery, setup, then a canvas of bound steps', async ({ page, consoleErrors }) => {
  await createBasic(page, '/data/sample.fastq.gz');

  for (const label of ['FastQC (raw reads)', 'Trim reads (fastp)', 'FastQC (trimmed reads)', 'MultiQC report']) {
    await expect(nodes(page).filter({ hasText: label })).toHaveCount(1);
  }
  await expect(page.locator('.react-flow__edge')).toHaveCount(4);
  await expect(page.getByTestId('toast').first()).toContainText('Created "Basic read quality check" with 4 steps.');
  // Everything is bound: no problems to fix before Run.
  await expect(page.getByTestId('problems-toggle')).toHaveCount(0);
  await expect(page.locator('.dirty-marker')).toBeVisible();

  // The first step holds the chosen file; the trimmed-reads check follows fastp.
  await nodes(page).filter({ hasText: 'FastQC (raw reads)' }).click();
  await expect(page.getByTestId('prop-slot-reads')).toHaveValue('/data/sample.fastq.gz');
  await nodes(page).filter({ hasText: 'FastQC (trimmed reads)' }).click();
  await expect(page.getByTestId('prop-label')).toHaveValue('FastQC (trimmed reads)');
  // Its reads come from fastp, shown as a link to that step's file.
  await expect(page.getByTestId('prop-slot-reads')).toHaveText('trimmed.fastq.gz');
  await expect(page.getByTestId('properties-panel')).toContainText('Trim reads (fastp)');
  await nodes(page).filter({ hasText: 'MultiQC report' }).click();
  await expect(page.getByTestId('properties-panel')).toContainText('FastQC (raw reads)');
  await expect(page.getByTestId('properties-panel')).toContainText('Trim reads (fastp)');

  // Laid out top to bottom: MultiQC is the lowest step.
  const tops = await nodes(page).evaluateAll((els) =>
    els.map((el) => ({ text: el.textContent ?? '', top: el.getBoundingClientRect().top }))
  );
  const multiqc = tops.find((t) => t.text.includes('MultiQC report'))!.top;
  expect(tops.filter((t) => !t.text.includes('MultiQC report')).every((t) => t.top < multiqc)).toBe(true);
  expect(consoleErrors).toEqual([]);
});

test('the file picker fills the field, and a file can be left for later', async ({ page, app }) => {
  await setWindow(app, 1440, 900);
  await openGallery(page);
  await page.getByTestId('template-card-basic-read-qc').click();
  await pickerReturns(app, '/data/run1.fq.gz');
  await page.getByTestId('template-input-choose-reads').click();
  await expect(page.getByTestId('template-input-field-reads')).toHaveValue('/data/run1.fq.gz');

  // A file of another kind is mentioned, not refused.
  await page.getByTestId('template-input-field-reads').fill('/data/run1.bam');
  await expect(page.getByTestId('template-input-reads')).toContainText('looks like a BAM file');
  await expect(page.getByTestId('template-create')).toBeEnabled();

  // A comma would split the name in two files.
  await page.getByTestId('template-input-field-reads').fill('/data/a,b.fq');
  await expect(page.getByTestId('template-input-reads')).toContainText('cannot contain a comma');
  await expect(page.getByTestId('template-create')).toHaveAttribute('aria-disabled', 'true');

  // Leave it empty: the workflow is made and says what is missing.
  await page.getByTestId('template-input-field-reads').fill('');
  await expect(page.getByTestId('template-missing-note')).toContainText('Sequencing reads is not chosen yet');
  await page.getByTestId('template-create').click();
  await expect(nodes(page)).toHaveCount(4);
  await expect(page.getByTestId('problems-panel')).toBeVisible();
  await expect(page.getByTestId('problem-item')).toHaveCount(2);
  // The steps are fitted beside the list, not under it (once the view has finished moving).
  await page.waitForTimeout(600);
  const panel = (await page.getByTestId('problems-panel').boundingBox())!;
  for (const box of await nodes(page).evaluateAll((els) => els.map((el) => el.getBoundingClientRect().toJSON()))) {
    expect(box.right <= panel.x || box.left >= panel.x + panel.width || box.top >= panel.y + panel.height).toBe(true);
  }
  await expect(page.getByTestId('problems-panel')).toContainText('Choose a file for "Reads"');
  await expect(page.getByTestId('run')).toHaveAttribute('aria-disabled', 'true');
});

test('the setup step explains the pipeline, what it makes and where it comes from', async ({ page }) => {
  await openGallery(page);
  await page.getByTestId('template-card-basic-read-qc').click();
  await expect(page.getByTestId('template-setup')).toContainText('single MultiQC report');
  await expect(page.getByTestId('template-outputs')).toContainText('Combined quality report');
  await expect(page.getByTestId('template-references')).toContainText('fastp');
  await expect(page.getByTestId('template-workflow-name')).toHaveValue('Basic read quality check');
  // Back returns to the gallery with nothing created.
  await page.getByTestId('template-back').click();
  await expect(page.getByTestId('template-card-basic-read-qc')).toBeVisible();
  await expect(nodes(page)).toHaveCount(0);
});

test('Escape closes the gallery and the New dialog leads to it', async ({ page }) => {
  await page.getByTestId('new-from-template').click();
  await expect(page.getByTestId('template-dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('template-dialog')).toHaveCount(0);

  await page.getByRole('button', { name: 'New', exact: true }).click();
  await page.getByTestId('new-dialog-templates').click();
  await expect(page.getByTestId('template-dialog')).toBeVisible();
});

test('the gallery is reachable and usable from the keyboard', async ({ page }) => {
  await page.getByTestId('new-from-template').focus();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('template-search')).toBeFocused();
  await page.keyboard.type('quality');
  await page.keyboard.press('Tab'); // topic filter
  await page.keyboard.press('Tab'); // the first card
  await expect(page.getByTestId('template-card-basic-read-qc')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('template-input-field-reads')).toBeFocused();
  await page.keyboard.type('/data/sample.fastq.gz');
  // Choose file, the reference links, Back, then Create: all reachable by Tab.
  for (let i = 0; i < 10; i++) {
    if (await page.getByTestId('template-create').evaluate((el) => el === document.activeElement)) break;
    await page.keyboard.press('Tab');
  }
  await expect(page.getByTestId('template-create')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(nodes(page)).toHaveCount(4);
});

test('the dialog fits the smallest window, footer included', async ({ page, app }) => {
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].setContentSize(1024, 700);
  });
  await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(1024);
  await openGallery(page);
  const fits = async (testId: string) => {
    const box = (await page.getByTestId(testId).boundingBox())!;
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.y + box.height).toBeLessThanOrEqual(700);
    expect(box.x + box.width).toBeLessThanOrEqual(1024);
  };
  await fits('template-dialog');
  await expect(page.getByTestId('template-close')).toBeInViewport({ ratio: 1 });
  await page.getByTestId('template-card-basic-read-qc').click();
  await fits('template-dialog');
  await expect(page.getByTestId('template-create')).toBeInViewport({ ratio: 1 });
  const scrollsSideways = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  expect(scrollsSideways).toBe(false);
});

test('in a narrow window the problem list stays closed and the steps are not covered', async ({ page, app }) => {
  await setWindow(app, 1024, 700);
  await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(1024);
  await openGallery(page);
  await page.getByTestId('template-card-basic-read-qc').click();
  await page.getByTestId('template-create').click();
  await expect(nodes(page)).toHaveCount(4);
  await expect(page.getByTestId('problems-panel')).toHaveCount(0);
  await expect(page.getByTestId('problems-toggle')).toContainText('2 problems');
  await page.waitForTimeout(600);
  const run = (await page.getByTestId('run-controls').boundingBox())!;
  for (const box of await nodes(page).evaluateAll((els) => els.map((el) => el.getBoundingClientRect().toJSON()))) {
    expect(box.right <= run.x || box.left >= run.x + run.width || box.top >= run.y + run.height).toBe(true);
  }
});

test('a template that replaces unsaved work asks first', async ({ page }) => {
  await createBasic(page, '/data/a.fq');
  await openGallery(page);
  await page.getByTestId('template-card-basic-read-qc').click();
  await page.getByTestId('template-create').click();
  await expect(page.getByTestId('confirm-dialog')).toContainText('Replace the current workflow?');
  await page.getByTestId('confirm-cancel').click();
  // Declining keeps the gallery open and the workflow as it was.
  await expect(page.getByTestId('template-dialog')).toBeVisible();
  await page.getByTestId('template-create').click();
  await page.getByTestId('confirm-accept').click();
  await expect(page.getByTestId('template-dialog')).toHaveCount(0);
  await expect(nodes(page)).toHaveCount(4);
});

test('saving the canvas as a template adds it to My templates', async ({ page, sandbox }) => {
  await createBasic(page, '/data/sample.fastq.gz');

  await openGallery(page);
  await page.getByTestId('template-save-current').click();
  await expect(page.getByTestId('save-template-dialog')).toBeVisible();
  await page.getByTestId('save-template-name').fill('My lab QC');
  await page.getByTestId('save-template-description').fill('Our standard first look at reads.');
  // The reads file used by two steps is one question, already ticked.
  await expect(page.getByTestId('save-template-dialog')).toContainText('Reads');
  await page.getByTestId('save-template-confirm').click();
  await expect(page.getByTestId('save-template-dialog')).toHaveCount(0);
  await expect(page.getByTestId('toast').last()).toContainText('Saved "My lab QC"');

  const files = fs.readdirSync(userTemplatesDir(sandbox));
  expect(files).toHaveLength(1);
  const saved = JSON.parse(fs.readFileSync(path.join(userTemplatesDir(sandbox), files[0]), 'utf8'));
  expect(saved).toMatchObject({ formatVersion: 1, name: 'My lab QC', description: 'Our standard first look at reads.' });
  expect(saved.steps).toHaveLength(4);
  expect(saved.inputs).toHaveLength(1);
  expect(JSON.stringify(saved)).not.toContain('/data/sample.fastq.gz');

  // It is listed apart from the ready-made ones and works like them.
  await openGallery(page);
  const mine = page.getByTestId('template-grid-user');
  await expect(mine).toContainText('My lab QC');
  await expect(page.getByTestId('template-grid-bundled')).not.toContainText('My lab QC');
  await mine.locator('[data-testid^="template-card-"]').click();
  await page.getByTestId('template-input-field-reads').fill('/data/other.fq.gz');
  await page.getByTestId('template-create').click();
  await page.getByTestId('confirm-accept').click();
  await expect(nodes(page)).toHaveCount(4);
  await nodes(page).filter({ hasText: 'FastQC (raw reads)' }).click();
  await expect(page.getByTestId('prop-slot-reads')).toHaveValue('/data/other.fq.gz');
});

test('My templates can be renamed and deleted', async ({ page, sandbox }) => {
  await createBasic(page, '/data/sample.fastq.gz');
  await openGallery(page);
  await page.getByTestId('template-save-current').click();
  await page.getByTestId('save-template-name').fill('Old name');
  await page.getByTestId('save-template-confirm').click();
  await expect(page.getByTestId('save-template-dialog')).toHaveCount(0);

  await openGallery(page);
  const id = path.basename(fs.readdirSync(userTemplatesDir(sandbox))[0], '.json');
  await page.getByTestId(`template-rename-${id}`).click();
  await page.getByTestId('template-rename-input').fill('New name');
  await page.getByTestId('template-rename-save').click();
  await expect(page.getByTestId('template-grid-user')).toContainText('New name');
  const onDisk = JSON.parse(fs.readFileSync(path.join(userTemplatesDir(sandbox), `${id}.json`), 'utf8'));
  expect(onDisk.name).toBe('New name');

  // Escape cancels a rename without closing the gallery.
  await page.getByTestId(`template-rename-${id}`).click();
  await page.getByTestId('template-rename-input').fill('Never mind');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('template-dialog')).toBeVisible();
  await expect(page.getByTestId('template-grid-user')).toContainText('New name');

  await page.getByTestId(`template-delete-${id}`).click();
  await expect(page.getByTestId('confirm-dialog')).toContainText('Delete this template?');
  await page.getByTestId('confirm-accept').click();
  await expect(page.getByTestId('my-templates-empty')).toBeVisible();
  expect(fs.readdirSync(userTemplatesDir(sandbox))).toEqual([]);
});

test('a damaged template file is reported and can be removed', async ({ page, sandbox }) => {
  fs.mkdirSync(userTemplatesDir(sandbox), { recursive: true });
  fs.writeFileSync(path.join(userTemplatesDir(sandbox), 'broken.json'), '{ nope');
  fs.writeFileSync(
    path.join(userTemplatesDir(sandbox), 'unknown-tool.json'),
    JSON.stringify({ formatVersion: 1, id: 'unknown-tool', name: 'X' })
  );
  await openGallery(page);
  const broken = page.getByTestId('template-broken');
  await expect(broken).toContainText('broken.json cannot be used');
  await expect(broken).toContainText('unknown-tool.json cannot be used');
  await broken.getByRole('button', { name: 'Delete' }).first().click();
  await page.getByTestId('confirm-accept').click();
  await expect(broken).not.toContainText('broken.json');
});

test('a workflow with a step written by hand cannot become a template, and says why', async ({ page }) => {
  await page.getByTestId('add-node').click();
  await expect(nodes(page)).toHaveCount(1);
  await page.getByTestId('new-from-template').click();
  const save = page.getByTestId('template-save-current');
  await expect(save).toHaveAttribute('aria-disabled', 'true');
  await save.hover();
  await expect(page.getByRole('tooltip')).toContainText('custom step');
});
