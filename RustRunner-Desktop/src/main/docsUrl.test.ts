import { describe, expect, it } from 'vitest';
import { MAX_DOCS_URL_LENGTH, safeDocsUrl } from './docsUrl';

describe('safeDocsUrl', () => {
  it('accepts plain https addresses', () => {
    expect(safeDocsUrl('https://www.htslib.org/doc/samtools-sort.html')).toBe(
      'https://www.htslib.org/doc/samtools-sort.html'
    );
    expect(safeDocsUrl('https://github.com/OpenGene/fastp')).toBe('https://github.com/OpenGene/fastp');
  });

  it('refuses everything that is not https', () => {
    for (const bad of [
      'http://example.org/',
      'file:///etc/passwd',
      'javascript:alert(1)',
      'ftp://example.org/',
      'steam://run/1',
      'data:text/html,<b>x</b>',
      '//example.org/',
      'example.org',
    ]) {
      expect(safeDocsUrl(bad), bad).toBeNull();
    }
  });

  it('refuses credentials in the address', () => {
    expect(safeDocsUrl('https://user:pass@example.org/')).toBeNull();
    expect(safeDocsUrl('https://user@example.org/')).toBeNull();
  });

  it('refuses things that are not text, empty text and very long text', () => {
    expect(safeDocsUrl(undefined)).toBeNull();
    expect(safeDocsUrl(42)).toBeNull();
    expect(safeDocsUrl('')).toBeNull();
    expect(safeDocsUrl(`https://example.org/${'a'.repeat(MAX_DOCS_URL_LENGTH)}`)).toBeNull();
  });
});
