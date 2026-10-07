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
import { defineDomain, exists, read, type BuiltChain, type Chain } from '../harness';
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
