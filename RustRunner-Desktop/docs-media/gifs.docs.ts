/**
 * The three recordings behind docs/media/*.gif. Each test drives the real app
 * the way a person would; nothing on screen is simulated. See recorder.ts.
 *
 *   npm run docs:gifs              all three, then converts them to GIFs
 *   DOCS_ONLY=template npm run docs:gifs   one of: template, catalog, failure
 */

import fs from 'fs';
import path from 'path';
import type { Page } from '@playwright/test';
import { test, expect } from '@playwright/test';
import { Recording, REPO, SANDBOX, preparedEnvDirs } from './recorder';

const only = process.env.DOCS_ONLY ?? '';
const wanted = (name: string) => only === '' || only === name;
// With DOCS_SANDBOX set, the data is reached through <sandbox>/riboseq-data (a
// symlink to riboseq-test/data) so the file fields show the neutral path too.
const DATA = process.env.DOCS_SANDBOX
  ? path.join(SANDBOX, 'riboseq-data')
  : path.join(REPO, 'riboseq-test', 'data');

const nodes = (page: Page) => page.getByTestId('workflow-node');

async function pickerReturns(rec: Recording, file: string) {
  await rec.app.evaluate(({ dialog }, f) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [f] })) as never;
  }, file);
}

/** One text per node state: changes whenever a step starts, finishes, retries or is skipped. */
const statusSignature = (page: Page) => () =>
  nodes(page).evaluateAll((els) =>
    els.map((e) => e.querySelector('[data-testid="node-status-line"]')?.getAttribute('data-status') ?? '-').join(',')
  );

// -----------------------------------------------------------------------------
// a. Template to run
// -----------------------------------------------------------------------------

test('template-to-run', async () => {
  test.skip(!wanted('template'), 'DOCS_ONLY');
  const files = [
    { id: 'reads', file: 'tiny/SRR12693498_200000reads_seed42.fastq.gz' },
    { id: 'rrna', file: 'ref/rRNA.fa' },
    { id: 'trna', file: 'ref/tRNA.fa' },
    { id: 'ncrna', file: 'ref/ncRNA.fa' },
    { id: 'genome', file: 'ref/genome_chr17_19_22.fa' },
    { id: 'annotation', file: 'ref/annotation_chr17_19_22.gtf' },
  ];
  const missing = files.map((f) => path.join(DATA, f.file)).filter((f) => !fs.existsSync(f));
  test.skip(missing.length > 0, `Ribo-seq test data is missing: ${missing.join(', ')}`);
  const envs = preparedEnvDirs();
  test.skip(envs.length === 0, 'no prepared tool environments in .sandbox/envs (run npm run test:tools once)');

  const rec = await Recording.start('template-to-run', { CONDA_ENVS_DIRS: envs.join(path.delimiter) });
  try {
    await recordTemplateToRun(rec, files);
  } catch (e) {
    await rec.abort(e);
    throw e;
  }
});

async function recordTemplateToRun(rec: Recording, files: Array<{ id: string; file: string }>) {
  const { page } = rec;

  await rec.caption('RustRunner: start from a template');
  await rec.pause(1200);
  await rec.click(page.getByTestId('empty-templates'), 900);
  await rec.type(page.getByTestId('template-search'), 'ribo');
  await rec.pause(700);
  await rec.caption('Pick the Ribo-seq pipeline');
  await rec.click(page.getByTestId('template-card-riboseq-umi-ribowaltz'), 1200);

  await rec.caption('Choose your files');
  for (const f of files) {
    await pickerReturns(rec, path.join(DATA, f.file));
    await rec.click(page.getByTestId(`template-input-choose-${f.id}`), 500);
    await expect(page.getByTestId(`template-input-field-${f.id}`)).toHaveValue(path.join(DATA, f.file));
  }
  await rec.pause(900);
  await rec.caption('Check the settings of your library');
  await page.getByRole('heading', { name: 'Check these settings' }).evaluate((el) => el.scrollIntoView({ block: 'start' }));
  await rec.pause(2200);
  await rec.caption('Create the workflow');
  await rec.click(page.getByTestId('template-create'), 600);
  await expect(nodes(page)).toHaveCount(20);
  // The app fits all 20 steps into the part of the canvas the run card leaves free.
  await rec.pause(2600);
  await rec.caption('Choose where the results go, then Run');
  await pickerReturns(rec, rec.workDir);
  await rec.click(page.getByTestId('set-directory'), 900);
  await rec.click(page.getByTestId('run'), 600);
  await rec.caption('');
  try {
    await expect(page.getByTestId('stop')).toBeEnabled({ timeout: 30_000 });
  } catch (e) {
    await page.screenshot({ path: path.join(rec.root, 'run-did-not-start.png') });
    throw e;
  }

  await rec.watch({
    signature: statusSignature(page),
    done: async () => (await page.getByTestId('run-summary').count()) > 0,
    idleSeconds: 3,
    timeoutSeconds: 12 * 60,
    cutCaption: () => 'Tools install and run (waiting time cut from this recording)',
  });
  await expect(page.getByTestId('run-summary-title')).toHaveText('Run succeeded');
  await rec.caption('Every step ran with the real tools');
  await rec.pause(3500);
  await rec.finish();
}

// -----------------------------------------------------------------------------
// b. Catalog and slots
// -----------------------------------------------------------------------------

const nodeByText = (page: Page, text: string) => nodes(page).filter({ hasText: text }).first();

async function connectSlowly(rec: Recording, from: string, to: string) {
  const { page } = rec;
  const src = nodeByText(page, from).locator('.react-flow__handle.source');
  const dst = nodeByText(page, to).locator('.react-flow__handle.target');
  await rec.drag(src, dst);
}

async function addFromPaletteSlowly(rec: Recording, query: string, id: string) {
  const { page } = rec;
  const search = page.getByTestId('palette-search');
  await rec.type(search, query);
  const item = page.getByTestId(`palette-item-${id}`);
  await rec.moveTo(item);
  await rec.pause(1500); // the preview beside the list says what the tool needs and makes
  await rec.click(item, 900);
}

test('catalog-and-slots', async () => {
  test.skip(!wanted('catalog'), 'DOCS_ONLY');
  const rec = await Recording.start('catalog-and-slots');
  const { page } = rec;
  try {
    await rec.caption('Search the tool catalog');
    await rec.pause(1200);
    await rec.click(page.getByTestId('empty-add-catalog'), 700);
    await addFromPaletteSlowly(rec, 'fastp', 'fastp');
    await expect(nodes(page)).toHaveCount(1);
    await rec.pause(900);

    await rec.caption('Only tools that fit after the selected step');
    await rec.click(page.getByTestId('open-palette'), 700);
    await rec.click(page.getByTestId('palette-fits-after'), 800);
    await rec.type(page.getByTestId('palette-search'), 'samtools sort');
    await expect(page.getByTestId('palette-empty')).toBeVisible();
    await rec.caption('samtools sort reads alignments, not the reads fastp writes: hidden');
    await rec.pause(2600);
    await rec.caption('Trimmers that read fastp output stay');
    await rec.type(page.getByTestId('palette-search'), 'cutadapt');
    await rec.pause(1200);
    await rec.click(page.getByTestId('palette-item-cutadapt'), 900);
    await expect(nodes(page)).toHaveCount(2);

    await rec.caption('Connect two steps: the file slot fills in by itself');
    await connectSlowly(rec, 'fastp', 'cutadapt');
    await expect(page.locator('[data-testid="typed-edge"][data-type-match="match"]')).toHaveCount(1);
    await rec.click(nodeByText(page, 'cutadapt'), 900);
    const basics = page.getByTestId('section-basics-toggle');
    if ((await basics.getAttribute('aria-expanded')) === 'true') await rec.click(basics, 500);
    const io = page.getByTestId('section-io-toggle');
    if ((await io.getAttribute('aria-expanded')) !== 'true') await rec.click(io, 600);
    await expect(page.getByTestId('prop-slots')).toBeVisible();
    await expect(page.getByTestId('prop-slots')).toContainText('fastp');
    await rec.caption('Green: the file type fits. The reads slot shows where it comes from');
    await rec.pause(3200);

    await rec.caption('Connect a step that cannot read it: the edge turns orange');
    await rec.click(page.getByTestId('open-palette'), 700);
    await addFromPaletteSlowly(rec, 'samtools sort', 'samtools-sort');
    await expect(nodes(page)).toHaveCount(3);
    await connectSlowly(rec, 'cutadapt', 'samtools sort');
    await expect(page.locator('[data-testid="typed-edge"][data-type-match="mismatch"]')).toHaveCount(1);
    await rec.pause(3500);
    await rec.caption('');
    await rec.finish();
  } catch (e) {
    await rec.abort(e);
    throw e;
  }
});

// -----------------------------------------------------------------------------
// c. Failure and report
// -----------------------------------------------------------------------------

/**
 * "Open report" hands the file to the person's browser, which a recording of the app cannot show. The
 * app's call to open it is intercepted (nothing external starts) and the report file itself is shown in a
 * full-window frame inside the recorded window, with a note saying so.
 */
async function interceptOpenPath(rec: Recording) {
  await rec.app.evaluate(({ shell }) => {
    const g = globalThis as unknown as { __opened?: string[] };
    g.__opened = [];
    shell.openPath = (async (target: string) => {
      g.__opened!.push(target);
      return '';
    }) as never;
  });
}

async function showOpenedReport(rec: Recording, note: string) {
  const { page } = rec;
  await expect
    .poll(() => rec.app.evaluate(() => ((globalThis as unknown as { __opened?: string[] }).__opened ?? []).length))
    .toBeGreaterThan(0);
  const opened = await rec.app.evaluate(() => {
    const list = (globalThis as unknown as { __opened: string[] }).__opened;
    return list[list.length - 1];
  });
  const html = fs.readFileSync(opened, 'utf8');
  await page.evaluate(
    ({ html: doc, note: text, name }) => {
      const wrap = document.createElement('div');
      wrap.id = 'docs-report-view';
      wrap.style.cssText = 'position:fixed;inset:0;z-index:2147483000;background:#fff;display:flex;flex-direction:column;';
      const bar = document.createElement('div');
      bar.style.cssText =
        'padding:8px 16px;background:#eef1f5;border-bottom:1px solid #c9d0da;font:600 13px -apple-system,sans-serif;color:#1f2530;display:flex;gap:12px;';
      bar.textContent = `${name}  -  ${text}`;
      const frame = document.createElement('iframe');
      frame.style.cssText = 'flex:1;border:0;width:100%;';
      frame.srcdoc = doc;
      wrap.append(bar, frame);
      document.body.appendChild(wrap);
    },
    { html, note, name: path.basename(opened) }
  );
}

const closeReportView = (page: Page) => page.evaluate(() => document.getElementById('docs-report-view')?.remove());

test('failure-and-report', async () => {
  test.skip(!wanted('failure'), 'DOCS_ONLY');
  const rec = await Recording.start('failure-and-report');
  const { page } = rec;
  try {
    await interceptOpenPath(rec);
    await pickerReturns(rec, rec.workDir);

    // A small workflow, built before the recording is interesting: two steps, the first writes an empty file.
    await rec.caption('A step with an output check');
    await rec.pause(800);
    await rec.hidden('building the workflow', async () => {
      const build = async (index: number, label: string, command: string, input: string, output: string) => {
        await page.getByTestId('add-node').click();
        await expect(nodes(page)).toHaveCount(index);
        await nodes(page).filter({ hasText: `Node ${index}` }).first().click();
        await page.getByTestId('prop-label').fill(label);
        await page.getByTestId('prop-tool').fill('bash');
        await page.getByTestId('prop-command').fill(command);
        await page.getByTestId('prop-input').fill(input);
        await page.getByTestId('prop-output').fill(output);
      };
      await build(1, 'Filter reads', ': > {output}', '', 'filtered.txt');
      await build(2, 'Summarise', 'cp {input} {output}', 'filtered.txt', 'summary.txt');
      await connectSlowly(rec, 'Filter reads', 'Summarise');
      await nodeByText(page, 'Filter reads').click();
      const checks = page.getByTestId('section-checks-toggle');
      if ((await checks.getAttribute('aria-expanded')) !== 'true') await checks.click();
      await page.getByTestId('prop-check-non-empty').check();
      await page.mouse.click(700, 780);
      await page.getByTestId('set-directory').click();
    });
    await rec.click(nodeByText(page, 'Filter reads'), 600);
    await rec.pause(1800);

    await rec.caption('Run it');
    await rec.click(page.getByTestId('run'), 400);
    await expect(page.getByTestId('failure-card')).toBeVisible({ timeout: 60_000 });
    await rec.caption('The step failed its check; the next one did not run');
    await rec.pause(4200);

    await rec.caption('Edit step opens the setting to change');
    await rec.click(page.getByTestId('failure-edit-step'), 1200);
    await rec.pause(1800);
    await rec.caption('Fix the command');
    await rec.type(page.getByTestId('prop-command'), 'echo "reads kept" > {output}');
    await rec.pause(900);

    await rec.caption('Run again');
    await rec.click(page.getByTestId('run'), 400);
    await expect(page.getByTestId('run-summary-title')).toHaveText('Run succeeded', { timeout: 60_000 });
    await rec.pause(2400);

    await rec.caption('Every run is kept in the run history');
    await rec.click(page.getByTestId('tab-history'), 900);
    await expect(page.getByTestId('history-row')).toHaveCount(2);
    await rec.pause(2400);

    await rec.caption('Open the run report');
    await rec.click(page.getByTestId('history-row').first().getByTestId('open-report'), 900);
    await showOpenedReport(rec, 'the report opens in your browser; shown here inside the window');
    await rec.pause(2200);
    await page.evaluate(() => (document.querySelector('#docs-report-view iframe') as HTMLIFrameElement | null)?.contentWindow?.scrollBy({ top: 420, behavior: 'smooth' }));
    await rec.pause(3500);
    await closeReportView(page);
    await rec.caption('');
    await rec.finish();
  } catch (e) {
    await rec.abort(e);
    throw e;
  }
});
