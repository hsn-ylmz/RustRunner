/**
 * RNA domain: spliced alignment and quantification. Each chain is built the
 * way the app builds it (see ../harness.ts).
 */
import { countsPerGene, defineDomain, read, sizeOf, type Chain } from '../harness';

const salmonIndex = {
  label: 'Salmon index',
  tool: 'salmon',
  command: 'salmon index -t {input} -i salmon_index -k 11 -p {threads}',
  threads: 2,
  input: 'transcripts.fa',
  output: 'salmon_index/info.json',
};

const CHAINS: Chain[] = [
  {
    name: 'star-rna-featurecounts',
    files: ['ref.fa', 'genes.gtf', 'rna_se.fastq.gz'],
    nodes: [
      {
        key: 'gen',
        raw: {
          label: 'STAR genomeGenerate',
          tool: 'star',
          command:
            'STAR --runMode genomeGenerate --runThreadN {threads} --genomeDir star_index ' +
            '--genomeFastaFiles {input} --sjdbGTFfile genes.gtf --sjdbOverhang 74 ' +
            '--genomeSAindexNbases 4 --outFileNamePrefix star_gen_',
          threads: 2,
          input: 'ref.fa',
          output: 'star_index/SA',
          // The same pinned build the catalog's STAR step uses, so the index matches.
          install: { kind: 'conda', package: 'star', version: '2.7.10b', channel: 'bioconda', osx64: true },
        },
      },
      { key: 'star', catalog: 'star', files: { index: 'star_index', reads: 'rna_se.fastq.gz' } },
      { key: 'fc', catalog: 'featurecounts', files: { annotation: 'genes.gtf' } },
    ],
    edges: [
      ['gen', 'star', 'after'],
      // STAR's BAM (not its output folder) is bound to featureCounts.
      ['star', 'fc'],
    ],
    verify: (dir) => [
      {
        tool: 'featurecounts',
        ok: countsPerGene(read(dir, 'counts.tsv')).every((n) => n > 0),
        message: 'every gene has reads (spliced RNA reads)',
      },
      { tool: 'star', ok: sizeOf(dir, 'star/Aligned.sortedByCoord.out.bam') > 1000, message: 'BAM not tiny' },
      { tool: 'star', ok: /Number of input reads\s*\|\s*[1-9]/.test(read(dir, 'star/Log.final.out')), message: 'STAR read the reads' },
    ],
  },
  {
    name: 'salmon',
    files: ['transcripts.fa', 'rna_se.fastq.gz'],
    nodes: [
      { key: 'idx', raw: salmonIndex },
      { key: 'quant', catalog: 'salmon-quant', files: { index: 'salmon_index', reads: 'rna_se.fastq.gz' } },
    ],
    edges: [['idx', 'quant', 'after']],
    verify: (dir) => {
      const rows = read(dir, 'salmon_out/quant.sf').trim().split('\n').slice(1);
      const reads = rows.reduce((sum, r) => sum + Number(r.split('\t')[4]), 0);
      return [
        { tool: 'salmon-quant', ok: rows.length === 3 && reads > 1000, message: `3 transcripts, ${reads.toFixed(0)} reads quantified` },
      ];
    },
  },
  {
    name: 'salmon-library-types',
    files: ['transcripts.fa', 'rna_se.fastq.gz'],
    nodes: [
      { key: 'idx', raw: salmonIndex },
      ...['U', 'SF', 'SR'].map((libtype) => ({
        key: `salmon_${libtype}`,
        catalog: 'salmon-quant',
        params: { libtype },
        files: { index: 'salmon_index', reads: 'rna_se.fastq.gz', out_dir: `salmon_${libtype}/` },
      })),
    ],
    edges: [
      ['idx', 'salmon_U', 'after'],
      ['idx', 'salmon_SF', 'after'],
      ['idx', 'salmon_SR', 'after'],
    ],
    verify: (dir) =>
      ['U', 'SF', 'SR'].map((libtype) => ({
        tool: 'salmon-quant',
        ok: read(dir, `salmon_${libtype}/quant.sf`).trim().split('\n').length === 4,
        message: `library type ${libtype} wrote 3 transcripts`,
      })),
  },
];

defineDomain({
  domain: 'rna',
  covers: ['star', 'salmon-quant', 'featurecounts'],
  chains: CHAINS,
});
