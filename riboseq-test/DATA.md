# Ribo-seq test data (human HEK293T, UMI library)

Real public data for testing the RustRunner Ribo-seq workflow end to end:

raw FASTQ, FastQC, cutadapt, FastQC, umi_tools extract, FastQC, bowtie2 vs rRNA, bowtie2 vs tRNA, bowtie2 vs ncRNA
(unaligned reads kept each time), FastQC, STAR (genome index + GTF, `--quantMode TranscriptomeSAM`), samtools view
(mapped only), samtools sort, samtools index, umi_tools dedup, riboWaltz, MultiQC.

Everything is built by `prepare_data.sh` (re-runnable, idempotent, checksummed) into `riboseq-test/data/`
(gitignored, about 610 MB including the downloads). Only this file, the script, its Python helper and
`checksums.sha256` are committed.

```
./riboseq-test/prepare_data.sh            # build what is missing, verify the rest
./riboseq-test/prepare_data.sh --record   # re-pin checksums.sha256 (only after an intended change)
FULL_READS=15000000 ./riboseq-test/prepare_data.sh   # stream more of the run (new file name, new checksum)
```

Needs `curl`, `gzip`, `shasum` and `python3` (standard library only).

## 1. The dataset

| | |
|---|---|
| Series | GEO [GSE158374](https://www.ncbi.nlm.nih.gov/geo/query/acc.cgi?acc=GSE158374) (BioProject PRJNA665035, SRA study SRP284977) |
| Sample | GSM4798525, `WT-HEK-1_ribo`: untreated HEK293T, replicate 1, ribosome profiling |
| Run | **SRR12693498** (experiment SRX9173296), single-end, Illumina NovaSeq 6000, 100 nt reads, 67,130,099 reads in total |
| Cells | HEK293T (ATCC), DMEM, cycloheximide in the lysis buffer |
| Library kit | Diagenode **D-Plex Small RNA-seq** (3' end dephosphorylation, poly(A) tailing, oligo(dT) RT primer, template switching with a 5' UMI) |
| Paper | Rao S, Hoskins I, Tonn T, Garcia PD, Ozadam H, Sarinay Cenik E, Cenik C. *Genes with 5' terminal oligopyrimidine tracts preferentially escape global suppression of translation by the SARS-CoV-2 Nsp1 protein.* RNA 27:1025-1045 (2021). PMID 34127534 |
| Authors' pipeline | RiboFlow, Ozadam et al., Bioinformatics 36:2929 (2020) |
| Kit manual | Diagenode, D-Plex Small RNA-seq Kit user guide v2 (03/2024), section "Data analysis" (read structure and the recommended cutadapt command) |

Why this run: the user asked for a human, single-end, UMI-containing footprint library from a common cell line with
a documented layout. The McGlincy and Ingolia (Methods 126:112, 2017) linker-style protocol is the best known UMI
Ribo-seq method, but I could not find a public human run with that protocol whose reads I could verify here, and
the layout of this run is documented both by the GEO record and by the kit manual, and was confirmed on the reads
(section 2). The UMI is at the **5' end of the read** (kit) rather than in a 3' linker (McGlincy), so
`umi_tools extract` works on the start of the read, after cutadapt has removed the 3' side.
The same GEO series also has RNA-seq runs and NSP1/NSP2-expressing cells; only the untreated footprint library
replicate 1 is used here.

Library layout, 5' to 3' on the read (R1 only, sense orientation):

```
[ UMI 12 nt ][ template-switch motif 4 nt ][ footprint insert ][ A-tail ][ 3' adapter ]
  positions 1-12   positions 13-16            variable         AAAAAAAAAACAAAAAAAAAA  AGATCGGAAGAGCACACGTCTGAACTCCAGTCAC
```

GEO describes it as "5' adapter: 12nt UMI followed by NNNN; 3' adapter: AAAAAAAAAACAAAAAAAAAA". The "NNNN" is the
template-switch motif (one variable base then GGG). The kit manual trims it with `cutadapt -u 16` (12 UMI + 4).
Because the user's pipeline runs cutadapt first and `umi_tools extract` second, the split here is:

| Step | Setting | Effect |
|---|---|---|
| cutadapt | 3' adapter `AAAAAAAAAACAAAAAAAAAAGATCGGAAGAGCACACGTCTGAACTCCAGTCAC`, `-e 0.1 -O 10 -m 20` | removes A-tail + Illumina adapter (and anything after it) |
| umi_tools extract | `--extract-method=regex --bc-pattern='^(?P<umi_1>.{12})(?P<discard_1>.{4})'` | moves the 12 nt UMI into the read name and removes the 4 nt motif |

## 2. What the reads show (verified, not assumed)

Checked on the first 500,000 reads and on the 200,000 read subsample; full-run numbers from the 5M reads.

- **3' adapter.** 94.6 % of reads carry the A-tail/adapter and are trimmed (4,729,525 of 5,000,000); 87.8 % contain
  the plain Illumina motif `AGATCGGAAGAGC`. The `A10-C-A10` is exactly 20 bases ahead of that motif's first base, as
  the GEO description says. 0.2 % of reads end up shorter than 20 nt and are dropped (4,992,017 remain).
  About 5.4 % of reads have no adapter at all: the insert fills the 100 nt read (84 nt after UMI and motif removal), so
  they are long RNA fragments, not footprints; the pipeline keeps them (no length filter was asked for).
  After trimming only 6.3 % of reads end in an `A`, so the A-tail is gone.
- **UMI position and length.** Positional base composition over the first 20 bases: positions 1-4 are a balanced
  mix (A 28-31 %, C 20-24 %, G 16-17 %, T 31-32 %), positions 5, 6, 10, 11 and 12 contain **almost no A** (0-1 %; a feature of the kit's UMI
  design), position 13 is uniform (the variable motif base), and positions 14-16 are `GGG` in 96-99 % of reads. So the
  UMI is 12 nt (positions 1-12) followed by a 4 nt motif, and the footprint starts at position 17. Diagenode's
  `-u 16` agrees.
- **The 4 nt motif must really be removed.** Aligning the extracted reads locally to rRNA, 94.8 % have **no** 5' soft
  clip, 4.0 % lose one base: the footprint starts exactly after base 16.
- **Orientation.** 99.996 % of the reads that align to rRNA align on the forward strand: reads are sense, no
  reverse-complementing is needed.
- **Insert length.** After adapter trimming and removal of the 16 nt, all reads together peak at **33 nt**
  (12.6 % of reads; 29-35 nt hold the bulk). Reads that map to transcripts (STAR, after depletion and dedup) peak at
  **31-32 nt** (30-34 nt carry most). This is a little longer than the textbook 28-30 nt of a ribosome footprint: it is
  what this library shows; riboWaltz should be told to use lengths 28-34 rather than a narrower window.
- **UMI complexity.** 188,373 distinct UMIs among 199,673 reads in the 200k set. After mapping to transcripts,
  `umi_tools dedup` (directional) removes 8.5 % of alignments (146,605 to 134,093): the library is far from saturated at
  this depth, so duplicate removal changes the counts only slightly.
- **P-site signal (sanity check of offsets and periodicity).** On the transcriptome BAM, 5' ends of 30-33 nt reads
  around the annotated start codon pile up at -13 and -12 nt (53 and 41 reads, against a background that is mostly under 20 per position), i.e. a P-site offset
  of 12-13 nt. Inside the CDS, 5' ends are periodic: frame 1 holds about 10 % and frames 0 and 2 about 90 % of the reads for
  31 nt reads. Counts are modest (the reference is three chromosomes), so the riboWaltz offset plot will be noisy;
  `FULL_READS=15000000` gives a sharper picture.

## 3. Read sets

| Set | File | Reads | Size |
|---|---|---|---|
| full | `data/full/SRR12693498_5000000reads.fastq.gz` | 5,000,000 (the first 5M of the run, streamed; the run is never downloaded in full) | 160 MB |
| tiny | `data/tiny/SRR12693498_200000reads_seed42.fastq.gz` | 200,000, `random.Random(42).sample` of the 5M, original order kept | 6.3 MB |

Read names are `@SRR12693498.<n> <n>/1`.

## 4. References (Ensembl release 115, GRCh38)

All in `data/ref/`. The release is pinned: Ensembl releases are immutable, and `checksums.sha256` pins the built files.

| File | Content | Source |
|---|---|---|
| `genome_chr17_19_22.fa` | Chromosomes 17, 19 and 22 (192.9 Mb), headers `17`, `19`, `22` | `Homo_sapiens.GRCh38.dna.chromosome.{17,19,22}.fa.gz` |
| `annotation_chr17_19_22.gtf` | 3,113 protein-coding genes with their `Ensembl_canonical` transcript (3,026 transcripts with CDS), transcript ids and versions untouched | `Homo_sapiens.GRCh38.115.gtf.gz` |
| `rRNA.fa` | 51 sequences: NCBI NR_046235.3 (45S pre-rRNA, contains 18S, 5.8S, 28S) and NR_023363.1 (5S), plus Ensembl biotypes `rRNA`, `Mt_rRNA` (MT-RNR1, MT-RNR2) and `rRNA_pseudogene` | NCBI nuccore, Ensembl `ncrna` FASTA |
| `tRNA.fa` | 454 sequences: GtRNAdb hg38 mature tRNAs plus Ensembl `Mt_tRNA` (22 mitochondrial tRNAs) | GtRNAdb Hsapi38, Ensembl `ncrna` FASTA |
| `ncRNA.fa` | 6,995 sequences: Ensembl `ncrna` FASTA restricted to the small RNA biotypes `miRNA`, `misc_RNA` (7SL, RNase P/MRP, Y RNA copies and others), `scaRNA`, `scRNA`, `snRNA`, `snoRNA`, `sRNA`, `vault_RNA`, `ribozyme`; U to T | Ensembl `ncrna` FASTA |

Decisions worth knowing:

- **Why chromosomes 17, 19 and 22.** Chromosome 19 is the most gene-dense human chromosome, and 17 and 22 are
  also well above the genome average in genes per megabase. Together they are 6 % of the genome (192.9 Mb of
  about 3.1 Gb) but hold 3,113 protein-coding genes (about 15 % of all), so a 5M read sample still gives enough transcript
  alignments for riboWaltz while the STAR index stays small (it built in about a minute here). Chromosome 22
  has no rDNA in the primary assembly (rRNA comes from the depletion references).
- **Reads from the other chromosomes will not align, which is expected.** Of the 1,239,079 reads left after depletion
  (full set), STAR maps 22.6 % uniquely and 15.9 % to multiple loci; the rest is mostly reported by STAR as unmapped "too short" (57 % in the 200k set): reads from
  genes on other chromosomes or from unannotated sequence.
- **One transcript per gene.** The GTF keeps only each gene's `Ensembl_canonical` transcript. The transcriptome BAM then
  has no isoform multi-mapping, and riboWaltz needs exactly one annotation per transcript anyway. Genes without that tag
  keep their gene line only. To use all isoforms, edit `keep_gtf_line` in `prepare_helpers.py` and re-run.
- **lncRNA is not in `ncRNA.fa`.** lncRNAs carry real translated ORFs in Ribo-seq and belong to the genome step.
  Patch and alternative-haplotype scaffolds of the Ensembl ncRNA FASTA are skipped (they duplicate chromosome genes).
- **tRNA references are mature sequences** (no CCA, no introns), which is what depletion needs; MT-tRNAs come from
  Ensembl.

## 5. A reference run of the whole chain (what to expect)

Run in the sandbox with cutadapt 5.2, umi_tools 1.1.6, bowtie2 (`--very-sensitive-local`, `--un-gz` for the unaligned
reads), STAR 2.7.10b and samtools, on the 5M-read file. The depletion mode is the user's choice; these numbers use local
alignment, which is the most sensitive.

| Step | Reads in | Result |
|---|---|---|
| cutadapt | 5,000,000 | 4,992,017 kept (94.6 % trimmed, 0.2 % too short) |
| umi_tools extract | 4,992,017 | 4,992,017 (UMI in the read name) |
| bowtie2 rRNA | 4,992,017 | 69.03 % aligned; 1,546,168 unaligned kept |
| bowtie2 tRNA | 1,546,168 | 6.13 % aligned; 1,451,327 unaligned kept |
| bowtie2 ncRNA | 1,451,327 | 14.62 % aligned; 1,239,079 unaligned kept |
| STAR | 1,239,079 | 22.63 % unique, 15.87 % multiple loci; transcriptome BAM 146,605 alignments on 2,886 transcripts |
| samtools view -F 4, sort, index | 146,605 | 146,605 mapped (20,101 are antisense, flag 16; `-F 20` keeps 120,493 sense alignments) |
| umi_tools dedup | 146,605 | 134,093 (8.5 % removed) |

The tiny set gives the same proportions (200,000 reads, 199,673 after cutadapt, 49,458 after depletion, 5,941
transcriptome alignments).

## 6. Things that will bite the tool run (found while validating)

These are properties of the tools, not of the data, and each needs handling in the workflow definition:

1. **`umi_tools extract` with `--extract-method=string` and `X` does not remove the discarded bases** (version
   1.1.6: `NNNNNNNNNNNNXXXX` removed only the 12 UMI bases and left the 4 nt motif at the start of the read, shifting
   every alignment). Use the regex form with a named `discard_1` group, as above.
2. **STAR 2.7.11b (the only bioconda build for osx-arm64, also the newest for osx-64) fails with `--quantMode`**:
   `Transcriptome.cpp:18 ... could not open input file /geneInfo.tab`, with an index built with `--sjdbGTFfile`
   and also with the GTF supplied at the mapping step. The native arm64 build also failed to start a
   `--readFilesCommand` (`Failed spawning readFilesCommand`). STAR 2.7.10b works (osx-64 build under Rosetta,
   `--readFilesCommand gunzip -c` and `zcat` both fine, and it reads an index built by 2.7.11b). If the workflow runs
   STAR from a micromamba environment on this Mac, it needs `star=2.7.10b` with the osx-64 platform, or a Linux
   machine.
3. **`umi_tools dedup` on the transcriptome BAM** needs a sorted, indexed BAM (the reason for the
   sort and index steps) and the UMI must still sit at the end of the read name after STAR (it does:
   `SRR12693498.54_GACAGTAAATGG`). `--per-contig` additionally requires `--per-gene`, so leave it out here.
4. **The transcriptome BAM contains antisense alignments** (13.7 %). STAR reports a read aligning to the minus strand of a
   transcript; for a sense library these are mostly multi-locus artifacts. Filtering them with `samtools view -F 20`
   in the "mapped only" step is closer to what riboWaltz expects than `-F 4`; this is a choice for the user.
5. On macOS the system `zcat` looks for `file.Z`; use `gzip -dc` in shell steps.
