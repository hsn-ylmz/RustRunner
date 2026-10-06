import type { Page } from '@playwright/test';
import { test, expect, connect, nodes, openSection, selectNode } from './fixtures';

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
    'mkdir -p qc && fastqc -t 2 --outdir qc {input}'
  );
  await expect(page.getByTestId('prop-threads')).toHaveValue('2');
  await expect(page.getByTestId('prop-input')).toHaveValue('reads.fastq.gz');
  await expect(page.getByTestId('prop-output')).toHaveValue('qc/reads_fastqc.html');
  await expect(page.getByTestId('catalog-param-outdir')).toHaveValue('qc');
  await expect(nodes(page).first()).toContainText('fastqc');
  await expect(page.locator('.dirty-marker')).toBeVisible();
  expect(consoleErrors).toEqual([]);
});

test('the palette searches by name and category, and closes with Escape', async ({ page }) => {
  await page.getByTestId('open-palette').click();
  const items = page.locator('[data-testid^="palette-item-"]');
  const all = await items.count();
  expect(all).toBeGreaterThanOrEqual(12);

  await page.getByTestId('palette-search').fill('BWA');
  await expect(items).toHaveCount(1);
  await expect(page.getByTestId('palette-item-bwa-mem')).toBeVisible();

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
  await expect(command).toHaveValue('samtools sort -@ 4 -m 768M -o {output} {input}');

  await page.getByTestId('catalog-param-by_name').check();
  await expect(command).toHaveValue('samtools sort -@ 4 -n -m 768M -o {output} {input}');
  await page.getByTestId('catalog-param-memory_per_thread').fill('2G');
  await expect(command).toHaveValue('samtools sort -@ 4 -n -m 2G -o {output} {input}');
  await page.getByTestId('prop-threads').fill('8');
  await expect(command).toHaveValue('samtools sort -@ 8 -n -m 2G -o {output} {input}');

  // Typing in the command takes over: options stop rewriting it.
  await command.fill('samtools sort -T /tmp/x -o {output} {input}');
  await expect(page.getByTestId('catalog-custom-note')).toBeVisible();
  await page.getByTestId('catalog-param-by_name').uncheck();
  await expect(command).toHaveValue('samtools sort -T /tmp/x -o {output} {input}');

  await page.getByTestId('catalog-regenerate').click();
  await expect(command).toHaveValue('samtools sort -@ 8 -m 2G -o {output} {input}');
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
  await addFromPalette(page, 'bwa', 'bwa-mem');
  await openSection(page, 'advanced');
  await expect(page.getByTestId('prop-command')).toHaveValue(
    'bwa mem -t 4 -M -k 19 {ref} {input} > {output}'
  );
  await expect(page.getByTestId('catalog-missing')).toContainText('Reference FASTA');

  await page.getByTestId('catalog-param-ref').fill('genome/hg38.fa');
  await expect(page.getByTestId('prop-command')).toHaveValue(
    'bwa mem -t 4 -M -k 19 genome/hg38.fa {input} > {output}'
  );
  await expect(page.getByTestId('catalog-missing')).toHaveCount(0);

  // Changing the tool detaches the node from the catalog; its command is kept.
  await page.getByTestId('prop-tool').fill('bash');
  await expect(page.getByTestId('catalog-params')).toHaveCount(0);
  await expect(page.getByTestId('prop-command')).toHaveValue(
    'bwa mem -t 4 -M -k 19 genome/hg38.fa {input} > {output}'
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
