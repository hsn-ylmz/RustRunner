import { test, expect } from './fixtures';

// A system theme change used to call BrowserWindow.setIcon with an .icns path,
// which throws on macOS ("Failed to load image from path") and showed an
// uncaught-exception dialog from the main process on every light/dark switch.
test('switching the system theme does not throw in the main process', async ({ app, page }) => {
  await expect(page.getByTestId('run')).toBeVisible();

  // Record uncaught main-process errors instead of letting Electron show its dialog.
  await app.evaluate(() => {
    const g = globalThis as unknown as { __themeErrors: string[] };
    g.__themeErrors = [];
    process.on('uncaughtException', (err) => {
      g.__themeErrors.push(String(err && err.stack ? err.stack : err));
    });
  });

  for (const source of ['dark', 'light', 'dark', 'system'] as const) {
    await app.evaluate(({ nativeTheme }, s) => {
      nativeTheme.themeSource = s;
    }, source);
    await page.waitForTimeout(150);
  }

  const errors = await app.evaluate(
    () => (globalThis as unknown as { __themeErrors: string[] }).__themeErrors,
  );
  expect(errors).toEqual([]);
});
