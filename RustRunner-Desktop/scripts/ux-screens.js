/**
 * Captures the UX review screenshots into a clean folder.
 *
 *   npm run ux:screens                           # ../ux-review/screens
 *   UX_OUT=../ux-review/after-x npm run ux:screens
 *
 * The folder is emptied of earlier PNGs first, so a capture never mixes with a
 * stale one (renamed or renumbered states would otherwise leave old files
 * behind). Only a folder inside the repository's ux-review directory is ever
 * cleared.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const desktop = path.resolve(__dirname, '..');
const uxReview = path.resolve(desktop, '..', 'ux-review');
const out = path.resolve(desktop, process.env.UX_OUT || '../ux-review/screens');

const relative = path.relative(uxReview, out);
if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
  console.error(`Refusing to clear ${out}: it is not a folder inside ${uxReview}.`);
  process.exit(1);
}

if (fs.existsSync(out)) {
  for (const name of fs.readdirSync(out)) {
    if (name.endsWith('.png')) fs.rmSync(path.join(out, name));
  }
}
fs.mkdirSync(out, { recursive: true });

const bin = path.join(desktop, 'node_modules', '.bin', process.platform === 'win32' ? 'playwright.cmd' : 'playwright');
const result = spawnSync(bin, ['test', 'ux-screens'], {
  cwd: desktop,
  stdio: 'inherit',
  env: { ...process.env, UX_OUT: out },
});
process.exit(result.status ?? 1);
