//! Workflow Data Model
//!
//! Core data structures representing workflow steps and their relationships.
//!
//! # Example YAML Format
//!
//! ```yaml
//! steps:
//!   - id: quality_control
//!     tool: fastqc
//!     command: fastqc {input} -o {output}
//!     input: raw_reads.fastq
//!     output: qc_report/
//!     threads: 2
//!
//!   - id: align_reads
//!     tool: bowtie2
//!     command: bowtie2 -x genome -U {input} -S {output}
//!     input: raw_reads.fastq
//!     output: aligned.sam
//!     previous:
//!       - quality_control
//!     threads: 8
//! ```
//!
//! # Named file slots
//!
//! A step can name its files instead of using the single `{input}` and
//! `{output}`. Each slot is a placeholder in the command; the engine fills it
//! with the slot's files, shell-quoted one by one:
//!
//! ```yaml
//! steps:
//!   - id: align
//!     tool: bwa
//!     command: bwa mem {ref} {reads} > {sam}
//!     named_inputs:
//!       ref: [genome.fa]
//!       reads: [trimmed.fastq]
//!     named_outputs:
//!       sam: [aligned.sam]
//! ```
//!
//! Steps without `named_inputs` and `named_outputs` behave exactly as before.
//!
//! An input listed in `optional_slots` may have an empty file list: its
//! placeholder then expands to nothing (the second read file of a pair).
//!
//! # Where the tool comes from
//!
//! A step can carry an `install` block (see
//! [`crate::environment::install::Install`]) so the engine installs exactly
//! the tool the step was made for:
//!
//! ```yaml
//! steps:
//!   - id: align
//!     tool: star
//!     command: STAR --version
//!     install:
//!       kind: conda        # or `external` (checked download) or `system`
//!       package: star
//!       version: 2.7.10b   # an exact pin: the environment is star-2.7.10b
//!       channel: bioconda
//!       osx64: true        # Intel build on Apple silicon
//! ```
//!
//! Steps without `install` keep the original behaviour.

use crate::environment::install::Install;
use serde::de::{self, Deserializer};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::path::Path;

/// How the delay between retry attempts grows.
#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
pub enum RetryBackoff {
    /// Wait `retry_delay_secs` before every retry.
    #[default]
    Fixed,
    /// Wait `retry_delay_secs`, then twice that, then four times, and so on.
    Exponential,
}

impl RetryBackoff {
    /// The YAML spelling of this mode.
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Fixed => "fixed",
            Self::Exponential => "exponential",
        }
    }
}

/// What an output check verifies.
#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CheckKind {
    /// The output path exists.
    Exists,
    /// The output exists and is not empty: a file with at least one byte, or a
    /// directory with at least one entry.
    NonEmpty,
    /// The output is a file with at least `lines` lines.
    MinLines,
}

impl CheckKind {
    /// The YAML spelling of this kind.
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Exists => "exists",
            Self::NonEmpty => "non_empty",
            Self::MinLines => "min_lines",
        }
    }
}

/// A sanity check run on a step's outputs after the step itself succeeded
/// (in the spirit of Dagster asset checks).
///
/// ```yaml
/// checks:
///   - kind: non_empty
///   - kind: min_lines
///     lines: 100
///     target: counts.tsv
///     blocking: false
/// ```
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub struct OutputCheck {
    /// What to verify.
    pub kind: CheckKind,

    /// Required line count for `min_lines` (at least 1); must be absent for
    /// the other kinds.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lines: Option<u64>,

    /// Which output to check: a path spelled exactly as in the step's `output`
    /// or `named_outputs`, or the name of a named output (which checks all of
    /// that slot's files). `None` checks every output.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target: Option<String>,

    /// A failing blocking check fails the step (and so the workflow); a
    /// failing non-blocking check only logs a warning.
    #[serde(default = "default_blocking", skip_serializing_if = "is_true")]
    pub blocking: bool,
}

fn default_blocking() -> bool {
    true
}

fn is_true(b: &bool) -> bool {
    *b
}

impl OutputCheck {
    /// A blocking check of `kind` over all outputs.
    pub fn new(kind: CheckKind) -> Self {
        Self {
            kind,
            lines: None,
            target: None,
            blocking: true,
        }
    }

    /// A blocking "at least `lines` lines" check over all outputs.
    pub fn min_lines(lines: u64) -> Self {
        Self {
            lines: Some(lines),
            ..Self::new(CheckKind::MinLines)
        }
    }

    /// Restricts the check to one output.
    pub fn with_target(mut self, target: impl Into<String>) -> Self {
        self.target = Some(target.into());
        self
    }

    /// Makes a failure only a warning.
    pub fn non_blocking(mut self) -> Self {
        self.blocking = false;
        self
    }

    /// Human-readable description, e.g. `min_lines 10 on counts.tsv`.
    pub fn describe(&self) -> String {
        let mut text = self.kind.as_str().to_string();
        if let Some(n) = self.lines {
            text.push_str(&format!(" {}", n));
        }
        text.push_str(&format!(
            " on {}",
            self.target.as_deref().unwrap_or("all outputs")
        ));
        if !self.blocking {
            text.push_str(" (non-blocking)");
        }
        text
    }

    /// Returns why this check is nonsensical for `step`, if it is.
    pub fn config_problem(&self, step: &Step) -> Option<String> {
        match (self.kind, self.lines) {
            (CheckKind::MinLines, None) => {
                return Some("min_lines needs a `lines` value".to_string())
            }
            (CheckKind::MinLines, Some(0)) => {
                return Some("min_lines with 0 lines can never fail; use at least 1".to_string())
            }
            (CheckKind::Exists | CheckKind::NonEmpty, Some(_)) => {
                return Some(format!(
                    "`lines` only applies to min_lines, not {}",
                    self.kind.as_str()
                ))
            }
            _ => {}
        }
        match &self.target {
            Some(target) if self.target_files(step).is_empty() => Some(format!(
                "target '{}' is not one of the step's outputs",
                target
            )),
            None if step.output_paths().is_empty() => {
                Some("the step has no outputs to check".to_string())
            }
            _ => None,
        }
    }

    /// The files this check looks at on `step`: every output without a
    /// target, the named output's files when the target is a slot name, else
    /// the output spelled exactly like the target.
    pub fn target_files(&self, step: &Step) -> Vec<String> {
        let outputs = step.output_paths();
        match &self.target {
            None => outputs,
            Some(target) => {
                let target = target.trim();
                let mut files: Vec<String> = outputs
                    .iter()
                    .filter(|o| o.as_str() == target)
                    .cloned()
                    .collect();
                if files.is_empty() {
                    if let Some(slot) = step.named_outputs.get(target) {
                        files = slot.clone();
                    }
                }
                files
            }
        }
    }
}

/// Represents a single step in a workflow.
///
/// Each step defines a command to execute, along with its inputs, outputs,
/// and dependencies on other steps.
#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct Step {
    /// Unique identifier for this step (derived from label if using GUI)
    pub id: String,

    /// Tool or command to use (e.g., "bash", "bowtie2", "samtools")
    pub tool: String,

    /// Command template with placeholders.
    /// Supported placeholders: `{input}`, `{output}`, `{inputs}`, `{outputs}`,
    /// `{threads}` and the names of the step's `named_inputs` and
    /// `named_outputs`.
    pub command: String,

    /// Input file(s) for this step
    #[serde(deserialize_with = "single_or_vec", default)]
    pub input: Vec<String>,

    /// Output file(s) produced by this step
    #[serde(deserialize_with = "single_or_vec", default)]
    pub output: Vec<String>,

    /// IDs of steps that must complete before this step can run
    #[serde(default)]
    pub previous: Vec<String>,

    /// IDs of steps that depend on this step (auto-populated)
    #[serde(default)]
    pub next: Vec<String>,

    /// Number of threads/cores this step requires
    #[serde(default = "default_threads")]
    pub threads: usize,

    /// Optional color for GUI visualization
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,

    /// Wildcard file mappings (wildcard_name -> list of concrete files)
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub wildcard_files: HashMap<String, Vec<String>>,

    /// Named input slots: slot name -> files. The command refers to a slot as
    /// `{name}`; every file is shell-quoted. An empty list is a declared slot
    /// that has no file yet (using it in the command is a validation error).
    /// Entries are exact paths: unlike `input`, they are not split at commas.
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub named_inputs: HashMap<String, Vec<String>>,

    /// Named outputs: slot name -> files the step writes. Used as `{name}` in
    /// the command, for freshness, checks and as the source of connections.
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub named_outputs: HashMap<String, Vec<String>>,

    /// How many times a failed (or timed-out) step is re-run before the
    /// workflow gives up. `0` means a single attempt.
    #[serde(default, skip_serializing_if = "is_zero")]
    pub retries: u32,

    /// Whether the delay between retries stays fixed or doubles each time.
    #[serde(default, skip_serializing_if = "is_default_backoff")]
    pub retry_backoff: RetryBackoff,

    /// Base delay in seconds before a retry.
    #[serde(default = "default_retry_delay_secs")]
    pub retry_delay_secs: u64,

    /// Wall-clock limit per attempt in seconds; the step's process group is
    /// killed when it is exceeded. `None` means no limit.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timeout_secs: Option<u64>,

    /// Checks run on the outputs after the step succeeds. Blocking failures
    /// fail the step without re-running the tool.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub checks: Vec<OutputCheck>,

    /// Do not run the tool: create (or touch) the declared outputs instead, so
    /// the rest of the workflow can be tried out without the real tool or its
    /// data. Files are created empty, outputs ending in `/` become
    /// directories. A mocked step never counts as up to date, and neither
    /// does a step after it (its result came from placeholders).
    #[serde(default, skip_serializing_if = "is_false")]
    pub mock: bool,

    /// Where the tool comes from (see [`Install`]): a pinned conda package, a
    /// checked download or a program already on the `PATH`. Without it the
    /// step runs as a system tool, or in the environment `env_map.json` names
    /// for its tool.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub install: Option<Install>,

    /// Named input slots that may stay empty: `{name}` then expands to
    /// nothing instead of being an error. Used for optional files such as
    /// the second read file of a pair.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub optional_slots: Vec<String>,
}

fn is_false(b: &bool) -> bool {
    !*b
}

/// Splits comma-separated entries, trims them and drops empty ones.
pub(crate) fn split_list(entries: &[String]) -> Vec<String> {
    entries
        .iter()
        .flat_map(|s| s.split(','))
        .map(|f| f.trim().to_string())
        .filter(|f| !f.is_empty())
        .collect()
}

/// The files of every slot, ordered by slot name, entries kept exactly.
fn slot_files(slots: &HashMap<String, Vec<String>>) -> Vec<String> {
    let mut names: Vec<&String> = slots.keys().collect();
    names.sort();
    names
        .into_iter()
        .flat_map(|name| slots[name].iter().cloned())
        .filter(|f| !f.trim().is_empty())
        .collect()
}

fn is_zero(n: &u32) -> bool {
    *n == 0
}

fn is_default_backoff(b: &RetryBackoff) -> bool {
    *b == RetryBackoff::Fixed
}

/// Upper bound for any single wait between retries (one hour).
pub const MAX_RETRY_DELAY_SECS: u64 = 3600;

/// Default base delay between retries.
pub const DEFAULT_RETRY_DELAY_SECS: u64 = 5;

fn default_retry_delay_secs() -> u64 {
    DEFAULT_RETRY_DELAY_SECS
}

/// Default thread count for steps that don't specify
fn default_threads() -> usize {
    1
}

/// Deserializes either a single string or array of strings into Vec<String>
fn single_or_vec<'de, D>(deserializer: D) -> Result<Vec<String>, D::Error>
where
    D: Deserializer<'de>,
{
    let val = Value::deserialize(deserializer)?;
    match val {
        Value::Null => Ok(Vec::new()),
        Value::String(s) if s.is_empty() => Ok(Vec::new()),
        Value::String(s) => Ok(vec![s]),
        Value::Array(arr) => arr
            .into_iter()
            .map(|v| match v {
                Value::String(s) => Ok(s),
                _ => Err(de::Error::custom("Expected string in array")),
            })
            .collect(),
        _ => Err(de::Error::custom("Expected string or array of strings")),
    }
}

impl Step {
    /// Creates a new Step with the given parameters.
    ///
    /// # Arguments
    ///
    /// * `id` - Unique identifier
    /// * `tool` - Tool name
    /// * `command` - Command template
    ///
    /// # Example
    ///
    /// ```
    /// use rustrunner::workflow::Step;
    ///
    /// let step = Step::new("align", "bowtie2", "bowtie2 -x ref {input} > {output}")
    ///     .with_input("reads.fastq")
    ///     .with_output("aligned.sam")
    ///     .with_threads(4);
    /// ```
    pub fn new(id: impl Into<String>, tool: impl Into<String>, command: impl Into<String>) -> Self {
        Self {
            id: id.into().trim().to_string(),
            tool: tool.into().trim().to_string(),
            command: command.into().trim().to_string(),
            input: Vec::new(),
            output: Vec::new(),
            previous: Vec::new(),
            next: Vec::new(),
            threads: 1,
            color: None,
            wildcard_files: HashMap::new(),
            named_inputs: HashMap::new(),
            named_outputs: HashMap::new(),
            retries: 0,
            retry_backoff: RetryBackoff::Fixed,
            retry_delay_secs: DEFAULT_RETRY_DELAY_SECS,
            timeout_secs: None,
            checks: Vec::new(),
            mock: false,
            install: None,
            optional_slots: Vec::new(),
        }
    }

    /// Sets where the tool comes from.
    pub fn with_install(mut self, install: Install) -> Self {
        self.install = Some(install);
        self
    }

    /// Marks named input slots as optional.
    pub fn with_optional_slots(mut self, names: &[&str]) -> Self {
        self.optional_slots = names.iter().map(|n| n.to_string()).collect();
        self
    }

    /// Adds an output check.
    pub fn with_check(mut self, check: OutputCheck) -> Self {
        self.checks.push(check);
        self
    }

    /// Whether the step uses named slots. Only such steps get the strict
    /// placeholder rules (unknown or unbound `{name}` is an error, quote
    /// aware filling); every other step keeps the original behaviour.
    pub fn is_structured(&self) -> bool {
        !self.named_inputs.is_empty() || !self.named_outputs.is_empty()
    }

    /// The files of `input`, with comma-separated entries split and trimmed.
    /// This is what `{input}` stands for.
    pub fn plain_inputs(&self) -> Vec<String> {
        split_list(&self.input)
    }

    /// The files of `output`, with comma-separated entries split and trimmed.
    /// This is what `{output}` stands for.
    pub fn plain_outputs(&self) -> Vec<String> {
        split_list(&self.output)
    }

    /// Every input path: `input` first, then the named inputs ordered by slot
    /// name.
    pub fn input_paths(&self) -> Vec<String> {
        let mut paths = self.plain_inputs();
        paths.extend(slot_files(&self.named_inputs));
        paths
    }

    /// Every output path: `output` first, then the named outputs ordered by
    /// slot name. Freshness, checks, mocking and directory creation all use
    /// this list.
    pub fn output_paths(&self) -> Vec<String> {
        let mut paths = self.plain_outputs();
        paths.extend(slot_files(&self.named_outputs));
        paths
    }

    /// Marks the step as mocked: its outputs are created instead of running
    /// the tool.
    pub fn with_mock(mut self, mock: bool) -> Self {
        self.mock = mock;
        self
    }

    /// Sets how many times a failed step is retried.
    pub fn with_retries(mut self, retries: u32) -> Self {
        self.retries = retries;
        self
    }

    /// Sets the retry back-off mode and base delay in seconds.
    pub fn with_retry_backoff(mut self, backoff: RetryBackoff, delay_secs: u64) -> Self {
        self.retry_backoff = backoff;
        self.retry_delay_secs = delay_secs;
        self
    }

    /// Sets the per-attempt timeout in seconds.
    pub fn with_timeout_secs(mut self, secs: u64) -> Self {
        self.timeout_secs = Some(secs);
        self
    }

    /// Delay before retry number `retry` (1 = first retry), capped at
    /// [`MAX_RETRY_DELAY_SECS`].
    pub fn retry_delay(&self, retry: u32) -> std::time::Duration {
        let factor = match self.retry_backoff {
            RetryBackoff::Fixed => 1,
            // 2^(retry-1), saturating so absurd retry counts can't overflow.
            RetryBackoff::Exponential => 1u64
                .checked_shl(retry.saturating_sub(1))
                .unwrap_or(u64::MAX),
        };
        let secs = self.retry_delay_secs.saturating_mul(factor);
        std::time::Duration::from_secs(secs.min(MAX_RETRY_DELAY_SECS))
    }

    /// Sets the input file(s) for this step.
    pub fn with_input(mut self, input: impl Into<String>) -> Self {
        self.input = vec![input.into()];
        self
    }

    /// Sets multiple input files for this step.
    pub fn with_inputs(mut self, inputs: Vec<String>) -> Self {
        self.input = inputs;
        self
    }

    /// Sets the output file(s) for this step.
    pub fn with_output(mut self, output: impl Into<String>) -> Self {
        self.output = vec![output.into()];
        self
    }

    /// Sets multiple output files for this step.
    pub fn with_outputs(mut self, outputs: Vec<String>) -> Self {
        self.output = outputs;
        self
    }

    /// Binds `files` to the named input slot `name`.
    pub fn with_named_input(mut self, name: &str, files: &[&str]) -> Self {
        self.named_inputs.insert(
            name.to_string(),
            files.iter().map(|f| f.to_string()).collect(),
        );
        self
    }

    /// Declares the named output `name` with the files the step writes.
    pub fn with_named_output(mut self, name: &str, files: &[&str]) -> Self {
        self.named_outputs.insert(
            name.to_string(),
            files.iter().map(|f| f.to_string()).collect(),
        );
        self
    }

    /// Sets the thread count for this step.
    pub fn with_threads(mut self, threads: usize) -> Self {
        self.threads = threads;
        self
    }

    /// Adds a dependency on another step.
    pub fn depends_on(mut self, step_id: impl Into<String>) -> Self {
        self.previous.push(step_id.into());
        self
    }

    /// Checks if all output files exist.
    pub fn outputs_exist(&self) -> bool {
        let outputs = self.output_paths();
        !outputs.is_empty() && outputs.iter().all(|f| Path::new(f).exists())
    }

    /// Checks if outputs are outdated compared to inputs.
    ///
    /// Returns true if any input is newer than any output, or if outputs don't exist.
    pub fn outputs_outdated(&self) -> bool {
        use std::fs;

        if !self.outputs_exist() {
            return true;
        }

        // Get newest input modification time
        let newest_input = self
            .input_paths()
            .iter()
            .filter_map(|f| fs::metadata(f).ok())
            .filter_map(|m| m.modified().ok())
            .max();

        // Get oldest output modification time
        let oldest_output = self
            .output_paths()
            .iter()
            .filter_map(|f| fs::metadata(f).ok())
            .filter_map(|m| m.modified().ok())
            .min();

        match (newest_input, oldest_output) {
            (Some(input_time), Some(output_time)) => input_time > output_time,
            _ => true,
        }
    }

    /// Determines if this step should run based on output existence and freshness.
    pub fn should_run(&self, force: bool) -> bool {
        if force {
            return true;
        }
        !self.outputs_exist() || self.outputs_outdated()
    }

    /// Every path pattern of the step: `input`, `output`, and the files of
    /// the named inputs and outputs (slots ordered by name). Wildcards live
    /// in these.
    pub fn pattern_entries(&self) -> Vec<&String> {
        let mut entries: Vec<&String> = self.input.iter().chain(self.output.iter()).collect();
        for map in [&self.named_inputs, &self.named_outputs] {
            let mut slots: Vec<_> = map.iter().collect();
            slots.sort_by(|a, b| a.0.cmp(b.0));
            entries.extend(slots.into_iter().flat_map(|(_, files)| files.iter()));
        }
        entries
    }

    /// Checks if this step has wildcard patterns
    pub fn has_wildcards(&self) -> bool {
        use crate::workflow::wildcards::has_wildcards;

        self.pattern_entries().iter().any(|p| has_wildcards(p)) || has_wildcards(&self.command)
    }

    /// Gets all wildcard names used in this step
    pub fn get_wildcard_names(&self) -> Vec<String> {
        use crate::workflow::wildcards::extract_wildcard_names;
        use std::collections::HashSet;

        let mut names = HashSet::new();
        for entry in self.pattern_entries() {
            names.extend(extract_wildcard_names(entry));
        }

        names.into_iter().collect()
    }

    /// Validates wildcard configuration
    pub fn validate_wildcards(&self) -> Result<(), String> {
        if !self.has_wildcards() {
            return Ok(());
        }

        let wildcard_names = self.get_wildcard_names();

        for name in &wildcard_names {
            if !self.wildcard_files.contains_key(name) {
                return Err(format!(
                    "Step '{}': Wildcard '{{{}}}' has no file mapping",
                    self.id, name
                ));
            }
        }

        if wildcard_names.len() > 1 {
            return Err(format!(
                "Step '{}': Multiple wildcards not supported in v1.0",
                self.id
            ));
        }

        Ok(())
    }
}

/// Longest accepted metadata name or version, in characters.
pub const MAX_METADATA_LEN: usize = 200;

/// Longest accepted workflow id, in characters.
pub const MAX_ID_LEN: usize = 64;

/// Optional descriptive information about a workflow, shown in the run log
/// and recorded in the run summary and the saved run state.
///
/// ```yaml
/// metadata:
///   id: 3f2b8c1e-5a47-4c0e-9d3a-7b1f6e2a9c10
///   name: RNA-seq QC
///   version: "1.2"
/// ```
#[derive(Serialize, Deserialize, Debug, Clone, Default, PartialEq, Eq)]
pub struct WorkflowMetadata {
    /// Stable identifier, generated once by the GUI. The saved run state is
    /// keyed on it, so renaming the workflow or its file keeps the resume
    /// history. Limited to letters, digits, `-` and `_` because it becomes a
    /// file name.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,

    /// Human-readable workflow name.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,

    /// Free-form version label (for example `1.2` or `2024-05-draft`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
}

impl WorkflowMetadata {
    /// Creates metadata with the given name and version.
    pub fn new(name: Option<&str>, version: Option<&str>) -> Self {
        Self {
            id: None,
            name: name.map(String::from),
            version: version.map(String::from),
        }
    }

    /// Sets the stable workflow id.
    pub fn with_id(mut self, id: &str) -> Self {
        self.id = Some(id.to_string());
        self
    }

    /// Trims all fields and turns blank ones into `None`.
    pub fn normalize(&mut self) {
        for field in [&mut self.id, &mut self.name, &mut self.version] {
            if let Some(value) = field.take() {
                let trimmed = value.trim();
                if !trimmed.is_empty() {
                    *field = Some(trimmed.to_string());
                }
            }
        }
    }

    /// Checks the fields are short and free of control characters. Metadata is
    /// echoed into the log, which front ends parse line by line, so a newline
    /// must never get through.
    pub fn validate(&self) -> Result<(), String> {
        if let Some(id) = &self.id {
            if id.chars().count() > MAX_ID_LEN {
                return Err(format!(
                    "Workflow metadata id is longer than {} characters",
                    MAX_ID_LEN
                ));
            }
            if !id
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
            {
                return Err(
                    "Workflow metadata id may only contain letters, digits, '-' and '_'"
                        .to_string(),
                );
            }
        }
        for (label, value) in [("name", &self.name), ("version", &self.version)] {
            let Some(value) = value else { continue };
            if value.chars().count() > MAX_METADATA_LEN {
                return Err(format!(
                    "Workflow metadata {} is longer than {} characters",
                    label, MAX_METADATA_LEN
                ));
            }
            if value.chars().any(char::is_control) {
                return Err(format!(
                    "Workflow metadata {} contains control characters",
                    label
                ));
            }
        }
        Ok(())
    }

    /// True when no id, name or version is set.
    pub fn is_empty(&self) -> bool {
        self.id.is_none() && self.name.is_none() && self.version.is_none()
    }

    /// One-line description such as `RNA-seq QC (version 1.2)`, or `None` when
    /// the metadata is empty.
    pub fn label(&self) -> Option<String> {
        match (&self.name, &self.version) {
            (Some(n), Some(v)) => Some(format!("{} (version {})", n, v)),
            (Some(n), None) => Some(n.clone()),
            (None, Some(v)) => Some(format!("version {}", v)),
            (None, None) => None,
        }
    }
}

/// Represents a complete workflow with multiple steps.
#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct Workflow {
    /// Ordered list of steps in the workflow
    pub steps: Vec<Step>,

    /// Optional name and version of the workflow
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub metadata: Option<WorkflowMetadata>,

    /// Keep going after a failure: a failed step blocks only the steps that
    /// depend on it, and independent branches still run to completion. The
    /// run still ends as failed.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub keep_going: bool,

    /// List of unique tools used (auto-populated)
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tools: Vec<String>,
}

impl Workflow {
    /// Creates a new empty workflow.
    pub fn new() -> Self {
        Self {
            steps: Vec::new(),
            metadata: None,
            keep_going: false,
            tools: Vec::new(),
        }
    }

    /// Creates a workflow from a list of steps.
    pub fn from_steps(steps: Vec<Step>) -> Self {
        let mut workflow = Self {
            steps,
            metadata: None,
            keep_going: false,
            tools: Vec::new(),
        };
        workflow.refresh_tools();
        workflow
    }

    /// Sets the workflow's name and version.
    pub fn with_metadata(mut self, metadata: WorkflowMetadata) -> Self {
        self.metadata = Some(metadata);
        self
    }

    /// Turns keep-going mode on or off.
    pub fn with_keep_going(mut self, keep_going: bool) -> Self {
        self.keep_going = keep_going;
        self
    }

    /// Adds a step to the workflow.
    pub fn add_step(&mut self, step: Step) -> Result<(), String> {
        if self.steps.iter().any(|s| s.id == step.id) {
            return Err(format!("Step '{}' already exists", step.id));
        }
        self.steps.push(step);
        self.refresh_tools();
        Ok(())
    }

    /// Removes a step from the workflow.
    pub fn remove_step(&mut self, id: &str) -> Result<(), String> {
        let index = self
            .steps
            .iter()
            .position(|s| s.id == id)
            .ok_or_else(|| format!("Step '{}' not found", id))?;

        // Remove references to this step from other steps
        for step in &mut self.steps {
            step.previous.retain(|s| s != id);
            step.next.retain(|s| s != id);
        }

        self.steps.remove(index);
        self.refresh_tools();
        Ok(())
    }

    /// Gets a step by ID.
    pub fn get_step(&self, id: &str) -> Option<&Step> {
        self.steps.iter().find(|s| s.id == id)
    }

    /// Gets a mutable reference to a step by ID.
    pub fn get_step_mut(&mut self, id: &str) -> Option<&mut Step> {
        self.steps.iter_mut().find(|s| s.id == id)
    }

    /// Returns steps with no dependencies (entry points).
    pub fn root_steps(&self) -> Vec<&Step> {
        self.steps
            .iter()
            .filter(|s| s.previous.is_empty())
            .collect()
    }

    /// Returns steps with no dependents (exit points).
    pub fn leaf_steps(&self) -> Vec<&Step> {
        self.steps.iter().filter(|s| s.next.is_empty()).collect()
    }

    /// Updates the tools list based on steps.
    pub fn refresh_tools(&mut self) {
        let tool_set: HashSet<_> = self.steps.iter().map(|s| s.tool.clone()).collect();
        self.tools = tool_set.into_iter().collect();
        self.tools.sort();
    }

    /// Returns the number of steps in the workflow.
    pub fn len(&self) -> usize {
        self.steps.len()
    }

    /// Returns true if the workflow has no steps.
    pub fn is_empty(&self) -> bool {
        self.steps.is_empty()
    }
}

impl Default for Workflow {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_old_yaml_without_metadata_has_none() {
        let wf: Workflow =
            serde_yaml::from_str("steps:\n  - id: a\n    tool: bash\n    command: x\n").unwrap();
        assert!(wf.metadata.is_none());
        assert!(!serde_yaml::to_string(&wf).unwrap().contains("metadata"));
    }

    #[test]
    fn test_metadata_parses_and_round_trips() {
        let yaml = "metadata:\n  name: RNA-seq QC\n  version: '1.2'\nsteps:\n  - id: a\n    tool: bash\n    command: x\n";
        let wf: Workflow = serde_yaml::from_str(yaml).unwrap();
        let meta = wf.metadata.clone().unwrap();
        assert_eq!(meta.name.as_deref(), Some("RNA-seq QC"));
        assert_eq!(meta.version.as_deref(), Some("1.2"));
        assert_eq!(meta.label().unwrap(), "RNA-seq QC (version 1.2)");
        let again: Workflow = serde_yaml::from_str(&serde_yaml::to_string(&wf).unwrap()).unwrap();
        assert_eq!(again.metadata, Some(meta));
    }

    #[test]
    fn test_metadata_id_round_trips_and_old_yaml_has_none() {
        let yaml =
            "metadata:\n  id: 3f2b8c1e-5a47\nsteps:\n  - id: a\n    tool: bash\n    command: x\n";
        let wf: Workflow = serde_yaml::from_str(yaml).unwrap();
        let meta = wf.metadata.clone().unwrap();
        assert_eq!(meta.id.as_deref(), Some("3f2b8c1e-5a47"));
        assert!(!meta.is_empty());
        assert_eq!(meta.label(), None);
        let again: Workflow = serde_yaml::from_str(&serde_yaml::to_string(&wf).unwrap()).unwrap();
        assert_eq!(again.metadata, Some(meta));

        let old: WorkflowMetadata = serde_yaml::from_str("name: qc\n").unwrap();
        assert_eq!(old.id, None);
    }

    #[test]
    fn test_metadata_id_must_be_path_safe() {
        for ok in ["abc", "3f2b8c1e-5a47_x", &"a".repeat(MAX_ID_LEN)] {
            assert!(WorkflowMetadata::default().with_id(ok).validate().is_ok());
        }
        for bad in [
            "../evil",
            "a/b",
            "a b",
            "ä",
            "x.state",
            &"a".repeat(MAX_ID_LEN + 1),
        ] {
            assert!(
                WorkflowMetadata::default().with_id(bad).validate().is_err(),
                "{bad}"
            );
        }
        let mut blank = WorkflowMetadata::default().with_id("  ");
        blank.normalize();
        assert!(blank.is_empty());
    }

    #[test]
    fn test_keep_going_defaults_to_false_and_round_trips() {
        let wf: Workflow =
            serde_yaml::from_str("steps:\n  - id: a\n    tool: bash\n    command: x\n").unwrap();
        assert!(!wf.keep_going);
        assert!(!serde_yaml::to_string(&wf).unwrap().contains("keep_going"));

        let on: Workflow = serde_yaml::from_str(
            "keep_going: true\nsteps:\n  - id: a\n    tool: bash\n    command: x\n",
        )
        .unwrap();
        assert!(on.keep_going);
        let again: Workflow = serde_yaml::from_str(&serde_yaml::to_string(&on).unwrap()).unwrap();
        assert!(again.keep_going);
    }

    #[test]
    fn test_metadata_normalize_and_label() {
        let mut meta = WorkflowMetadata::new(Some("  qc  "), Some("   "));
        meta.normalize();
        assert_eq!(meta.name.as_deref(), Some("qc"));
        assert_eq!(meta.version, None);
        assert_eq!(meta.label().as_deref(), Some("qc"));
        let mut blank = WorkflowMetadata::new(Some(" "), None);
        blank.normalize();
        assert!(blank.is_empty());
        assert_eq!(blank.label(), None);
        assert_eq!(
            WorkflowMetadata::new(None, Some("2")).label().as_deref(),
            Some("version 2")
        );
    }

    #[test]
    fn test_metadata_validate_rejects_newlines_and_overlong() {
        assert!(WorkflowMetadata::new(Some("ok"), Some("1"))
            .validate()
            .is_ok());
        assert!(WorkflowMetadata::new(Some("a\nStarting step: x"), None)
            .validate()
            .is_err());
        let long = "x".repeat(MAX_METADATA_LEN + 1);
        assert!(WorkflowMetadata::new(None, Some(&long)).validate().is_err());
    }

    #[test]
    fn test_old_yaml_without_checks_has_none() {
        let step: Step = serde_yaml::from_str("id: a\ntool: bash\ncommand: x\n").unwrap();
        assert!(step.checks.is_empty());
        // And an unchecked step does not serialize the field.
        assert!(!serde_yaml::to_string(&step).unwrap().contains("checks"));
    }

    #[test]
    fn test_checks_parse_with_defaults_and_round_trip() {
        let yaml = "id: a\ntool: bash\ncommand: x\noutput: o.tsv\nchecks:\n\
                    \x20 - kind: exists\n\
                    \x20 - kind: min_lines\n\x20   lines: 10\n\x20   target: o.tsv\n\x20   blocking: false\n";
        let step: Step = serde_yaml::from_str(yaml).unwrap();
        assert_eq!(step.checks[0], OutputCheck::new(CheckKind::Exists));
        assert_eq!(
            step.checks[1],
            OutputCheck::min_lines(10)
                .with_target("o.tsv")
                .non_blocking()
        );
        let again: Step = serde_yaml::from_str(&serde_yaml::to_string(&step).unwrap()).unwrap();
        assert_eq!(again.checks, step.checks);
    }

    #[test]
    fn test_unknown_check_kind_is_rejected() {
        let yaml = "id: a\ntool: bash\ncommand: x\nchecks:\n  - kind: sorted\n";
        assert!(serde_yaml::from_str::<Step>(yaml).is_err());
    }

    #[test]
    fn test_old_yaml_without_retry_fields_gets_defaults() {
        let step: Step = serde_yaml::from_str("id: a\ntool: bash\ncommand: echo hi\n").unwrap();
        assert_eq!(step.retries, 0);
        assert_eq!(step.retry_backoff, RetryBackoff::Fixed);
        assert_eq!(step.retry_delay_secs, DEFAULT_RETRY_DELAY_SECS);
        assert_eq!(step.timeout_secs, None);
    }

    #[test]
    fn test_retry_fields_parse_from_yaml() {
        let yaml = "id: a\ntool: bash\ncommand: x\nretries: 3\n\
                    retry_backoff: exponential\nretry_delay_secs: 2\ntimeout_secs: 90\n";
        let step: Step = serde_yaml::from_str(yaml).unwrap();
        assert_eq!(step.retries, 3);
        assert_eq!(step.retry_backoff, RetryBackoff::Exponential);
        assert_eq!(step.retry_delay_secs, 2);
        assert_eq!(step.timeout_secs, Some(90));
    }

    #[test]
    fn test_unknown_backoff_is_rejected() {
        let yaml = "id: a\ntool: bash\ncommand: x\nretry_backoff: linear\n";
        assert!(serde_yaml::from_str::<Step>(yaml).is_err());
    }

    #[test]
    fn test_default_retry_fields_are_not_serialized_noise() {
        let yaml = serde_yaml::to_string(&Step::new("a", "bash", "echo")).unwrap();
        assert!(!yaml.contains("retries"));
        assert!(!yaml.contains("timeout_secs"));
        let yaml = serde_yaml::to_string(&Step::new("a", "bash", "echo").with_retries(2)).unwrap();
        assert!(yaml.contains("retries: 2"));
    }

    #[test]
    fn test_retry_delay_fixed_and_exponential() {
        let fixed = Step::new("a", "bash", "x").with_retry_backoff(RetryBackoff::Fixed, 5);
        assert_eq!(fixed.retry_delay(1).as_secs(), 5);
        assert_eq!(fixed.retry_delay(4).as_secs(), 5);

        let exp = Step::new("a", "bash", "x").with_retry_backoff(RetryBackoff::Exponential, 5);
        assert_eq!(exp.retry_delay(1).as_secs(), 5);
        assert_eq!(exp.retry_delay(2).as_secs(), 10);
        assert_eq!(exp.retry_delay(4).as_secs(), 40);
    }

    #[test]
    fn test_retry_delay_is_capped_and_never_overflows() {
        let exp = Step::new("a", "bash", "x").with_retry_backoff(RetryBackoff::Exponential, 5);
        assert_eq!(exp.retry_delay(200).as_secs(), MAX_RETRY_DELAY_SECS);
        assert_eq!(exp.retry_delay(u32::MAX).as_secs(), MAX_RETRY_DELAY_SECS);
    }

    #[test]
    fn test_step_creation() {
        let step = Step::new("test", "bash", "echo hello")
            .with_input("input.txt")
            .with_output("output.txt")
            .with_threads(2);

        assert_eq!(step.id, "test");
        assert_eq!(step.tool, "bash");
        assert_eq!(step.threads, 2);
        assert_eq!(step.input, vec!["input.txt"]);
        assert_eq!(step.output, vec!["output.txt"]);
    }

    #[test]
    fn test_workflow_add_step() {
        let mut workflow = Workflow::new();
        let step = Step::new("step1", "bash", "echo test");

        assert!(workflow.add_step(step.clone()).is_ok());
        assert!(workflow.add_step(step).is_err()); // Duplicate
        assert_eq!(workflow.len(), 1);
    }

    #[test]
    fn test_workflow_root_leaf_detection() {
        let mut workflow = Workflow::new();
        workflow
            .add_step(Step::new("root", "bash", "echo root"))
            .unwrap();
        workflow
            .add_step(Step::new("leaf", "bash", "echo leaf").depends_on("root"))
            .unwrap();

        // Update next references
        if let Some(root) = workflow.get_step_mut("root") {
            root.next.push("leaf".to_string());
        }

        assert_eq!(workflow.root_steps().len(), 1);
        assert_eq!(workflow.leaf_steps().len(), 1);
        assert_eq!(workflow.root_steps()[0].id, "root");
        assert_eq!(workflow.leaf_steps()[0].id, "leaf");
    }

    #[test]
    fn test_step_outputs_exist() {
        use tempfile::tempdir;

        let temp_dir = tempdir().unwrap();
        let output_file = temp_dir.path().join("output.txt");
        std::fs::write(&output_file, "test").unwrap();

        let step =
            Step::new("test", "bash", "echo test").with_output(output_file.to_str().unwrap());

        assert!(step.outputs_exist());
    }

    #[test]
    fn test_step_outputs_not_exist() {
        let step = Step::new("test", "bash", "echo test").with_output("/nonexistent/path/file.txt");

        assert!(!step.outputs_exist());
    }

    #[test]
    fn test_step_outputs_empty() {
        let step = Step::new("test", "bash", "echo test");
        assert!(!step.outputs_exist());
    }

    #[test]
    fn test_step_outputs_outdated() {
        use std::thread;
        use std::time::Duration;
        use tempfile::tempdir;

        let temp_dir = tempdir().unwrap();
        let input_file = temp_dir.path().join("input.txt");
        let output_file = temp_dir.path().join("output.txt");

        // Create output first
        std::fs::write(&output_file, "output").unwrap();

        // Wait and create input (newer)
        thread::sleep(Duration::from_millis(100));
        std::fs::write(&input_file, "input").unwrap();

        let step = Step::new("test", "bash", "cat {input} > {output}")
            .with_input(input_file.to_str().unwrap())
            .with_output(output_file.to_str().unwrap());

        assert!(step.outputs_outdated());
    }

    #[test]
    fn test_step_should_run_force() {
        let step = Step::new("test", "bash", "echo test");
        assert!(step.should_run(true));
    }

    #[test]
    fn test_step_should_run_no_outputs() {
        let step = Step::new("test", "bash", "echo test").with_output("/nonexistent/file.txt");
        assert!(step.should_run(false));
    }

    #[test]
    fn test_step_multiple_inputs_outputs() {
        let step = Step::new("test", "bash", "cat {inputs} > {output}")
            .with_inputs(vec!["file1.txt".to_string(), "file2.txt".to_string()])
            .with_outputs(vec!["out1.txt".to_string(), "out2.txt".to_string()]);

        assert_eq!(step.input.len(), 2);
        assert_eq!(step.output.len(), 2);
    }

    #[test]
    fn test_step_depends_on_multiple() {
        let step = Step::new("test", "bash", "echo test")
            .depends_on("parent1")
            .depends_on("parent2");

        assert_eq!(step.previous.len(), 2);
        assert!(step.previous.contains(&"parent1".to_string()));
        assert!(step.previous.contains(&"parent2".to_string()));
    }

    #[test]
    fn test_workflow_is_empty() {
        let workflow = Workflow::new();
        assert!(workflow.is_empty());
        assert_eq!(workflow.len(), 0);
    }

    #[test]
    fn test_workflow_not_empty() {
        let mut workflow = Workflow::new();
        workflow
            .add_step(Step::new("test", "bash", "echo test"))
            .unwrap();

        assert!(!workflow.is_empty());
        assert_eq!(workflow.len(), 1);
    }

    #[test]
    fn test_workflow_get_step_mut() {
        let mut workflow = Workflow::new();
        workflow
            .add_step(Step::new("test", "bash", "echo test"))
            .unwrap();

        let step_mut = workflow.get_step_mut("test");
        assert!(step_mut.is_some());

        step_mut.unwrap().command = "echo modified".to_string();

        assert_eq!(workflow.get_step("test").unwrap().command, "echo modified");
    }

    #[test]
    fn test_workflow_get_step_none() {
        let workflow = Workflow::new();
        assert!(workflow.get_step("nonexistent").is_none());
    }

    #[test]
    fn test_workflow_from_steps() {
        let steps = vec![
            Step::new("step1", "bash", "echo 1"),
            Step::new("step2", "python", "print(2)"),
        ];

        let workflow = Workflow::from_steps(steps);
        assert_eq!(workflow.len(), 2);
        assert_eq!(workflow.tools.len(), 2);
    }

    #[test]
    fn test_workflow_remove_step() {
        let mut workflow = Workflow::new();
        workflow
            .add_step(Step::new("step1", "bash", "echo 1"))
            .unwrap();
        workflow
            .add_step(Step::new("step2", "bash", "echo 2"))
            .unwrap();

        assert!(workflow.remove_step("step1").is_ok());
        assert_eq!(workflow.len(), 1);
        assert_eq!(workflow.steps[0].id, "step2");
    }

    #[test]
    fn test_workflow_remove_nonexistent_step() {
        let mut workflow = Workflow::new();
        assert!(workflow.remove_step("nonexistent").is_err());
    }

    #[test]
    fn test_workflow_remove_cleans_references() {
        let mut workflow = Workflow::new();
        let mut step1 = Step::new("step1", "bash", "echo 1");
        let mut step2 = Step::new("step2", "bash", "echo 2");

        step2.previous = vec!["step1".to_string()];
        step1.next = vec!["step2".to_string()];

        workflow.steps.push(step1);
        workflow.steps.push(step2);

        workflow.remove_step("step1").unwrap();
        assert!(workflow.steps[0].previous.is_empty());
    }

    #[test]
    fn test_workflow_refresh_tools() {
        let steps = vec![
            Step::new("step1", "bash", "echo 1"),
            Step::new("step2", "python", "print(2)"),
            Step::new("step3", "bash", "echo 3"),
        ];

        let workflow = Workflow::from_steps(steps);
        assert_eq!(workflow.tools.len(), 2);
        assert!(workflow.tools.contains(&"bash".to_string()));
        assert!(workflow.tools.contains(&"python".to_string()));
    }

    #[test]
    fn test_workflow_default() {
        let workflow = Workflow::default();
        assert!(workflow.is_empty());
    }

    #[test]
    fn test_step_has_wildcards() {
        let step = Step::new("test", "bash", "cat {sample}.fastq").with_input("{sample}.fastq");
        assert!(step.has_wildcards());

        let step2 = Step::new("test2", "bash", "echo hello").with_input("regular.txt");
        assert!(!step2.has_wildcards());
    }

    #[test]
    fn test_step_get_wildcard_names() {
        let step = Step::new("test", "bash", "cat {input}")
            .with_input("{sample}.fastq")
            .with_output("{sample}.bam");

        let names = step.get_wildcard_names();
        assert!(names.contains(&"sample".to_string()));
    }

    #[test]
    fn test_step_validate_wildcards_ok() {
        let mut step = Step::new("test", "bash", "cat {input}")
            .with_input("{sample}.fastq")
            .with_output("{sample}.bam");

        step.wildcard_files.insert(
            "sample".to_string(),
            vec!["s1.fastq".to_string(), "s2.fastq".to_string()],
        );

        assert!(step.validate_wildcards().is_ok());
    }

    #[test]
    fn test_step_validate_wildcards_missing_mapping() {
        let step = Step::new("test", "bash", "cat {input}")
            .with_input("{sample}.fastq")
            .with_output("{sample}.bam");

        let result = step.validate_wildcards();
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("no file mapping"));
    }

    #[test]
    fn test_step_validate_wildcards_none() {
        let step = Step::new("test", "bash", "echo hello");
        assert!(step.validate_wildcards().is_ok());
    }

    // ---- named slots ----

    #[test]
    fn test_named_slots_round_trip_through_yaml() {
        let step = Step::new("align", "bwa", "bwa mem {ref} {reads} > {sam}")
            .with_named_input("ref", &["genome.fa"])
            .with_named_input("reads", &["a b.fq", "c.fq"])
            .with_named_input("unbound", &[])
            .with_named_output("sam", &["out.sam"]);
        let yaml = serde_yaml::to_string(&step).unwrap();
        assert!(yaml.contains("named_inputs"), "{yaml}");
        assert!(yaml.contains("named_outputs"), "{yaml}");
        let back: Step = serde_yaml::from_str(&yaml).unwrap();
        assert_eq!(back.named_inputs["reads"], vec!["a b.fq", "c.fq"]);
        // A declared slot with no file survives, so the engine can name it.
        assert!(back.named_inputs["unbound"].is_empty());
        assert_eq!(back.named_outputs["sam"], vec!["out.sam"]);
    }

    #[test]
    fn test_steps_without_slots_serialize_and_load_as_before() {
        let step = Step::new("a", "bash", "echo {input}").with_input("x");
        let yaml = serde_yaml::to_string(&step).unwrap();
        assert!(!yaml.contains("named_"), "{yaml}");
        // Old YAML has no slot keys at all.
        let old = "id: a\ntool: bash\ncommand: echo hi\n";
        let step: Step = serde_yaml::from_str(old).unwrap();
        assert!(step.named_inputs.is_empty() && step.named_outputs.is_empty());
        assert!(!step.is_structured());
    }

    #[test]
    fn test_input_and_output_paths_include_named_slots_in_name_order() {
        let step = Step::new("s", "bash", "true")
            .with_inputs(vec!["a.txt, b.txt".to_string()])
            .with_named_input("zeta", &["z,1.txt"])
            .with_named_input("alpha", &["al.txt", " "])
            .with_outputs(vec!["o1".to_string()])
            .with_named_output("bam", &["x.bam"]);
        // `input` is split at commas; slot entries are exact; blanks dropped.
        assert_eq!(
            step.input_paths(),
            vec!["a.txt", "b.txt", "al.txt", "z,1.txt"]
        );
        assert_eq!(step.output_paths(), vec!["o1", "x.bam"]);
        assert_eq!(step.plain_inputs(), vec!["a.txt", "b.txt"]);
        assert_eq!(step.plain_outputs(), vec!["o1"]);
    }

    #[test]
    fn test_outputs_exist_counts_named_outputs() {
        let dir = tempfile::tempdir().unwrap();
        let present = dir.path().join("a.bam");
        std::fs::write(&present, "x").unwrap();
        let missing = dir.path().join("a.bai");
        let step = Step::new("s", "bash", "true")
            .with_named_output("bam", &[present.to_str().unwrap()])
            .with_named_output("bai", &[missing.to_str().unwrap()]);
        assert!(!step.outputs_exist());
        std::fs::write(&missing, "x").unwrap();
        assert!(step.outputs_exist());
    }

    #[test]
    fn test_wildcards_in_slots_are_found() {
        let step = Step::new("s", "bash", "cat {f}").with_named_input("f", &["d/{sample}.txt"]);
        assert!(step.has_wildcards());
        assert_eq!(step.get_wildcard_names(), vec!["sample"]);
        assert!(step.validate_wildcards().is_err());
    }

    #[test]
    fn test_check_target_may_be_a_named_output() {
        let step = Step::new("s", "bash", "true")
            .with_named_output("bam", &["a.bam"])
            .with_named_output("counts", &["c1.tsv", "c2.tsv"]);
        let by_slot = OutputCheck::new(CheckKind::Exists).with_target("counts");
        assert!(by_slot.config_problem(&step).is_none());
        assert_eq!(by_slot.target_files(&step), vec!["c1.tsv", "c2.tsv"]);
        let by_path = OutputCheck::new(CheckKind::Exists).with_target("a.bam");
        assert!(by_path.config_problem(&step).is_none());
        assert_eq!(by_path.target_files(&step), vec!["a.bam"]);
        let none = OutputCheck::new(CheckKind::Exists);
        assert_eq!(none.target_files(&step).len(), 3);
        let bad = OutputCheck::new(CheckKind::Exists).with_target("nope");
        assert!(bad.config_problem(&step).is_some());
    }
}
