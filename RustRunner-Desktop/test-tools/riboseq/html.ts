/**
 * A small, strict reader for the one self-contained HTML page the riboWaltz
 * report script writes (inline CSS, inline base64 PNG figures, no script).
 * It is what "the page opens" means in the real-tool suite: the page parses
 * with every element closed in order, and every figure decodes to a real PNG.
 * It is not a general HTML parser.
 */

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);

export interface ParsedReport {
  /** Problems found, empty when the page is sound. */
  problems: string[];
  title: string;
  headings: string[];
  /** The decoded figures: pixel size of each inline PNG. */
  figures: Array<{ width: number; height: number }>;
  /** Every address the page would fetch or follow (src, href, url(...)) that is not an inline data: URI. */
  external: string[];
  /** Elements that run code or pull in other documents. */
  active: string[];
}

/** Width and height of a PNG from its header, or null when the bytes are not a PNG. */
export function pngSize(bytes: Buffer): { width: number; height: number } | null {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (bytes.length < 33 || !bytes.subarray(0, 8).equals(signature)) return null;
  if (bytes.subarray(12, 16).toString('latin1') !== 'IHDR') return null;
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  return width > 0 && height > 0 ? { width, height } : null;
}

export function parseReport(html: string): ParsedReport {
  const out: ParsedReport = { problems: [], title: '', headings: [], figures: [], external: [], active: [] };
  if (!/^<!DOCTYPE html>/i.test(html)) out.problems.push('the page does not start with <!DOCTYPE html>');

  const stack: string[] = [];
  const tag = /<!--[\s\S]*?-->|<!DOCTYPE[^>]*>|<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:"[^"]*"|'[^']*'|[^'">])*)>/gi;
  let last = 0;
  let text = '';
  const raw = new Set(['style', 'title']);
  for (let m = tag.exec(html); m; m = tag.exec(html)) {
    text = html.slice(last, m.index);
    last = tag.lastIndex;
    if (m[2] === undefined) continue; // a comment or the doctype
    const closing = m[1] === '/';
    const name = m[2].toLowerCase();
    const attrs = m[3] ?? '';
    const top = stack[stack.length - 1];
    if (top !== undefined && raw.has(top) && !(closing && name === top)) {
      out.problems.push(`<${top}> contains a tag <${name}>`);
      continue;
    }
    if (closing) {
      if (top !== name) out.problems.push(`</${name}> closes <${top ?? 'nothing'}>`);
      else stack.pop();
      if (name === 'title') out.title = text.trim();
      if (name === 'h2') out.headings.push(text.trim());
      continue;
    }
    if (['script', 'iframe', 'object', 'embed', 'form'].includes(name)) out.active.push(name);
    for (const a of attrs.matchAll(/\s(src|href|poster|action|data)\s*=\s*("([^"]*)"|'([^']*)')/gi)) {
      const value = a[3] ?? a[4] ?? '';
      if (name === 'img' && a[1].toLowerCase() === 'src' && value.startsWith('data:image/png;base64,')) {
        const size = pngSize(Buffer.from(value.slice('data:image/png;base64,'.length), 'base64'));
        if (size) out.figures.push(size);
        else out.problems.push('an inline image is not a valid PNG');
      } else if (!value.startsWith('data:') && !value.startsWith('#')) {
        out.external.push(value);
      }
    }
    if (/\sstyle\s*=\s*"[^"]*url\(/i.test(attrs)) out.external.push('url() in a style attribute');
    if (!VOID.has(name) && !attrs.trimEnd().endsWith('/')) stack.push(name);
  }
  for (const css of html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)) {
    for (const u of css[1].matchAll(/url\(\s*['"]?([^'")]+)/gi)) if (!u[1].startsWith('data:')) out.external.push(u[1]);
    for (const i of css[1].matchAll(/@import\s+([^;]+);/gi)) out.external.push(i[1]);
  }
  if (stack.length > 0) out.problems.push(`unclosed elements at the end: ${stack.join(', ')}`);
  if (out.title === '') out.problems.push('the page has no title');
  return out;
}
