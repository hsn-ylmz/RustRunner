import { describe, expect, it } from 'vitest';
import { parseReport, pngSize } from './html';

/** A 1x1 PNG (the smallest valid one). */
const PNG_1X1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const page = (body: string, head = '<style>body{margin:0}</style>') =>
  `<!DOCTYPE html>\n<html lang="en"><head><meta charset="utf-8"><title>riboWaltz report</title>${head}</head><body>${body}</body></html>`;

describe('parseReport', () => {
  it('reads a sound page: title, headings and decoded figures', () => {
    const r = parseReport(page(`<h2>Read lengths</h2><img alt="x" src="data:image/png;base64,${PNG_1X1}"><br><h2>P-site offsets</h2><table><tr><td>1</td></tr></table>`));
    expect(r.problems).toEqual([]);
    expect(r.title).toBe('riboWaltz report');
    expect(r.headings).toEqual(['Read lengths', 'P-site offsets']);
    expect(r.figures).toEqual([{ width: 1, height: 1 }]);
    expect(r.external).toEqual([]);
    expect(r.active).toEqual([]);
  });

  it('finds an unclosed element, a wrong closing tag and a missing doctype', () => {
    expect(parseReport(page('<div><p>text</div>')).problems.join(' ')).toMatch(/closes <p>/);
    expect(parseReport('<!DOCTYPE html><html><head><title>t</title></head><body><div>').problems.join(' ')).toMatch(/unclosed elements at the end: html, body, div/);
    expect(parseReport('<html><head><title>t</title></head><body></body></html>').problems.join(' ')).toMatch(/DOCTYPE/);
  });

  it('finds external addresses, stylesheets, fonts and scripts', () => {
    const r = parseReport(
      page(
        '<a href="https://example.org/x">x</a><img src="plot.png"><script>1</script>',
        '<link rel="stylesheet" href="https://cdn.example/a.css"><style>@import url(x.css);body{background:url(b.png)}</style>'
      )
    );
    expect(r.external).toEqual(expect.arrayContaining(['https://example.org/x', 'plot.png', 'https://cdn.example/a.css', 'b.png']));
    expect(r.active).toEqual(['script']);
  });

  it('rejects an inline image that is not a PNG', () => {
    const r = parseReport(page(`<img src="data:image/png;base64,${Buffer.from('not a png at all, just text').toString('base64')}">`));
    expect(r.problems).toContain('an inline image is not a valid PNG');
  });

  it('does not take text in a style block for a tag', () => {
    expect(parseReport(page('<p>a &lt; b</p>', '<style>a>b{color:red}</style>')).problems).toEqual([]);
  });

  it('reads the size of a PNG header and refuses other bytes', () => {
    expect(pngSize(Buffer.from(PNG_1X1, 'base64'))).toEqual({ width: 1, height: 1 });
    expect(pngSize(Buffer.from('GIF89a'))).toBeNull();
  });
});
