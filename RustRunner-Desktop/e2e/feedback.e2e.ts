/**
 * Runtime feedback: status on the canvas, the end-of-run summary, the failure
 * card and its actions, the log tools, and the empty states.
 */

import type { ElectronApplication } from '@playwright/test';
import { test, expect, buildChain, nodes, openSection, selectNode } from './fixtures';

const TWO_STEPS = [
  { label: 'Make', command: 'echo hello > {output}', output: 'a.txt' },
  { label: 'Copy', command: 'cp {input} {output}', input: 'a.txt', output: 'b.txt' },
];

const FAILING_CHAIN = [
  { label: 'Empty', command: 'touch {output}', output: 'empty.txt' },
  { label: 'Next', command: 'cp {input} {output}', input: 'empty.txt', output: 'next.txt' },
];

async function stubOpenPath(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ shell }) => {
    (globalThis as any).__openedPaths = [];
    shell.openPath = (async (target: string) => {
      (globalThis as any).__openedPaths.push(target);
      return '';
    }) as any;
  });
}

const openedPaths = (app: ElectronApplication): Promise<string[]> =>
  app.evaluate(() => (globalThis as any).__openedPaths as string[]);

const nodeStatus = (page: any, label: string) =>
  nodes(page).filter({ hasText: label }).first().getByTestId('node-status-line');

async function buildFailingRun(page: any) {
  await buildChain(page, FAILING_CHAIN);
  await selectNode(page, 'Empty');
  await openSection(page, 'checks');
  await page.getByTestId('prop-check-non-empty').check();
  await page.mouse.click(700, 800);
  await page.getByTestId('run-from-scratch').click();
  await expect(page.getByTestId('failure-card')).toBeVisible();
}

test('a node shows its state with an icon and words, and a finished run shows a summary', async ({
  page,
  app,
}) => {
  await stubOpenPath(app);
  await buildChain(page, TWO_STEPS);
  await expect(page.getByTestId('run-summary')).toHaveCount(0);

  await page.getByTestId('run-from-scratch').click();
  await expect(page.getByTestId('run-summary')).toBeVisible();

  await expect(nodeStatus(page, 'Make')).toHaveAttribute('data-status', 'succeeded');
  await expect(nodeStatus(page, 'Make')).toContainText('Done');
  await expect(nodeStatus(page, 'Make').locator('svg')).toHaveCount(1);

  await expect(page.getByTestId('run-summary')).toHaveAttribute('data-outcome', 'success');
  await expect(page.getByTestId('run-summary-title')).toHaveText('Run succeeded');
  await expect(page.getByTestId('run-summary-detail')).toContainText('2 succeeded');
  await expect(page.getByTestId('failure-card')).toHaveCount(0);

  await page.getByTestId('summary-open-report').click();
  await expect.poll(async () => (await openedPaths(app)).length).toBe(1);
  expect((await openedPaths(app))[0]).toMatch(/report\.html$/);

  await page.getByTestId('summary-dismiss').click();
  await expect(page.getByTestId('run-summary')).toHaveCount(0);
});

test('a step that is running shows it, and the connection into it is highlighted', async ({
  page,
}) => {
  await buildChain(page, [
    { label: 'Make', command: 'echo hello > {output}', output: 'a.txt' },
    { label: 'Slow', command: 'sleep 4; cp {input} {output}', input: 'a.txt', output: 'b.txt' },
  ]);
  await page.getByTestId('run-from-scratch').click();

  await expect(nodeStatus(page, 'Slow')).toHaveAttribute('data-status', 'running');
  await expect(nodeStatus(page, 'Slow')).toContainText('Running');
  await expect(page.locator('[data-testid="typed-edge"][data-active="true"]')).toHaveCount(1);

  await expect(nodeStatus(page, 'Slow')).toHaveAttribute('data-status', 'succeeded');
  await expect(page.locator('[data-testid="typed-edge"][data-active="true"]')).toHaveCount(0);
});

test('the failure card names the step and the check, and its actions work', async ({
  page,
  app,
}) => {
  await stubOpenPath(app);
  await buildFailingRun(page);

  await expect(page.getByTestId('run-summary')).toHaveAttribute('data-outcome', 'danger');
  await expect(page.getByTestId('run-summary-title')).toHaveText('Run failed');
  await expect(page.getByTestId('failure-title')).toContainText('"Empty" failed');
  await expect(page.getByTestId('failure-what')).toContainText('did not pass a check');
  await expect(page.getByTestId('failure-check')).toContainText('empty');
  await expect(nodeStatus(page, 'Empty')).toHaveAttribute('data-status', 'failed');
  await expect(nodeStatus(page, 'Next')).toHaveAttribute('data-status', 'skipped');
  await expect(page.getByTestId('failure-card')).toContainText('did not run');

  // Show in report
  await page.getByTestId('failure-show-report').click();
  await expect.poll(async () => (await openedPaths(app)).length).toBe(1);

  // Show logs: the log tab, narrowed to the errors
  await page.getByTestId('tab-steps').click();
  await page.getByTestId('failure-show-logs').click();
  await expect(page.getByTestId('tab-logs')).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('log-filter-errors')).toHaveAttribute('aria-pressed', 'true');
  const shown = await page.getByTestId('log-entry').allTextContents();
  expect(shown.length).toBeGreaterThan(0);
  expect(shown.join('\n')).toContain('Empty'.toLowerCase());

  // Edit step: selects the node and opens the section that holds the check
  await page.getByTestId('section-checks-toggle').click(); // collapse, so opening is observable
  await page.mouse.click(700, 800);
  await page.getByTestId('failure-edit-step').click();
  await expect(page.getByTestId('prop-label')).toHaveValue('Empty');
  await expect(page.getByTestId('section-checks-toggle')).toHaveAttribute('aria-expanded', 'true');
});

test('the log can be filtered, searched and copied', async ({ page }) => {
  await buildFailingRun(page);
  await page.getByTestId('tab-logs').click();

  const count = () => page.getByTestId('log-entry').count();
  const all = await count();
  await page.getByTestId('log-filter-errors').click();
  const errors = await count();
  expect(errors).toBeGreaterThan(0);
  expect(errors).toBeLessThan(all);
  await page.getByTestId('log-filter-warnings').click();
  await expect(page.getByTestId('log-empty')).toBeVisible();
  await page.getByTestId('log-reset-filter').click();
  await expect(page.getByTestId('log-entry')).toHaveCount(all);

  await page.getByTestId('log-search').fill('zzz-no-such-text');
  await expect(page.getByTestId('log-empty')).toContainText('No lines match');
  await page.getByTestId('log-search').fill('empty');
  expect(await count()).toBeGreaterThan(0);
  await expect(page.getByTestId('log-count')).toContainText(`of ${all} lines`);

  await page.getByTestId('log-copy').click();
  await expect(page.getByTestId('toast').first()).toBeVisible();

  const follow = page.getByTestId('log-follow');
  await expect(follow).toHaveAttribute('aria-pressed', 'true');
  await follow.click();
  await expect(follow).toHaveAttribute('aria-pressed', 'false');
});

test('an empty log, a search without results and an empty history say what to do', async ({
  page,
}) => {
  await page.getByTestId('tab-logs').click();
  await page.getByRole('button', { name: 'Clear log' }).click();
  await expect(page.getByTestId('log-empty')).toContainText('No output yet');
  await expect(page.getByTestId('log-copy')).toHaveAttribute('aria-disabled', 'true');

  await page.getByTestId('open-palette').click();
  await page.getByTestId('palette-search').fill('qqqzzz');
  await expect(page.getByTestId('palette-empty')).toContainText('qqqzzz');
  await page.getByTestId('palette-clear-search').click();
  await expect(page.getByTestId('palette-empty')).toHaveCount(0);
  await expect(page.getByTestId('palette-search')).toHaveValue('');
  await page.getByTestId('palette-search').fill('qqqzzz');
  await page.getByTestId('palette-add-custom').click();
  await expect(nodes(page)).toHaveCount(1);

  await page.getByTestId('tab-history').click();
  await expect(page.getByTestId('history-empty')).toBeVisible();
  await page.getByTestId('tab-steps').click();
  await expect(page.getByTestId('steps-empty')).toBeVisible();
});

test('a refused run never opens a native dialog', async ({ page }) => {
  const dialogs: string[] = [];
  page.on('dialog', (d) => {
    dialogs.push(d.message());
    void d.dismiss();
  });
  await buildChain(page, TWO_STEPS);
  // An unfinished step makes the run refuse; the reason is shown in the app.
  await page.getByTestId('add-node').click();
  await page.getByTestId('run').click({ force: true });
  await expect(page.getByTestId('problems-panel')).toBeVisible();
  expect(dialogs).toEqual([]);
});
