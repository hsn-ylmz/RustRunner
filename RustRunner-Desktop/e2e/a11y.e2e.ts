/**
 * Accessibility and resilience of the editor as a whole: a workflow can be
 * built and run with the keyboard alone, every button has a name, motion stops
 * under reduced motion, and nothing overflows in the smallest window the app
 * allows. None of these tests touches the mouse unless it says so.
 */

import type { Page } from '@playwright/test';
import { test, expect, buildChain, nodes, stepRow, openStepStatus } from './fixtures';

/**
 * Presses Tab (or Shift+Tab) until the focused element matches `selector`,
 * and fails when it is not reached within `max` presses: an element the Tab
 * key cannot reach is not usable from the keyboard.
 */
async function tabTo(page: Page, selector: string, { back = false, max = 120 } = {}): Promise<number> {
  for (let i = 1; i <= max; i++) {
    await page.keyboard.press(back ? 'Shift+Tab' : 'Tab');
    const hit = await page.evaluate(
      (sel) => document.activeElement instanceof Element && document.activeElement.matches(sel),
      selector
    );
    if (hit) return i;
  }
  throw new Error(`${selector} was not reached with ${back ? 'Shift+Tab' : 'Tab'} in ${max} presses`);
}

/** Replaces the text of the focused field by typing, as a keyboard user would. */
async function typeInto(page: Page, text: string) {
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.type(text);
}

const testId = (id: string) => `[data-testid="${id}"]`;

test('a two-step workflow is built, connected and run with the keyboard only', async ({ page }) => {
  // Step 1: a custom step, filled in field by field.
  await tabTo(page, testId('add-node'));
  await page.keyboard.press('Enter');
  await expect(nodes(page)).toHaveCount(1);
  await expect(page.getByTestId('properties-panel')).toBeVisible();

  await tabTo(page, testId('prop-label'));
  await typeInto(page, 'Make');
  await tabTo(page, testId('prop-tool'));
  await typeInto(page, 'bash');
  await tabTo(page, testId('prop-output'));
  await typeInto(page, 'a.txt');
  await tabTo(page, testId('prop-command'));
  await typeInto(page, 'echo hello > {output}');

  // Step 2: back up to "Add node" (it comes before the canvas and the panel).
  await tabTo(page, testId('add-node'), { back: true });
  await page.keyboard.press('Enter');
  await expect(nodes(page)).toHaveCount(2);
  await expect(page.getByTestId('prop-label')).toHaveValue('Node 2');

  await tabTo(page, testId('prop-label'));
  await typeInto(page, 'Copy');
  await tabTo(page, testId('prop-tool'));
  await typeInto(page, 'bash');

  // The connection, without dragging: tick "Make" under "Runs after".
  await tabTo(page, '[data-testid^="prop-upstream-"]');
  await expect(page.locator(':focus')).toHaveAccessibleName('Make');
  await page.keyboard.press('Space');
  await expect(page.locator('.react-flow__edge')).toHaveCount(1);

  await tabTo(page, testId('prop-input'));
  await typeInto(page, 'a.txt');
  await tabTo(page, testId('prop-output'));
  await typeInto(page, 'b.txt');
  await tabTo(page, testId('prop-command'));
  await typeInto(page, 'cp {input} {output}');

  // Run: the folder picker is answered by the fixture.
  await tabTo(page, testId('run'), { back: true });
  await expect(page.getByTestId('run')).toBeEnabled();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('run-summary-title')).toContainText('succeeded', { timeout: 30_000 });
  await openStepStatus(page);
  await expect(stepRow(page, 'make')).toHaveAttribute('data-state', 'succeeded');
  await expect(stepRow(page, 'copy')).toHaveAttribute('data-state', 'succeeded');
});

test('"Runs after" refuses a loop and can remove a connection', async ({ page }) => {
  await buildChain(page, [
    { label: 'One', command: 'echo 1 > {output}', output: 'a.txt' },
    { label: 'Two', command: 'cp {input} {output}', input: 'a.txt', output: 'b.txt' },
  ]);
  await expect(page.locator('.react-flow__edge')).toHaveCount(1);

  // On "One", "Two" already runs after it: ticking it would make a loop.
  await nodes(page).filter({ hasText: 'One' }).first().click();
  const loop = page.getByTestId('prop-upstream').getByRole('checkbox', { name: /Two/ });
  await expect(loop).toBeDisabled();
  await expect(page.getByTestId('prop-upstream')).toContainText('runs after this step');

  // On "Two", unticking "One" removes the connection, and Undo brings it back.
  await nodes(page).filter({ hasText: 'Two' }).first().click();
  const one = page.getByTestId('prop-upstream').getByRole('checkbox', { name: 'One' });
  await expect(one).toBeChecked();
  await one.uncheck();
  await expect(page.locator('.react-flow__edge')).toHaveCount(0);
  await page.keyboard.press('ControlOrMeta+Z');
  await expect(page.locator('.react-flow__edge')).toHaveCount(1);
});

/** Visible buttons, radios and links without an accessible name. */
async function unnamedControls(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const named = (el: Element): boolean => {
      const label = el.getAttribute('aria-label')?.trim();
      if (label) return true;
      const by = el.getAttribute('aria-labelledby');
      if (by && by.split(/\s+/).some((id) => document.getElementById(id)?.textContent?.trim())) return true;
      if ((el.textContent ?? '').trim()) return true;
      return Boolean(el.getAttribute('title')?.trim());
    };
    return Array.from(document.querySelectorAll('button, [role="button"], [role="radio"], [role="tab"], a[href]'))
      .filter((el) => {
        const box = (el as HTMLElement).getBoundingClientRect();
        return box.width > 0 && box.height > 0 && !named(el);
      })
      .map((el) => el.outerHTML.slice(0, 120));
  });
}

test('every visible button has an accessible name', async ({ page }) => {
  expect(await unnamedControls(page)).toEqual([]);

  await buildChain(page, [
    { label: 'Make', command: 'echo hi > {output}', output: 'a.txt' },
    { label: 'Fail', command: 'exit 2', input: 'a.txt', output: 'b.txt' },
  ]);
  await nodes(page).filter({ hasText: 'Fail' }).first().click();
  expect(await unnamedControls(page)).toEqual([]);

  await page.getByTestId('open-palette').click();
  expect(await unnamedControls(page)).toEqual([]);
  await page.keyboard.press('Escape');

  await page.getByTestId('run-from-scratch').click();
  await expect(page.getByTestId('failure-card')).toBeVisible();
  expect(await unnamedControls(page)).toEqual([]);

  // Icon-only controls in particular, by role and name.
  await expect(page.getByRole('button', { name: 'Keyboard shortcuts (?)' })).toBeVisible();
  await expect(page.getByRole('radiogroup', { name: 'Node colour' })).toBeVisible();
});

test('under reduced motion the running spinner does not keep turning', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await buildChain(page, [{ label: 'Slow', command: 'sleep 3; echo done > {output}', output: 'a.txt' }]);
  await page.getByTestId('run-from-scratch').click();
  const spinner = nodes(page).filter({ hasText: 'Slow' }).locator('.icon-spin');
  await expect(spinner).toBeVisible();
  const motion = await spinner.evaluate((el) => {
    const cs = getComputedStyle(el);
    return { count: cs.animationIterationCount, duration: parseFloat(cs.animationDuration) };
  });
  expect(motion.count).toBe('1');
  expect(motion.duration).toBeLessThan(0.01);
  await page.getByTestId('stop').click();
});

test('at the minimum window size nothing overflows or overlaps', async ({ page, app }) => {
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].setContentSize(1024, 700);
  });
  await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(1024);

  const check = async (when: string) => {
    const problems = await page.evaluate(() => {
      const out: string[] = [];
      const doc = document.documentElement;
      if (doc.scrollWidth > window.innerWidth) out.push(`page scrolls sideways (${doc.scrollWidth}px)`);
      const toolbar = document.querySelector('.top-toolbar') as HTMLElement;
      // One row: the bar is no taller than its tallest item plus its padding.
      if (toolbar.getBoundingClientRect().height > 72) out.push(`toolbar wraps (${toolbar.offsetHeight}px)`);
      for (const btn of Array.from(toolbar.querySelectorAll('button'))) {
        const r = btn.getBoundingClientRect();
        if (r.right > window.innerWidth + 0.5) out.push(`toolbar button cut off: ${btn.textContent}`);
      }
      const rect = (sel: string) => document.querySelector(sel)?.getBoundingClientRect() ?? null;
      const overlap = (a: DOMRect | null, b: DOMRect | null) =>
        !!a && !!b && a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
      const run = rect('[data-testid="run-controls"]');
      if (overlap(run, rect('.top-toolbar'))) out.push('run controls overlap the toolbar');
      if (overlap(run, rect('.react-flow__controls'))) out.push('run controls overlap the zoom controls');
      if (overlap(run, rect('.react-flow__minimap'))) out.push('run controls overlap the minimap');
      const canvas = rect('.flow-container')!;
      if (run && run.bottom > canvas.bottom + 0.5) out.push('run controls run past the canvas');
      const empty = rect('.empty-state');
      if (empty && (empty.top < canvas.top - 0.5 || empty.bottom > canvas.bottom + 0.5)) {
        out.push('the empty-canvas card is clipped');
      }
      return out;
    });
    expect(problems, when).toEqual([]);
  };

  await check('empty canvas');
  await buildChain(page, [
    { label: 'Empty', command: 'touch {output}', output: 'empty.txt' },
    { label: 'Next', command: 'cp {input} {output}', input: 'empty.txt', output: 'next.txt' },
  ]);
  await check('node selected');
  await page.getByTestId('section-checks-toggle').click();
  await page.getByTestId('prop-check-non-empty').check();
  await page.getByTestId('run-from-scratch').click();
  await expect(page.getByTestId('failure-card')).toBeVisible();
  await check('failed run with the properties panel open');
});
