/**
 * Which addresses the app may open in the person's browser: the documentation
 * links of catalog tools. Only plain `https://` addresses without a user name
 * or password are accepted, so a link can never start a program (`file:`,
 * custom schemes) or send credentials. Kept free of Electron imports so it can
 * be unit-tested.
 */

/** The longest address the app will pass on. */
export const MAX_DOCS_URL_LENGTH = 2048;

/** The normalised address when `value` is safe to open, otherwise null. */
export function safeDocsUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_DOCS_URL_LENGTH) {
    return null;
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:') return null;
  if (url.username !== '' || url.password !== '') return null;
  if (url.hostname === '') return null;
  return url.toString();
}
