import fs from 'fs';
import path from 'path';
import type { Page } from '@playwright/test';
import { test, expect, connect, nodes, openSection, openStepStatus, selectNode, stepRow } from './fixtures';

/** Opens the palette, searches and adds the tool with `id`. */
async function addFromPalette(page: Page, query: string, id: string): Promise<void> {
  const before = await nodes(page).count();
  await page.getByTestId('open-palette').click();
  await expect(page.getByTestId('tool-palette')).toBeVisible();
  await page.getByTestId('palette-search').fill(query);
  await page.getByTestId(`palette-item-${id}`).click();
  // The palette closes so it never covers the canvas.
  await expect(page.getByTestId('tool-palette')).toHaveCount(0);
  await expect(nodes(page)).toHaveCount(before + 1);
}

test('adding fastqc from the palette gives a prefilled node', async ({ page, consoleErrors }) => {
  await addFromPalette(page, 'fastq', 'fastqc');

  // The new node is selected, so its properties are showing already. The
  // command is a catalog step's advanced detail, folded until asked for.
  await expect(page.getByTestId('prop-label')).toHaveValue('FastQC');
  await expect(page.getByTestId('prop-command')).toHaveCount(0);
  await openSection(page, 'advanced');
  await expect(page.getByTestId('prop-tool')).toHaveValue('fastqc');
  await expect(page.getByTestId('prop-command')).toHaveValue(
    'fastqc -t 2 --outdir {report_dir} {reads}'
  );
  await expect(page.getByTestId('prop-threads')).toHaveValue('2');
  // Every file is a named field; the single Input and Output fields are not shown.
  await expect(page.getByTestId('prop-input')).toHaveCount(0);
  await expect(page.getByTestId('prop-output')).toHaveCount(0);
  await expect(page.getByTestId('prop-slot-reads')).toHaveValue('');
  await expect(page.getByTestId('prop-slot-reads')).toHaveAttribute('placeholder', 'e.g. reads.fastq.gz');
  await expect(page.getByTestId('prop-slot-report_dir')).toHaveValue('qc/');
  // Where the tool comes from, and its manual.
  await expect(page.getByTestId('catalog-types')).toContainText('fastqc 0.13.0');
  await expect(page.getByTestId('catalog-docs')).toBeVisible();
  await expect(nodes(page).first()).toContainText('fastqc');
  await expect(page.locator('.dirty-marker')).toBeVisible();
  expect(consoleErrors).toEqual([]);
});

test('the palette searches by name and category, and closes with Escape', async ({ page }) => {
  await page.getByTestId('open-palette').click();
  const items = page.locator('[data-testid^="palette-item-"]');
  const all = await items.count();
  expect(all).toBeGreaterThanOrEqual(57);

  await page.getByTestId('palette-search').fill('BWA');
  await expect(items).toHaveCount(2);
  await expect(page.getByTestId('palette-item-bwa-index')).toBeVisible();
  await expect(page.getByTestId('palette-item-bwa-mem')).toBeVisible();
  // Every word has to match: only the index builder is in "Aligner indexes".
  await page.getByTestId('palette-search').fill('BWA indexes');
  await expect(items).toHaveCount(1);
  await expect(page.getByTestId('palette-item-bwa-index')).toBeVisible();

  await page.getByTestId('palette-search').fill('alignment');
  await expect(page.getByTestId('palette-item-bowtie2')).toBeVisible();
  await expect(page.getByTestId('palette-item-fastqc')).toHaveCount(0);

  await page.getByTestId('palette-search').fill('');
  await page.getByTestId('palette-category').selectOption('processing');
  await expect(page.getByTestId('palette-item-samtools-sort')).toBeVisible();
  await expect(page.getByTestId('palette-item-star')).toHaveCount(0);

  await page.getByTestId('palette-search').fill('nothing like this');
  await expect(items).toHaveCount(0);
  await expect(page.getByTestId('palette-list')).toContainText('No catalog tool matches');

  await page.getByTestId('palette-search').press('Escape');
  await expect(page.getByTestId('tool-palette')).toHaveCount(0);
  // Nothing was added by browsing.
  await expect(nodes(page)).toHaveCount(0);
});

test('editing options re-renders the command until it is edited by hand', async ({ page }) => {
  await addFromPalette(page, 'sort', 'samtools-sort');
  await openSection(page, 'advanced');
  const command = page.getByTestId('prop-command');
  await expect(command).toHaveValue('samtools sort -@ 4 -m 768M -o {bam} {alignments}');

  await page.getByTestId('catalog-param-by_name').check();
  await expect(command).toHaveValue('samtools sort -@ 4 -n -m 768M -o {bam} {alignments}');
  await page.getByTestId('catalog-param-memory_per_thread').fill('2G');
  await expect(command).toHaveValue('samtools sort -@ 4 -n -m 2G -o {bam} {alignments}');
  await page.getByTestId('prop-threads').fill('8');
  await expect(command).toHaveValue('samtools sort -@ 8 -n -m 2G -o {bam} {alignments}');

  // Typing in the command takes over: options stop rewriting it.
  await command.fill('samtools sort -T /tmp/x -o {bam} {alignments}');
  await expect(page.getByTestId('catalog-custom-note')).toBeVisible();
  await page.getByTestId('catalog-param-by_name').uncheck();
  await expect(command).toHaveValue('samtools sort -T /tmp/x -o {bam} {alignments}');

  await page.getByTestId('catalog-regenerate').click();
  await expect(command).toHaveValue('samtools sort -@ 8 -m 2G -o {bam} {alignments}');
  await expect(page.getByTestId('catalog-custom-note')).toHaveCount(0);

  // Options survive selecting another node and coming back.
  await page.getByTestId('add-node').click();
  await selectNode(page, 'Node 2');
  await expect(page.getByTestId('catalog-params')).toHaveCount(0);
  await selectNode(page, 'samtools sort');
  await expect(page.getByTestId('catalog-param-memory_per_thread')).toHaveValue('2G');
  await expect(page.getByTestId('prop-threads')).toHaveValue('8');
});

test('a required option is flagged until it is filled in, and a free-form node stays possible', async ({
  page,
}) => {
  await addFromPalette(page, 'cutadapt', 'cutadapt');
  await openSection(page, 'advanced');
  await expect(page.getByTestId('prop-command')).toHaveValue(
    'cutadapt -j 4 -a AGATCGGAAGAGC -m 20 -q 20 -o {trimmed} {reads} > {report}'
  );
  await expect(page.getByTestId('catalog-missing')).toHaveCount(0);

  await page.getByTestId('catalog-param-adapter').fill('');
  await expect(page.getByTestId('prop-command')).toHaveValue(
    'cutadapt -j 4 -a {adapter} -m 20 -q 20 -o {trimmed} {reads} > {report}'
  );
  await expect(page.getByTestId('catalog-missing')).toContainText("3' adapter sequence");

  await page.getByTestId('catalog-param-adapter').fill('CTGTCTCTTATA');
  await expect(page.getByTestId('prop-command')).toHaveValue(
    'cutadapt -j 4 -a CTGTCTCTTATA -m 20 -q 20 -o {trimmed} {reads} > {report}'
  );
  await expect(page.getByTestId('catalog-missing')).toHaveCount(0);

  // Changing the tool detaches the node from the catalog; its command is kept.
  await page.getByTestId('prop-tool').fill('bash');
  await expect(page.getByTestId('catalog-params')).toHaveCount(0);
  await expect(page.getByTestId('prop-command')).toHaveValue(
    'cutadapt -j 4 -a CTGTCTCTTATA -m 20 -q 20 -o {trimmed} {reads} > {report}'
  );

  // The plain button still adds an empty custom node.
  await page.getByTestId('add-node').click();
  await expect(nodes(page)).toHaveCount(2);
  await selectNode(page, 'Node 2');
  await expect(page.getByTestId('prop-tool')).toHaveValue('');
  await expect(page.getByTestId('catalog-params')).toHaveCount(0);
});

/** The RGB channels of an edge's stroke colour. */
async function strokeOf(page: Page, edge: ReturnType<Page['locator']>): Promise<number[]> {
  const color = await edge
    .locator('.react-flow__edge-path')
    .first()
    .evaluate((el) => getComputedStyle(el).stroke);
  return (color.match(/\d+/g) ?? []).slice(0, 3).map(Number);
}

/** The computed dash pattern of an edge's stroke ("none" when solid). */
async function dashOf(edge: ReturnType<Page['locator']>): Promise<string> {
  return edge
    .locator('.react-flow__edge-path')
    .first()
    .evaluate((el) => getComputedStyle(el).strokeDasharray);
}

test('connecting bwa to samtools sort shows a green edge; a mismatch is orange', async ({ page }) => {
  await addFromPalette(page, 'bwa', 'bwa-mem');
  await addFromPalette(page, 'sort', 'samtools-sort');
  await addFromPalette(page, 'fastqc', 'fastqc');
  await page.getByTestId('add-node').click();
  await expect(nodes(page)).toHaveCount(4);

  // sam (from BWA MEM) is accepted by samtools sort: green.
  await connect(page, 'BWA MEM', 'samtools sort');
  const green = page.locator('[data-testid="typed-edge"][data-type-match="match"]');
  await expect(green).toHaveCount(1);
  const [r, g, b] = await strokeOf(page, green);
  expect(g).toBeGreaterThan(r);
  expect(g).toBeGreaterThan(b);
  await expect(green.locator('title')).toHaveText(/Types match: BWA MEM makes sam/);
  // Not colour alone: a matching edge is solid and carries a check mark.
  expect(await dashOf(green)).toBe('none');
  await expect(green.getByTestId('typed-edge-label')).toHaveText('✓');

  // FastQC makes html and zip; samtools sort wants sam or bam: orange, still connected.
  await connect(page, 'FastQC', 'samtools sort');
  const orange = page.locator('[data-testid="typed-edge"][data-type-match="mismatch"]');
  await expect(orange).toHaveCount(1);
  const [r2, g2, b2] = await strokeOf(page, orange);
  expect(r2).toBeGreaterThan(g2);
  expect(g2).toBeGreaterThan(b2);
  await expect(orange.locator('title')).toHaveText(/Types differ: FastQC makes html, zip/);
  // Not colour alone: a mismatched edge is dashed and says so on the edge.
  expect(await dashOf(orange)).not.toBe('none');
  // The label says what differs, not just that something does.
  await expect(orange.getByTestId('typed-edge-label')).toContainText(/needs .+, gets .+/);

  // A custom node has no types: its edge stays neutral.
  await connect(page, 'samtools sort', 'Node 4');
  const neutral = page.locator('[data-testid="typed-edge"][data-type-match="unknown"]');
  await expect(neutral).toHaveCount(1);
  // No verdict, no marker.
  await expect(neutral.getByTestId('typed-edge-label')).toHaveCount(0);
  await expect(page.locator('.react-flow__edge')).toHaveCount(3);
  await expect(green).toHaveCount(1);
});

test('a tool with a reference and optional reads shows each file as a field and says what is missing', async ({
  page,
}) => {
  await addFromPalette(page, 'bwa', 'bwa-mem');

  // Three input files and one output, each its own labelled field; the second reads file is optional.
  await expect(page.getByTestId('prop-slot-ref-row')).toBeVisible();
  await expect(page.getByTestId('prop-slot-reads1-row')).toBeVisible();
  await expect(page.getByTestId('prop-slot-reads2-row')).toContainText('optional');
  await expect(page.getByTestId('prop-slot-sam')).toHaveValue('aligned.sam');
  await expect(page.getByTestId('prop-input')).toHaveCount(0);

  // Run says why it cannot start: the reference and the first reads file are missing.
  await expect(page.getByTestId('run')).toHaveAttribute('aria-disabled', 'true');
  // "What will run" (in Advanced) marks the parts that have no file yet.
  await openSection(page, 'advanced');
  await expect(page.getByTestId('command-preview-missing')).toContainText('{ref}');

  await page.getByTestId('prop-slot-ref').fill('genome/hg38.fa');
  await page.getByTestId('prop-slot-reads1').fill('reads_R1.fastq.gz');
  // Nothing is missing any more, although the second reads file is empty.
  await expect(page.getByTestId('command-preview-missing')).toHaveCount(0);
  await expect(page.getByTestId('command-preview')).toContainText(
    'bwa mem -t 4 -M -k 19 genome/hg38.fa reads_R1.fastq.gz  > aligned.sam'
  );
  await expect(page.getByTestId('run')).not.toHaveAttribute('aria-disabled', 'true');
});

test('a folder output has a derived file that follows it, and is offered to the next step', async ({ page }) => {
  await addFromPalette(page, 'star', 'star');
  await expect(page.getByTestId('prop-slot-out_dir')).toHaveValue('star/');
  // The BAM has no field to type in: it is the folder plus its fixed name.
  await expect(page.getByTestId('prop-slot-bam')).toHaveText('star/Aligned.sortedByCoord.out.bam');
  await page.getByTestId('prop-slot-out_dir').fill('results/lane1/');
  await expect(page.getByTestId('prop-slot-bam')).toHaveText('results/lane1/Aligned.sortedByCoord.out.bam');

  // Connecting featureCounts picks the BAM, not the folder, without asking.
  await addFromPalette(page, 'featurecounts', 'featurecounts');
  await connect(page, 'STAR', 'featureCounts');
  await selectNode(page, 'featureCounts');
  await expect(page.getByTestId('binding-prompt')).toHaveCount(0);
  await expect(page.getByTestId('prop-slot-bams-from-badge')).toContainText('from STAR');
  await expect(page.getByTestId('prop-slot-bams')).toHaveText('results/lane1/Aligned.sortedByCoord.out.bam');
});

test('an index builder hands its indexed copy of the genome to the aligner without asking', async ({ page }) => {
  await addFromPalette(page, 'bwa', 'bwa-index');
  await expect(page.getByTestId('prop-slot-index_dir')).toHaveValue('bwa_index/');
  // The FASTA copy has no field: it is the folder plus its fixed name.
  await expect(page.getByTestId('prop-slot-indexed_ref')).toHaveText('bwa_index/reference.fa');

  await addFromPalette(page, 'bwa', 'bwa-mem');
  await connect(page, 'BWA index', 'BWA MEM');
  await selectNode(page, 'BWA MEM');
  await expect(page.getByTestId('binding-prompt')).toHaveCount(0);
  await expect(page.getByTestId('prop-slot-ref-from-badge')).toContainText('from BWA index');
  await expect(page.getByTestId('prop-slot-ref')).toHaveText('bwa_index/reference.fa');
});

test('a variant caller offers fractions with a fine step and builds its command from the form', async ({ page }) => {
  await addFromPalette(page, 'freebayes', 'freebayes');
  const fraction = page.getByTestId('catalog-param-min_alt_fraction');
  await expect(fraction).toHaveAttribute('step', '0.01');
  await expect(fraction).toHaveValue('0.05');
  await fraction.fill('0.1');
  await page.getByTestId('catalog-param-ploidy').fill('1');
  await openSection(page, 'advanced');
  await expect(page.getByTestId('prop-command')).toHaveValue(
    'freebayes -f {ref} --ploidy 1 --min-alternate-fraction 0.1 --min-alternate-count 2 --min-mapping-quality 1 --min-base-quality 0 {bams} > {vcf}'
  );
  // Several BAM files can feed it.
  await expect(page.getByTestId('prop-slot-bams-row')).toBeVisible();
});

test('a choice shows plain labels and puts the flag it stands for into the command', async ({ page }) => {
  await addFromPalette(page, 'stringtie assemble', 'stringtie-assemble');
  const strand = page.getByTestId('catalog-param-strand');
  // The values are flags; the person reads what each means.
  await expect(strand.locator('option')).toHaveText([
    'Unstranded (read direction does not matter)',
    'Reverse-stranded (dUTP kits: read 1 is the opposite strand)',
    'Forward-stranded (read 1 is the transcript strand)',
  ]);
  await expect(strand).toHaveValue('');
  await openSection(page, 'advanced');
  await expect(page.getByTestId('prop-command')).not.toHaveValue(/--rf/);
  await strand.selectOption({ label: 'Reverse-stranded (dUTP kits: read 1 is the opposite strand)' });
  await expect(page.getByTestId('prop-command')).toHaveValue(/-f 0\.01 --rf \$\{G:\+/);
  // The guide annotation is optional: the step can run on the alignments alone.
  await expect(page.getByTestId('prop-slot-annotation-row')).toContainText('optional');
});

test('transcript sequences from gffread go straight into an index builder, and the index into the quantifier', async ({
  page,
}) => {
  await addFromPalette(page, 'gffread', 'gffread');
  await addFromPalette(page, 'kallisto index', 'kallisto-index');
  await addFromPalette(page, 'kallisto quant', 'kallisto-quant');
  await connect(page, 'gffread transcripts', 'kallisto index');
  await connect(page, 'kallisto index', 'kallisto quant');
  await selectNode(page, 'kallisto index');
  await expect(page.getByTestId('binding-prompt')).toHaveCount(0);
  await expect(page.getByTestId('prop-slot-transcripts')).toHaveText('transcripts.fa');
  await selectNode(page, 'kallisto quant');
  await expect(page.getByTestId('binding-prompt')).toHaveCount(0);
  await expect(page.getByTestId('prop-slot-index')).toHaveText('kallisto.idx');
  await expect(page.getByTestId('prop-slot-reads2-row')).toContainText('optional');
});

test('a peak caller takes the ChIP, then the input as its control, and a peak annotator says nothing is downloaded', async ({
  page,
}) => {
  await addFromPalette(page, 'samtools sort', 'samtools-sort');
  await addFromPalette(page, 'samtools sort', 'samtools-sort');
  await addFromPalette(page, 'macs3', 'macs3-callpeak');
  await connect(page, 'samtools sort', 'MACS3 callpeak');
  await connect(page, 'samtools sort 2', 'MACS3 callpeak');
  await selectNode(page, 'MACS3 callpeak');
  // Nobody is asked: the first BAM is the ChIP, the second the control.
  await expect(page.getByTestId('binding-prompt')).toHaveCount(0);
  await expect(page.getByTestId('prop-slot-treatment')).toHaveText('sorted.bam');
  await expect(page.getByTestId('prop-slot-control')).toHaveText('sorted.bam');
  await expect(page.getByTestId('catalog-param-format').locator('option')).toHaveText(['Paired-end reads', 'Single-end reads']);
  await expect(page.getByTestId('catalog-types')).toContainText('macs3 3.0.5');
  // The peaks, their summits and the signal track are files the next step can take.
  await expect(page.getByTestId('prop-slot-peaks')).toContainText('sample_peaks.narrowPeak');

  await addFromPalette(page, 'homer', 'homer-annotatepeaks');
  await expect(page.getByTestId('catalog-needs-database')).toContainText('nothing is downloaded');
  await expect(page.getByTestId('catalog-needs-database')).toContainText('Genome FASTA and gene annotation');
  await expect(page.getByTestId('prop-slot-genome-row')).not.toContainText('optional');
});

test('MultiQC follows several steps at once, and asks which of a step\'s files to use', async ({ page }) => {
  await addFromPalette(page, 'fastqc', 'fastqc');
  await addFromPalette(page, 'cutadapt', 'cutadapt');
  await addFromPalette(page, 'multiqc', 'multiqc');

  // FastQC makes one thing (its report folder): bound without a question.
  await connect(page, 'FastQC', 'MultiQC');
  await selectNode(page, 'MultiQC');
  await expect(page.getByTestId('binding-prompt')).toHaveCount(0);
  await expect(page.getByTestId('prop-slot-reports')).toHaveText('qc/');

  // Cutadapt makes reads and a report: the person chooses, and both stay linked.
  await connect(page, 'Cutadapt', 'MultiQC');
  await selectNode(page, 'MultiQC');
  await expect(page.getByTestId('binding-prompt')).toBeVisible();
  await page.getByTestId('binding-option-reports-report').click();
  await expect(page.getByTestId('binding-prompt')).toHaveCount(0);
  await expect(page.getByTestId('prop-slot-reports')).toHaveText('qc/');
  await expect(page.getByTestId('prop-slot-reports-2')).toHaveText('cutadapt.txt');
  await expect(page.getByTestId('prop-slot-reports-from-badge')).toContainText('from FastQC');
  await expect(page.getByTestId('prop-slot-reports-from-badge-2')).toContainText('from Cutadapt');

  // Letting go of one keeps the other.
  await page.getByTestId('prop-slot-reports-unlink-2').click();
  await expect(page.getByTestId('prop-slot-reports-from-badge-2')).toHaveCount(0);
  await expect(page.getByTestId('prop-slot-reports-from-badge')).toContainText('from FastQC');
  await expect(page.getByTestId('prop-slot-reports-typed')).toHaveValue('cutadapt.txt');
});

test('a catalog step runs through the real engine with its install block (mocked, so nothing is installed)', async ({
  page,
  sandbox,
}) => {
  await addFromPalette(page, 'sort', 'samtools-sort');
  await page.getByTestId('set-directory').click();
  await expect(page.locator('.working-directory')).toContainText('Folder: work');
  await page.getByTestId('prop-slot-alignments').fill('in.sam');
  await openSection(page, 'advanced');
  await page.getByTestId('prop-mock').check();
  await page.getByTestId('run').click();
  await openStepStatus(page);
  await expect(stepRow(page, 'samtools_sort')).toHaveAttribute('data-state', 'succeeded');
  // The mocked step made its named output.
  expect(fs.existsSync(path.join(sandbox.workDir, 'sorted.bam'))).toBe(true);
});

test('opening a workflow saved with the version 1 catalog updates its steps', async ({ page, app, sandbox }) => {
  const v1Node = (id: string, label: string, catalogId: string, data: Record<string, unknown>, x: number) => ({
    id,
    type: 'custom',
    position: { x, y: 100 },
    data: { label, threads: 4, color: 'sky', catalogId, ...data },
  });
  const file = path.join(sandbox.workDir, 'old-workflow.json');
  fs.writeFileSync(
    file,
    JSON.stringify({
      nodes: [
        v1Node('n1', 'Align', 'bwa-mem', {
          tool: 'bwa',
          command: 'bwa mem -t 4 -M -k 19 genome.fa {input} > {output}',
          input: 'reads_R1.fastq.gz, reads_R2.fastq.gz',
          output: 'aligned.sam',
          catalogParams: { ref: 'genome.fa', mark_secondary: true, min_seed_length: 19 },
        }, 100),
        v1Node('n2', 'Sort', 'samtools-sort', {
          tool: 'samtools',
          command: 'samtools sort -@ 4 -m 768M -o {output} {input}',
          input: 'aligned.sam',
          output: 'sorted.bam',
          catalogParams: { by_name: false, memory_per_thread: '768M' },
        }, 400),
      ],
      edges: [{ id: 'e1', source: 'n1', target: 'n2' }],
      wildcardFiles: {},
      metadata: { name: 'Old workflow' },
    })
  );
  await app.evaluate(({ dialog }, target) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [target] })) as any;
  }, file);

  await page.getByRole('button', { name: 'Open', exact: true }).click();
  await expect(nodes(page)).toHaveCount(2);
  await expect(page.getByTestId('toast').first()).toContainText('2 steps were updated to the new tool catalog');

  // The files the old steps named are now in their fields, and the command is the new one.
  await selectNode(page, 'Align');
  await expect(page.getByTestId('prop-slot-ref')).toHaveValue('genome.fa');
  await expect(page.getByTestId('prop-slot-reads1')).toHaveValue('reads_R1.fastq.gz');
  await expect(page.getByTestId('prop-slot-reads2')).toHaveValue('reads_R2.fastq.gz');
  await expect(page.getByTestId('prop-slot-sam')).toHaveValue('aligned.sam');
  await expect(page.getByTestId('prop-input')).toHaveCount(0);
  await openSection(page, 'advanced');
  await expect(page.getByTestId('prop-command')).toHaveValue(
    'bwa mem -t 4 -M -k 19 {ref} {reads1} {reads2} > {sam}'
  );
  // The unsaved marker shows: saving keeps the update.
  await expect(page.locator('.dirty-marker')).toBeVisible();

  // Sort reads the file the old step named.
  await selectNode(page, 'Sort');
  await expect(page.getByTestId('prop-slot-alignments')).toHaveValue('aligned.sam');
});
