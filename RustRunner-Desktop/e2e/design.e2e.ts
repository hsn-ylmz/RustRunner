import { test, expect, buildChain, selectNode } from './fixtures';

/** WCAG contrast of two computed `rgb(...)` colours. */
async function contrastOf(page: any, selector: string): Promise<number> {
  return page.evaluate((sel: string) => {
    const el = document.querySelector(sel) as HTMLElement;
    const parse = (c: string) => (c.match(/[\d.]+/g) || []).slice(0, 3).map(Number);
    const lum = ([r, g, b]: number[]) => {
      const f = (v: number) => {
        const s = v / 255;
        return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
    };
    const cs = getComputedStyle(el);
    const [a, b] = [lum(parse(cs.color)), lum(parse(cs.backgroundColor))].sort((x, y) => y - x);
    return (a + 0.05) / (b + 0.05);
  }, selector);
}

for (const scheme of ['light', 'dark'] as const) {
  test(`${scheme}: the rendered primary button and focus ring meet contrast`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme });
    // Run is only available once the step is complete.
    await buildChain(page, [{ label: 'Make', command: 'echo hi > {output}', output: 'a.txt' }]);
    await expect(page.getByTestId('run')).toBeEnabled();
    await page.waitForTimeout(400); // let the colour transition finish
    expect(await contrastOf(page, '[data-testid="run"]')).toBeGreaterThanOrEqual(4.5);

    // A keyboard user gets a visible ring.
    await page.keyboard.press('Tab');
    const ring = await page.evaluate(() => {
      const cs = getComputedStyle(document.activeElement as HTMLElement);
      return { style: cs.outlineStyle, width: parseFloat(cs.outlineWidth) };
    });
    expect(ring.style).toBe('solid');
    expect(ring.width).toBeGreaterThanOrEqual(2);
  });
}

test('labels name their fields', async ({ page }) => {
  await page.getByTestId('add-node').click();
  await selectNode(page, 'Node 1');
  await expect(page.getByLabel('Node name')).toHaveValue('Node 1');
  await expect(page.getByLabel('Threads')).toBeVisible();
});

test('a disabled Run says why, and the dialog is an accessible modal', async ({ page }) => {
  const run = page.getByTestId('run');
  await expect(run).toBeDisabled();
  await run.hover();
  await expect(page.getByRole('tooltip')).toContainText('Add a step');

  await page.getByTestId('details').focus();
  await page.getByTestId('details').press('Enter');
  const dialog = page.getByRole('dialog', { name: 'Workflow details' });
  await expect(dialog).toBeVisible();
  await expect(page.getByTestId('dialog-name')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(page.getByTestId('details')).toBeFocused();
});

test('tabs move with the arrow keys and node colours have names', async ({ page }) => {
  await page.getByTestId('tab-logs').focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByTestId('tab-steps')).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('tab-steps')).toBeFocused();

  await page.getByTestId('add-node').click();
  await selectNode(page, 'Node 1');
  await expect(page.getByRole('button', { name: 'Node colour: Rose' })).toBeVisible();
});
