import fs from 'fs';
import path from 'path';
import { test, expect, buildChain, nodes, openSection, openStepStatus, selectNode, stepRow } from './fixtures';

test('a mocked step creates placeholder outputs, shows MOCKED, and a real run then runs it for real', async ({
  page,
  sandbox,
}) => {
  await buildChain(page, [
    { label: 'Make', command: 'echo hello > {output}', output: 'a.txt' },
    { label: 'Copy', command: 'cp {input} {output}', input: 'a.txt', output: 'b.txt' },
  ]);
  await page.getByTestId('set-directory').click();
  await expect(page.locator('.working-directory')).toBeVisible();

  // No mocked step, no warning.
  await expect(page.getByTestId('mock-warning')).toHaveCount(0);

  await selectNode(page, 'Make');
  await page.getByTestId('prop-mock').check();
  await expect(page.getByTestId('mock-warning')).toHaveText(/1 mocked step/);
  await expect(nodes(page).filter({ hasText: 'Make' }).getByTestId('node-mock-badge')).toHaveText('MOCK');

  await page.getByTestId('run').click();
  await openStepStatus(page);
  await expect(stepRow(page, 'make')).toHaveAttribute('data-state', 'succeeded');
  await expect(stepRow(page, 'copy')).toHaveAttribute('data-state', 'succeeded');
  await expect(stepRow(page, 'make').getByTestId('step-mocked')).toHaveText('MOCKED');
  await expect(stepRow(page, 'copy').getByTestId('step-mocked')).toHaveCount(0);

  // The tool did not run: the output is an empty placeholder.
  expect(fs.statSync(path.join(sandbox.workDir, 'a.txt')).size).toBe(0);

  // Turn the mock off and press Run (not "from scratch"): a mocked step is
  // never remembered as done, so it runs for real now and so does what follows.
  await selectNode(page, 'Make');
  await page.getByTestId('prop-mock').uncheck();
  await expect(page.getByTestId('mock-warning')).toHaveCount(0);
  await expect(page.getByTestId('run')).toBeEnabled();
  await page.getByTestId('run').click();
  await expect(stepRow(page, 'make')).toHaveAttribute('data-state', 'succeeded');
  await expect(stepRow(page, 'make').getByTestId('step-mocked')).toHaveCount(0);
  await expect(stepRow(page, 'copy')).toHaveAttribute('data-state', 'succeeded');
  expect(fs.readFileSync(path.join(sandbox.workDir, 'a.txt'), 'utf-8').trim()).toBe('hello');
  expect(fs.readFileSync(path.join(sandbox.workDir, 'b.txt'), 'utf-8').trim()).toBe('hello');
});

test('an output check can apply to one declared output or to all of them', async ({ page, sandbox }) => {
  await buildChain(page, [
    // a.txt has content, b.txt is empty.
    { label: 'Two', command: 'echo data > a.txt; : > b.txt', output: 'a.txt, b.txt' },
  ]);
  await selectNode(page, 'Two');
  await openSection(page, 'checks');
  await page.getByTestId('prop-check-non-empty').check();

  const target = page.getByTestId('prop-check-non-empty-target');
  await expect(target).toHaveValue('');
  await expect(target.locator('option')).toHaveText(['All outputs', 'Only a.txt', 'Only b.txt']);

  // Only a.txt must be non-empty: the run passes although b.txt is empty.
  await target.selectOption('a.txt');
  await page.getByTestId('run-from-scratch').click();
  await openStepStatus(page);
  await expect(stepRow(page, 'two')).toHaveAttribute('data-state', 'succeeded');
  expect(fs.existsSync(path.join(sandbox.workDir, 'b.txt'))).toBe(true);

  // All outputs: the empty b.txt now fails the step.
  await target.selectOption('');
  await expect(page.getByTestId('run-from-scratch')).toBeEnabled();
  await page.getByTestId('run-from-scratch').click();
  await expect(stepRow(page, 'two')).toHaveAttribute('data-state', 'failed');
  await expect(stepRow(page, 'two').locator('.step-row-details')).toContainText('b.txt');

  // Aiming the check at b.txt fails it too.
  await target.selectOption('b.txt');
  await expect(page.getByTestId('run-from-scratch')).toBeEnabled();
  await page.getByTestId('run-from-scratch').click();
  await expect(stepRow(page, 'two')).toHaveAttribute('data-state', 'failed');
});

test('a check target that is no longer an output is flagged, not silently changed', async ({ page }) => {
  await buildChain(page, [{ label: 'One', command: 'echo x > {output}', output: 'x.txt, y.txt' }]);
  await selectNode(page, 'One');
  await openSection(page, 'checks');
  await page.getByTestId('prop-check-exists').check();
  await page.getByTestId('prop-check-exists-target').selectOption('y.txt');

  await page.getByTestId('prop-output').fill('x.txt');
  await expect(page.getByTestId('prop-check-exists-target-stale')).toContainText('y.txt');
  await expect(page.getByTestId('prop-check-exists-target')).toHaveValue('y.txt');

  await page.getByTestId('prop-check-exists-target').selectOption('');
  await expect(page.getByTestId('prop-check-exists-target-stale')).toHaveCount(0);
});
