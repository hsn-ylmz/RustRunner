/**
 * The templates that ship with the app.
 *
 * To add one: write `templates/<id>.json` (see `schema.ts` for the format),
 * import it below and list it in `BUNDLED_SOURCES`. `__tests__/templates.test.ts`
 * fails when a template file is not listed here, when one is invalid (every
 * tool and file slot is checked against the catalog), or when an id repeats.
 */

import basicReadQc from './basic-read-qc.json';
import { parseTemplate, type WorkflowTemplate } from './schema';

/** Every bundled template file, as imported. Order is the order the gallery shows. */
export const BUNDLED_SOURCES: Array<{ file: string; raw: unknown }> = [
  { file: 'basic-read-qc.json', raw: basicReadQc },
];

/** The bundled templates that are valid for the tool catalog this app has. */
export function bundledTemplates(): WorkflowTemplate[] {
  const out: WorkflowTemplate[] = [];
  for (const { raw } of BUNDLED_SOURCES) {
    const parsed = parseTemplate(raw);
    if (parsed.ok) out.push(parsed.template);
  }
  return out;
}
