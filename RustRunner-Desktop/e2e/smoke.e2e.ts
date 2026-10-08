import fs from 'fs';
import path from 'path';
import {
  test,
  expect,
  addNode,
  buildChain,
  connect,
  fillNode,
  nodes,
  openStepStatus,
  pidsMatching,
  selectNode,
  stepRow,
} from './fixtures';

const TWO_STEPS = [
  { label: 'Make', command: 'echo hello > {output}', output: 'a.txt' },
  { label: 'Copy', command: 'cp {input} {output}', input: 'a.txt', output: 'b.txt' },
];

test('app launches without console errors', async ({ page, consoleErrors }) => {
  await expect(page.getByTestId('add-node')).toBeVisible();
  await expect(page.getByTestId('run-from-scratch')).toHaveText('Run from scratch');
  // Nothing to run yet.
  await expect(page.getByTestId('run-from-scratch')).toBeDisabled();
  await expect(page.getByTestId('run')).toHaveText('Run');
  await expect(page.getByTestId('run')).toBeDisabled();
  await expect(page.getByTestId('stop')).toBeDisabled();
  // Give late errors (React warnings, CSP violations) a moment to surface.
  await page.waitForTimeout(500);
  expect(consoleErrors).toEqual([]);
});

test('two nodes can be added, connected and filled in', async ({ page, consoleErrors }) => {
  await buildChain(page, TWO_STEPS);
  await expect(nodes(page)).toHaveCount(2);
  await expect(page.locator('.react-flow__edge')).toHaveCount(1);

  await selectNode(page, 'Copy');
  await expect(page.getByTestId('prop-tool')).toHaveValue('bash');
  await expect(page.getByTestId('prop-command')).toHaveValue('cp {input} {output}');
  await expect(page.getByTestId('prop-input')).toHaveValue('a.txt');
  await expect(page.getByTestId('prop-output')).toHaveValue('b.txt');

  await selectNode(page, 'Make');
  await expect(page.getByTestId('prop-command')).toHaveValue('echo hello > {output}');
  await expect(page.getByTestId('prop-output')).toHaveValue('a.txt');

  // Edits mark the workflow dirty.
  await expect(page.locator('.dirty-marker')).toBeVisible();
  expect(consoleErrors).toEqual([]);
});

test('retries, timeout and output checks render and persist on reselect', async ({ page }) => {
  await buildChain(page, TWO_STEPS);
  await selectNode(page, 'Make');

  // Retry options are hidden until retries > 0.
  await expect(page.getByTestId('prop-retry-backoff')).toHaveCount(0);
  await page.getByTestId('prop-retries').fill('3');
  await expect(page.getByTestId('prop-retry-backoff')).toBeVisible();
  await page.getByTestId('prop-retry-backoff').selectOption('exponential');
  await page.getByTestId('prop-retry-delay').fill('2');
  await page.getByTestId('prop-timeout').fill('45');

  await page.getByTestId('prop-check-exists').check();
  await page.getByTestId('prop-check-non-empty').check();
  await page.getByTestId('prop-check-min-lines-enabled').check();
  await page.getByTestId('prop-check-min-lines').fill('4');
  await page.getByTestId('prop-check-blocking').uncheck();

  // Select the other node (fields reset to its defaults), then come back.
  await selectNode(page, 'Copy');
  await expect(page.getByTestId('prop-retries')).toHaveValue('0');
  await expect(page.getByTestId('prop-timeout')).toHaveValue('');
  await expect(page.getByTestId('prop-check-exists')).not.toBeChecked();
  await expect(page.getByTestId('prop-check-blocking')).toBeChecked();

  await selectNode(page, 'Make');
  await expect(page.getByTestId('prop-retries')).toHaveValue('3');
  await expect(page.getByTestId('prop-retry-backoff')).toHaveValue('exponential');
  await expect(page.getByTestId('prop-retry-delay')).toHaveValue('2');
  await expect(page.getByTestId('prop-timeout')).toHaveValue('45');
  await expect(page.getByTestId('prop-check-exists')).toBeChecked();
  await expect(page.getByTestId('prop-check-non-empty')).toBeChecked();
  await expect(page.getByTestId('prop-check-min-lines-enabled')).toBeChecked();
  await expect(page.getByTestId('prop-check-min-lines')).toHaveValue('4');
  await expect(page.getByTestId('prop-check-blocking')).not.toBeChecked();
});

test('output checks are disabled until the node has an output', async ({ page }) => {
  await addNode(page);
  await nodes(page).first().click();
  await expect(page.getByTestId('prop-check-exists')).toBeDisabled();
  await page.getByTestId('prop-output').fill('x.txt');
  await expect(page.getByTestId('prop-check-exists')).toBeEnabled();
});

test('a two-step workflow runs to success and both steps show as succeeded', async ({
  page,
  sandbox,
  consoleErrors,
}) => {
  await buildChain(page, TWO_STEPS);

  await page.getByTestId('run-from-scratch').click();
  await openStepStatus(page);

  await expect(stepRow(page, 'make')).toHaveAttribute('data-state', 'succeeded');
  await expect(stepRow(page, 'copy')).toHaveAttribute('data-state', 'succeeded');
  await expect(page.getByTestId('step-status')).toContainText('2 succeeded');
  await expect(page.getByTestId('progress')).toHaveText('2 / 2 steps');
  await expect(nodes(page).filter({ hasText: 'Make' })).toHaveAttribute('data-state', 'succeeded');

  // The run really happened, in the chosen working directory.
  expect(fs.readFileSync(path.join(sandbox.workDir, 'b.txt'), 'utf-8').trim()).toBe('hello');

  await page.getByTestId('tab-logs').click();
  await expect(
    page.getByTestId('log-entry').filter({ hasText: 'Workflow completed successfully' })
  ).not.toHaveCount(0);
  await expect(page.getByTestId('stop')).toBeDisabled();
  expect(consoleErrors).toEqual([]);
});

test('a failing step shows as retrying with its attempt, then succeeds', async ({ page, sandbox }) => {
  // Fails on the first attempt (creating the marker), succeeds on the second.
  await buildChain(page, [
    {
      label: 'Flaky',
      command: 'if [ -f flaky.ok ]; then echo ok > {output}; else touch flaky.ok; exit 1; fi',
      output: 'flaky.txt',
    },
  ]);
  await selectNode(page, 'Flaky');
  await page.getByTestId('prop-retries').fill('1');
  await page.getByTestId('prop-retry-delay').fill('4');

  await page.getByTestId('run-from-scratch').click();
  await openStepStatus(page);

  // The engine waits 4 s between the attempts; the typed event keeps the
  // state visible for that whole time.
  const row = stepRow(page, 'flaky');
  await expect(row).toHaveAttribute('data-state', 'retrying');
  await expect(row.locator('.step-row-details')).toContainText('attempt 1/2 failed, retrying in 4s');
  await expect(page.getByTestId('step-status')).toContainText('1 retrying');
  await expect(nodes(page).filter({ hasText: 'Flaky' })).toHaveAttribute('data-state', 'retrying');

  await expect(row).toHaveAttribute('data-state', 'succeeded');
  await expect(row.locator('.step-row-details')).toContainText('attempt 2/2');
  expect(fs.readFileSync(path.join(sandbox.workDir, 'flaky.txt'), 'utf-8').trim()).toBe('ok');

  // Raw logs keep streaming, without the event lines.
  await page.getByTestId('tab-logs').click();
  await expect(
    page.getByTestId('log-entry').filter({ hasText: 'Starting step: flaky' })
  ).not.toHaveCount(0);
  await expect(page.getByTestId('log-entry').filter({ hasText: 'RUSTRUNNER_EVENT' })).toHaveCount(0);
});

test('a failed blocking output check fails the step and skips the one after it', async ({ page }) => {
  await buildChain(page, [
    { label: 'Empty', command: 'touch {output}', output: 'empty.txt' },
    { label: 'Next', command: 'cp {input} {output}', input: 'empty.txt', output: 'next.txt' },
  ]);
  await selectNode(page, 'Empty');
  await page.getByTestId('prop-check-non-empty').check();

  await page.getByTestId('run-from-scratch').click();
  await openStepStatus(page);

  const failed = stepRow(page, 'empty');
  await expect(failed).toHaveAttribute('data-state', 'failed');
  await expect(failed.locator('.step-row-details')).toContainText('output check failed');
  await expect(stepRow(page, 'next')).toHaveAttribute('data-state', 'skipped');
  await expect(stepRow(page, 'next').locator('.step-row-details')).toContainText('not run');
  await expect(page.getByTestId('run-from-scratch')).toBeEnabled();
});

test('Stop during a long step ends the run and leaves no sleep process', async ({ page }) => {
  const marker = 'sleep 71.37';
  await buildChain(page, [
    { label: 'Slow', command: marker, output: 'slow.txt' },
    { label: 'After', command: 'cp {input} {output}', input: 'slow.txt', output: 'after.txt' },
  ]);

  await page.getByTestId('run-from-scratch').click();
  await expect.poll(() => pidsMatching(marker).length, { timeout: 20_000 }).toBeGreaterThan(0);
  await expect(page.getByTestId('stop')).toBeEnabled();

  await page.getByTestId('stop').click();

  await expect(page.getByTestId('stop')).toBeDisabled();
  await expect(page.getByTestId('run-from-scratch')).toBeEnabled();
  await expect(
    page.getByTestId('log-entry').filter({ hasText: 'Workflow stopped by user' })
  ).not.toHaveCount(0);
  await expect.poll(() => pidsMatching(marker), { timeout: 10_000 }).toEqual([]);

  // The step after the stopped one never ran.
  await openStepStatus(page);
  await expect(stepRow(page, 'after')).not.toHaveAttribute('data-state', 'succeeded');
});

test('a second Run skips every up-to-date step and Run from scratch runs them again', async ({
  page,
  sandbox,
}) => {
  await buildChain(page, TWO_STEPS);
  await page.getByTestId('set-directory').click();
  await expect(page.locator('.working-directory')).toBeVisible();
  // A directory with no saved state: Run is available and says nothing is saved.
  await expect(page.getByTestId('run')).toBeEnabled();
  await expect(page.getByTestId('run')).toHaveAttribute('title', /No saved run/);

  await page.getByTestId('run').click();
  await openStepStatus(page);
  await expect(stepRow(page, 'copy')).toHaveAttribute('data-state', 'succeeded');
  await expect(stepRow(page, 'make')).toHaveAttribute('data-state', 'succeeded');
  await expect(page.getByTestId('run')).toBeEnabled();

  // The engine's state file now exists and the tooltip counts its steps.
  await expect(page.getByTestId('run')).toHaveAttribute('title', /2 step/);

  // Both outputs are current, so the second Run skips both steps.
  await page.getByTestId('run').click();
  await expect(stepRow(page, 'make')).toHaveAttribute('data-state', 'skipped');
  await expect(stepRow(page, 'copy')).toHaveAttribute('data-state', 'skipped');
  await expect(stepRow(page, 'make').locator('.step-row-details')).toContainText('up to date');
  await expect(page.getByTestId('run')).toBeEnabled();
  await page.getByTestId('tab-logs').click();
  await expect(
    page.getByTestId('log-entry').filter({ hasText: 'steps whose outputs are up to date are skipped' })
  ).not.toHaveCount(0);

  // Run from scratch discards the saved progress and runs everything again.
  fs.rmSync(path.join(sandbox.workDir, 'b.txt'));
  await page.getByTestId('run-from-scratch').click();
  await openStepStatus(page);
  await expect(stepRow(page, 'make')).toHaveAttribute('data-state', 'succeeded');
  await expect(stepRow(page, 'copy')).toHaveAttribute('data-state', 'succeeded');
  await expect(page.getByTestId('run-from-scratch')).toBeEnabled();
  expect(fs.existsSync(path.join(sandbox.workDir, 'b.txt'))).toBe(true);
});

/** Number of lines in a file of the sandbox (0 while it does not exist). */
const lineCount = (dir: string, name: string): number => {
  try {
    return fs.readFileSync(path.join(dir, name), 'utf-8').split('\n').filter(Boolean).length;
  } catch {
    return 0;
  }
};

test('editing a command re-runs that step and its children, not its parents', async ({
  page,
  sandbox,
}) => {
  // Every step appends to its own log, so runs can be counted exactly.
  await buildChain(page, [
    { label: 'Make', command: 'echo run >> make.log; echo hello > {output}', output: 'a.txt' },
    { label: 'Copy', command: 'echo run >> copy.log; cp {input} {output}', input: 'a.txt', output: 'b.txt' },
    { label: 'Count', command: 'echo run >> count.log; wc -c < {input} > {output}', input: 'b.txt', output: 'c.txt' },
  ]);
  await page.getByTestId('set-directory').click();
  await expect(page.locator('.working-directory')).toBeVisible();

  const runsOf = () => ['make', 'copy', 'count'].map((n) => lineCount(sandbox.workDir, `${n}.log`));

  await page.getByTestId('run').click();
  await expect.poll(runsOf, { timeout: 30_000 }).toEqual([1, 1, 1]);
  await expect(page.getByTestId('stop')).toBeDisabled();

  // Nothing changed: the second Run skips all three and runs nothing.
  await page.getByTestId('run').click();
  await openStepStatus(page);
  for (const id of ['make', 'copy', 'count']) {
    await expect(stepRow(page, id)).toHaveAttribute('data-state', 'skipped');
  }
  await expect(page.getByTestId('stop')).toBeDisabled();
  expect(runsOf()).toEqual([1, 1, 1]);

  // Edit the middle step: it and its child run, the parent is skipped.
  await selectNode(page, 'Copy');
  await page
    .getByTestId('prop-command')
    .fill('echo run >> copy.log; cp -f {input} {output}');
  await page.getByTestId('run').click();
  await expect.poll(runsOf, { timeout: 30_000 }).toEqual([1, 2, 2]);
  await expect(page.getByTestId('stop')).toBeDisabled();
  await expect(stepRow(page, 'make')).toHaveAttribute('data-state', 'skipped');
  await expect(stepRow(page, 'copy')).toHaveAttribute('data-state', 'succeeded');
  await expect(stepRow(page, 'count')).toHaveAttribute('data-state', 'succeeded');

  // The edited definition is recorded: the next Run skips everything again.
  await page.getByTestId('run').click();
  await expect(stepRow(page, 'copy')).toHaveAttribute('data-state', 'skipped');
  await expect(stepRow(page, 'count')).toHaveAttribute('data-state', 'skipped');
  await expect(page.getByTestId('stop')).toBeDisabled();
  expect(runsOf()).toEqual([1, 2, 2]);
});

test('Run after a failure re-runs only the failed step', async ({ page, sandbox }) => {
  // The second step fails until a marker file exists.
  await buildChain(page, [
    { label: 'First', command: 'echo one > {output}', output: 'one.txt' },
    {
      label: 'Gate',
      command: 'test -f gate.ok && cp {input} {output}',
      input: 'one.txt',
      output: 'two.txt',
    },
  ]);

  await page.getByTestId('run-from-scratch').click();
  await openStepStatus(page);
  await expect(stepRow(page, 'gate')).toHaveAttribute('data-state', 'failed');
  await expect(stepRow(page, 'first')).toHaveAttribute('data-state', 'succeeded');
  await expect(page.getByTestId('run-from-scratch')).toBeEnabled();
  await expect(page.getByTestId('run')).toBeEnabled();

  fs.writeFileSync(path.join(sandbox.workDir, 'gate.ok'), '');
  await page.getByTestId('run').click();
  await expect(stepRow(page, 'gate')).toHaveAttribute('data-state', 'succeeded');
  await expect(stepRow(page, 'first')).toHaveAttribute('data-state', 'skipped');
});

test('newly added nodes never cover each other', async ({ page }) => {
  // Regression: the first node triggers fit-to-view and opening the
  // properties panel resizes the canvas, so later nodes used to land on top
  // of earlier ones and became unclickable.
  await addNode(page);
  await nodes(page).first().click();
  for (let i = 0; i < 3; i++) await addNode(page);

  const boxes = [];
  for (const n of await nodes(page).all()) boxes.push((await n.boundingBox())!);
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i];
      const b = boxes[j];
      const overlap = a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
      expect(overlap, `nodes ${i} and ${j} overlap`).toBe(false);
    }
  }
});

/** Opens Workflow Details and applies `change` before confirming. */
async function editDetails(
  page: import('@playwright/test').Page,
  change: { name?: string; keepGoing?: boolean }
): Promise<void> {
  await page.getByTestId('details').click();
  if (change.name !== undefined) await page.getByTestId('dialog-name').fill(change.name);
  if (change.keepGoing !== undefined) {
    await page.getByTestId('keep-going').setChecked(change.keepGoing);
  }
  await page.getByTestId('dialog-confirm').click();
  await expect(page.getByTestId('dialog-confirm')).toHaveCount(0);
}

test('keep going runs the independent branch after a failure', async ({ page, sandbox }) => {
  // Bad -> After, and an unrelated Free -> Free2 that is still running when Bad fails.
  await buildChain(page, [
    { label: 'Bad', command: 'exit 1', output: 'bad.txt' },
    { label: 'After', command: 'cp {input} {output}', input: 'bad.txt', output: 'after.txt' },
  ]);
  await addNode(page);
  await selectNode(page, 'Node 3');
  await fillNode(page, { label: 'Free', command: 'sleep 1; echo ok > {output}', output: 'free.txt' });
  await addNode(page);
  await selectNode(page, 'Node 4');
  await fillNode(page, { label: 'Free2', command: 'cp {input} {output}', input: 'free.txt', output: 'free2.txt' });
  await connect(page, 'Free', 'Free2');

  await editDetails(page, { keepGoing: true });
  await page.getByTestId('run-from-scratch').click();
  await openStepStatus(page);

  await expect(stepRow(page, 'bad')).toHaveAttribute('data-state', 'failed');
  await expect(stepRow(page, 'after')).toHaveAttribute('data-state', 'skipped');
  await expect(stepRow(page, 'after').locator('.step-row-details')).toContainText("step 'bad' failed");
  await expect(stepRow(page, 'free')).toHaveAttribute('data-state', 'succeeded');
  await expect(stepRow(page, 'free2')).toHaveAttribute('data-state', 'succeeded');
  await expect(page.getByTestId('run-from-scratch')).toBeEnabled();
  expect(fs.existsSync(path.join(sandbox.workDir, 'free2.txt'))).toBe(true);
  expect(fs.existsSync(path.join(sandbox.workDir, 'after.txt'))).toBe(false);
});

test('renaming the workflow keeps its saved run for Run', async ({ page }) => {
  await buildChain(page, TWO_STEPS);
  await page.getByTestId('set-directory').click();
  await expect(page.locator('.working-directory')).toBeVisible();

  await page.getByTestId('run-from-scratch').click();
  await openStepStatus(page);
  await expect(stepRow(page, 'copy')).toHaveAttribute('data-state', 'succeeded');
  await expect(page.getByTestId('run')).toBeEnabled();

  await editDetails(page, { name: 'A completely different name' });
  await expect(page.getByTestId('workflow-title')).toContainText('A completely different name');
  await expect(page.getByTestId('run')).toBeEnabled();
  await expect(page.getByTestId('run')).toHaveAttribute('title', /2 step/);

  await page.getByTestId('run').click();
  await expect(page.getByTestId('run-from-scratch')).toBeEnabled();
  await expect(stepRow(page, 'make')).toHaveAttribute('data-state', 'skipped');
  await expect(stepRow(page, 'copy')).toHaveAttribute('data-state', 'skipped');
});
