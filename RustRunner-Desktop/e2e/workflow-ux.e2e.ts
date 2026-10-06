/**
 * Workflow-building UX: the empty canvas, collapsible properties, inline
 * validation, keyboard shortcuts and undo. These drive the real app; the pure
 * rules behind them are unit-tested in src/renderer/__tests__.
 */

import { test, expect, addNode, buildChain, nodes, openSection, openStepStatus, selectNode, stepRow } from './fixtures';

const MOD = 'ControlOrMeta';

/** Moves focus out of any field, onto the page, the way a click on the canvas does. */
async function focusCanvas(page: import('@playwright/test').Page): Promise<void> {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
}

const TWO_STEPS = [
  { label: 'Make', command: 'echo hello > {output}', output: 'a.txt' },
  { label: 'Copy', command: 'cp {input} {output}', input: 'a.txt', output: 'b.txt' },
];

test('an empty canvas explains how to start, and goes away with the first step', async ({ page }) => {
  const empty = page.getByTestId('empty-state');
  await expect(empty).toBeVisible();
  await expect(empty.getByRole('button', { name: 'Add a tool from the catalog' })).toBeVisible();
  await expect(empty.getByRole('button', { name: 'Add a custom step' })).toBeVisible();
  await expect(empty.getByRole('button', { name: 'Open a workflow' })).toBeVisible();
  await expect(empty.getByRole('list', { name: 'How it works' }).getByRole('listitem')).toHaveCount(3);

  // The first action opens the catalog (and the card steps aside for it).
  await page.getByTestId('empty-add-catalog').click();
  await expect(page.getByTestId('tool-palette')).toBeVisible();
  await expect(empty).toHaveCount(0);
  await page.getByTestId('palette-search').press('Escape');
  await expect(page.getByTestId('tool-palette')).toHaveCount(0);
  await expect(empty).toBeVisible();

  await page.getByTestId('empty-add-custom').click();
  await expect(nodes(page)).toHaveCount(1);
  await expect(empty).toHaveCount(0);
});

test('properties are folded into sections that summarise themselves and remember being opened', async ({
  page,
}) => {
  await addNode(page);
  await nodes(page).first().click();

  // Folded by default, with what is inside written on the header.
  const reliability = page.getByTestId('section-reliability-toggle');
  await expect(reliability).toHaveAttribute('aria-expanded', 'false');
  await expect(reliability).toContainText('No retries, no time limit');
  await expect(page.getByTestId('prop-retries')).toHaveCount(0);

  await openSection(page, 'reliability');
  await page.getByTestId('prop-retries').fill('2');
  await page.getByTestId('prop-timeout').fill('600');
  await expect(page.getByTestId('keep-going-hint')).toContainText('off');

  await reliability.click();
  await expect(reliability).toHaveAttribute('aria-expanded', 'false');
  await expect(reliability).toContainText('2 retries, 10 min timeout');

  // The choice survives selecting another node.
  await addNode(page);
  await selectNode(page, 'Node 2');
  await expect(page.getByTestId('section-reliability-toggle')).toHaveAttribute('aria-expanded', 'false');
  await openSection(page, 'reliability');
  await selectNode(page, 'Node 1');
  await expect(page.getByTestId('section-reliability-toggle')).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByTestId('prop-retries')).toHaveValue('2');

  // The keep-going hint leads to the workflow-wide setting.
  await page.getByTestId('open-keep-going').click();
  await expect(page.getByTestId('workflow-dialog')).toBeVisible();
  await page.keyboard.press('Escape');
});

test('problems show inline, block Run with a reason, and a click jumps to the field', async ({ page }) => {
  const dialogs: string[] = [];
  page.on('dialog', (d) => {
    dialogs.push(d.message());
    void d.dismiss();
  });

  await addNode(page);
  await nodes(page).first().click();

  // Nothing is shouted at a field nobody has visited yet, but Run says no.
  await expect(page.getByTestId('prop-tool')).toBeVisible();
  await expect(page.locator('#' + (await page.getByTestId('prop-tool').getAttribute('id')) + '-error')).toHaveCount(0);
  const run = page.getByTestId('run');
  await expect(run).toBeDisabled();
  await run.hover();
  await expect(page.getByRole('tooltip')).toContainText('Fix 2 problems before running');
  await expect(page.getByTestId('problems-toggle')).toHaveText('2 problems');

  // Trying to run lists the problems and shows each on its field.
  // The button is aria-disabled, so a click has to be forced past Playwright's actionability check.
  await run.click({ force: true });
  const panel = page.getByTestId('problems-panel');
  await expect(panel).toBeVisible();
  await expect(panel.getByTestId('problem-item')).toHaveCount(2);
  await expect(panel).toContainText('Node 1');
  await expect(page.getByTestId('prop-tool')).toHaveAttribute('aria-invalid', 'true');
  await expect(page.getByTestId('section-basics').getByText('Enter the tool this step uses')).toBeVisible();

  // Clicking a problem selects that step and puts the cursor in the field,
  // even when the field's section is folded.
  await page.getByTestId('section-advanced-toggle').click();
  await expect(page.getByTestId('prop-command')).toHaveCount(0);
  await panel.getByTestId('problem-item').filter({ hasText: 'Enter the command' }).click();
  await expect(page.getByTestId('prop-command')).toBeFocused();

  await page.getByTestId('prop-command').fill('echo hi > {output}');
  await page.getByTestId('prop-tool').fill('bash');
  await expect(panel).toHaveCount(0);
  await expect(page.getByTestId('problems-toggle')).toHaveCount(0);
  await expect(run).toBeEnabled();

  // Validation never used a native dialog.
  expect(dialogs).toEqual([]);
});

test('a duplicate name is flagged on the name field right away', async ({ page }) => {
  await buildChain(page, [{ label: 'Same', command: 'echo a > {output}', output: 'a.txt' }]);
  await addNode(page);
  await selectNode(page, 'Node 2');
  await page.getByTestId('prop-label').fill('same');
  await expect(page.getByTestId('prop-label')).toHaveAttribute('aria-invalid', 'true');
  await expect(page.getByText('Another step has the same name')).toBeVisible();
  await expect(page.getByTestId('run')).toBeDisabled();
});

test('Ctrl/Cmd+K opens the catalog, Escape closes it, and ? lists the shortcuts', async ({ page }) => {
  await focusCanvas(page);
  await page.keyboard.press(`${MOD}+k`);
  await expect(page.getByTestId('tool-palette')).toBeVisible();
  await expect(page.getByTestId('palette-search')).toBeFocused();

  await page.keyboard.press('Escape');
  await expect(page.getByTestId('tool-palette')).toHaveCount(0);

  await focusCanvas(page);
  await page.keyboard.press('?');
  const dialog = page.getByRole('dialog', { name: 'Keyboard shortcuts' });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('Undo');
  await expect(dialog).toContainText(/(Cmd|Ctrl)Enter/);
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);

  // The toolbar button opens the same list.
  await page.getByTestId('open-shortcuts').click();
  await expect(dialog).toBeVisible();
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(dialog).toHaveCount(0);
});

test('Escape deselects the selected step', async ({ page }) => {
  await addNode(page);
  await nodes(page).first().click();
  await expect(page.getByTestId('properties-panel')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('properties-panel')).toHaveCount(0);
});

test('Delete removes the selected step, undo brings it and its connection back, redo removes it again', async ({
  page,
}) => {
  await buildChain(page, TWO_STEPS);
  await expect(page.locator('.react-flow__edge')).toHaveCount(1);

  await selectNode(page, 'Copy');
  await page.keyboard.press('Delete');
  await expect(nodes(page)).toHaveCount(1);
  await expect(page.locator('.react-flow__edge')).toHaveCount(0);

  await page.keyboard.press(`${MOD}+z`);
  await expect(nodes(page)).toHaveCount(2);
  await expect(page.locator('.react-flow__edge')).toHaveCount(1);
  await expect(nodes(page).filter({ hasText: 'Copy' })).toHaveCount(1);

  await page.keyboard.press(`${MOD}+Shift+z`);
  await expect(nodes(page)).toHaveCount(1);
  await expect(page.locator('.react-flow__edge')).toHaveCount(0);

  // Undo again, then the step's own settings are intact.
  await page.keyboard.press(`${MOD}+z`);
  await selectNode(page, 'Copy');
  await expect(page.getByTestId('prop-command')).toHaveValue('cp {input} {output}');
});

test('Delete removes a selected connection, and Backspace in a field only edits text', async ({ page }) => {
  await buildChain(page, TWO_STEPS);
  await page.locator('.react-flow__edge-interaction').first().dispatchEvent('click');
  await page.keyboard.press('Delete');
  await expect(page.locator('.react-flow__edge')).toHaveCount(0);
  await expect(nodes(page)).toHaveCount(2);
  await page.keyboard.press(`${MOD}+z`);
  await expect(page.locator('.react-flow__edge')).toHaveCount(1);

  await selectNode(page, 'Make');
  await page.getByTestId('prop-label').click();
  await page.keyboard.press('Backspace');
  await page.keyboard.press('Delete');
  await expect(nodes(page)).toHaveCount(2);
  await expect(page.getByTestId('prop-label')).toHaveValue('Mak');
});

test('typing a name is one undo step, and undo restores the earlier name', async ({ page }) => {
  await addNode(page);
  await nodes(page).first().click();
  await page.getByTestId('prop-label').fill('Aligner');
  await expect(nodes(page).filter({ hasText: 'Aligner' })).toHaveCount(1);

  await focusCanvas(page);
  await page.keyboard.press(`${MOD}+z`);
  await expect(nodes(page).filter({ hasText: 'Node 1' })).toHaveCount(1);
  await page.keyboard.press(`${MOD}+Shift+z`);
  await expect(nodes(page).filter({ hasText: 'Aligner' })).toHaveCount(1);
});

test('undoing a drag puts the step back where it was', async ({ page }) => {
  await addNode(page);
  const node = nodes(page).first();
  const before = (await node.boundingBox())!;
  await page.mouse.move(before.x + before.width / 2, before.y + before.height / 2);
  await page.mouse.down();
  await page.mouse.move(before.x + 40, before.y + 160, { steps: 8 });
  await page.mouse.up();
  const moved = (await node.boundingBox())!;
  expect(Math.abs(moved.y - before.y)).toBeGreaterThan(50);

  await focusCanvas(page);
  await page.keyboard.press(`${MOD}+z`);
  await expect.poll(async () => Math.round((await node.boundingBox())!.y)).toBe(Math.round(before.y));
});

test('Ctrl/Cmd+Enter runs the workflow', async ({ page }) => {
  await buildChain(page, TWO_STEPS);
  await focusCanvas(page);
  await page.keyboard.press(`${MOD}+Enter`);
  await openStepStatus(page);
  await expect(stepRow(page, 'make')).toHaveAttribute('data-state', 'succeeded');
  await expect(stepRow(page, 'copy')).toHaveAttribute('data-state', 'succeeded');
  await expect(page.getByTestId('run-state')).toContainText('Last run succeeded');
});

test('the run column groups the controls and explains each one', async ({ page }) => {
  await buildChain(page, TWO_STEPS);
  await expect(page.getByTestId('run-state')).toContainText('Ready');

  const tips: Record<string, RegExp> = {
    'run-from-scratch': /every step again/,
    'dry-run': /without running anything/,
  };
  for (const [id, pattern] of Object.entries(tips)) {
    await page.getByTestId(id).hover();
    await expect(page.getByRole('tooltip')).toContainText(pattern);
  }
  await page.getByTestId('stop').hover();
  await expect(page.getByRole('tooltip')).toContainText('Nothing is running');

  await page.getByTestId('run-from-scratch').click();
  await openStepStatus(page);
  await expect(stepRow(page, 'copy')).toHaveAttribute('data-state', 'succeeded');
  await expect(page.getByTestId('run-state')).toContainText('Last run succeeded');
});

test('discarding unsaved work is confirmed in the app, not by the system', async ({ page }) => {
  await addNode(page);
  await expect(page.locator('.dirty-marker')).toBeVisible();

  await page.getByRole('button', { name: 'New', exact: true }).click();
  const confirm = page.getByTestId('confirm-dialog');
  await expect(confirm).toBeVisible();
  // The safe answer has focus, so Enter does not discard by reflex.
  await expect(page.getByTestId('confirm-cancel')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(confirm).toHaveCount(0);
  await expect(nodes(page)).toHaveCount(1);

  await page.getByRole('button', { name: 'New', exact: true }).click();
  await page.getByTestId('confirm-accept').click();
  await expect(page.getByTestId('workflow-dialog')).toBeVisible();
});

test('Clear canvas can be undone', async ({ page }) => {
  await buildChain(page, TWO_STEPS);
  await page.getByRole('button', { name: 'Clear canvas' }).click();
  await page.getByTestId('confirm-accept').click();
  await expect(nodes(page)).toHaveCount(0);
  await expect(page.getByTestId('empty-state')).toBeVisible();

  await page.keyboard.press(`${MOD}+z`);
  await expect(nodes(page)).toHaveCount(2);
  await expect(page.locator('.react-flow__edge')).toHaveCount(1);
});
