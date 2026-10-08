//! Per-run report and run history
//!
//! Every real run (not a dry run) leaves a record of itself in the working
//! directory:
//!
//! ```text
//! <working dir>/.rustrunner/runs/
//!     index.json              newest first, at most MAX_RUNS entries
//!     <run_id>/run.json       summary and one record per step
//!     <run_id>/report.html    the same data as a self-contained page
//! ```
//!
//! The report needs no network and no JavaScript: the CSS is inline and the
//! workflow graph and resource charts are inline SVG.
//!
//! # One source of truth
//!
//! The record is not collected by a second mechanism. The [`EventSink`]
//! (`--json-events`) already sees every step event, so a [`RunLog`] folds those
//! very events into per-step records; the totals are the sink's tally, the
//! duration is the one `run_finished` carries. The only extra inputs are the
//! step definitions (command, threads, dependencies), the stderr tail of a
//! failed attempt and the resource samples the engine's sampling thread
//! already takes.
//!
//! [`EventSink`]: super::events::EventSink
//!
//! # Safety of the HTML
//!
//! Step names, commands, paths, reasons and stderr all come from the workflow
//! file or from the tools it runs, so every dynamic string goes through [`esc`]
//! before it reaches the page; nothing is ever concatenated into markup raw.

use std::collections::HashMap;
use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use chrono::{DateTime, SecondsFormat, Utc};
use log::warn;
use serde::{Deserialize, Serialize};

use super::events::{Event, RunStatus, RunSummary};
use crate::workflow::CheckKind;

/// Directory (below the working directory) that holds every run.
pub const RUNS_DIR: &str = ".rustrunner/runs";

/// Name of the run index inside [`RUNS_DIR`].
pub const INDEX_FILE: &str = "index.json";

/// How many runs are kept. Older runs are removed from the index and their
/// directories deleted.
pub const MAX_RUNS: usize = 50;

/// Version of the `run.json` and `index.json` layouts.
pub const SCHEMA_VERSION: u32 = 1;

/// Longest stderr tail kept for a failed step.
const STDERR_TAIL_LINES: usize = 40;
const STDERR_TAIL_BYTES: usize = 8 * 1024;

/// Resource samples kept in memory (the engine takes two per second).
const MAX_SAMPLES: usize = 20_000;

/// Resource points drawn in the report; longer runs are thinned out.
const CHART_POINTS: usize = 240;

// =============================================================================
// What a run looked like
// =============================================================================

/// What the report knows about a step's definition. Built by the engine from
/// the workflow, so the report does not re-derive anything.
#[derive(Debug, Clone, PartialEq)]
pub struct StepInfo {
    pub id: String,
    pub tool: String,
    pub command: String,
    pub threads: usize,
    /// Ids of the steps this one waits for.
    pub depends_on: Vec<String>,
    /// Output checks the step is configured with: `(kind, description)`.
    pub checks: Vec<(String, String)>,
}

/// Everything about a run that is known before it starts.
#[derive(Debug, Clone, PartialEq)]
pub struct RunContext {
    /// The `.rustrunner/runs` directory the run is stored in.
    pub runs_dir: PathBuf,
    pub workflow_name: String,
    pub workflow_id: Option<String>,
    pub workflow_version: Option<String>,
    pub keep_going: bool,
    pub working_dir: String,
    pub steps: Vec<StepInfo>,
}

/// How a step ended, as the report words it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum StepStatus {
    /// No event was ever reported for the step.
    #[default]
    NotRun,
    /// Started and not finished when the record was made (the run was stopped).
    Interrupted,
    Succeeded,
    Failed,
    /// Up to date, or never reached; `reason` says which.
    Skipped,
}

impl StepStatus {
    /// Words for the page. The status is never conveyed by color alone.
    fn label(self) -> &'static str {
        match self {
            Self::NotRun => "not run",
            Self::Interrupted => "interrupted",
            Self::Succeeded => "succeeded",
            Self::Failed => "failed",
            Self::Skipped => "skipped",
        }
    }

    /// CSS class suffix.
    fn class(self) -> &'static str {
        match self {
            Self::NotRun => "notrun",
            Self::Interrupted => "interrupted",
            Self::Succeeded => "succeeded",
            Self::Failed => "failed",
            Self::Skipped => "skipped",
        }
    }
}

/// The outcome of one configured output check.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CheckRecord {
    pub kind: String,
    pub passed: bool,
    pub blocking: bool,
    /// Why it failed, or what was checked when it passed.
    pub message: String,
    /// Not evaluated because the step was mocked (`passed` is true then).
    #[serde(default, skip_serializing_if = "is_false")]
    pub skipped: bool,
}

fn is_false(b: &bool) -> bool {
    !*b
}

/// One step of a finished run.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct StepRecord {
    pub id: String,
    pub tool: String,
    pub command: String,
    pub threads: usize,
    pub depends_on: Vec<String>,
    pub status: StepStatus,
    /// Attempts used (0 for a step that never ran).
    pub attempts: u32,
    /// The tool did not run: the outputs are placeholders (MOCKED).
    #[serde(default, skip_serializing_if = "is_false")]
    pub mocked: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub started_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duration_secs: Option<f64>,
    /// Why the step failed, or why it was skipped (`up_to_date` when its
    /// outputs were current).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub checks: Vec<CheckRecord>,
    /// Last lines the failed step wrote to stderr.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stderr_tail: Option<String>,
}

/// One resource sample of the engine process.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct ResourceRecord {
    /// Seconds since the run started.
    pub t_secs: f64,
    pub cpu_percent: f32,
    pub memory_mb: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct WorkflowInfo {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
}

/// Contents of `run.json`.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct RunRecord {
    pub schema_version: u32,
    pub run_id: String,
    pub workflow: WorkflowInfo,
    pub status: RunStatus,
    pub started_at: String,
    pub finished_at: String,
    pub duration_secs: f64,
    pub keep_going: bool,
    pub working_dir: String,
    pub summary: RunSummary,
    pub steps: Vec<StepRecord>,
    /// Samples of the engine process, empty when none were taken.
    pub resources: Vec<ResourceRecord>,
}

// =============================================================================
// Folding events into step records
// =============================================================================

#[derive(Debug, Clone, Default)]
struct StepLog {
    status: StepStatus,
    /// Set by `step_started`, cleared when the step ends.
    running: bool,
    attempts: u32,
    mocked: bool,
    started: Option<DateTime<Utc>>,
    ended: Option<DateTime<Utc>>,
    reason: Option<String>,
    /// Failed checks, as `(kind, blocking, message)`.
    failed_checks: Vec<(String, bool, String)>,
    stderr_tail: Option<String>,
}

/// What the event stream said about a run so far.
#[derive(Debug, Clone, Default)]
pub struct RunLog {
    run_id: String,
    started: Option<DateTime<Utc>>,
    steps: HashMap<String, StepLog>,
    samples: Vec<ResourceRecord>,
}

impl RunLog {
    /// Folds one event into the log. `now` is when it was emitted.
    pub fn apply(&mut self, event: &Event, now: DateTime<Utc>) {
        match event {
            Event::RunStarted { run_id, .. } => {
                self.run_id = run_id.clone();
                self.started = Some(now);
            }
            Event::StepStarted { step, attempt, .. } => {
                let log = self.steps.entry(step.clone()).or_default();
                log.started.get_or_insert(now);
                log.running = true;
                log.attempts = log.attempts.max(*attempt);
            }
            Event::StepRetrying { step, attempt, .. } => {
                let log = self.steps.entry(step.clone()).or_default();
                log.attempts = log.attempts.max(*attempt);
            }
            Event::StepSucceeded {
                step,
                attempts,
                mocked,
            } => {
                let log = self.steps.entry(step.clone()).or_default();
                log.status = StepStatus::Succeeded;
                log.mocked = *mocked;
                log.running = false;
                log.attempts = *attempts;
                log.ended = Some(now);
                // A stderr tail left by an attempt that was retried is stale.
                log.stderr_tail = None;
            }
            Event::StepFailed {
                step,
                reason,
                attempts,
            } => {
                let log = self.steps.entry(step.clone()).or_default();
                log.status = StepStatus::Failed;
                log.running = false;
                log.attempts = *attempts;
                log.ended = Some(now);
                log.reason = Some(reason.clone());
            }
            Event::StepSkipped { step, reason } => {
                let log = self.steps.entry(step.clone()).or_default();
                log.status = StepStatus::Skipped;
                log.reason = Some(reason.clone());
            }
            Event::CheckFailed {
                step,
                kind,
                blocking,
                message,
            } => {
                self.steps
                    .entry(step.clone())
                    .or_default()
                    .failed_checks
                    .push((kind.clone(), *blocking, message.clone()));
            }
            // Recorded by `run_finished`'s error; no step to attach it to.
            Event::SetupFailed { .. } => {}
            Event::RunFinished { .. } => {}
        }
    }

    /// Remembers the tail of what a failed attempt wrote to stderr.
    pub fn note_stderr(&mut self, step: &str, stderr: &str) {
        let tail = tail_of(stderr, STDERR_TAIL_LINES, STDERR_TAIL_BYTES);
        self.steps.entry(step.to_string()).or_default().stderr_tail =
            if tail.is_empty() { None } else { Some(tail) };
    }

    /// Adds a resource sample taken `t_secs` after the run started.
    pub fn add_sample(&mut self, t_secs: f64, cpu_percent: f32, memory_mb: u64) {
        if self.samples.len() < MAX_SAMPLES {
            self.samples.push(ResourceRecord {
                t_secs: (t_secs * 1000.0).round() / 1000.0,
                cpu_percent,
                memory_mb,
            });
        }
    }

    /// The record of the run as it stands. A step that started and never
    /// finished is `interrupted`; one that never reported is `not_run`.
    pub fn build_record(
        &self,
        ctx: &RunContext,
        status: RunStatus,
        summary: RunSummary,
        finished: DateTime<Utc>,
    ) -> RunRecord {
        let steps = ctx
            .steps
            .iter()
            .map(|info| self.step_record(info))
            .collect();
        let started = self.started.unwrap_or(finished);
        RunRecord {
            schema_version: SCHEMA_VERSION,
            run_id: self.run_id.clone(),
            workflow: WorkflowInfo {
                name: ctx.workflow_name.clone(),
                id: ctx.workflow_id.clone(),
                version: ctx.workflow_version.clone(),
            },
            status,
            started_at: started.to_rfc3339_opts(SecondsFormat::Millis, true),
            finished_at: finished.to_rfc3339_opts(SecondsFormat::Millis, true),
            duration_secs: summary.duration_secs,
            keep_going: ctx.keep_going,
            working_dir: ctx.working_dir.clone(),
            summary,
            steps,
            resources: self.samples.clone(),
        }
    }

    fn step_record(&self, info: &StepInfo) -> StepRecord {
        let log = self.steps.get(&info.id).cloned().unwrap_or_default();
        let status = match (log.status, log.running) {
            (StepStatus::NotRun, true) => StepStatus::Interrupted,
            (other, _) => other,
        };
        let duration_secs = match (log.started, log.ended) {
            (Some(start), Some(end)) => {
                Some((end - start).num_milliseconds().max(0) as f64 / 1000.0)
            }
            _ => None,
        };

        let mut checks = Vec::new();
        if status == StepStatus::Succeeded {
            // The tool succeeded, so every configured check ran. Each failure
            // event accounts for one configured check of its kind.
            let mut failed: Vec<&(String, bool, String)> = log.failed_checks.iter().collect();
            for (kind, description) in &info.checks {
                if log.mocked && kind_skipped_for_mock(kind) {
                    checks.push(CheckRecord {
                        kind: kind.clone(),
                        passed: true,
                        blocking: !description.contains("(non-blocking)"),
                        message: format!("skipped, the step is mocked ({})", description),
                        skipped: true,
                    });
                    continue;
                }
                match failed.iter().position(|(k, _, _)| k == kind) {
                    Some(i) => {
                        let (kind, blocking, message) = failed.remove(i);
                        checks.push(CheckRecord {
                            kind: kind.clone(),
                            passed: false,
                            blocking: *blocking,
                            message: message.clone(),
                            skipped: false,
                        });
                    }
                    None => checks.push(CheckRecord {
                        kind: kind.clone(),
                        passed: true,
                        blocking: !description.contains("(non-blocking)"),
                        message: description.clone(),
                        skipped: false,
                    }),
                }
            }
            for (kind, blocking, message) in failed {
                checks.push(CheckRecord {
                    kind: kind.clone(),
                    passed: false,
                    blocking: *blocking,
                    message: message.clone(),
                    skipped: false,
                });
            }
        } else {
            // A failed check (blocking) fails the step: show what was reported.
            for (kind, blocking, message) in &log.failed_checks {
                checks.push(CheckRecord {
                    kind: kind.clone(),
                    passed: false,
                    blocking: *blocking,
                    message: message.clone(),
                    skipped: false,
                });
            }
        }

        StepRecord {
            id: info.id.clone(),
            tool: info.tool.clone(),
            command: info.command.clone(),
            threads: info.threads,
            depends_on: info.depends_on.clone(),
            status,
            attempts: log.attempts,
            mocked: log.mocked && status == StepStatus::Succeeded,
            started_at: log
                .started
                .map(|t| t.to_rfc3339_opts(SecondsFormat::Millis, true)),
            duration_secs,
            reason: log.reason,
            checks,
            stderr_tail: if status == StepStatus::Failed {
                log.stderr_tail
            } else {
                None
            },
        }
    }
}

/// Whether the check of this kind (its YAML spelling) is not evaluated on a
/// mocked step; see `checks::skipped_for_mock`.
fn kind_skipped_for_mock(kind: &str) -> bool {
    kind == CheckKind::NonEmpty.as_str() || kind == CheckKind::MinLines.as_str()
}

/// The last `max_lines` lines of `text`, at most `max_bytes` long, with ANSI
/// escape sequences and other control characters removed.
pub fn tail_of(text: &str, max_lines: usize, max_bytes: usize) -> String {
    let clean = strip_control(text);
    let trimmed = clean.trim_end();
    let lines: Vec<&str> = trimmed.lines().collect();
    let start = lines.len().saturating_sub(max_lines);
    let mut tail = lines[start..].join("\n");
    if tail.len() > max_bytes {
        let mut cut = tail.len() - max_bytes;
        while !tail.is_char_boundary(cut) {
            cut += 1;
        }
        tail = format!("...{}", &tail[cut..]);
    }
    tail
}

/// Removes ANSI CSI sequences and control characters other than newline and
/// tab (a progress bar's carriage returns become line breaks).
fn strip_control(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '\u{1b}' => {
                if chars.peek() == Some(&'[') {
                    chars.next();
                    for next in chars.by_ref() {
                        if ('\u{40}'..='\u{7e}').contains(&next) {
                            break;
                        }
                    }
                }
            }
            '\r' => out.push('\n'),
            '\n' | '\t' => out.push(c),
            c if c.is_control() => {}
            c => out.push(c),
        }
    }
    out
}

// =============================================================================
// HTML
// =============================================================================

/// Escapes text for use in HTML content and in double-quoted attributes.
pub fn esc(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            c => out.push(c),
        }
    }
    out
}

/// "850 ms", "12.3 s", "4 min 07 s", "1 h 02 min".
fn fmt_duration(secs: f64) -> String {
    if secs < 1.0 {
        format!("{} ms", (secs * 1000.0).round() as u64)
    } else if secs < 60.0 {
        format!("{:.1} s", secs)
    } else if secs < 3600.0 {
        let total = secs.round() as u64;
        format!("{} min {:02} s", total / 60, total % 60)
    } else {
        let total = (secs / 60.0).round() as u64;
        format!("{} h {:02} min", total / 60, total % 60)
    }
}

fn run_status_label(status: RunStatus) -> &'static str {
    match status {
        RunStatus::Succeeded => "succeeded",
        RunStatus::Failed => "failed",
        RunStatus::Stopped => "stopped",
    }
}

const STYLE: &str = r#"
:root{color-scheme:light dark;--bg:#fafaf9;--fg:#1c1917;--muted:#57534e;--card:#fff;--line:#d6d3d1;
--ok:#15803d;--ok-bg:#dcfce7;--bad:#b91c1c;--bad-bg:#fee2e2;--warn:#a16207;--warn-bg:#fef3c7;
--idle:#57534e;--idle-bg:#f5f5f4;--accent:#1d4ed8}
@media (prefers-color-scheme:dark){:root{--bg:#1c1917;--fg:#f5f5f4;--muted:#a8a29e;--card:#292524;
--line:#44403c;--ok:#4ade80;--ok-bg:#14301d;--bad:#f87171;--bad-bg:#3b1515;--warn:#fbbf24;
--warn-bg:#35280a;--idle:#a8a29e;--idle-bg:#292524;--accent:#93c5fd}}
*{box-sizing:border-box}
body{margin:0;padding:24px 16px 48px;background:var(--bg);color:var(--fg);
font:14px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{max-width:1100px;margin:0 auto}
h1{font-size:22px;margin:0 0 4px}h2{font-size:16px;margin:28px 0 10px}
.sub{color:var(--muted);margin:0 0 16px}
.badge{display:inline-block;padding:1px 10px;border-radius:999px;font-size:13px;font-weight:600;
border:1px solid currentColor;vertical-align:middle;margin-left:8px}
.badge.succeeded{color:var(--ok);background:var(--ok-bg)}
.badge.failed{color:var(--bad);background:var(--bad-bg)}
.badge.stopped,.badge.interrupted{color:var(--warn);background:var(--warn-bg)}
.cards{display:flex;flex-wrap:wrap;gap:8px;margin:12px 0}
.card{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:6px 14px}
.card b{display:block;font-size:20px}.card span{color:var(--muted);font-size:12px}
dl.meta{display:grid;grid-template-columns:max-content 1fr;gap:2px 16px;margin:0}
dl.meta dt{color:var(--muted)}dl.meta dd{margin:0;overflow-wrap:anywhere}
.err{background:var(--bad-bg);color:var(--bad);border:1px solid var(--bad);border-radius:8px;
padding:8px 12px;margin:12px 0;overflow-wrap:anywhere}
.scroll{overflow-x:auto;background:var(--card);border:1px solid var(--line);border-radius:8px}
table{border-collapse:collapse;width:100%}
th,td{text-align:left;padding:6px 10px;border-bottom:1px solid var(--line);vertical-align:top}
th{font-size:12px;color:var(--muted);text-transform:uppercase;letter-spacing:.03em}
tr:last-child td{border-bottom:0}
td.num{text-align:right;white-space:nowrap}
.st{font-weight:600;white-space:nowrap}
.st.succeeded{color:var(--ok)}.st.failed{color:var(--bad)}
.st.skipped,.st.notrun{color:var(--idle)}.st.interrupted{color:var(--warn)}
code,pre{font:12px/1.45 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
pre{margin:6px 0 0;padding:8px 10px;background:var(--idle-bg);border:1px solid var(--line);
border-radius:6px;overflow-x:auto;white-space:pre-wrap;overflow-wrap:anywhere}
details summary{cursor:pointer;color:var(--accent);font-size:12px}
ul.checks{margin:0;padding-left:16px}
.pass{color:var(--ok)}.fail{color:var(--bad)}.skip{color:var(--idle)}
.mock{display:inline-block;padding:0 6px;border:1px solid var(--warn);border-radius:4px;
color:var(--warn);background:var(--warn-bg);font-size:11px;font-weight:700}
.mockbanner{background:var(--warn-bg);color:var(--warn);border:1px solid var(--warn);
border-radius:8px;padding:8px 12px;margin:12px 0}
.failure{background:var(--card);border:1px solid var(--bad);border-radius:8px;padding:10px 14px;margin:0 0 10px}
.failure h3{margin:0 0 4px;font-size:14px}
svg{display:block;max-width:100%;height:auto}
svg text{fill:var(--fg);font:12px system-ui,sans-serif}
svg .sub2{fill:var(--muted);font-size:11px}
svg .edge{fill:none;stroke:var(--muted);stroke-width:1.2}
svg .arrow{fill:var(--muted)}
svg .node rect{fill:var(--idle-bg);stroke:var(--idle);stroke-width:1.5}
svg .node.succeeded rect{fill:var(--ok-bg);stroke:var(--ok)}
svg .node.failed rect{fill:var(--bad-bg);stroke:var(--bad)}
svg .node.interrupted rect{fill:var(--warn-bg);stroke:var(--warn)}
svg .node.skipped rect,svg .node.notrun rect,svg .node.mocked rect{stroke-dasharray:4 3}
svg .axis{stroke:var(--line);stroke-width:1}
svg .cpu{fill:none;stroke:var(--accent);stroke-width:1.5}
svg .mem{fill:none;stroke:var(--warn);stroke-width:1.5}
.note{color:var(--muted);font-size:12px;margin:6px 0 0}
"#;

/// Renders the self-contained report page for a run.
pub fn render_html(run: &RunRecord) -> String {
    let mut h = String::with_capacity(16 * 1024);
    let title = format!("{} - run report", run.workflow.name);
    h.push_str("<!doctype html>\n<html lang=\"en\">\n<head>\n<meta charset=\"utf-8\">\n");
    h.push_str("<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n");
    h.push_str(&format!(
        "<title>{}</title>\n<style>{}</style>\n",
        esc(&title),
        STYLE
    ));
    h.push_str("</head>\n<body>\n<main>\n");

    // Header.
    h.push_str(&format!(
        "<h1>{}<span class=\"badge {}\">{}</span></h1>\n",
        esc(&run.workflow.name),
        run_status_label(run.status),
        run_status_label(run.status)
    ));
    h.push_str(&format!("<p class=\"sub\">Run {}</p>\n", esc(&run.run_id)));

    if let Some(error) = &run.summary.error {
        h.push_str(&format!("<div class=\"err\">{}</div>\n", esc(error)));
    }

    if run.summary.mocked > 0 {
        h.push_str(&format!(
            "<div class=\"mockbanner\"><b>MOCKED:</b> {} step(s) did not run their tool. Their \
             outputs are empty placeholders, so downstream results are not real.</div>\n",
            run.summary.mocked
        ));
    }

    // Totals.
    let s = &run.summary;
    h.push_str("<div class=\"cards\">\n");
    for (value, label) in [
        (s.total, "steps"),
        (s.succeeded, "succeeded"),
        (s.failed, "failed"),
        (s.skipped, "skipped"),
        (s.retried, "retried"),
        (s.check_warnings, "check warnings"),
        (s.mocked, "mocked"),
    ] {
        if label == "mocked" && value == 0 {
            continue;
        }
        h.push_str(&format!(
            "<div class=\"card\"><b>{}</b><span>{}</span></div>\n",
            value, label
        ));
    }
    h.push_str("</div>\n");

    // Facts.
    h.push_str("<dl class=\"meta\">\n");
    let mut fact = |name: &str, value: &str| {
        h.push_str(&format!("<dt>{}</dt><dd>{}</dd>\n", esc(name), esc(value)));
    };
    fact("Started", &run.started_at);
    fact("Finished", &run.finished_at);
    fact("Duration", &fmt_duration(run.duration_secs));
    fact(
        "Keep going after a failure",
        if run.keep_going { "yes" } else { "no" },
    );
    fact("Working directory", &run.working_dir);
    if let Some(id) = &run.workflow.id {
        fact("Workflow id", id);
    }
    if let Some(version) = &run.workflow.version {
        fact("Workflow version", version);
    }
    h.push_str("</dl>\n");

    // Graph.
    h.push_str("<h2>Workflow graph</h2>\n<div class=\"scroll\">\n");
    h.push_str(&render_dag(&run.steps));
    h.push_str("</div>\n");

    // Failures first: that is what a reader came for.
    let failed: Vec<&StepRecord> = run
        .steps
        .iter()
        .filter(|st| st.status == StepStatus::Failed)
        .collect();
    if !failed.is_empty() {
        h.push_str("<h2>Failed steps</h2>\n");
        for st in failed {
            h.push_str("<div class=\"failure\">");
            h.push_str(&format!(
                "<h3>{}</h3><div>{}</div>",
                esc(&st.id),
                esc(st.reason.as_deref().unwrap_or("failed"))
            ));
            match &st.stderr_tail {
                Some(tail) => h.push_str(&format!(
                    "<div class=\"note\">Last lines of stderr</div><pre>{}</pre>",
                    esc(tail)
                )),
                None => h.push_str("<div class=\"note\">No stderr output was captured.</div>"),
            }
            h.push_str("</div>\n");
        }
    }

    // Step table.
    h.push_str("<h2>Steps</h2>\n<div class=\"scroll\"><table>\n<thead><tr>");
    for head in [
        "Step", "Status", "Attempts", "Duration", "Threads", "Tool", "Reason", "Checks",
    ] {
        h.push_str(&format!("<th>{}</th>", head));
    }
    h.push_str("</tr></thead>\n<tbody>\n");
    for st in &run.steps {
        h.push_str("<tr>");
        h.push_str(&format!(
            "<td>{}<details><summary>command</summary><pre>{}</pre></details></td>",
            esc(&st.id),
            esc(&st.command)
        ));
        h.push_str(&format!(
            "<td class=\"st {}\">{}{}</td>",
            st.status.class(),
            st.status.label(),
            if st.mocked {
                " <span class=\"mock\">MOCKED</span>"
            } else {
                ""
            }
        ));
        h.push_str(&format!("<td class=\"num\">{}</td>", st.attempts));
        h.push_str(&format!(
            "<td class=\"num\">{}</td>",
            st.duration_secs.map(fmt_duration).unwrap_or_default()
        ));
        h.push_str(&format!("<td class=\"num\">{}</td>", st.threads));
        h.push_str(&format!("<td>{}</td>", esc(&st.tool)));
        h.push_str(&format!(
            "<td>{}</td>",
            esc(&reason_text(st.status, st.reason.as_deref()))
        ));
        h.push_str("<td>");
        if !st.checks.is_empty() {
            h.push_str("<ul class=\"checks\">");
            for c in &st.checks {
                let (class, mark) = if c.skipped {
                    ("skip", "skipped")
                } else if c.passed {
                    ("pass", "passed")
                } else if c.blocking {
                    ("fail", "FAILED")
                } else {
                    ("fail", "warning")
                };
                h.push_str(&format!(
                    "<li class=\"{}\">{}: {}</li>",
                    class,
                    mark,
                    esc(&c.message)
                ));
            }
            h.push_str("</ul>");
        }
        h.push_str("</td></tr>\n");
    }
    h.push_str("</tbody></table></div>\n");

    // Resources.
    if run.resources.len() >= 2 {
        h.push_str("<h2>Resource usage</h2>\n<div class=\"scroll\">\n");
        h.push_str(&render_resources(&run.resources));
        h.push_str("</div>\n<p class=\"note\">Samples of the rustrunner process itself, not of the tools it starts.</p>\n");
    }

    h.push_str("</main>\n</body>\n</html>\n");
    h
}

/// The wording of the Reason column.
fn reason_text(status: StepStatus, reason: Option<&str>) -> String {
    match (status, reason) {
        (StepStatus::Skipped, Some("up_to_date")) => {
            "up to date: outputs exist and are current".into()
        }
        (_, Some(reason)) => reason.to_string(),
        _ => String::new(),
    }
}

// =============================================================================
// Workflow graph (inline SVG)
// =============================================================================

const NODE_W: f64 = 160.0;
const NODE_H: f64 = 44.0;
const GAP_X: f64 = 56.0;
const GAP_Y: f64 = 16.0;
const PAD: f64 = 16.0;
const LABEL_CHARS: usize = 22;

/// Column of each step: 0 for a step with no dependency, else one more than
/// its deepest dependency. Unknown ids are ignored, and the relaxation is
/// bounded so a cycle (the validator rejects them) cannot loop.
fn layers(steps: &[StepRecord]) -> Vec<usize> {
    let index: HashMap<&str, usize> = steps
        .iter()
        .enumerate()
        .map(|(i, s)| (s.id.as_str(), i))
        .collect();
    let mut depth = vec![0usize; steps.len()];
    for _ in 0..steps.len() {
        let mut changed = false;
        for (i, step) in steps.iter().enumerate() {
            for dep in &step.depends_on {
                if let Some(&d) = index.get(dep.as_str()) {
                    if d != i && depth[i] < depth[d] + 1 && depth[d] < steps.len() {
                        depth[i] = depth[d] + 1;
                        changed = true;
                    }
                }
            }
        }
        if !changed {
            break;
        }
    }
    depth
}

fn truncate_label(text: &str) -> String {
    if text.chars().count() <= LABEL_CHARS {
        text.to_string()
    } else {
        let cut: String = text.chars().take(LABEL_CHARS - 1).collect();
        format!("{}...", cut)
    }
}

/// Draws the steps in columns by depth, left to right, with an arrow from each
/// dependency to the step that waits for it.
pub fn render_dag(steps: &[StepRecord]) -> String {
    if steps.is_empty() {
        return "<p class=\"note\" style=\"padding:8px 12px\">The workflow has no steps.</p>"
            .to_string();
    }
    let depth = layers(steps);
    let columns = depth.iter().copied().max().unwrap_or(0) + 1;
    let mut rows_in_column = vec![0usize; columns];
    let mut pos: Vec<(f64, f64)> = Vec::with_capacity(steps.len());
    for &d in &depth {
        let row = rows_in_column[d];
        rows_in_column[d] += 1;
        pos.push((
            PAD + d as f64 * (NODE_W + GAP_X),
            PAD + row as f64 * (NODE_H + GAP_Y),
        ));
    }
    let max_rows = rows_in_column.iter().copied().max().unwrap_or(1);
    let width = PAD * 2.0 + columns as f64 * NODE_W + (columns - 1) as f64 * GAP_X;
    let height = PAD * 2.0 + max_rows as f64 * NODE_H + (max_rows - 1) as f64 * GAP_Y;

    let index: HashMap<&str, usize> = steps
        .iter()
        .enumerate()
        .map(|(i, s)| (s.id.as_str(), i))
        .collect();

    let mut svg = format!(
        "<svg xmlns=\"http://www.w3.org/2000/svg\" role=\"img\" aria-label=\"Workflow graph\" \
         viewBox=\"0 0 {w} {h}\" width=\"{w}\" height=\"{h}\">\n\
         <defs><marker id=\"arrow\" viewBox=\"0 0 8 8\" refX=\"7\" refY=\"4\" markerWidth=\"7\" \
         markerHeight=\"7\" orient=\"auto\"><path class=\"arrow\" d=\"M0,0 L8,4 L0,8 z\"/></marker></defs>\n",
        w = width,
        h = height
    );
    for (i, step) in steps.iter().enumerate() {
        for dep in &step.depends_on {
            let Some(&d) = index.get(dep.as_str()) else {
                continue;
            };
            if d == i {
                continue;
            }
            let (x1, y1) = (pos[d].0 + NODE_W, pos[d].1 + NODE_H / 2.0);
            let (x2, y2) = (pos[i].0, pos[i].1 + NODE_H / 2.0);
            let mid = (x1 + x2) / 2.0;
            svg.push_str(&format!(
                "<path class=\"edge\" d=\"M{x1},{y1} C{mid},{y1} {mid},{y2} {x2},{y2}\" marker-end=\"url(#arrow)\"/>\n",
                x1 = x1,
                y1 = y1,
                x2 = x2 - 1.0,
                y2 = y2,
                mid = mid
            ));
        }
    }
    for (i, step) in steps.iter().enumerate() {
        let (x, y) = pos[i];
        svg.push_str(&format!(
            "<g class=\"node {class}{mock}\"><title>{full}: {status}</title>\
             <rect x=\"{x}\" y=\"{y}\" width=\"{w}\" height=\"{h}\" rx=\"7\"/>\
             <text x=\"{tx}\" y=\"{ty1}\">{name}</text>\
             <text class=\"sub2\" x=\"{tx}\" y=\"{ty2}\">{status}</text></g>\n",
            class = step.status.class(),
            mock = if step.mocked { " mocked" } else { "" },
            full = esc(&step.id),
            status = if step.mocked {
                "succeeded (MOCKED)"
            } else {
                step.status.label()
            },
            x = x,
            y = y,
            w = NODE_W,
            h = NODE_H,
            tx = x + 10.0,
            ty1 = y + 19.0,
            ty2 = y + 35.0,
            name = esc(&truncate_label(&step.id)),
        ));
    }
    svg.push_str("</svg>");
    svg
}

// =============================================================================
// Resource chart (inline SVG)
// =============================================================================

/// Two small line charts, CPU and memory, over the run's time.
fn render_resources(samples: &[ResourceRecord]) -> String {
    let step = samples.len().div_ceil(CHART_POINTS).max(1);
    let thinned: Vec<&ResourceRecord> = samples.iter().step_by(step).collect();
    let t_max = samples.last().map(|s| s.t_secs).unwrap_or(0.0).max(0.001);
    let cpu_max = samples
        .iter()
        .map(|s| s.cpu_percent as f64)
        .fold(0.0, f64::max)
        .max(1.0);
    let mem_max = samples
        .iter()
        .map(|s| s.memory_mb)
        .max()
        .unwrap_or(0)
        .max(1) as f64;

    let (w, h, pad_l, pad_r, pad_t, pad_b) = (600.0, 110.0, 56.0, 12.0, 10.0, 22.0);
    let chart =
        |title: &str, class: &str, unit: &str, max: f64, value: &dyn Fn(&ResourceRecord) -> f64| {
            let points: Vec<String> = thinned
                .iter()
                .map(|s| {
                    let x = pad_l + (s.t_secs / t_max) * (w - pad_l - pad_r);
                    let y = pad_t + (1.0 - value(s) / max) * (h - pad_t - pad_b);
                    format!("{:.1},{:.1}", x, y)
                })
                .collect();
            format!(
                "<svg xmlns=\"http://www.w3.org/2000/svg\" role=\"img\" aria-label=\"{title}\" \
             viewBox=\"0 0 {w} {h}\" width=\"{w}\" height=\"{h}\">\
             <line class=\"axis\" x1=\"{pl}\" y1=\"{y0}\" x2=\"{x1}\" y2=\"{y0}\"/>\
             <line class=\"axis\" x1=\"{pl}\" y1=\"{pt}\" x2=\"{pl}\" y2=\"{y0}\"/>\
             <text x=\"4\" y=\"{pt4}\">{title}</text>\
             <text class=\"sub2\" x=\"4\" y=\"{pt18}\">max {max:.0} {unit}</text>\
             <text class=\"sub2\" x=\"{pl}\" y=\"{ty}\">0 s</text>\
             <text class=\"sub2\" x=\"{x1}\" y=\"{ty}\" text-anchor=\"end\">{tmax}</text>\
             <polyline class=\"{class}\" points=\"{points}\"/></svg>",
                title = esc(title),
                w = w,
                h = h,
                pl = pad_l,
                pt = pad_t,
                pt4 = pad_t + 4.0,
                pt18 = pad_t + 18.0,
                y0 = h - pad_b,
                x1 = w - pad_r,
                ty = h - 6.0,
                tmax = esc(&fmt_duration(t_max)),
                max = max,
                unit = unit,
                class = class,
                points = points.join(" "),
            )
        };
    format!(
        "{}\n{}",
        chart("CPU", "cpu", "%", cpu_max, &|s| s.cpu_percent as f64),
        chart("Memory", "mem", "MB", mem_max, &|s| s.memory_mb as f64)
    )
}

// =============================================================================
// Storage: run directory, index and pruning
// =============================================================================

/// A line of `index.json`: enough to list a run without opening it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct IndexEntry {
    pub run_id: String,
    pub workflow: String,
    #[serde(default)]
    pub workflow_id: Option<String>,
    pub status: String,
    pub started_at: String,
    #[serde(default)]
    pub finished_at: String,
    #[serde(default)]
    pub duration_secs: f64,
    #[serde(default)]
    pub total: usize,
    #[serde(default)]
    pub succeeded: usize,
    #[serde(default)]
    pub failed: usize,
    #[serde(default)]
    pub skipped: usize,
    #[serde(default)]
    pub keep_going: bool,
    /// Path of the report relative to the runs directory.
    pub report: String,
}

#[derive(Serialize, Deserialize)]
struct IndexFile {
    #[serde(default)]
    version: u32,
    #[serde(default)]
    runs: Vec<IndexEntry>,
}

impl IndexEntry {
    fn from_record(run: &RunRecord) -> Self {
        Self {
            run_id: run.run_id.clone(),
            workflow: run.workflow.name.clone(),
            workflow_id: run.workflow.id.clone(),
            status: run_status_label(run.status).to_string(),
            started_at: run.started_at.clone(),
            finished_at: run.finished_at.clone(),
            duration_secs: run.duration_secs,
            total: run.summary.total,
            succeeded: run.summary.succeeded,
            failed: run.summary.failed,
            skipped: run.summary.skipped,
            keep_going: run.keep_going,
            report: format!("{}/report.html", run.run_id),
        }
    }
}

/// A run id becomes a directory name, and the index may be edited by hand, so
/// only plain names are ever used as one.
pub fn is_safe_run_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 100
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// Writes `contents` to `path` through a temporary file, so a reader (or a
/// process that is killed half way) never sees a partial file.
///
/// The temporary name carries the process id and a per-process counter: two
/// engines finishing in the same working directory at once must not truncate
/// or rename each other's temporary file (the index is then last write wins,
/// but neither write fails).
fn write_atomic(path: &Path, contents: &str) -> io::Result<()> {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let unique = COUNTER.fetch_add(1, Ordering::Relaxed);
    let tmp = path.with_extension(format!("{}-{}.tmp", std::process::id(), unique));
    {
        let mut file = fs::File::create(&tmp)?;
        file.write_all(contents.as_bytes())?;
        file.sync_all()?;
    }
    fs::rename(&tmp, path).inspect_err(|_| {
        let _ = fs::remove_file(&tmp);
    })
}

/// The runs listed in `<runs_dir>/index.json`, newest first. A missing or
/// unreadable index is an empty one.
pub fn read_index(runs_dir: &Path) -> Vec<IndexEntry> {
    let path = runs_dir.join(INDEX_FILE);
    let Ok(text) = fs::read_to_string(&path) else {
        return Vec::new();
    };
    match serde_json::from_str::<IndexFile>(&text) {
        Ok(file) => file.runs,
        Err(e) => {
            warn!("Ignoring unreadable run index {}: {}", path.display(), e);
            Vec::new()
        }
    }
}

/// Stores a run: `run.json`, `report.html` and the index, then prunes runs
/// beyond [`MAX_RUNS`]. Returns the path of the report.
pub fn write_run(runs_dir: &Path, run: &RunRecord) -> io::Result<PathBuf> {
    store_run(runs_dir, run, MAX_RUNS)
}

fn store_run(runs_dir: &Path, run: &RunRecord, max_runs: usize) -> io::Result<PathBuf> {
    if !is_safe_run_id(&run.run_id) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("run id '{}' cannot be used as a directory name", run.run_id),
        ));
    }
    let dir = runs_dir.join(&run.run_id);
    fs::create_dir_all(&dir)?;

    let json = serde_json::to_string_pretty(run).map_err(io::Error::other)?;
    write_atomic(&dir.join("run.json"), &json)?;
    let report = dir.join("report.html");
    write_atomic(&report, &render_html(run))?;

    let mut runs = read_index(runs_dir);
    runs.retain(|r| r.run_id != run.run_id);
    runs.insert(0, IndexEntry::from_record(run));
    let pruned = if runs.len() > max_runs {
        runs.split_off(max_runs)
    } else {
        Vec::new()
    };
    let index = IndexFile {
        version: SCHEMA_VERSION,
        runs,
    };
    let text = serde_json::to_string_pretty(&index).map_err(io::Error::other)?;
    write_atomic(&runs_dir.join(INDEX_FILE), &text)?;

    for old in pruned {
        // Only ever delete a plain directory name that sits directly in the
        // runs directory, whatever the index says.
        if !is_safe_run_id(&old.run_id) {
            continue;
        }
        let old_dir = runs_dir.join(&old.run_id);
        if old_dir.is_dir() {
            if let Err(e) = fs::remove_dir_all(&old_dir) {
                warn!("Could not remove old run {}: {}", old_dir.display(), e);
            }
        }
    }
    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn info(id: &str, deps: &[&str]) -> StepInfo {
        StepInfo {
            id: id.to_string(),
            tool: "bash".to_string(),
            command: format!("echo {}", id),
            threads: 1,
            depends_on: deps.iter().map(|d| d.to_string()).collect(),
            checks: Vec::new(),
        }
    }

    fn context(dir: &Path, steps: Vec<StepInfo>) -> RunContext {
        RunContext {
            runs_dir: dir.to_path_buf(),
            workflow_name: "demo".to_string(),
            workflow_id: Some("demo-id".to_string()),
            workflow_version: None,
            keep_going: false,
            working_dir: "/work".to_string(),
            steps,
        }
    }

    fn record(run_id: &str, ctx: &RunContext, log: &RunLog) -> RunRecord {
        log.build_record(
            ctx,
            RunStatus::Succeeded,
            RunSummary {
                total: ctx.steps.len(),
                duration_secs: 1.5,
                ..RunSummary::default()
            },
            Utc::now(),
        )
        .with_run_id(run_id)
    }

    impl RunRecord {
        fn with_run_id(mut self, id: &str) -> Self {
            self.run_id = id.to_string();
            self
        }
    }

    fn started(run_id: &str) -> Event {
        Event::RunStarted {
            workflow: "demo".into(),
            run_id: run_id.into(),
            steps: vec![],
            dry_run: false,
        }
    }

    #[test]
    fn test_esc_escapes_markup_and_quotes() {
        assert_eq!(
            esc("<script>alert(\"x\" & 'y')</script>"),
            "&lt;script&gt;alert(&quot;x&quot; &amp; &#39;y&#39;)&lt;/script&gt;"
        );
    }

    #[test]
    fn test_log_folds_events_into_step_records() {
        let tmp = tempfile::tempdir().unwrap();
        let ctx = context(
            tmp.path(),
            vec![info("a", &[]), info("b", &["a"]), info("c", &["b"])],
        );
        let mut log = RunLog::default();
        let t0 = Utc::now();
        log.apply(&started("r1"), t0);
        log.apply(
            &Event::StepStarted {
                step: "a".into(),
                attempt: 1,
                max_attempts: 2,
            },
            t0,
        );
        log.apply(
            &Event::StepRetrying {
                step: "a".into(),
                attempt: 1,
                max_attempts: 2,
                delay_secs: 0,
                reason: "x".into(),
            },
            t0,
        );
        log.apply(
            &Event::StepStarted {
                step: "a".into(),
                attempt: 2,
                max_attempts: 2,
            },
            t0,
        );
        log.apply(
            &Event::StepSucceeded {
                step: "a".into(),
                attempts: 2,
                mocked: false,
            },
            t0 + chrono::Duration::milliseconds(2500),
        );
        log.apply(
            &Event::StepStarted {
                step: "b".into(),
                attempt: 1,
                max_attempts: 1,
            },
            t0,
        );
        let rec = record("r1", &ctx, &log);
        assert_eq!(rec.steps[0].status, StepStatus::Succeeded);
        assert_eq!(rec.steps[0].attempts, 2);
        assert_eq!(rec.steps[0].duration_secs, Some(2.5));
        // Started, never finished: the run was cut short.
        assert_eq!(rec.steps[1].status, StepStatus::Interrupted);
        assert_eq!(rec.steps[1].duration_secs, None);
        // Never reported.
        assert_eq!(rec.steps[2].status, StepStatus::NotRun);
        assert_eq!(rec.steps[2].attempts, 0);
    }

    #[test]
    fn test_failed_step_keeps_reason_and_stderr_tail_but_success_drops_it() {
        let tmp = tempfile::tempdir().unwrap();
        let ctx = context(tmp.path(), vec![info("bad", &[]), info("flaky", &[])]);
        let mut log = RunLog::default();
        let now = Utc::now();
        log.note_stderr("bad", "line1\nboom: no such file\n");
        log.apply(
            &Event::StepFailed {
                step: "bad".into(),
                reason: "Step 'bad' failed.".into(),
                attempts: 1,
            },
            now,
        );
        log.note_stderr("flaky", "first attempt noise");
        log.apply(
            &Event::StepSucceeded {
                step: "flaky".into(),
                attempts: 2,
                mocked: false,
            },
            now,
        );
        let rec = record("r1", &ctx, &log);
        assert_eq!(rec.steps[0].reason.as_deref(), Some("Step 'bad' failed."));
        assert_eq!(
            rec.steps[0].stderr_tail.as_deref(),
            Some("line1\nboom: no such file")
        );
        assert_eq!(rec.steps[1].stderr_tail, None);
    }

    #[test]
    fn test_check_results_pair_failures_with_configured_checks() {
        let tmp = tempfile::tempdir().unwrap();
        let mut step = info("s", &[]);
        step.checks = vec![
            ("exists".into(), "exists on all outputs".into()),
            (
                "min_lines".into(),
                "min_lines 5 on all outputs (non-blocking)".into(),
            ),
        ];
        let ctx = context(tmp.path(), vec![step]);
        let mut log = RunLog::default();
        let now = Utc::now();
        log.apply(
            &Event::CheckFailed {
                step: "s".into(),
                kind: "min_lines".into(),
                blocking: false,
                message: "out.txt has 2 lines, expected at least 5".into(),
            },
            now,
        );
        log.apply(
            &Event::StepSucceeded {
                step: "s".into(),
                attempts: 1,
                mocked: false,
            },
            now,
        );
        let rec = record("r1", &ctx, &log);
        let checks = &rec.steps[0].checks;
        assert_eq!(checks.len(), 2);
        assert!(checks[0].passed && checks[0].kind == "exists");
        assert!(!checks[1].passed && !checks[1].blocking);
        assert!(checks[1].message.contains("2 lines"));
    }

    #[test]
    fn test_tail_keeps_last_lines_and_strips_escapes() {
        let text = "a\nb\nc\nd\n";
        assert_eq!(tail_of(text, 2, 1000), "c\nd");
        assert_eq!(tail_of("\u{1b}[31mred\u{1b}[0m\u{7}", 5, 100), "red");
        let long = "x".repeat(100);
        let tail = tail_of(&long, 5, 10);
        assert!(tail.starts_with("...") && tail.len() == 13);
        // Multi-byte characters are never split.
        let tail = tail_of(&"ö".repeat(20), 5, 11);
        assert!(tail.ends_with('ö'));
        assert_eq!(tail_of("", 5, 10), "");
    }

    #[test]
    fn test_layers_follow_the_longest_path() {
        let mk = |id: &str, deps: &[&str]| StepRecord {
            id: id.into(),
            tool: "bash".into(),
            command: String::new(),
            threads: 1,
            depends_on: deps.iter().map(|d| d.to_string()).collect(),
            status: StepStatus::Succeeded,
            attempts: 1,
            mocked: false,
            started_at: None,
            duration_secs: None,
            reason: None,
            checks: vec![],
            stderr_tail: None,
        };
        // d depends on a directly and through b -> c.
        let steps = vec![
            mk("a", &[]),
            mk("b", &["a"]),
            mk("c", &["b"]),
            mk("d", &["a", "c"]),
        ];
        assert_eq!(layers(&steps), vec![0, 1, 2, 3]);
        // Unknown ids and a cycle do not hang or panic.
        let odd = vec![mk("x", &["ghost", "y"]), mk("y", &["x"])];
        let _ = layers(&odd);
        let _ = render_dag(&odd);
    }

    #[test]
    fn test_html_report_lists_steps_and_is_self_contained() {
        let tmp = tempfile::tempdir().unwrap();
        let ctx = context(
            tmp.path(),
            vec![info("first", &[]), info("second", &["first"])],
        );
        let mut log = RunLog::default();
        let now = Utc::now();
        log.apply(&started("r1"), now);
        log.apply(
            &Event::StepSucceeded {
                step: "first".into(),
                attempts: 1,
                mocked: false,
            },
            now,
        );
        log.apply(
            &Event::StepSkipped {
                step: "second".into(),
                reason: "up_to_date".into(),
            },
            now,
        );
        let mut rec = record("r1", &ctx, &log);
        rec.resources = vec![
            ResourceRecord {
                t_secs: 0.5,
                cpu_percent: 1.0,
                memory_mb: 10,
            },
            ResourceRecord {
                t_secs: 1.0,
                cpu_percent: 3.0,
                memory_mb: 12,
            },
        ];
        let html = render_html(&rec);
        assert!(html.starts_with("<!doctype html>"));
        assert!(html.contains("first") && html.contains("second"));
        assert!(html.contains("up to date: outputs exist"));
        assert!(html.contains("<svg") && html.contains("polyline"));
        // Nothing external, no script.
        for forbidden in ["http://", "https://", "<script", "<link", "src="] {
            // The SVG namespace attribute is the only URL and is not fetched.
            let stripped = html.replace("xmlns=\"http://www.w3.org/2000/svg\"", "");
            assert!(!stripped.contains(forbidden), "found {forbidden}");
        }
    }

    #[test]
    fn test_html_escapes_every_user_controlled_string() {
        let tmp = tempfile::tempdir().unwrap();
        let evil = "<script>alert(1)</script>";
        let mut step = info(evil, &[]);
        step.command = format!("echo '{}' > \"{}\"", evil, evil);
        step.tool = evil.to_string();
        step.checks = vec![("exists".into(), evil.into())];
        let mut ctx = context(tmp.path(), vec![step, info("after", &[evil])]);
        ctx.workflow_name = evil.to_string();
        ctx.working_dir = evil.to_string();
        ctx.workflow_id = Some(evil.to_string());
        let mut log = RunLog::default();
        let now = Utc::now();
        log.apply(&started("r1"), now);
        log.note_stderr(evil, evil);
        log.apply(
            &Event::StepFailed {
                step: evil.into(),
                reason: evil.into(),
                attempts: 1,
            },
            now,
        );
        let mut rec = record("r1", &ctx, &log);
        rec.summary.error = Some(evil.to_string());
        let html = render_html(&rec);
        assert!(!html.contains("<script"), "raw script tag leaked");
        assert!(!html.contains("alert(1)</script"));
        assert!(html.contains("&lt;script&gt;alert(1)&lt;/script&gt;"));
    }

    #[test]
    fn test_write_run_creates_files_and_index() {
        let tmp = tempfile::tempdir().unwrap();
        let runs = tmp.path().join(RUNS_DIR);
        let ctx = context(&runs, vec![info("a", &[])]);
        let log = RunLog::default();
        let report = write_run(&runs, &record("20260101T000000Z-1", &ctx, &log)).unwrap();
        assert_eq!(report, runs.join("20260101T000000Z-1/report.html"));
        assert!(report.is_file());
        let json: serde_json::Value = serde_json::from_str(
            &fs::read_to_string(runs.join("20260101T000000Z-1/run.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(json["schema_version"], 1);
        assert_eq!(json["steps"][0]["id"], "a");
        let index = read_index(&runs);
        assert_eq!(index.len(), 1);
        assert_eq!(index[0].report, "20260101T000000Z-1/report.html");
        assert_eq!(index[0].workflow_id.as_deref(), Some("demo-id"));
        // No temporary files are left behind.
        assert!(fs::read_dir(&runs)
            .unwrap()
            .all(|e| { !e.unwrap().file_name().to_string_lossy().ends_with(".tmp") }));
    }

    #[test]
    fn test_index_is_newest_first_and_pruned_with_directories() {
        let tmp = tempfile::tempdir().unwrap();
        let runs = tmp.path().join(RUNS_DIR);
        let ctx = context(&runs, vec![info("a", &[])]);
        let log = RunLog::default();
        for n in 1..=5 {
            store_run(&runs, &record(&format!("run-{n}"), &ctx, &log), 3).unwrap();
        }
        let ids: Vec<_> = read_index(&runs).into_iter().map(|e| e.run_id).collect();
        assert_eq!(ids, vec!["run-5", "run-4", "run-3"]);
        assert!(runs.join("run-3").is_dir());
        assert!(!runs.join("run-2").exists());
        assert!(!runs.join("run-1").exists());
    }

    #[test]
    fn test_pruning_never_deletes_outside_the_runs_directory() {
        let tmp = tempfile::tempdir().unwrap();
        let runs = tmp.path().join(RUNS_DIR);
        let victim = tmp.path().join("precious");
        fs::create_dir_all(&victim).unwrap();
        fs::create_dir_all(&runs).unwrap();
        // A tampered index naming a path outside the runs directory.
        let tampered = serde_json::json!({
            "version": 1,
            "runs": [{
                "run_id": "../../precious", "workflow": "x", "status": "failed",
                "started_at": "", "report": "../../precious/report.html"
            }]
        });
        fs::write(runs.join(INDEX_FILE), tampered.to_string()).unwrap();
        let ctx = context(&runs, vec![info("a", &[])]);
        store_run(&runs, &record("run-1", &ctx, &RunLog::default()), 1).unwrap();
        assert!(victim.is_dir());
    }

    #[test]
    fn test_writes_do_not_collide_with_another_writers_temporary_file() {
        // Another engine process writing the same index at the same moment
        // has its own temporary file in flight; it must not make this run's
        // write fail (that would drop `report` from `run_finished`).
        let tmp = tempfile::tempdir().unwrap();
        let runs = tmp.path().join(RUNS_DIR);
        fs::create_dir_all(runs.join("index.tmp")).unwrap();
        let ctx = context(&runs, vec![info("a", &[])]);
        let report = write_run(&runs, &record("run-1", &ctx, &RunLog::default())).unwrap();
        assert!(report.is_file());
        assert_eq!(read_index(&runs).len(), 1);
        // The foreign file is left alone, and none of ours is left behind.
        assert!(runs.join("index.tmp").is_dir());
        let leftovers: Vec<String> = fs::read_dir(&runs)
            .unwrap()
            .chain(fs::read_dir(runs.join("run-1")).unwrap())
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .filter(|name| name.ends_with(".tmp") && name != "index.tmp")
            .collect();
        assert!(leftovers.is_empty(), "{leftovers:?}");
    }

    #[cfg(unix)]
    #[test]
    fn test_pruning_a_symlinked_run_removes_only_the_link() {
        let tmp = tempfile::tempdir().unwrap();
        let runs = tmp.path().join(RUNS_DIR);
        let victim = tmp.path().join("precious");
        fs::create_dir_all(&victim).unwrap();
        fs::write(victim.join("keep.txt"), "data").unwrap();
        fs::create_dir_all(&runs).unwrap();
        std::os::unix::fs::symlink(&victim, runs.join("run-0")).unwrap();
        let entry = serde_json::json!({
            "version": 1,
            "runs": [{
                "run_id": "run-0", "workflow": "x", "status": "failed",
                "started_at": "", "report": "run-0/report.html"
            }]
        });
        fs::write(runs.join(INDEX_FILE), entry.to_string()).unwrap();
        let ctx = context(&runs, vec![info("a", &[])]);
        store_run(&runs, &record("run-1", &ctx, &RunLog::default()), 1).unwrap();
        assert!(fs::symlink_metadata(runs.join("run-0")).is_err());
        assert_eq!(fs::read_to_string(victim.join("keep.txt")).unwrap(), "data");
    }

    #[test]
    fn test_unsafe_run_id_is_refused_and_a_corrupt_index_is_replaced() {
        let tmp = tempfile::tempdir().unwrap();
        let runs = tmp.path().join(RUNS_DIR);
        let ctx = context(&runs, vec![]);
        let log = RunLog::default();
        assert!(write_run(&runs, &record("../x", &ctx, &log)).is_err());
        assert!(write_run(&runs, &record("", &ctx, &log)).is_err());
        fs::create_dir_all(&runs).unwrap();
        fs::write(runs.join(INDEX_FILE), "{ not json").unwrap();
        write_run(&runs, &record("run-1", &ctx, &log)).unwrap();
        assert_eq!(read_index(&runs).len(), 1);
    }

    #[test]
    fn test_empty_workflow_still_renders() {
        let tmp = tempfile::tempdir().unwrap();
        let ctx = context(tmp.path(), vec![]);
        let html = render_html(&record("r1", &ctx, &RunLog::default()));
        assert!(html.contains("no steps"));
    }
}
