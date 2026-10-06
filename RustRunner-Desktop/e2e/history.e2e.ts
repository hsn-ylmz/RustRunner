import fs from 'fs';
import path from 'path';
import { test, expect, buildChain, type Sandbox } from './fixtures';
import type { ElectronApplication, Page } from '@playwright/test';

const TWO_STEPS = [
  { label: 'Make', command: 'echo hello > {output}', output: 'a.txt' },
  { label: 'Copy', command: 'cp {input} {output}', input: 'a.txt', output: 'b.txt' },
];

/** Replaces shell.openPath so no external application is ever started. */
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

/** Runs the chain and waits until the engine has finished. */
async function runToEnd(page: Page): Promise<void> {
  await page.getByTestId('run').click();
  await expect(page.getByTestId('open-latest-report')).toBeVisible();
  await expect(page.getByTestId('stop')).toBeDisabled();
}

const runsDirOf = (sandbox: Sandbox) =>
  fs.realpathSync(path.join(sandbox.workDir, '.rustrunner', 'runs'));

test('after a run the history lists it and Open report opens a file inside the run folder', async ({
  page,
  app,
  sandbox,
  consoleErrors,
}) => {
  await stubOpenPath(app);
  await buildChain(page, TWO_STEPS);
  await runToEnd(page);

  await page.getByTestId('tab-history').click();
  const rows = page.getByTestId('history-row');
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toHaveAttribute('data-status', 'succeeded');
  await expect(rows.first()).toContainText('2 succeeded of 2');

  await rows.first().getByTestId('open-report').click();
  await expect.poll(async () => (await openedPaths(app)).length).toBe(1);
  const [opened] = await openedPaths(app);
  const runsDir = runsDirOf(sandbox);
  expect(path.dirname(path.dirname(opened))).toBe(runsDir);
  expect(path.basename(opened)).toBe('report.html');

  // The report is a real, self-contained page about this run.
  const html = fs.readFileSync(opened, 'utf-8');
  expect(html).toContain('make');
  expect(html).toContain('copy');
  expect(html).not.toContain('<script');

  // The latest-report button opens the same file.
  await page.getByTestId('open-latest-report').click();
  await expect.poll(async () => (await openedPaths(app)).length).toBe(2);
  expect(fs.realpathSync((await openedPaths(app))[1])).toBe(opened);

  expect(consoleErrors).toEqual([]);
});

test('a second run is listed above the first', async ({ page, sandbox }) => {
  await buildChain(page, TWO_STEPS);
  await runToEnd(page);
  // The run id has one-second resolution; make sure the next one differs.
  await page.waitForTimeout(1100);
  await page.getByTestId('run-from-scratch').click();
  await page.getByTestId('tab-history').click();
  await expect(page.getByTestId('history-row')).toHaveCount(2);
  const index = JSON.parse(
    fs.readFileSync(path.join(runsDirOf(sandbox), 'index.json'), 'utf-8')
  );
  const ids = await page.getByTestId('history-row').evaluateAll((els) =>
    els.map((el) => el.getAttribute('data-run-id'))
  );
  expect(ids).toEqual(index.runs.map((r: { run_id: string }) => r.run_id));
});

test('the main process refuses to open anything outside the run folder', async ({
  page,
  app,
  sandbox,
}) => {
  await stubOpenPath(app);
  await buildChain(page, TWO_STEPS);
  await runToEnd(page);
  fs.writeFileSync(path.join(sandbox.workDir, 'secret.html'), 'x');

  const attempts = [
    '../../secret.html',
    path.join(sandbox.workDir, 'secret.html'),
    '/etc/hosts',
    '',
  ];
  for (const attempt of attempts) {
    const result: { ok: boolean } = await page.evaluate(
      ([dir, ref]) => (window as any).electron.ipcRenderer.openRunReport(dir, ref),
      [sandbox.workDir, attempt]
    );
    expect(result.ok, attempt).toBe(false);
  }
  expect(await openedPaths(app)).toEqual([]);
});

test('a dry run is not recorded in the history', async ({ page, sandbox }) => {
  await buildChain(page, TWO_STEPS);
  await page.getByTestId('dry-run').click();
  await expect(page.getByTestId('progress')).toHaveText('2 / 2 steps');
  await expect(page.getByTestId('stop')).toBeDisabled();
  await page.getByTestId('tab-history').click();
  await expect(page.getByTestId('history-empty')).toBeVisible();
  expect(fs.existsSync(path.join(sandbox.workDir, '.rustrunner', 'runs'))).toBe(false);
});
