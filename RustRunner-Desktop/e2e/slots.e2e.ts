/**
 * Named file slots: a command that names files in braces gets labelled file
 * fields, connecting two steps fills a matching slot, and the preview shows the
 * command as it will run. The rules are unit-tested in
 * src/renderer/__tests__/slots.test.ts; these drive the real app and engine.
 */

import fs from 'fs';
import path from 'path';
import { test, expect, addNode, connect, fillNode, nodes, openSection, selectNode, type NodeSpec } from './fixtures';
import type { Page } from '@playwright/test';

/** Adds a custom node and fills it in, leaving it selected. */
async function addFilledNode(page: Page, spec: NodeSpec): Promise<void> {
  const before = await nodes(page).count();
  await addNode(page);
  await nodes(page).filter({ hasText: `Node ${before + 1}` }).first().click();
  await expect(page.getByTestId('prop-label')).toHaveValue(`Node ${before + 1}`);
  await fillNode(page, spec);
  await expect(nodes(page).filter({ hasText: spec.label })).toHaveCount(1);
}

const TRIM: NodeSpec = {
  label: 'Trim reads',
  command: 'cp {input} {output}',
  input: 'raw.fastq',
  output: 'trimmed.fastq',
};

test('a command with {placeholders} gets labelled file fields and a preview', async ({ page }) => {
  await addFilledNode(page, { label: 'Align', command: 'bwa mem {ref} {reads} > {output}', output: 'aligned.sam' });

  const slots = page.getByTestId('prop-slots');
  await expect(slots).toBeVisible();
  // Plain words and the declared file type, not the raw placeholder alone.
  await expect(page.getByTestId('prop-slot-ref')).toBeVisible();
  await expect(page.getByLabel('Reference genome', { exact: true })).toBeVisible();
  await expect(slots).toContainText('Reference genome');
  await expect(slots).toContainText('Reads');
  await expect(slots).toContainText('File type: fasta');
  // Folded, the section says what is open.
  await page.getByTestId('section-io-toggle').click();
  await expect(page.getByTestId('section-io-toggle')).toContainText('2 named files, 2 to choose');
  await page.getByTestId('section-io-toggle').click();

  // The preview marks both open placeholders with words, not only a colour.
  const preview = page.getByTestId('command-preview');
  await expect(preview).toContainText('bwa mem');
  await expect(page.getByTestId('preview-missing-ref')).toContainText('{ref}');
  await expect(page.getByTestId('preview-missing-ref')).toContainText('no file');
  await expect(page.getByTestId('preview-missing-reads')).toBeVisible();
  await expect(page.getByTestId('command-preview-missing')).toContainText('{ref}, {reads}');

  // Typing a file fills the preview in; the other stays marked.
  await page.getByTestId('prop-slot-ref').fill('genome.fa');
  await expect(page.getByTestId('preview-missing-ref')).toHaveCount(0);
  await expect(preview).toContainText('bwa mem genome.fa {reads}');
  await expect(page.getByTestId('preview-missing-reads')).toBeVisible();
  await page.getByTestId('section-io-toggle').click();
  await expect(page.getByTestId('section-io-toggle')).toContainText('1 to choose');
  await page.getByTestId('section-io-toggle').click();
});

test('connecting two steps binds the slot of the matching file type, and the preview resolves', async ({
  page,
}) => {
  await addFilledNode(page, TRIM);
  await addFilledNode(page, { label: 'Align', command: 'bwa mem {ref} {reads} > {output}', output: 'aligned.sam' });
  await page.getByTestId('prop-slot-ref').fill('genome.fa');

  await connect(page, 'Trim reads', 'Align');
  await selectNode(page, 'Align');

  // trimmed.fastq is fastq: it goes to "Reads", not to the fasta "Reference genome".
  const badge = page.getByTestId('prop-slot-reads-from-badge');
  await expect(badge).toContainText('from Trim reads');
  await expect(page.getByTestId('prop-slot-reads')).toHaveText('trimmed.fastq');
  await expect(page.getByTestId('prop-slot-ref')).toHaveValue('genome.fa');
  await expect(page.getByTestId('binding-prompt')).toHaveCount(0);

  await expect(page.getByTestId('command-preview')).toContainText(
    'bwa mem genome.fa trimmed.fastq > aligned.sam'
  );
  await expect(page.getByTestId('command-preview-missing')).toHaveCount(0);

  // The slot follows the earlier step when its output changes.
  await selectNode(page, 'Trim reads');
  await page.getByTestId('prop-output').fill('clean.fastq');
  await selectNode(page, 'Align');
  await expect(page.getByTestId('prop-slot-reads')).toHaveText('clean.fastq');
  await expect(page.getByTestId('command-preview')).toContainText('genome.fa clean.fastq');

  // Unlink keeps the file as typed text.
  await page.getByTestId('prop-slot-reads-unlink').click();
  await expect(badge).toHaveCount(0);
  await expect(page.getByTestId('prop-slot-reads')).toHaveValue('clean.fastq');
  await expect(page.getByTestId('command-preview')).toContainText('genome.fa clean.fastq');
});

test('a connection that fits two slots asks which one, and the answer binds it', async ({ page }) => {
  await addFilledNode(page, TRIM);
  await addFilledNode(page, { label: 'Pair', command: 'merge {reads1} {reads2} > {output}', output: 'pair.txt' });

  await connect(page, 'Trim reads', 'Pair');

  // The later step opens with a small question; nothing is bound until it is answered.
  const prompt = page.getByTestId('binding-prompt');
  await expect(prompt).toBeVisible();
  await expect(prompt).toContainText('Where should the file from Trim reads go?');
  await expect(page.getByTestId('prop-label')).toHaveValue('Pair');
  await expect(page.getByTestId('prop-slot-reads1-from-badge')).toHaveCount(0);

  await page.getByTestId('binding-option-reads2-main').click();
  await expect(prompt).toHaveCount(0);
  await expect(page.getByTestId('prop-slot-reads2-from-badge')).toContainText('from Trim reads');
  await expect(page.getByTestId('prop-slot-reads1')).toHaveValue('');
  await expect(page.getByTestId('command-preview')).toContainText('merge {reads1} no file trimmed.fastq > pair.txt');
  await expect(page.getByTestId('preview-missing-reads1')).toContainText('no file');
});

test('the same binding works from the keyboard: Runs after, the question, and the "use output of" list', async ({
  page,
}) => {
  await addFilledNode(page, TRIM);
  await addFilledNode(page, { label: 'Pair', command: 'merge {reads1} {reads2} > {output}', output: 'pair.txt' });

  // Tick "Trim reads" under "Runs after" (the keyboard way to connect).
  const runsAfter = page.getByTestId('prop-upstream').getByRole('checkbox', { name: 'Trim reads' });
  await runsAfter.focus();
  await page.keyboard.press('Space');
  await expect(page.locator('.react-flow__edge')).toHaveCount(1);

  // The question appears, and its buttons are reached and used with the keyboard.
  const skip = page.getByTestId('binding-skip');
  await expect(skip).toBeVisible();
  await page.getByTestId('binding-option-reads1-main').focus();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('prop-slot-reads1-from-badge')).toContainText('from Trim reads');

  // The other slot offers the connected step's output in a list.
  const list = page.getByTestId('prop-slot-reads2-from');
  await expect(list).toBeVisible();
  await list.selectOption({ label: 'Trim reads: Output file (trimmed.fastq)' });
  await expect(page.getByTestId('prop-slot-reads2-from-badge')).toContainText('from Trim reads');
  await expect(page.getByTestId('command-preview')).toContainText(
    'merge trimmed.fastq trimmed.fastq > pair.txt'
  );

  // Unlinking, with the keyboard too.
  await page.getByTestId('prop-slot-reads2-unlink').focus();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('prop-slot-reads2-from-badge')).toHaveCount(0);

  // "Leave empty" dismisses a question without binding. (Unlinking left the
  // file name as text, so clear both fields to make the slots free again.)
  await page.getByTestId('prop-slot-reads1-unlink').click();
  await page.getByTestId('prop-slot-reads1').fill('');
  await page.getByTestId('prop-slot-reads2').fill('');
  await page.getByTestId('prop-upstream').getByRole('checkbox', { name: 'Trim reads' }).uncheck();
  await page.getByTestId('prop-upstream').getByRole('checkbox', { name: 'Trim reads' }).check();
  await expect(page.getByTestId('binding-prompt')).toBeVisible();
  await page.getByTestId('binding-skip').click();
  await expect(page.getByTestId('binding-prompt')).toHaveCount(0);
  await expect(page.getByTestId('prop-slot-reads1-from-badge')).toHaveCount(0);
});

test('a slot with no file blocks Run and says which one; Undo brings a binding back', async ({ page }) => {
  await addFilledNode(page, TRIM);
  await addFilledNode(page, { label: 'Align', command: 'bwa mem {ref} {reads} > {output}', output: 'aligned.sam' });

  const run = page.getByTestId('run');
  await expect(run).toBeDisabled();
  await run.hover();
  await expect(page.getByRole('tooltip')).toContainText('Choose a file for "Reference genome"');
  await page.getByTestId('problems-toggle').click();
  await expect(page.getByTestId('problems-panel')).toContainText('Align');

  await page.getByTestId('prop-slot-ref').fill('genome.fa');
  await connect(page, 'Trim reads', 'Align');
  await selectNode(page, 'Align');
  await expect(page.getByTestId('prop-slot-reads-from-badge')).toBeVisible();
  await expect(run).toBeEnabled();

  // One Undo takes the connection and its binding away together.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press('ControlOrMeta+Z');
  await expect(page.locator('.react-flow__edge')).toHaveCount(0);
  await selectNode(page, 'Align');
  await expect(page.getByTestId('prop-slot-reads-from-badge')).toHaveCount(0);
  await expect(page.getByTestId('prop-slot-reads')).toHaveValue('');
  await expect(page.getByTestId('prop-slot-ref')).toHaveValue('genome.fa');
});

test('a workflow with slots runs, and file names with spaces and quotes reach the tool intact', async ({
  page,
  sandbox,
}) => {
  const reads = 'raw reads.fastq';
  const genome = "my genome's copy.fa";
  fs.writeFileSync(path.join(sandbox.workDir, reads), 'READS\n');
  fs.writeFileSync(path.join(sandbox.workDir, genome), 'GENOME\n');

  await addFilledNode(page, { label: 'Trim reads', command: 'cp {input} {output}', input: reads, output: 'trimmed reads.fastq' });
  await addFilledNode(page, { label: 'Align', command: 'cat {ref} {reads} > {output}', output: 'aligned.txt' });
  await page.getByTestId('prop-slot-ref').fill(genome);
  await connect(page, 'Trim reads', 'Align');
  await selectNode(page, 'Align');
  await expect(page.getByTestId('prop-slot-reads-from-badge')).toContainText('from Trim reads');

  await page.getByTestId('run-from-scratch').click();
  await expect(page.getByTestId('run-summary-title')).toContainText('succeeded', { timeout: 30_000 });

  expect(fs.readFileSync(path.join(sandbox.workDir, 'aligned.txt'), 'utf-8')).toBe('GENOME\nREADS\n');
  // The engine did not take the quote in the name for shell syntax.
  expect(fs.readdirSync(sandbox.workDir).filter((f) => f.startsWith('PWNED'))).toEqual([]);
});

test('braces written twice stay plain text and make no slot', async ({ page, sandbox }) => {
  await addFilledNode(page, { label: 'Say', command: 'echo {{not_a_file}} > {output}', output: 'say.txt' });
  await expect(page.getByTestId('prop-slots')).toHaveCount(0);
  await expect(page.getByTestId('command-preview')).toContainText('{{not_a_file}}');

  await page.getByTestId('run-from-scratch').click();
  await expect(page.getByTestId('run-summary-title')).toContainText('succeeded', { timeout: 30_000 });
  // With no slots the engine passes braces on as typed, so the editor wrote them once.
  expect(fs.readFileSync(path.join(sandbox.workDir, 'say.txt'), 'utf-8').trim()).toBe('{not_a_file}');
});

test('old-style steps are untouched: no slot section, no preview noise, braces in awk', async ({ page, sandbox }) => {
  fs.writeFileSync(path.join(sandbox.workDir, 'in.txt'), 'a b\nc d\n');
  await addFilledNode(page, {
    label: 'First column',
    command: "awk '{print $1}' {input} > {output}",
    input: 'in.txt',
    output: 'col.txt',
  });
  await expect(page.getByTestId('prop-slots')).toHaveCount(0);
  await expect(page.getByTestId('command-preview')).toContainText("awk '{print $1}' in.txt > col.txt");
  await page.getByTestId('run-from-scratch').click();
  await expect(page.getByTestId('run-summary-title')).toContainText('succeeded', { timeout: 30_000 });
  expect(fs.readFileSync(path.join(sandbox.workDir, 'col.txt'), 'utf-8')).toBe('a\nc\n');
});

test('a hand-written slot can be switched to a file the step writes, and later steps can use it', async ({
  page,
  sandbox,
}) => {
  await addFilledNode(page, { label: 'Make', command: 'echo hi > {report}', input: '', output: '' });
  await expect(page.getByTestId('prop-slot-report')).toBeVisible();
  await page.getByTestId('prop-slot-report-kind').selectOption('output');
  await page.getByTestId('prop-slot-report').fill('report.txt');
  await expect(page.getByTestId('command-preview')).toContainText('echo hi > report.txt');

  await addFilledNode(page, { label: 'Use', command: 'cp {source} {output}', output: 'copy.txt' });
  await connect(page, 'Make', 'Use');
  await selectNode(page, 'Use');
  await expect(page.getByTestId('prop-slot-source-from-badge')).toContainText('from Make');
  await expect(page.getByTestId('prop-slot-source')).toHaveText('report.txt');

  await page.getByTestId('run-from-scratch').click();
  await expect(page.getByTestId('run-summary-title')).toContainText('succeeded', { timeout: 30_000 });
  expect(fs.readFileSync(path.join(sandbox.workDir, 'copy.txt'), 'utf-8').trim()).toBe('hi');

  // Saved nodes keep the binding: select the other step and come back.
  await selectNode(page, 'Make');
  await openSection(page, 'io');
  await selectNode(page, 'Use');
  await expect(page.getByTestId('prop-slot-source-from-badge')).toContainText('from Make');
});
