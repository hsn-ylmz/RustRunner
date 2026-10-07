# Testing RustRunner Lab on a Ribo-seq pipeline

This is the test you run yourself before deciding whether to merge the Lab branch: your own PhD pipeline,
built from the template **Ribo-seq with UMIs (riboWaltz)**, run in the desktop app on real public human data.

```
raw FASTQ -> FastQC -> cutadapt -> FastQC -> umi_tools extract -> FastQC
          -> bowtie2 vs rRNA -> bowtie2 vs tRNA -> bowtie2 vs ncRNA (unaligned reads kept each time) -> FastQC
          -> STAR (genome index + GTF, --quantMode TranscriptomeSAM, transcript-coordinate BAM)
          -> samtools view (mapped, sense) -> samtools sort -> samtools index
          -> umi_tools dedup -> riboWaltz HTML report            (+ MultiQC over all QC and log files)
```

Contents: [the data](#1-the-data) | [one-time setup](#2-one-time-setup) | [the test, click by click](#3-the-test-click-by-click) |
[how long it takes](#4-how-long-it-takes) | [where the results are](#5-where-the-results-are) |
[what you should see](#6-what-you-should-see) | [what to look at critically](#7-what-to-look-at-critically) |
[disk space and removing the tools](#8-disk-space-and-removing-the-tools) | [troubleshooting](#9-troubleshooting)

## 1. The data

Public human HEK293T ribosome profiling reads: GEO GSE158374, sample GSM4798525, run SRR12693498 (Rao et al., RNA 2021),
library kit Diagenode D-Plex Small RNA-seq (12 nt 5' UMI, 4 nt template-switch motif, poly(A) tail plus Illumina
adapter at the 3' end, sense reads). The full provenance, the verified read layout and the reference sources are in
[DATA.md](DATA.md). Nothing here is simulated.

Everything is already built under `riboseq-test/data/` (git-ignored). If it is missing, run
`./riboseq-test/prepare_data.sh` once (about 610 MB of downloads, checksummed).

| Use it as | File (under `riboseq-test/data/`) | Size |
|---|---|---|
| **Reads, the test you want** | `full/SRR12693498_5000000reads.fastq.gz` (the first 5,000,000 reads of the run) | 160 MB |
| Reads, quick smoke test | `tiny/SRR12693498_200000reads_seed42.fastq.gz` (200,000 reads) | 6 MB |
| rRNA sequences | `ref/rRNA.fa` | |
| tRNA sequences | `ref/tRNA.fa` | |
| Other small ncRNA sequences | `ref/ncRNA.fa` | |
| Genome (chromosomes 17, 19, 22 of GRCh38) | `ref/genome_chr17_19_22.fa` | 193 MB |
| Gene annotation (Ensembl 115, one canonical transcript per gene) | `ref/annotation_chr17_19_22.gtf` | 39 MB |

The genome is three chromosomes on purpose (the STAR index stays small and builds in about a minute). Only about 15 % of
the reads that survive depletion map uniquely; most of the rest are reported by STAR as unmapped "too short" because they come
from genes on the other chromosomes or from unannotated sequence. That is expected (DATA.md, section 4). Use the 5 million read file: the 200,000 read file is too small for riboWaltz to estimate P-site
offsets (the report says so instead of inventing numbers).

## 2. One-time setup

1. **Engine.** The app starts the engine from `RustRunner/target/debug/rustrunner`:
   `cd RustRunner && cargo build` (nothing to do if you already built it).
2. **micromamba.** A run installs each tool into its own conda environment with micromamba. When you start the app
   from source it looks for `RustRunner/runtime/micromamba` (git-ignored). Download it once:
   `cd RustRunner/runtime && curl -Ls https://micro.mamba.pm/api/micromamba/osx-arm64/latest | tar -xj bin/micromamba && mv bin/micromamba . && rmdir bin`
   (use `osx-64` on an Intel Mac, `linux-64` on Linux). Without it the first step stops with "micromamba not found".
3. **Rosetta (Apple silicon only).** STAR 2.7.10b has no native arm64 build, so it runs as an Intel build.
   Check with `arch -x86_64 /usr/bin/true`; if it fails, run `softwareupdate --install-rosetta --agree-to-license`.
4. **Network** on the first run only, to download the tools (see section 8 for the size).

Running from source writes `RustRunner/runtime/env_map.json` (it is tracked). After the test, `git checkout RustRunner/runtime/env_map.json`
puts it back.

## 3. The test, click by click

1. Open the app: `cd RustRunner-Desktop && npm start` (builds the app, then starts it).
2. Click **Templates** in the top toolbar (or the Templates card on the empty canvas).
3. Type `ribo` in the search box and click the card **Ribo-seq with UMIs (riboWaltz)** (20 steps, advanced).
   The right-hand column draws the pipeline and lists what you will get.
4. Under **Your files**, click **Choose file** for each of the six inputs (or paste the full path into the field):

   | Field | File |
   |---|---|
   | Sequencing reads (FASTQ) | `riboseq-test/data/full/SRR12693498_5000000reads.fastq.gz` |
   | rRNA sequences (FASTA) | `riboseq-test/data/ref/rRNA.fa` |
   | tRNA sequences (FASTA) | `riboseq-test/data/ref/tRNA.fa` |
   | Other small ncRNA sequences (FASTA) | `riboseq-test/data/ref/ncRNA.fa` |
   | Genome sequence (FASTA) | `riboseq-test/data/ref/genome_chr17_19_22.fa` |
   | Gene annotation (GTF) | `riboseq-test/data/ref/annotation_chr17_19_22.gtf` |

5. Under **Check these settings**, leave the defaults (they are the settings of this library). Read them anyway,
   this is where a wrong layout would silently cost you reads:

   | Setting | Default | Why |
   |---|---|---|
   | 3' adapter | `AAAAAAAAAACAAAAAAAAAAGATCGGAAGAGCACACGTCTGAACTCCAGTCAC` | poly(A) tail A10-C-A10, then the Illumina adapter |
   | UMI position | 5' end | D-Plex puts the UMI at the start of the read |
   | UMI length | 12 | |
   | Bases to remove next to the UMI | 4 | the template-switch motif; removed with the UMI |
   | Shortest / longest footprint | 28 / 34 | this library peaks at 31 to 32 nt, so not 28 to 30 |
   | Mismatches allowed in STAR | 2 | |
   | Most places a read may align to | 1 | unique alignments only |

6. Click **Create workflow**. The 20 steps appear on the canvas, connected. Nothing should be listed as a problem.
7. Click **Choose results folder** (top left, under the workflow name) and pick a new empty folder **outside**
   `riboseq-test/`, for example `~/riboseq-results/run1`. It will hold about 4 GB (the STAR index is 3.1 GB), so it
   must not be the data folder, which should stay exactly what `prepare_data.sh` made.
8. Optional but cheap: click **Dry run**. It checks every step and shows what would run without installing or running anything.
9. Click **Run**. The **Step status** tab shows each step; **Execution logs** shows the tools' output. Independent steps
   (the three index builds, the STAR index, the FastQC checks) run side by side.
10. When it finishes, the summary card offers **Open report**.

To repeat without installing again, click **Run from scratch**; **Run** alone continues from the steps that already finished.

## 4. How long it takes

Measured on this machine (Apple M5 Pro, 18 cores, 48 GB, STAR under Rosetta), template path, tools already installed:

| Reads | Whole workflow | Of which |
|---|---|---|
| 5,000,000 (full) | about **2 minutes** (119 s) | STAR index 75 s, UMI extract 51 s, STAR mapping 22 s, FastQC 4 to 13 s each |
| 200,000 (tiny) | about 1.5 minutes (95 s of engine time) | the STAR index does not depend on the reads, so it costs the same |

The **first** run also creates the conda environments for eight tools (FastQC, cutadapt, UMI-tools, bowtie2, STAR, samtools,
riboWaltz with R, MultiQC). Allow **5 to 20 minutes** more on a normal connection (an estimate); riboWaltz with R is the largest download.
Later runs, in any folder, reuse them. I did not time a cold install on your machine. One earlier run on this machine took 10 minutes of wall
time although the engine counted 95 s: the STAR index step alone took 9 minutes (the machine was busy or asleep, I could not tell). If the
STAR index step takes much longer than 1.5 minutes, look at what else is using the machine.

## 5. Where the results are

All of it is under the results folder you chose.

| What | Where | How to open |
|---|---|---|
| **riboWaltz report** (one self-contained HTML page: read lengths, P-site offsets, read ends around start and stop codons, 3-nt periodicity by region and by length, metaprofiles, P-sites per region, codon usage) | `ribowaltz/ribowaltz_report.html` | double-click it |
| riboWaltz tables | `ribowaltz/*.tsv` (`psite_offsets`, `periodicity_by_length`, `periodicity_by_region`, `psites_per_region`, `read_lengths`, `codon_usage`, ...) | any spreadsheet |
| **MultiQC** (four FastQC checkpoints, cutadapt, UMI-tools extract and dedup, the three depletion summaries, STAR) | `multiqc/multiqc_report.html` | double-click it |
| **Run report** (every step: status, duration, command, resource use, graph) | the **Open report** button, or `.rustrunner/runs/<run id>/report.html` | in the app |
| **Run history** (every earlier run in this folder) | the **Run history** tab under the canvas | in the app |
| The BAM riboWaltz read | `deduplicated.bam` (transcript coordinates), `sorted.bam` and `sorted.bam.bai` before deduplication | IGV, samtools |
| Logs | `cutadapt.txt`, `umi_extract.log`, `rrna_removal.log`, `trna_removal.log`, `ncrna_removal.log`, `star_riboseq/Log.final.out`, `umi_dedup.log` | text editor |
| Reads after each step | `trimmed.fastq.gz`, `umi_extracted.fastq.gz`, `no_rRNA.fastq.gz`, `no_tRNA.fastq.gz`, `no_ncRNA.fastq.gz` | |

The riboWaltz and MultiQC pages are files, not buttons: open them from Finder or with `open <path>`.

## 6. What you should see

The numbers below are what the 5-million-read file gave, run through the template by the automated check
(`npm run test:tools`, chain `template-riboseq-umi-ribowaltz-full`) and, before that, by the hand-built chain, in
separate runs. Every step up to STAR gave identical counts both times. Treat anything within a few reads of these as the same.

| Step | Expected |
|---|---|
| cutadapt | 5,000,000 reads in; 4,794,594 (95.9 %) had the poly(A) tail and adapter; 4,991,918 kept (0.2 % too short) |
| UMI-tools extract | 4,991,918 out; the UMI is the first 12 bases, now in the read name (`@SRR12693498.54_GACAGTAAATGG`) |
| bowtie2 vs rRNA | 69.08 % match; **1,543,535** left |
| bowtie2 vs tRNA | 6.17 % match; **1,448,236** left |
| bowtie2 vs ncRNA | 14.51 % match; **1,238,156** left |
| STAR | 14.68 % unique (181,788 reads), 5.46 % hit more than one place (dropped with the limit of 1), 65.8 % unmapped "too short" (genes of other chromosomes) |
| samtools view (mapped, sense, MAPQ 20) | 80,072 alignments |
| UMI-tools dedup | 73,257 remain (**8.5 % removed**) |
| riboWaltz | most common footprint length 31 nt (31 and 32 nt hold 28 % of the reads, 30 to 34 nt most of them); **P-site offsets 12 to 13 nt** from the 5' end (12, 12, 13, 12, 13, 12, 13 for 28 to 34 nt); **95.9 % of P-sites in the CDS**, 1.3 % and 2.8 % in the 5' and 3' UTR (the CDS is 51 % of the transcript space, so 1.9-fold enriched); **42.8 % of CDS P-sites in frame 0**, 24.0 % and 33.2 % in the other two |
| MultiQC | four FastQC checkpoints, one cutadapt, two UMI-tools, three Bowtie 2, one STAR |

With the 200,000-read file you get 49,442 reads after depletion, 3,184 alignments, 3,176 after deduplication (0.25 % removed),
and a riboWaltz report that starts with a warning that there are too few reads over start codons to estimate offsets.
That is the correct behaviour, not a failure.

## 7. What to look at critically

You know Ribo-seq better than the tools do. These are the places where I would not take the result on trust.

- **The library layout is an input, not a discovery.** The adapter, UMI position, UMI length and spacer come from the kit manual and
  were checked on the reads (DATA.md, section 2: positional base composition, 94.8 % of reads with no 5' soft clip against rRNA once
  16 nt are removed, 99.996 % sense). Check the first lines of `cutadapt.txt` and the UMI in the read names in `trimmed.fastq.gz`
  against `umi_extracted.fastq.gz`.
- **Footprint length 31 to 32 nt, not 28 to 30.** That is what this library shows after the 16 nt are removed. The template's
  window is 28 to 34; if you narrow it to 28 to 30 you throw away the main peak.
- **The periodicity is moderate (42.8 % in frame 0), and I think I know why.** `periodicity_by_length.tsv` shows two frames per
  length, for example 31 nt: frame 0 39 %, frame 2 53 %; 32 nt: frame 0 55 %, frame 1 31 %. That is two populations of 5' ends one
  nucleotide apart, together with offsets that alternate 12, 12, 13, 12, 13, 12, 13 between neighbouring lengths. riboWaltz estimates
  every offset from only about 350 reads over start codons (three chromosomes, 5 million reads), so neighbouring lengths pick 12 or 13
  by a handful of reads. This is my reading of the tables, not something I proved: applying 13 to 28, 29 and 31 to 34 nt and 12 to 30 nt
  would put 44 to 62 % of those reads in frame 0 (DATA.md section 2: the 5' ends of 31 nt reads leave frame 1 with only about 10 %, so the signal is there). On a
  whole-genome data set with tens of millions of reads this should sharpen; on your own data, compare the offsets by length with the
  start-codon figure in the report before trusting the in-frame numbers. This is the one result of this test I would not call clean.
- **Local depletion removes more than perfect matches.** The three bowtie2 steps use local, very sensitive alignment, so a read with
  leftover bases or a few mismatches against rRNA is removed too (69 % of reads). That is the sensitive choice; end-to-end is a setting of the step.
- **STAR keeps unique reads only** (`--outFilterMultimapNmax 1`, end to end, 2 mismatches, at least 20 matched bases) and writes
  the transcriptome BAM with `--quantTranscriptomeBan IndelSoftclipSingleend`. Footprints that need soft clipping or an indel do not
  reach the transcript BAM at all.
- **samtools view keeps mapped, sense, MAPQ 20** (the `-F 20` idea of DATA.md, written `-F 4 -G 16` because two `-F` do not combine).
  The BAM held 13.7 % antisense alignments before this step.
- **Deduplication is directional, by position, and also compares the read length** (UMI error 1, seed 1). It is not per transcript:
  one read per UMI and transcript would erase codon resolution. 8.5 % removed shows a library far from saturation.
- **One transcript per gene.** The GTF keeps each gene's Ensembl canonical transcript. With every isoform riboWaltz assigns a read to
  several transcripts. The check run asserts that every transcript name in the BAM header is a transcript of the GTF.
- **lncRNA is not removed** (it is not in `ncRNA.fa`): lncRNAs can be translated and belong to the genome step.
- **STAR is pinned to 2.7.10b.** 2.7.11b fails with `--quantMode TranscriptomeSAM`. If you change the tool version, check this first.
- **One sample per run.** For several samples make one workflow per sample, or ask me to add multi-sample input.

## 8. Disk space and removing the tools

A real run installs conda environments into `~/.rustrunner/micromamba/` (the real home folder, not the repository):

| Environment | Size |
|---|---|
| `fastqc-0.13.0` | 0.5 GB |
| `cutadapt-5.2` | 0.1 GB |
| `umi_tools-1.1.6` | 0.5 GB |
| `bowtie2-2.5.5` | 0.2 GB |
| `star-2.7.10b-osx64` | 0.1 GB |
| `samtools-1.24` | 0.1 GB |
| `ribowaltz-2.0` (R) | 1.6 GB |
| `multiqc-1.35` | 1.1 GB |
| **Total** | **about 4.2 GB**, plus a package cache (`~/.rustrunner/micromamba/pkgs`) of similar size while installing |

The results folder needs about 4 GB more for the 5-million-read run.

To remove the tools of this test only:

```
cd ~/.rustrunner/micromamba/envs
rm -rf fastqc-0.13.0 cutadapt-5.2 umi_tools-1.1.6 bowtie2-2.5.5 star-2.7.10b-osx64 samtools-1.24 ribowaltz-2.0 multiqc-1.35
rm -rf ~/.rustrunner/micromamba/pkgs        # the download cache
```

To remove everything RustRunner keeps in your home folder (all environments, and also your saved templates under
`~/.rustrunner/templates`): `rm -rf ~/.rustrunner`. The results folder is yours to delete separately.

## 9. Troubleshooting

| What you see | What it means and what to do |
|---|---|
| The first step fails with "micromamba not found" | Section 2, step 2: put the binary at `RustRunner/runtime/micromamba` and `chmod +x` it. |
| "Failed to create environment" for one tool, or a download error | No network, a proxy, or a full disk. Fix it and click **Run**: finished steps are skipped. |
| STAR fails to start, "Bad CPU type in executable" | Rosetta is missing (section 2, step 3). |
| STAR fails with `could not open input file .../geneInfo.tab` | STAR 2.7.11b was used. The template pins 2.7.10b; do not change the version of the STAR steps. |
| STAR index is "Killed" or runs out of memory | The index of this three-chromosome genome needs a few GB. For a whole human genome plan about 32 GB of RAM and 30 GB of disk. |
| riboWaltz report starts with "could not estimate the P-site offsets" | Too few reads cover start codons (the 200,000 read file always does this). Use the 5-million-read file. |
| "UMI-tools needs the BAM index next to the BAM" | The dedup step ran without `sorted.bam.bai` (for example the index step was deleted). Keep **Index alignments** connected to dedup. |
| Cutadapt trims almost nothing | The adapter setting does not match your library. Check section 3, step 5. |
| Few reads survive STAR | Normal with this reference (three chromosomes). With a full genome and your own data expect far more. |
| A path with a comma is refused | Rename the file or move it to a folder without a comma. |
| A step failed and you want the reason | The failure card names the step and the reason (its **Show in report** button opens the run report); the tool's own output is in the **Execution logs** tab. |
| "Run" does nothing new | Everything finished earlier is skipped. Use **Run from scratch** to redo all steps. |
| `git status` shows `RustRunner/runtime/env_map.json` changed | The engine records its environments there when started from source. `git checkout RustRunner/runtime/env_map.json`. |

If something here is wrong or unclear, the most useful thing to send back is the run report (`.rustrunner/runs/<run id>/report.html`)
and `ribowaltz/periodicity_by_length.tsv`.
