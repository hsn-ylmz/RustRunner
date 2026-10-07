# Changelog

All notable changes to RustRunner are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the project follows [Semantic Versioning](https://semver.org/) (a pre-release such as `1.0.0-beta.1` sorts before `1.0.0`).

## [1.0.0-beta.1] - 2026-10-08

The first public beta of RustRunner 1.0, an open beta. Everything since 0.11.1, by area. Old workflow files and old
`.rustrunner/*.state` files still load: every new field is optional and old catalog steps are migrated when opened.

### Engine

- Each step runs in its own process group. Stop (and quitting the app) ends the whole process tree of every step, with a
  grace period and then a kill; no tool is left running. Timeouts return as soon as the step stops.
- Per-step **retries** (fixed or exponential delay), a **timeout** per attempt, and **output checks** (exists, not empty, at
  least N lines) with a blocking or warning-only mode and a target of one output or all. A failed blocking check fails the step
  and skips what depends on it; the tool is not run again for a check. Setup errors (a missing environment) are never retried.
- **Up-to-date skipping.** A step whose settings are unchanged, whose outputs exist and whose inputs are not newer is skipped;
  everything after a stale step runs. `--fresh` ignores the saved state.
- **Keep going** (`--keep-going`): the independent branches still run after a failure, and the run ends as failed.
- Machine-readable run events (`--json-events`) replace log parsing in the app. Run state records attempts per step and has a
  stable workflow id, so renaming a workflow keeps its saved run.
- **Named file slots.** A command names its files (`{reads}`, `{ref}`) and the engine fills them in, quoting every value so file
  names with spaces and quotes reach the tool intact. Workflow metadata (name, version) is logged and saved.
- Per-step **mocking** (skip the tool, make empty outputs) to test the rest of a pipeline.
- **Install kinds.** A step can install a conda package at a pinned version and channel (with extra packages, and an Intel build
  on Apple silicon where a tool has no native one) or download a vendor binary over https with a checksum.
- **Checks before a run.** If micromamba cannot be found, the run stops before any step with an event that lists every place it
  looked, instead of a bare "No such file or directory". A conda step starts through a launcher that puts the environment's own
  Java first on `PATH`, so tools that call plain `java` (FastQC, Picard, GATK) never reach the macOS "install Java" stub.
- Relative workflow, pause-flag and `--working-dir` paths resolve against the directory the CLI started in.
- `rustrunner --version` and the banner say `(open beta)` for a beta build.

### Tool catalog

- A bundled catalog of **85 tools** (schema v2), each naming every file it reads and writes with a type, installing the tool at a
  pinned version, and **run against the real program** on small data (macOS arm64): quality control, trimming, reference
  preparation, alignment, BAM processing, variant calling and annotation, RNA-seq quantification, ChIP and ATAC peak calling, signal
  tracks, genome intervals, FASTA and FASTQ tools, assembly, metagenomics, Nanopore signal and Ribo-seq.
- Tools that need a database (Kraken2 and others) say so before they are added, with a link.
- Files that ship with the app (for example the riboWaltz report script) are available to steps as `{app_resource:path}`.
- Fixed by running the real tools: FastQC, STAR and featureCounts commands; the riboWaltz entry now installs
  `bioconductor-txdbmaker`, which riboWaltz 2.0 needs; BWA MEM writes a read group.
- Old saved steps (catalog v1) are migrated when a workflow is opened.

### Templates

- A gallery of **14 templates** that build a whole pipeline from your files and ask the settings that depend on your data first:
  basic read QC; RNA-seq (HISAT2 with featureCounts; Salmon); **Ribo-seq with UMIs (riboWaltz)**; germline variants (bcftools
  single-end and paired-end; GATK); ChIP-seq (MACS3); ATAC-seq (Genrich); Nanopore (from FASTQ; from raw signal with Dorado);
  metagenomics (Kraken2 and Bracken); assembly (SPAdes and QUAST; Flye and QUAST).
- Every template is run through the real engine by the real-tool suite. **My templates** saves any all-catalog workflow as your
  own template.
- `riboseq-test/` holds a real public Ribo-seq dataset (HEK293T, a D-Plex UMI library), a data-preparation script with checksums
  and a README for running the template on it, with the numbers to expect.

### User interface

- A new design system: tokens for light and dark (checked for contrast by a test), UI primitives, and a `ui-ux` skill that
  documents them.
- A one-row toolbar, an onboarding empty state, collapsible property sections with inline validation, undo and redo, keyboard
  shortcuts, and a keyboard path for connecting steps and running a workflow.
- A searchable palette (ranked search, categories, favourites and recently used tools, preview with what a tool reads and makes,
  "Only tools that fit after the selected step"). Connections are typed: green when file types fit, an orange dashed edge with
  words when they do not, and the slot of the matching type fills in on connect.
- Live status on every step (icon and words), a run summary, a failure card that names the step, the file and the setting with
  **Edit step**, **Show in report** and **Show logs**, a searchable log, toasts instead of native dialogs.
- A step status panel, Run and Run from scratch, pause and resume, dry run.
- A card to install micromamba (pinned, checksummed, https only) when it is missing.
- The window title and About panel say "open beta"; the update banner names the version the same way.
- The canvas can zoom out to 20 percent, so a long pipeline such as Ribo-seq fits in the window.
- A fix: forcing a theme no longer crashes the main process on macOS (the Dock icon is set from a PNG).

### Reports and history

- Every run writes a self-contained HTML report (graph, status, duration, attempts, command, checks, resource use) and is listed
  in the Run history. The Open report buttons refuse anything outside the run folder.
- Templates that end in MultiQC give one combined quality report.

### Updates and release

- The updater follows the version it runs: a beta build is offered the next beta and then the final 1.0, a stable build is never
  offered a beta, and nobody is downgraded (tested). A beta must be published on GitHub as a pre-release.
- macOS (unsigned) is told about an update and linked to the download; Windows and Linux install it.

### CI

- Clippy with `-D warnings`, `cargo fmt --check` and a Linux end-to-end job are blocking; a release builds only after the whole
  CI workflow passes, and fails if electron-builder skips publishing. The macOS Intel runner is `macos-15-intel`.
- The test suites grew from 0.11.1 to: engine 506 tests, 1392 unit tests, 118 end-to-end tests, and an opt-in real-tool suite.

### Documentation

- A rewritten README, this changelog, a project site in `docs/` (generated from the catalog and templates by
  `npm run docs:site`), and three recordings of the real app made by `npm run docs:gifs`.

### Known limitations

- macOS on Apple silicon is the primary tested platform; Windows and Linux builds are published but untested end to end, and the
  real-tool suite has only been run on macOS arm64.
- STAR and a few other tools have no native Apple-silicon build and run as Intel builds, which needs Rosetta.
- Tool versions are pinned but their conda dependencies are not fully locked.
- Commands were validated on synthetic and small real data.
- Builds are not signed; macOS and Windows warn on first start, and macOS does not install updates by itself.
- Mocked steps: no "mock everything downstream"; directory outputs must end in `/`; a step after a mocked step runs for real on
  empty placeholders.
- The run history index can lose a concurrent run's entry (last write wins); a hard-killed run leaves no report.
- A check target covers one output or all of them, not a subset.

[1.0.0-beta.1]: https://github.com/hsn-ylmz/RustRunner/releases/tag/v1.0.0-beta.1
