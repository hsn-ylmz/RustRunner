/**
 * Templates domain: every bundled workflow template is made into steps by the
 * code the "New from template" dialog runs (`instantiateTemplate`, with files
 * chosen the way the setup step passes them), converted to the engine's YAML
 * the way the app does, and run for real against the bioconda tools on the
 * synthetic data. A template that works in the editor but not in the engine,
 * or whose declared outputs are not what the tools write, fails here.
 *
 * To add a bundled template: add an entry to `SETUPS` (the data files and the
 * file chosen for each input, and what the results must hold). The layout test
 * in `../coverage.tools.ts` fails for a bundled template without one.
 */
import { defineDomain, exists, read, truthSnps, type BuiltChain, type Chain, type Check } from '../harness';
import { bundledTemplates } from '../../src/renderer/templates/registry';
import { instantiateTemplate, templateNodeId } from '../../src/renderer/templates/instantiate';
import { collectIssues } from '../../src/renderer/validation';
import { validateCatalogNodes } from '../../src/renderer/tools/catalog';
import { convertNodesToWorkflow, labelToId, validateWorkflow } from '../../src/renderer/workflowConversion';

interface Setup {
  /** Data files copied from the synthetic data folder into the run directory. */
  files: string[];
  /** The files chosen for each template input, as the setup step would pass them. */
  values: Record<string, string[]>;
  verify: Chain['verify'];
}


/** Rows of a tab-separated table with a header line. */
function table(text: string): Array<Record<string, string>> {
  const [head, ...rows] = text.trim().split('\n');
  const names = head.split('\t');
  return rows.map((row) => Object.fromEntries(row.split('\t').map((value, i) => [names[i], value])));
}

/** The MultiQC modules that found something in a report folder. */
function multiqcModules(dir: string, folder: string): string[] {
  return [...new Set(table(read(dir, `${folder}/multiqc_report_data/multiqc_sources.txt`)).map((r) => r.Module))];
}

interface VcfCall {
  contig: string;
  pos: number;
  alt: string[];
}

function vcfCalls(text: string): VcfCall[] {
  return text
    .split('\n')
    .filter((l) => l && !l.startsWith('#'))
    .map((l) => {
      const f = l.split('\t');
      return { contig: f[0], pos: Number(f[1]), alt: f[4].split(',') };
    });
}

/** How many of the planted SNPs a VCF reports with the right alternative base. */
function plantedFound(text: string): number {
  const calls = vcfCalls(text);
  return truthSnps().filter((s) => calls.some((c) => c.contig === s.contig && c.pos === s.pos && c.alt.includes(s.alt))).length;
}

const ok = (tool: string, condition: boolean, message: string): Check => ({ tool, ok: condition, message });

/** The checks the two bcftools templates share: planted SNPs found, the filter, the stats, the report. */
function bcftoolsChecks(dir: string, extraModules: string[]): Check[] {
  const total = truthSnps().length;
  const all = read(dir, 'variants.vcf');
  const kept = vcfCalls(read(dir, 'filtered.vcf'));
  const stats = read(dir, 'variant_stats.txt');
  const statsSnps = Number(/number of SNPs:\t(\d+)/.exec(stats)?.[1]);
  const modules = multiqcModules(dir, 'multiqc');
  return [
    ok('bcftools-call', plantedFound(all) >= Math.ceil(total * 0.75), `${plantedFound(all)}/${total} planted SNPs called`),
    ok('bcftools-filter', plantedFound(read(dir, 'filtered.vcf')) >= Math.ceil(total * 0.75), 'the default filter keeps the planted SNPs'),
    ok('bcftools-stats', statsSnps > 0 && statsSnps <= vcfCalls(all).length, `bcftools stats counts ${statsSnps} SNPs in the filtered file (${kept.length} records)`),
    ok('multiqc', ['Bcftools', ...extraModules].every((m) => modules.includes(m)), `MultiQC read ${modules.join(', ')}`),
  ];
}

/** Template id -> how to run it on the synthetic data. */
export const SETUPS: Record<string, Setup> = {
  'basic-read-qc': {
    files: ['dna_se.fastq.gz'],
    values: { reads: ['dna_se.fastq.gz'] },
    verify: (dir) => {
      const report = read(dir, 'multiqc/multiqc_report.html');
      return [
        { tool: 'fastqc', ok: exists(dir, 'qc_raw/dna_se_fastqc.zip'), message: 'FastQC checked the raw reads' },
        { tool: 'fastp', ok: exists(dir, 'trimmed.fastq.gz'), message: 'fastp wrote the trimmed reads' },
        { tool: 'fastqc', ok: exists(dir, 'qc_trimmed/trimmed_fastqc.zip'), message: 'FastQC checked the trimmed reads' },
        { tool: 'multiqc', ok: report.includes('FastQC'), message: 'the combined report has the FastQC results' },
        { tool: 'multiqc', ok: report.includes('fastp'), message: 'the combined report has the fastp results' },
      ];
    },
  },
  'rnaseq-salmon': {
    files: ['rna_se.fastq.gz', 'transcripts.fa'],
    values: { reads: ['rna_se.fastq.gz'], transcripts: ['transcripts.fa'] },
    verify: (dir) => {
      const counts = table(read(dir, 'salmon_out/quant.sf')).map((r) => Number(r.NumReads));
      const trimmed = JSON.parse(read(dir, 'fastp.json')).summary.after_filtering.total_reads as number;
      const modules = multiqcModules(dir, 'multiqc');
      return [
        ok('fastp', exists(dir, 'trimmed.fastq.gz'), 'fastp wrote the trimmed reads'),
        ok('salmon-index', exists(dir, 'salmon_index/info.json'), 'the Salmon index was built from the transcripts'),
        ok('salmon-quant', counts.length === 3 && counts.every((n) => n > 350 && n < 650), `Salmon quantifies the three transcripts evenly (${counts.map((n) => n.toFixed(0)).join(' / ')})`),
        ok('salmon-quant', Math.abs(counts.reduce((a, b) => a + b, 0) - trimmed) < 0.05 * trimmed, `the estimated reads add up to the ${trimmed} reads fastp kept`),
        ok('multiqc', ['fastp', 'Salmon'].every((m) => modules.includes(m)), `MultiQC read fastp and Salmon (it read ${modules.join(', ')})`),
      ];
    },
  },
  'rnaseq-hisat2-counts': {
    files: ['rna_se.fastq.gz', 'ref.fa', 'genes.gtf'],
    values: { reads: ['rna_se.fastq.gz'], genome: ['ref.fa'], annotation: ['genes.gtf'] },
    verify: (dir) => {
      const rows = table(read(dir, 'counts.tsv').split('\n').filter((l) => !l.startsWith('#')).join('\n'));
      const perGene = rows.map((r) => Number(Object.values(r).at(-1)));
      const modules = multiqcModules(dir, 'multiqc');
      const trimmed = JSON.parse(read(dir, 'fastp.json')).summary.after_filtering.total_reads as number;
      const hisatReads = Number(read(dir, 'hisat2_summary.txt').match(/Total reads: (\d+)/)?.[1]);
      return [
        ok('hisat2-build', exists(dir, 'hisat2_index/genome.1.ht2'), 'the HISAT2 index was built from the genome'),
        ok('hisat2', hisatReads === trimmed && trimmed > 1000, `HISAT2 aligned the ${trimmed} reads fastp kept (${hisatReads})`),
        ok('samtools-index', exists(dir, 'sorted.bam.bai'), 'the sorted BAM has an index'),
        ok('featurecounts', rows.length === 3 && perGene.every((n) => n > 350 && n < 650), `featureCounts counts the three genes evenly (${perGene.join(' / ')})`),
        ok('multiqc', ['fastp', 'HISAT2', 'featureCounts'].every((m) => modules.includes(m)), `MultiQC read fastp, HISAT2 and featureCounts (it read ${modules.join(', ')})`),
      ];
    },
  },
  'variants-bcftools': {
    files: ['dna_se.fastq.gz', 'ref.fa'],
    values: { reads: ['dna_se.fastq.gz'], reference: ['ref.fa'] },
    verify: (dir) => [
      ok('bwa-index', exists(dir, 'bwa_index/reference.fa.bwt'), 'the BWA index was built from the reference'),
      ok('samtools-markdup', exists(dir, 'markdup.bam') && exists(dir, 'markdup.bam.bai'), 'the marked BAM and its index exist'),
      ...bcftoolsChecks(dir, ['fastp']),
    ],
  },
  'variants-bcftools-paired': {
    files: ['dna_R1.fastq.gz', 'dna_R2.fastq.gz', 'ref.fa'],
    values: { reads1: ['dna_R1.fastq.gz'], reads2: ['dna_R2.fastq.gz'], reference: ['ref.fa'] },
    verify: (dir) => {
      const flag = read(dir, 'flagstat.txt');
      const properly = Number(/(\d+) \+ 0 properly paired/.exec(flag)?.[1]);
      return [
        ok('bwa-mem', properly > 1000, `the read pairs align as pairs (${properly} reads properly paired)`),
        ok('samtools-markdup', exists(dir, 'markdup.bam') && exists(dir, 'markdup.bam.bai'), 'the marked BAM and its index exist'),
        ...bcftoolsChecks(dir, ['Samtools']),
      ];
    },
  },
  'variants-gatk': {
    files: ['dna_se.fastq.gz', 'ref.fa'],
    values: { reads: ['dna_se.fastq.gz'], reference: ['ref.fa'] },
    verify: (dir) => {
      const total = truthSnps().length;
      const vcf = read(dir, 'haplotypecaller.vcf');
      const metrics = read(dir, 'duplication_metrics.txt');
      const modules = multiqcModules(dir, 'multiqc');
      return [
        ok('gatk-createsequencedictionary', /^@SQ\tSN:chr1\tLN:3000/m.test(read(dir, 'gatk_reference/reference.dict')), 'the dictionary lists chr1'),
        ok('picard-markduplicates', metrics.includes('LIBRARY') && exists(dir, 'marked.bam.bai'), 'Picard marked the duplicates and the BAM is indexed'),
        ok('gatk-haplotypecaller', plantedFound(vcf) >= Math.ceil(total * 0.75), `${plantedFound(vcf)}/${total} planted SNPs called by HaplotypeCaller`),
        ok('multiqc', ['fastp', 'Picard', 'Bcftools'].every((m) => modules.includes(m)), `MultiQC read fastp, Picard and bcftools (it read ${modules.join(', ')})`),
      ];
    },
  },
};

function templateChain(id: string): Chain {
  const setup = SETUPS[id];
  const name = `template-${id}`;
  const build = (): BuiltChain => {
    const template = bundledTemplates().find((t) => t.id === id);
    if (!template) throw new Error(`no bundled template ${id}`);
    const made = instantiateTemplate(template, setup.values);
    if (made.ok === false) throw new Error(made.errors.join('; '));
    // The same switches every chain turns on: a declared output that is not what the tool writes fails the step.
    const nodes = made.nodes.map((n) => ({ ...n, data: { ...n.data, checkExists: true, checkNonEmpty: true } }));
    const issues = collectIssues(nodes, {}, made.edges);
    if (issues.length > 0) throw new Error(issues.map((i) => `${i.nodeLabel}: ${i.message}`).join('; '));
    const problems = validateCatalogNodes(nodes);
    if (problems.length > 0) throw new Error(problems.join('; '));
    const workflow = convertNodesToWorkflow(nodes, made.edges, {}, { name });
    const errors = validateWorkflow(workflow);
    if (errors.length > 0) throw new Error(errors.join('; '));
    const stepOf: Record<string, string> = {};
    const toolOf: Record<string, string> = {};
    for (const step of template.steps) {
      const node = nodes.find((n) => n.id === templateNodeId(step.key))!;
      const stepId = labelToId(node.data.label);
      stepOf[step.key] = stepId;
      toolOf[stepId] = step.tool;
    }
    return { workflow, stepOf, toolOf };
  };
  return { name, files: setup.files, nodes: [], edges: [], build, verify: setup.verify };
}

defineDomain({
  domain: 'templates',
  // The tools are covered by their own domains; this domain checks the templates built from them.
  covers: [],
  chains: Object.keys(SETUPS).map(templateChain),
});
