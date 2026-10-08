/**
 * Test helper: reads styles/tokens.css and answers "what is the value of
 * --name in the light / dark theme" and "what is the WCAG contrast of two
 * tokens". Kept out of the app bundle (it uses fs); only tests import it.
 */

import fs from 'fs';
import path from 'path';

export const RENDERER_DIR = path.resolve(__dirname, '..');
export const TOKENS_FILE = path.join(RENDERER_DIR, 'styles', 'tokens.css');

export type TokenMap = Record<string, string>;

/** Removes /* ... *\/ comments. */
export function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

/** The text between the braces of the first block whose header matches. */
export function blockBody(css: string, header: string): string {
  const start = css.indexOf(header);
  if (start < 0) throw new Error(`no block "${header}"`);
  const open = css.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < css.length; i++) {
    if (css[i] === '{') depth++;
    if (css[i] === '}') {
      depth--;
      if (depth === 0) return css.slice(open + 1, i);
    }
  }
  throw new Error(`unterminated block "${header}"`);
}

/** `--name: value;` declarations of one block body. */
export function declarations(body: string): TokenMap {
  const out: TokenMap = {};
  const re = /(--[\w-]+)\s*:\s*([^;]+);/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body))) out[m[1]] = m[2].trim().replace(/\s+/g, ' ');
  return out;
}

export interface Themes {
  light: TokenMap;
  /** The block applied for `prefers-color-scheme: dark`. */
  darkMedia: TokenMap;
  /** The block applied for `data-theme="dark"`. */
  darkAttr: TokenMap;
  /** Light tokens overlaid with the dark ones. */
  dark: TokenMap;
}

export function loadThemes(file = TOKENS_FILE): Themes {
  const css = stripComments(fs.readFileSync(file, 'utf-8'));
  const media = blockBody(css, '@media (prefers-color-scheme: dark)');
  const light = declarations(blockBody(css, ':root {'));
  const darkMedia = declarations(blockBody(media, ":root:not([data-theme='light'])"));
  const darkAttr = declarations(blockBody(css, ":root[data-theme='dark']"));
  return { light, darkMedia, darkAttr, dark: { ...light, ...darkMedia } };
}

/** Follows var(--x) references until a literal value is reached. */
export function resolve(theme: TokenMap, name: string, depth = 0): string {
  if (depth > 10) throw new Error(`token cycle at ${name}`);
  const value = theme[name];
  if (value === undefined) throw new Error(`undefined token ${name}`);
  const ref = /^var\((--[\w-]+)\)$/.exec(value);
  return ref ? resolve(theme, ref[1], depth + 1) : value;
}

export type Rgb = [number, number, number];

/** #rgb, #rrggbb, #rrggbbaa (alpha ignored: tokens used for text are opaque). */
export function parseColor(value: string): Rgb {
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(value.trim());
  if (!hex) throw new Error(`not an opaque hex colour: ${value}`);
  let h = hex[1];
  if (h.length === 3) h = [...h].map((c) => c + c).join('');
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as Rgb;
}

function channel(c: number): number {
  const s = c / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

/** WCAG 2.x relative luminance. */
export function luminance([r, g, b]: Rgb): number {
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** WCAG 2.x contrast ratio, 1 to 21. */
export function contrastRatio(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** Contrast between two tokens of one theme. */
export function tokenContrast(theme: TokenMap, fg: string, bg: string): number {
  return contrastRatio(parseColor(resolve(theme, fg)), parseColor(resolve(theme, bg)));
}

/** What kinds of colour literal `findColourLiterals` looks for. */
const LITERALS: Array<[string, RegExp, boolean]> = [
  // [kind, pattern, stylesheets only]
  ['hex colour', /#[0-9a-fA-F]{3,8}\b/g, false],
  ['rgb()/hsl() colour', /\b(?:rgba?|hsla?)\(/g, false],
  ['colour keyword', /:\s*[^;{}]*\b(?:white|black)\b[^;{}]*;/g, true],
];

export interface ColourLiteral {
  line: number;
  kind: string;
  text: string;
}

/**
 * Colour literals in a source file: hex values, rgb()/hsl() calls, and (in
 * stylesheets) the keywords white and black. Comments in stylesheets are
 * ignored; prose in TypeScript is never matched against the keyword rule.
 */
export function findColourLiterals(source: string, isStylesheet: boolean): ColourLiteral[] {
  const text = isStylesheet ? stripComments(source) : source;
  const out: ColourLiteral[] = [];
  for (const [kind, re, cssOnly] of LITERALS) {
    if (cssOnly && !isStylesheet) continue;
    for (const m of text.matchAll(re)) {
      out.push({ line: text.slice(0, m.index).split('\n').length, kind, text: m[0].trim() });
    }
  }
  return out.sort((a, b) => a.line - b.line);
}
