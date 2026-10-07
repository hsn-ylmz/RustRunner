/**
 * The templates that ship with the app.
 *
 * To add one: write `templates/<id>.json` (see `schema.ts` for the format),
 * import it below and list it in `BUNDLED_SOURCES`. `__tests__/templates.test.ts`
 * fails when a template file is not listed here, when one is invalid (every
 * tool and file slot is checked against the catalog), or when an id repeats.
 */

import basicReadQc from './basic-read-qc.json';
import rnaseqSalmon from './rnaseq-salmon.json';
import rnaseqHisat2Counts from './rnaseq-hisat2-counts.json';
import variantsBcftools from './variants-bcftools.json';
import variantsBcftoolsPaired from './variants-bcftools-paired.json';
import variantsGatk from './variants-gatk.json';
import chipseqMacs3 from './chipseq-macs3.json';
import atacseqGenrich from './atacseq-genrich.json';
import nanoporeSignal from './nanopore-signal.json';
import nanoporeFastq from './nanopore-fastq.json';
import metagenomicsKraken2Bracken from './metagenomics-kraken2-bracken.json';
import assemblySpadesQuast from './assembly-spades-quast.json';
import assemblyFlyeQuast from './assembly-flye-quast.json';
import { parseTemplate, type WorkflowTemplate } from './schema';

/** Every bundled template file, as imported. Order is the order the gallery shows. */
export const BUNDLED_SOURCES: Array<{ file: string; raw: unknown }> = [
  { file: 'basic-read-qc.json', raw: basicReadQc },
  { file: 'rnaseq-salmon.json', raw: rnaseqSalmon },
  { file: 'rnaseq-hisat2-counts.json', raw: rnaseqHisat2Counts },
  { file: 'variants-bcftools.json', raw: variantsBcftools },
  { file: 'variants-bcftools-paired.json', raw: variantsBcftoolsPaired },
  { file: 'variants-gatk.json', raw: variantsGatk },
  { file: 'chipseq-macs3.json', raw: chipseqMacs3 },
  { file: 'atacseq-genrich.json', raw: atacseqGenrich },
  { file: 'nanopore-signal.json', raw: nanoporeSignal },
  { file: 'nanopore-fastq.json', raw: nanoporeFastq },
  { file: 'metagenomics-kraken2-bracken.json', raw: metagenomicsKraken2Bracken },
  { file: 'assembly-spades-quast.json', raw: assemblySpadesQuast },
  { file: 'assembly-flye-quast.json', raw: assemblyFlyeQuast },
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
