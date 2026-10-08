/**
 * A run that cannot start because the tool installer (micromamba) is missing:
 * the app says so in a card, offers to install it, and the run works after.
 *
 * The engine is pointed at a micromamba path inside the sandbox that does not
 * exist yet (RUSTRUNNER_MICROMAMBA), and the "download" is a local file:// fixture
 * through the test-only source override. A packaged app ignores that override
 * and downloads only the pinned release over https (see micromambaInstall.ts).
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { test as base, expect, buildChain } from './fixtures';

/** A stand-in for micromamba that accepts every command and does nothing. */
const FAKE_MICROMAMBA = '#!/bin/sh\nexit 0\n';
const FAKE_SHA = crypto.createHash('sha256').update(FAKE_MICROMAMBA).digest('hex');

const test = base;
test.use({
  appEnv: {
    RUSTRUNNER_MICROMAMBA: '{root}/mm/micromamba',
    RUSTRUNNER_TEST_MICROMAMBA_SOURCE: JSON.stringify({
      url: 'file://{root}/fixture/micromamba',
      sha256: FAKE_SHA,
    }),
  },
});

const CONDA_STEP = [{ label: 'Align', tool: 'bowtie2', command: 'echo hi > {output}', output: 'a.txt' }];

test('a missing tool installer shows a clear card and can be installed in the app', async ({
  page,
  sandbox,
}) => {
  const root = path.dirname(sandbox.workDir);
  fs.mkdirSync(path.join(root, 'fixture'));
  fs.writeFileSync(path.join(root, 'fixture', 'micromamba'), FAKE_MICROMAMBA);

  await buildChain(page, CONDA_STEP);
  await page.getByTestId('run-from-scratch').click();

  const card = page.getByTestId('setup-card');
  await expect(card).toBeVisible();
  await expect(page.getByTestId('setup-title')).toHaveText('The tool installer (micromamba) is missing');
  await expect(page.getByTestId('setup-what')).toContainText('No step was run');
  await expect(page.getByTestId('run-summary-title')).toHaveText('Run failed');
  await expect(page.getByTestId('failure-card')).toHaveCount(0);

  // Every place the engine looked is listed (here: the one path it was told to use).
  await page.getByTestId('setup-searched').locator('summary').click();
  await expect(page.getByTestId('setup-searched')).toContainText(path.join(root, 'mm', 'micromamba'));

  if (process.env.UX_OUT) {
    fs.mkdirSync(process.env.UX_OUT, { recursive: true });
    await page.screenshot({ path: path.join(process.env.UX_OUT, 'setup-card.png') });
  }

  await page.getByTestId('setup-install').click();
  await expect(page.getByTestId('setup-install-result')).toContainText('Press Run to start again');
  if (process.env.UX_OUT) {
    await page.screenshot({ path: path.join(process.env.UX_OUT, 'setup-card-installed.png') });
  }
  await expect(page.getByTestId('setup-install')).toHaveCount(0);
  const installed = path.join(root, 'mm', 'micromamba');
  expect(fs.readFileSync(installed, 'utf-8')).toBe(FAKE_MICROMAMBA);
  if (process.platform !== 'win32') expect(fs.statSync(installed).mode & 0o111).not.toBe(0);

  // Run again: the check passes now and the run goes through.
  await page.getByTestId('run-from-scratch').click();
  await expect(page.getByTestId('run-summary-title')).toHaveText('Run succeeded');
  await expect(page.getByTestId('setup-card')).toHaveCount(0);
});

test('a checksum mismatch is refused and nothing is installed', async ({ page, sandbox }) => {
  const root = path.dirname(sandbox.workDir);
  fs.mkdirSync(path.join(root, 'fixture'));
  fs.writeFileSync(path.join(root, 'fixture', 'micromamba'), '#!/bin/sh\necho tampered\n');

  await buildChain(page, CONDA_STEP);
  await page.getByTestId('run-from-scratch').click();
  await page.getByTestId('setup-install').click();

  await expect(page.getByTestId('setup-install-result')).toContainText('checksum');
  // The offer stays, so the person can try again.
  await expect(page.getByTestId('setup-install')).toBeVisible();
  expect(fs.existsSync(path.join(root, 'mm', 'micromamba'))).toBe(false);
});

test('a dry run does not need the tool installer', async ({ page }) => {
  await buildChain(page, CONDA_STEP);
  await page.getByTestId('dry-run').click();
  await expect(page.getByTestId('run-summary-title')).toHaveText('Dry run succeeded');
  await expect(page.getByTestId('setup-card')).toHaveCount(0);
});
