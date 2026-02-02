/**
 * Utility Functions
 */

import { URL } from 'url';
import path from 'path';

/**
 * Resolves the path to an HTML file based on environment.
 *
 * In development, returns localhost URL.
 * In production, returns file:// URL.
 */
export function resolveHtmlPath(htmlFileName: string): string {
  if (process.env.NODE_ENV === 'development') {
    const port = process.env.PORT || 3000;
    const url = new URL(`http://localhost:${port}`);
    url.pathname = htmlFileName;
    return url.href;
  }
  return `file://${path.resolve(__dirname, '../renderer/', htmlFileName)}`;
}
