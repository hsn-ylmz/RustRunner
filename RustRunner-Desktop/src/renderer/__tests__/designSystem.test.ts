import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import {
  RENDERER_DIR,
  TOKENS_FILE,
  contrastRatio,
  findColourLiterals,
  loadThemes,
  parseColor,
  resolve,
  stripComments,
  tokenContrast,
  type TokenMap,
} from './tokenModel';

const themes = loadThemes();
const THEME_NAMES = ['light', 'dark'] as const;

const SURFACES = ['--bg', '--surface', '--surface-muted', '--surface-sunken', '--elevated'];
const ROLES = ['accent', 'success', 'warning', 'danger', 'info'];
const STATUSES = ['pending', 'running', 'retrying', 'succeeded', 'failed', 'skipped'];
const NODE_COLORS = Object.keys(themes.light)
  .filter((n) => /^--node-(?!border|text)/.test(n))
  .map((n) => n);

/** [foreground, background, minimum ratio] triples that must hold in each theme. */
function requirements(): Array<[string, string, number, string]> {
  const out: Array<[string, string, number, string]> = [];
  const text = (fg: string, bg: string, why: string) => out.push([fg, bg, 4.5, why]);
  const boundary = (fg: string, bg: string, why: string) => out.push([fg, bg, 3, why]);

  for (const s of SURFACES) {
    text('--text', s, 'body text');
    text('--text-muted', s, 'hints and placeholders');
    boundary('--border-strong', s, 'control edge');
    boundary('--focus-ring-color', s, 'focus ring');
  }
  for (const r of ROLES) {
    text('--text-inverse', `--${r}-solid`, `${r} button label`);
    text('--text-inverse', `--${r}-solid-hover`, `${r} button label on hover`);
    text(`--${r}`, `--${r}-subtle`, `${r} message text`);
    text('--text', `--${r}-subtle`, `body text on a ${r} tint`);
    text('--text-muted', `--${r}-subtle`, `hint on a ${r} tint`);
    for (const s of ['--bg', '--surface', '--surface-muted', '--elevated']) {
      text(`--${r}`, s, `${r} text on surface`);
    }
  }
  for (const s of STATUSES) {
    text(`--status-${s}`, '--surface-muted', `${s} text in the status panel`);
    text(`--status-${s}`, '--surface-sunken', `${s} text in the log panel`);
    text(`--status-${s}`, '--bg', `${s} ring on the canvas`);
    text('--text-inverse', `--status-${s}-solid`, `${s} badge glyph`);
    boundary(`--status-${s}-solid`, '--bg', `${s} badge edge`);
  }
  text('--tooltip-text', '--tooltip-bg', 'tooltip');
  boundary('--tooltip-bg', '--bg', 'tooltip edge');
  out.push(['--disabled-text', '--disabled-bg', 3, 'disabled button label']);
  for (const e of ['--edge-default', '--edge-match', '--edge-mismatch', '--node-border']) {
    boundary(e, '--bg', 'canvas line');
  }
  text('--edge-match-text', '--edge-match-subtle', 'match label');
  text('--edge-mismatch-text', '--edge-mismatch-subtle', 'mismatch label');
  boundary('--edge-match', '--edge-match-subtle', 'match label outline');
  boundary('--edge-mismatch', '--edge-mismatch-subtle', 'mismatch label outline');
  for (const n of NODE_COLORS) {
    text('--node-text', n, `node label on ${n}`);
    text('--node-text-muted', n, `node tool name on ${n}`);
  }
  return out;
}

describe('colour tokens', () => {
  for (const name of THEME_NAMES) {
    describe(`${name} theme`, () => {
      const theme = themes[name];
      for (const [fg, bg, min, why] of requirements()) {
        it(`${fg} on ${bg} is at least ${min}:1 (${why})`, () => {
          expect(tokenContrast(theme, fg, bg)).toBeGreaterThanOrEqual(min);
        });
      }
    });
  }

  it('finds the ten node colours', () => {
    expect(NODE_COLORS).toHaveLength(10);
  });

  it('writes the dark values identically for the OS setting and the data-theme attribute', () => {
    expect(themes.darkAttr).toEqual(themes.darkMedia);
  });

  it('only overrides tokens in dark that light defines', () => {
    for (const name of Object.keys(themes.darkMedia)) {
      expect(themes.light, name).toHaveProperty([name]);
    }
  });

  it('resolves every var() reference to a literal', () => {
    for (const name of THEME_NAMES) {
      for (const token of Object.keys(themes[name])) {
        if (/^--(space|radius|text-(xs|sm|md|lg|xl)|weight|leading|duration|ease|font|shadow|overlay|hover|active|focus-ring-(width|offset))/.test(token)) continue;
        expect(() => parseColor(resolve(themes[name], token)), `${name} ${token}`).not.toThrow();
      }
    }
  });

  it('computes contrast like the WCAG reference values', () => {
    expect(contrastRatio([0, 0, 0], [255, 255, 255])).toBeCloseTo(21, 5);
    expect(contrastRatio([255, 255, 255], [255, 255, 255])).toBeCloseTo(1, 5);
    // The audit's measurement: white on the old pastel green button was 1.80:1.
    expect(contrastRatio(parseColor('#ffffff'), parseColor('#7dd663'))).toBeCloseTo(1.8, 1);
  });
});

describe('scale tokens', () => {
  const light = themes.light;
  const px = (name: string) => parseFloat(light[name]);

  it('keeps spacing on the 4-point grid', () => {
    for (const n of ['--space-1', '--space-2', '--space-3', '--space-4', '--space-5', '--space-6']) {
      expect(px(n) % 4, n).toBe(0);
    }
  });

  it('keeps the type scale ascending and no smaller than 12px', () => {
    const sizes = ['--text-xs', '--text-sm', '--text-md', '--text-lg', '--text-xl'].map(px);
    expect(sizes[0]).toBeGreaterThanOrEqual(12);
    expect([...sizes].sort((a, b) => a - b)).toEqual(sizes);
  });

  it('keeps motion short and the focus ring at least 2px', () => {
    for (const n of ['--duration-fast', '--duration-base', '--duration-slow']) {
      expect(px(n), n).toBeLessThanOrEqual(400);
    }
    expect(px('--focus-ring-width')).toBeGreaterThanOrEqual(2);
  });
});

// -----------------------------------------------------------------------------
// No colour literals outside the token file
// -----------------------------------------------------------------------------

/** Files that may hold colour literals, and why. */
const COLOUR_LITERAL_ALLOWLIST = new Map<string, string>([
  [path.join('styles', 'tokens.css'), 'the token definitions'],
  [
    'nodeColors.ts',
    'maps the hex values saved in older workflow files to node colour names',
  ],
]);

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__') continue;
      out.push(...sourceFiles(full));
    } else if (/\.(css|tsx?|html|json)$/.test(entry.name) && !entry.name.endsWith('.d.ts')) {
      out.push(full);
    }
  }
  return out;
}

describe('colour literals', () => {
  const files = sourceFiles(RENDERER_DIR);

  it('scans the renderer sources', () => {
    expect(files.some((f) => f.endsWith('App.css'))).toBe(true);
    expect(files.some((f) => f.endsWith(path.join('components', 'PropertiesPanel.tsx')))).toBe(true);
  });

  it('keeps every colour literal in the token file', () => {
    const offenders: string[] = [];
    for (const file of files) {
      const rel = path.relative(RENDERER_DIR, file);
      if (COLOUR_LITERAL_ALLOWLIST.has(rel)) continue;
      const found = findColourLiterals(fs.readFileSync(file, 'utf-8'), file.endsWith('.css'));
      for (const f of found) offenders.push(`${rel}:${f.line} ${f.kind} ${f.text}`);
    }
    expect(offenders).toEqual([]);
  });

  it('flags hex, rgb(), hsl() and white/black in stylesheets', () => {
    const css = '.a { color: #fff; background: rgb(0 0 0 / 0.5); border-color: hsl(10 20% 30%); fill: white; }';
    expect(findColourLiterals(css, true).map((f) => f.kind)).toEqual([
      'hex colour',
      'rgb()/hsl() colour',
      'rgb()/hsl() colour',
      'colour keyword',
    ]);
  });

  it('flags a hex colour in TypeScript but not the word white in prose', () => {
    expect(findColourLiterals("const c = '#88c5f7'; // paint it white", false)).toHaveLength(1);
  });

  it('ignores colours inside CSS comments and accepts var() and transparent', () => {
    const css = '/* was #ff0000 */ .a { color: var(--text); background: transparent; }';
    expect(findColourLiterals(css, true)).toEqual([]);
  });

  it('only allows literals in files that say why', () => {
    for (const [file, why] of COLOUR_LITERAL_ALLOWLIST) {
      expect(why.length).toBeGreaterThan(10);
      expect(fs.existsSync(path.join(RENDERER_DIR, file)), file).toBe(true);
    }
  });
});

describe('token references', () => {
  const defined = new Set([
    ...Object.keys(themes.light),
    ...Object.keys(themes.dark),
  ]);

  /** Custom properties a stylesheet or component sets for itself. */
  function declaredLocally(text: string): Set<string> {
    const out = new Set<string>();
    for (const m of text.matchAll(/(--[\w-]+)\s*:/g)) out.add(m[1]);
    for (const m of text.matchAll(/['"`](--[\w-]+)['"`]\s*:/g)) out.add(m[1]);
    return out;
  }

  it('uses only tokens that exist', () => {
    const missing: string[] = [];
    for (const file of sourceFiles(RENDERER_DIR)) {
      if (file === TOKENS_FILE || !/\.(css|tsx)$/.test(file)) continue;
      const text = fs.readFileSync(file, 'utf-8');
      const local = declaredLocally(text);
      for (const m of text.matchAll(/var\((--[\w-]+)/g)) {
        const name = m[1];
        // React Flow's own variables are set by its stylesheet.
        if (name.startsWith('--xy-') || defined.has(name) || local.has(name)) continue;
        missing.push(`${path.relative(RENDERER_DIR, file)} ${name}`);
      }
    }
    expect(missing).toEqual([]);
  });
});

describe('token file', () => {
  it('is plain CSS custom properties (no rules that style elements)', () => {
    const css = stripComments(fs.readFileSync(TOKENS_FILE, 'utf-8'));
    const selectors = [...css.matchAll(/([^{}]+)\{/g)].map((m) => m[1].trim());
    for (const s of selectors) {
      expect(s, s).toMatch(/^(:root|@media \(prefers-color-scheme: dark\)|:root:not\(\[data-theme='light'\]\)|:root\[data-theme='dark'\])/);
    }
  });
});

export type { TokenMap };
