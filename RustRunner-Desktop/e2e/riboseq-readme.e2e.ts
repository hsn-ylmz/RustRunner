/**
 * riboseq-test/README.md, section 3, followed literally in the real app up to
 * (not including) the click on Run: the same button names, the same field
 * labels, the same default settings and the real data files. If the README
 * and the app drift apart, this test says where.
 *
 * Needs the data of riboseq-test/prepare_data.sh (git-ignored); without it the
 * test is skipped. With UX_OUT set it also writes the screenshots of the
 * gallery card and the setup step into that folder (taken at 1x).
 */

import fs from 'fs';
import path from 'path';
import type { ElectronApplication, Page } from '@playwright/test';
import { test, expect, nodes } from './fixtures';

const REPO = path.resolve(__dirname, '..', '..');
const DATA = path.join(REPO, 'riboseq-test', 'data');
const README = fs.readFileSync(path.join(REPO, 'riboseq-test', 'README.md'), 'utf8');

/** README section 3, step 4: field label -> file under riboseq-test/data. */
const FILES: Array<{ id: string; label: string; file: string }> = [
  { id: 'reads', label: 'Sequencing reads (FASTQ)', file: 'full/SRR12693498_5000000reads.fastq.gz' },
  { id: 'rrna', label: 'rRNA sequences (FASTA)', file: 'ref/rRNA.fa' },
  { id: 'trna', label: 'tRNA sequences (FASTA)', file: 'ref/tRNA.fa' },
  { id: 'ncrna', label: 'Other small ncRNA sequences (FASTA)', file: 'ref/ncRNA.fa' },
  { id: 'genome', label: 'Genome sequence (FASTA)', file: 'ref/genome_chr17_19_22.fa' },
  { id: 'annotation', label: 'Gene annotation (GTF)', file: 'ref/annotation_chr17_19_22.gtf' },
];

/** README section 3, step 5: setting label (start of it) -> default shown in the setup step. */
const SETTINGS: Array<{ label: RegExp; readme: string; value: string }> = [
  { label: /^3' adapter/, readme: "3' adapter", value: 'AAAAAAAAAACAAAAAAAAAAGATCGGAAGAGCACACGTCTGAACTCCAGTCAC' },
  { label: /^Shortest read kept by cutadapt/, readme: 'Shortest read kept by cutadapt', value: '36' },
  { label: /^UMI position/, readme: 'UMI position', value: '5prime' },
  { label: /^UMI length/, readme: 'UMI length', value: '12' },
  { label: /^Bases to remove next to the UMI/, readme: 'Bases to remove next to the UMI', value: '4' },
  { label: /^Shortest footprint/, readme: 'Shortest / longest footprint', value: '28' },
  { label: /^Longest footprint/, readme: 'Shortest / longest footprint', value: '34' },
  { label: /^Adjust P-site offsets to the reading frame/, readme: 'Adjust P-site offsets to the reading frame', value: 'frame' },
  { label: /^Mismatches allowed in STAR/, readme: 'Mismatches allowed in STAR', value: '2' },
  { label: /^Most places a read may align to/, readme: 'Most places a read may align to', value: '1' },
];

const missing = FILES.map((f) => path.join(DATA, f.file)).filter((f) => !fs.existsSync(f));
test.skip(missing.length > 0, `the Ribo-seq test data is missing (run ./riboseq-test/prepare_data.sh): ${missing.join(', ')}`);

const OUT = process.env.UX_OUT ? path.resolve(process.env.UX_OUT) : '';

async function shoot(page: Page, name: string) {
  if (!OUT) return;
  fs.mkdirSync(OUT, { recursive: true });
  await page.waitForTimeout(350);
  await page.screenshot({ path: path.join(OUT, `${name}.png`) });
}

/** Answers the next native file or folder picker with `file`. */
async function pickerReturns(app: ElectronApplication, file: string) {
  await app.evaluate(({ dialog }, f) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [f] })) as any;
  }, file);
}

test('README section 3 works as written, with the real data, up to Run', async ({ app, page, sandbox }) => {
  test.setTimeout(120_000);
  await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0];
    w.setContentSize(1440, 900);
    w.center();
  });

  // Every name the README uses for a field or a setting is the app's.
  for (const f of FILES) expect(README, `README names the field "${f.label}"`).toContain(`| ${f.label} | \`riboseq-test/data/${f.file}\` |`);
  for (const s of SETTINGS) expect(README, `README names the setting "${s.readme}"`).toContain(`| ${s.readme} |`);

  // Step 2: "Templates" in the top toolbar, or the templates button on the empty canvas.
  await expect(page.getByTestId('new-from-template')).toHaveText('Templates');
  await expect(page.getByTestId('empty-templates')).toHaveText('Start from a template');
  expect(README).toContain('**Start from a template**');
  await page.getByTestId('new-from-template').click();
  await expect(page.getByTestId('template-dialog')).toBeVisible();

  // Step 3: type "ribo", the card says 20 steps and advanced.
  await page.getByTestId('template-search').fill('ribo');
  const card = page.getByTestId('template-card-riboseq-umi-ribowaltz');
  await expect(card).toBeVisible();
  await expect(card).toContainText('Ribo-seq with UMIs (riboWaltz)');
  await expect(card).toContainText('20 steps');
  await expect(card).toContainText('Advanced');
  await shoot(page, '01-gallery-card');
  await card.click();
  await expect(page.getByTestId('template-setup')).toBeVisible();
  // "The right-hand column draws the pipeline and lists what you will get."
  const drawing = page.locator('.template-dag-large').first();
  await expect(drawing).toBeVisible();
  await expect(page.getByTestId('template-outputs')).toContainText('riboWaltz report');
  const filesBox = await page.getByTestId('template-input-reads').boundingBox();
  const drawingBox = await drawing.boundingBox();
  expect(drawingBox!.x).toBeGreaterThan(filesBox!.x + filesBox!.width - 1);

  // Step 4: under "Your files", "Choose file" for the reads and the full path pasted for the others.
  await expect(page.getByRole('heading', { name: 'Your files' })).toBeVisible();
  for (const f of FILES) await expect(page.getByTestId(`template-input-${f.id}`)).toContainText(f.label);
  await expect(page.getByTestId('template-input-choose-reads')).toHaveText('Choose file');
  await pickerReturns(app, path.join(DATA, FILES[0].file));
  await page.getByTestId('template-input-choose-reads').click();
  await expect(page.getByTestId('template-input-field-reads')).toHaveValue(path.join(DATA, FILES[0].file));
  for (const f of FILES.slice(1)) await page.getByTestId(`template-input-field-${f.id}`).fill(path.join(DATA, f.file));
  for (const f of FILES) await expect(page.getByTestId(`template-input-warning-${f.id}`)).toHaveCount(0);
  await expect(page.getByTestId('template-missing-note')).toHaveCount(0);
  await page.getByRole('heading', { name: 'Your files' }).evaluate((el) => el.scrollIntoView({ block: 'start' }));
  await shoot(page, '02-setup-files');

  // Step 5: under "Check these settings", the defaults of the README table.
  await expect(page.getByRole('heading', { name: 'Check these settings' })).toBeVisible();
  for (const s of SETTINGS) await expect(page.getByLabel(s.label), String(s.label)).toHaveValue(s.value);
  await page.getByRole('heading', { name: 'Check these settings' }).evaluate((el) => el.scrollIntoView({ block: 'start' }));
  await shoot(page, '03-setup-settings');
  await page.getByLabel(/^Most places a read may align to/).evaluate((el) => el.scrollIntoView({ block: 'end' }));
  await shoot(page, '04-setup-settings-end');

  // Step 6: Create workflow: 20 steps, connected, no problem listed.
  await expect(page.getByTestId('template-create')).toHaveText('Create workflow');
  await page.getByTestId('template-create').click();
  await expect(page.getByTestId('template-dialog')).toHaveCount(0);
  await expect(nodes(page)).toHaveCount(20);
  await expect(page.getByTestId('problems-toggle')).toHaveCount(0);
  await shoot(page, '05-workflow');

  // Step 7: "Choose results folder" (top left, under the workflow name), a new empty folder outside riboseq-test/.
  const results = path.join(sandbox.workDir, 'riboseq-results', 'run1');
  fs.mkdirSync(results, { recursive: true });
  await expect(page.getByTestId('set-directory')).toHaveText('Choose results folder');
  await pickerReturns(app, results);
  await page.getByTestId('set-directory').click();
  await expect(page.getByTestId('set-directory')).toHaveText('Folder: run1');

  // Step 8: Dry run checks every step without installing or running anything.
  await expect(page.getByTestId('dry-run')).toHaveText('Dry run');
  await page.getByTestId('dry-run').click();
  await expect(page.getByTestId('run-summary-title')).toHaveText('Dry run succeeded', { timeout: 60_000 });
  await expect(page.getByTestId('progress')).toHaveText('20 / 20 steps');
  // Nothing was run or recorded: the folder is still empty, so Run afterwards runs every step.
  expect(fs.readdirSync(results)).toEqual([]);
  await shoot(page, '06-dry-run');

  // Step 9: Run is there and can be clicked (the test stops here), and so are the two tabs the README names.
  await expect(page.getByTestId('run')).toHaveText('Run');
  await expect(page.getByTestId('run')).toBeEnabled();
  await expect(page.getByTestId('run-from-scratch')).toHaveText('Run from scratch');
  await expect(page.getByTestId('tab-steps')).toContainText('Step status');
  await expect(page.getByTestId('tab-logs')).toHaveText('Execution logs');
});
