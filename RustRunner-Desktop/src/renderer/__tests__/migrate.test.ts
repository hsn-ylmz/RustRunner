import { describe, expect, it } from 'vitest';
import { migrateNodes, needsMigration, repairStarReadCommand } from '../tools/migrate';
import { CATALOG, buildCatalogNodeData, catalogToolName, findTool } from '../tools/catalog';
import { slotIssues, slotStates, slotYaml } from '../slots';
import { convertNodesToWorkflow, validateWorkflow } from '../workflowConversion';

/** A step as the version 1 catalog saved it. */
function v1(
  id: string,
  command: string,
  params: Record<string, unknown>,
  input: string,
  output: string,
  extra: Record<string, unknown> = {}
) {
  return {
    id: `n_${id}`,
    position: { x: 0, y: 0 },
    type: 'custom',
    data: <Record<string, any>>{
      label: id,
      // The v1 catalog set the node's tool to the conda package, as v2 does.
      tool: catalogToolName(findTool(id)!),
      command,
      input,
      output,
      threads: 4,
      color: 'sky',
      catalogId: id,
      catalogParams: params,
      ...extra,
    },
  };
}

const migrateOne = (node: ReturnType<typeof v1>) => migrateNodes([node]).nodes[0];

describe('which steps are migrated', () => {
  it('needs only catalog steps that are not on schema 2', () => {
    expect(needsMigration({ catalogId: 'fastqc' })).toBe(true);
    expect(needsMigration({ catalogId: 'fastqc', catalogSchema: 2 })).toBe(false);
    expect(needsMigration({ catalogId: 'removed-tool' })).toBe(false);
    expect(needsMigration({ tool: 'bash' })).toBe(false);
    expect(needsMigration(null)).toBe(false);
    expect(needsMigration(undefined)).toBe(false);
  });

  it('leaves free-form steps and steps of unknown tools exactly as they are', () => {
    const free = { id: 'a', position: { x: 1, y: 2 }, data: { label: 'Custom', tool: 'bash', command: 'echo' } };
    const gone = { id: 'b', position: { x: 1, y: 2 }, data: { label: 'Gone', catalogId: 'removed-tool', command: 'x' } };
    const result = migrateNodes([free, gone]);
    expect(result.migrated).toBe(0);
    expect(result.nodes[0]).toBe(free);
    expect(result.nodes[1]).toBe(gone);
  });

  it('is idempotent: a migrated step is not migrated again', () => {
    const once = migrateNodes([v1('samtools-sort', 'samtools sort', {}, 'aligned.sam', 'sorted.bam')]);
    expect(once.migrated).toBe(1);
    const twice = migrateNodes(once.nodes);
    expect(twice.migrated).toBe(0);
    expect(twice.nodes[0]).toBe(once.nodes[0]);
  });

  it('does not touch a step made by the current catalog', () => {
    const fresh = { id: 'n', position: { x: 0, y: 0 }, data: buildCatalogNodeData(findTool('fastqc')!, []) };
    expect(migrateNodes([fresh]).migrated).toBe(0);
  });

  it('keeps everything else about the step: name, colour, retries, checks, mock', () => {
    const node = v1('samtools-sort', 'samtools sort', {}, 'aligned.sam', 'sorted.bam', {
      label: 'My sort',
      color: 'rose',
      retries: 2,
      timeoutSecs: 60,
      mock: true,
      checkNonEmpty: true,
      wildcardName: 'lane',
    });
    const data = migrateOne(node).data;
    expect(data).toMatchObject({
      label: 'My sort',
      color: 'rose',
      retries: 2,
      timeoutSecs: 60,
      mock: true,
      checkNonEmpty: true,
      wildcardName: 'lane',
      threads: 4,
    });
  });
});

describe('each version 1 tool becomes a version 2 step with the same files', () => {
  it('fastqc: the reads become its input, the old folder option becomes the report folder', () => {
    const data = migrateOne(
      v1('fastqc', 'mkdir -p qc && fastqc -t 2 --outdir qc {input}', { outdir: 'qc' }, 'reads.fastq.gz', 'qc/reads_fastqc.html', {
        threads: 2,
      })
    ).data;
    expect(data).toMatchObject({
      catalogSchema: 2,
      command: 'fastqc -t 2 --outdir {report_dir} {reads}',
      input: '',
      output: '',
      slotFiles: { reads: 'reads.fastq.gz', report_dir: 'qc/' },
      catalogParams: {},
    });
  });

  it('fastqc: a folder typed without the slash gets one, a changed folder is kept', () => {
    const data = migrateOne(v1('fastqc', 'x', { outdir: 'reports/lane1' }, 'a.fq', 'reports/lane1/a_fastqc.html')).data;
    expect(data.slotFiles.report_dir).toBe('reports/lane1/');
  });

  it('multiqc: the files to combine and the report folder', () => {
    const data = migrateOne(
      v1('multiqc', 'multiqc', { outdir: 'multiqc', report_name: 'multiqc_report' }, 'qc/reads_fastqc.zip', 'multiqc/multiqc_report.html')
    ).data;
    expect(data.slotFiles).toMatchObject({ reports: 'qc/reads_fastqc.zip', report_dir: 'multiqc/' });
    expect(data.command).toBe('multiqc --force -o {report_dir} -n multiqc_report {reports}');
  });

  it('fastp: keeps its options and moves the report names to their slots', () => {
    const data = migrateOne(
      v1('fastp', 'fastp', { min_quality: 20, min_length: 30, html_report: 'r.html', json_report: 'r.json' }, 'raw.fastq.gz', 'clean.fastq.gz')
    ).data;
    expect(data.catalogParams).toEqual({ min_quality: 20, min_length: 30 });
    expect(data.slotFiles).toEqual({
      reads: 'raw.fastq.gz',
      trimmed: 'clean.fastq.gz',
      html_report: 'r.html',
      json_report: 'r.json',
    });
    expect(data.command).toContain('-q 20 -l 30 --html {html_report}');
  });

  it('cutadapt: input and output; its new report starts with its default name', () => {
    const data = migrateOne(
      v1('cutadapt', 'cutadapt', { adapter: 'AAAA', min_length: 25, quality_cutoff: 10 }, 'in.fq.gz', 'out.fq.gz')
    ).data;
    expect(data.slotFiles).toEqual({ trimmed: 'out.fq.gz', report: 'cutadapt.txt', reads: 'in.fq.gz' });
    expect(data.command).toContain('-a AAAA -m 25 -q 10 -o {trimmed} {reads} > {report}');
  });

  it('bwa mem: the reference option becomes the reference slot', () => {
    const data = migrateOne(
      v1('bwa-mem', 'bwa mem', { ref: 'genome.fa', mark_secondary: false, min_seed_length: 25 }, 'trimmed.fastq.gz', 'aln.sam')
    ).data;
    expect(data.slotFiles).toMatchObject({ ref: 'genome.fa', reads1: 'trimmed.fastq.gz', sam: 'aln.sam' });
    expect(data.slotFiles.reads2).toBeUndefined();
    // The migrated step is rebuilt from the current tool, so it gains the read group (default sample name).
    expect(data.catalogParams).toEqual({ mark_secondary: false, min_seed_length: 25, sample_name: 'sample' });
    expect(data.command).toBe(
      'sample=sample; bwa mem -t 4 -k 25 -R "@RG\\tID:$sample\\tSM:$sample" {ref} {reads1} {reads2} > {sam}'
    );
  });

  it('bwa mem: the comma-separated pair becomes the first and second read file', () => {
    const data = migrateOne(
      v1('bwa-mem', 'bwa mem', { ref: 'g.fa', mark_secondary: true, min_seed_length: 19 }, 'r1.fq.gz, r2.fq.gz', 'aln.sam')
    ).data;
    expect(data.slotFiles).toMatchObject({ reads1: 'r1.fq.gz', reads2: 'r2.fq.gz' });
  });

  it('bowtie2: index prefix and preset', () => {
    const data = migrateOne(v1('bowtie2', 'bowtie2', { index: 'idx/ref', preset: 'fast' }, 'reads.fq', 'aln.sam')).data;
    expect(data.slotFiles).toMatchObject({ index: 'idx/ref', reads: 'reads.fq', sam: 'aln.sam' });
    expect(data.command).toContain('bowtie2 -p 4 --fast -x {index} -X 500 "$@" -S {sam}');
    expect(data.command).toContain('set -- -U "{reads}"');
  });

  it('star: genome folder and output prefix become slots; the decompression option is dropped', () => {
    const data = migrateOne(
      v1(
        'star',
        'STAR --readFilesCommand zcat',
        { genome_dir: 'star_index', read_command: 'zcat', prefix: 'star/' },
        'rna.fastq.gz',
        'star/Aligned.sortedByCoord.out.bam',
        { threads: 8 }
      )
    ).data;
    expect(data.slotFiles).toEqual({ reads: 'rna.fastq.gz', index: 'star_index', out_dir: 'star/' });
    expect(data.catalogParams).toEqual({});
    expect(data.command).toContain('--readFilesCommand gzip -cdf');
    expect(data.command).not.toContain('zcat');
    expect(data.command).toContain('--runThreadN 8');
  });

  it('samtools sort, index, view and flagstat: their files go to their slots', () => {
    expect(migrateOne(v1('samtools-sort', 's', { by_name: true, memory_per_thread: '2G' }, 'a.sam', 's.bam')).data).toMatchObject({
      slotFiles: { alignments: 'a.sam', bam: 's.bam' },
      catalogParams: { by_name: true, memory_per_thread: '2G' },
      command: 'samtools sort -@ 4 -n -m 2G -o {bam} {alignments}',
    });
    expect(migrateOne(v1('samtools-index', 'i', {}, 's.bam', 's.bam.bai')).data.slotFiles).toEqual({
      bam: 's.bam',
      bai: 's.bam.bai',
    });
    expect(migrateOne(v1('samtools-view', 'v', { min_mapq: 30, mapped_only: true }, 's.bam', 'f.bam')).data.slotFiles).toEqual({
      alignments: 's.bam',
      filtered: 'f.bam',
    });
    expect(migrateOne(v1('samtools-flagstat', 'f', {}, 's.bam', 'flag.txt')).data.slotFiles).toEqual({
      alignments: 's.bam',
      report: 'flag.txt',
    });
  });

  it('bcftools call: reference, alignments and the variants file', () => {
    const data = migrateOne(v1('bcftools-call', 'x', { ref: 'g.fa', min_mapq: 25 }, 's.bam', 'v.vcf')).data;
    expect(data.slotFiles).toEqual({ ref: 'g.fa', bam: 's.bam', vcf: 'v.vcf' });
    expect(data.command).toContain('-f {ref} -q 25 {bam}');
  });

  it('salmon quant: index, reads and the result folder', () => {
    const data = migrateOne(
      v1('salmon-quant', 'x', { index: 'salmon_idx', libtype: 'U', outdir: 'quant_u' }, 'rna.fq.gz', 'quant_u/quant.sf')
    ).data;
    expect(data.slotFiles).toEqual({ index: 'salmon_idx', out_dir: 'quant_u/', reads: 'rna.fq.gz' });
    expect(data.command).toContain('-l U ');
    // The abundance table follows the folder.
    const node = { id: 'n', data };
    expect(slotStates(node, [node], []).find((s) => s.def.id === 'quant')!.files).toEqual(['quant_u/quant.sf']);
  });

  it('featureCounts: alignments, annotation, counts table, paired option', () => {
    const data = migrateOne(
      v1('featurecounts', 'x', { annotation: 'genes.gtf', feature_type: 'gene', attribute: 'gene_name', paired: true }, 's.bam', 'c.tsv')
    ).data;
    expect(data.slotFiles).toEqual({ bams: 's.bam', annotation: 'genes.gtf', counts: 'c.tsv' });
    expect(data.command).toContain('-t gene -g gene_name -p --countReadPairs -o {counts} {bams}');
  });

  it('a v1 input with several files fills the multiple-file slot', () => {
    const data = migrateOne(v1('featurecounts', 'x', { annotation: 'g.gtf' }, 'a.bam, b.bam', 'c.tsv')).data;
    expect(data.slotFiles.bams).toBe('a.bam, b.bam');
  });

  it('every one of the 14 version 1 tools is covered', () => {
    const v1Ids = [
      'fastqc',
      'multiqc',
      'fastp',
      'cutadapt',
      'bwa-mem',
      'bowtie2',
      'star',
      'samtools-sort',
      'samtools-index',
      'samtools-view',
      'samtools-flagstat',
      'bcftools-call',
      'salmon-quant',
      'featurecounts',
    ];
    for (const id of v1Ids) {
      const tool = findTool(id)!;
      const node = v1(id, 'old', {}, 'in.file', 'out.file');
      const data = migrateOne(node).data;
      expect(data.catalogSchema, id).toBe(2);
      // Everything a run needs is either typed or has a default; a fresh migration never leaves an engine gap other than the inputs the old step had none for.
      expect(data.command, id).not.toContain('{input}');
      expect(data.command, id).not.toContain('{output}');
      for (const out of tool.outputs) {
        if (!out.derived) expect(data.slotFiles[out.name], `${id}.${out.name}`).toBeTruthy();
      }
    }
  });
});

describe('what the migrated step does at run time', () => {
  it('converts to a valid workflow whose files match what the old step named', () => {
    const nodes = migrateNodes([
      v1('fastp', 'x', { min_quality: 15, min_length: 15, html_report: 'fastp.html', json_report: 'fastp.json' }, 'raw.fastq.gz', 'trimmed.fastq.gz'),
      v1('bwa-mem', 'x', { ref: 'ref.fa', mark_secondary: true, min_seed_length: 19 }, 'trimmed.fastq.gz', 'aligned.sam'),
      v1('samtools-sort', 'x', { by_name: false, memory_per_thread: '768M' }, 'aligned.sam', 'sorted.bam'),
    ]).nodes;
    const edges = [
      { id: 'e1', source: 'n_fastp', target: 'n_bwa-mem' },
      { id: 'e2', source: 'n_bwa-mem', target: 'n_samtools-sort' },
    ];
    const workflow = convertNodesToWorkflow(nodes, edges, {}, {});
    expect(validateWorkflow(workflow)).toEqual([]);
    const [fastp, bwa, sort] = workflow.steps;
    expect(fastp.named_inputs).toEqual({ reads: ['raw.fastq.gz'] });
    expect(fastp.named_outputs).toEqual({
      trimmed: ['trimmed.fastq.gz'],
      html_report: ['fastp.html'],
      json_report: ['fastp.json'],
    });
    expect(bwa.named_inputs).toEqual({ ref: ['ref.fa'], reads1: ['trimmed.fastq.gz'], reads2: [] });
    expect(bwa.optional_slots).toEqual(['reads2']);
    expect(sort.named_inputs).toEqual({ alignments: ['aligned.sam'] });
    expect(sort.named_outputs).toEqual({ bam: ['sorted.bam'] });
    expect(sort.install).toMatchObject({ kind: 'conda', package: 'samtools', version: '1.24' });
  });

  it('has no gap left when the old step was filled in', () => {
    const node = migrateOne(
      v1('bwa-mem', 'x', { ref: 'ref.fa', mark_secondary: true, min_seed_length: 19 }, 'a.fq.gz', 'aligned.sam')
    );
    expect(slotIssues(node, [node], [])).toEqual([]);
  });

  it('flags the reference when the old step never had one, so Run says what to fill in', () => {
    const node = migrateOne(v1('bwa-mem', 'x', { ref: '', mark_secondary: true, min_seed_length: 19 }, 'a.fq.gz', 'aligned.sam'));
    expect(slotIssues(node, [node], []).map((i) => i.slot)).toEqual(['ref']);
  });

  it('writes the same YAML for a migrated step as for a freshly made one with the same files', () => {
    const migrated = migrateOne(v1('samtools-flagstat', 'x', {}, 'sorted.bam', 'flagstat.txt'));
    const fresh = {
      id: migrated.id,
      position: { x: 0, y: 0 },
      data: {
        ...buildCatalogNodeData(findTool('samtools-flagstat')!, []),
        label: 'samtools-flagstat',
        threads: 4,
        color: 'sky',
        slotFiles: { alignments: 'sorted.bam', report: 'flagstat.txt' },
        command: migrated.data.command,
      },
    };
    expect(slotYaml(migrated, [migrated], [])).toEqual(slotYaml(fresh, [fresh], []));
    expect(convertNodesToWorkflow([migrated], [], {}, {}).steps[0]).toEqual(
      convertNodesToWorkflow([fresh], [], {}, {}).steps[0]
    );
  });
});

describe('a command that was edited by hand', () => {
  it('keeps the command, the Input and the Output as the person left them', () => {
    const node = v1(
      'samtools-sort',
      'samtools sort -T /scratch -o {output} {input}',
      { by_name: false, memory_per_thread: '768M' },
      'aligned.sam',
      'sorted.bam',
      { catalogCommandCustom: true }
    );
    const data = migrateOne(node).data;
    expect(data).toMatchObject({
      command: 'samtools sort -T /scratch -o {output} {input}',
      input: 'aligned.sam',
      output: 'sorted.bam',
      catalogCommandCustom: true,
      catalogSchema: 2,
    });
    expect(data.slotFiles).toBeUndefined();
  });

  it('still runs: {input} and {output} are filled from the step, with the pinned install', () => {
    const node = migrateOne(
      v1('samtools-sort', 'samtools sort -o {output} {input}', {}, 'aligned.sam', 'sorted.bam', { catalogCommandCustom: true })
    );
    const step = convertNodesToWorkflow([node], [], {}, {}).steps[0];
    expect(step.command).toBe('samtools sort -o {output} {input}');
    expect(step.input).toEqual(['aligned.sam']);
    expect(step.output).toEqual(['sorted.bam']);
    expect(step.install.version).toBe('1.24');
  });

  it('repairs the old STAR zcat decompression in a hand-edited command', () => {
    const node = v1(
      'star',
      'STAR --runThreadN 8 --genomeDir idx --readFilesIn {input} --readFilesCommand zcat --outSAMtype BAM Unsorted',
      { genome_dir: 'idx', read_command: 'zcat', prefix: 'star/' },
      'r.fq.gz',
      'star/Aligned.out.bam',
      { catalogCommandCustom: true }
    );
    const data = migrateOne(node).data;
    expect(data.command).toBe(
      'STAR --runThreadN 8 --genomeDir idx --readFilesIn {input} --readFilesCommand gzip -cdf --outSAMtype BAM Unsorted'
    );
    expect(data.input).toBe('r.fq.gz');
  });
});

describe('repairStarReadCommand', () => {
  it('replaces zcat and nothing else', () => {
    expect(repairStarReadCommand('STAR --readFilesCommand zcat --x')).toBe('STAR --readFilesCommand gzip -cdf --x');
    expect(repairStarReadCommand('STAR --readFilesCommand   zcat')).toBe('STAR --readFilesCommand gzip -cdf');
    expect(repairStarReadCommand('STAR --readFilesCommand cat')).toBe('STAR --readFilesCommand cat');
    expect(repairStarReadCommand('STAR --readFilesCommand zcatalog')).toBe('STAR --readFilesCommand zcatalog');
    expect(repairStarReadCommand('zcat file.gz | wc -l')).toBe('zcat file.gz | wc -l');
  });
});

describe('check targets', () => {
  it('points a check at all outputs when its file is not an output of the migrated step', () => {
    const node = v1('fastqc', 'x', { outdir: 'qc' }, 'a.fq', 'qc/a_fastqc.html', {
      checkExists: true,
      checkExistsTarget: 'qc/a_fastqc.html',
    });
    const data = migrateOne(node).data;
    expect(data.checkExists).toBe(true);
    expect(data.checkExistsTarget).toBeUndefined();
  });

  it('keeps a check target that is still one of the outputs', () => {
    const node = v1('samtools-sort', 'x', {}, 'a.sam', 'sorted.bam', { checkNonEmpty: true, checkNonEmptyTarget: 'sorted.bam' });
    expect(migrateOne(node).data.checkNonEmptyTarget).toBe('sorted.bam');
  });
});

describe('the catalog the migration targets', () => {
  it('has a plan for every tool that existed in version 1', () => {
    // Guard against renaming a v1 tool id without a migration plan.
    for (const id of ['fastqc', 'multiqc', 'fastp', 'cutadapt', 'bwa-mem', 'bowtie2', 'star', 'samtools-sort', 'samtools-index', 'samtools-view', 'samtools-flagstat', 'bcftools-call', 'salmon-quant', 'featurecounts']) {
      expect(findTool(id, CATALOG), id).toBeDefined();
    }
  });
});
