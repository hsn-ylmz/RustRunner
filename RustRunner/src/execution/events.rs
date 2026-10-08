//! Machine-readable run events
//!
//! With `--json-events` the CLI writes one JSON object per line describing
//! what the run is doing, so a front end does not have to scrape the human
//! log. The human log is unchanged and keeps flowing alongside.
//!
//! # Transport
//!
//! Events go to **stderr**, one per line, each line starting with
//! [`EVENT_PREFIX`] followed by the JSON object. The prefix lets a reader pick
//! the events out of the interleaved log without guessing, and stderr is
//! unbuffered, so every event leaves in a single `write` and cannot be torn by
//! the log lines written next to it. Steps' own output is captured by the
//! engine and never reaches this stream.
//!
//! # Schema (version 1)
//!
//! Every object has `"v": 1`, a `"ts"` (RFC 3339 UTC, milliseconds) and an
//! `"event"` name; the rest depends on the event:
//!
//! | event | fields |
//! |---|---|
//! | `run_started` | `workflow`, `run_id`, `steps` (all step ids), `dry_run` |
//! | `step_started` | `step`, `attempt`, `max_attempts` (one per attempt) |
//! | `step_retrying` | `step`, `attempt` (the one that failed), `max_attempts`, `delay_secs`, `reason` |
//! | `step_succeeded` | `step`, `attempts` |
//! | `step_failed` | `step`, `reason`, `attempts` |
//! | `step_skipped` | `step`, `reason` (`up_to_date` when its outputs are current, else why it was never reached) |
//! | `check_failed` | `step`, `kind`, `blocking`, `message` |
//! | `run_finished` | `status` (`succeeded`, `failed`, `stopped`), `summary`, `report` (optional) |
//!
//! `summary` holds `total`, `succeeded`, `failed`, `skipped`, `retried`,
//! `check_warnings`, `duration_secs` and, unless the run succeeded, `error`.
//! `report` is the absolute path of the run's `report.html` (see
//! [`super::report`]); it is absent for a dry run and when the report could not
//! be written.
//!
//! A step's events always appear in order: `step_started`, then for each failed
//! attempt that will be repeated `step_retrying` followed by `step_started`
//! with the next attempt, then `check_failed` for each failed output check,
//! then exactly one of `step_succeeded` / `step_failed`. `run_finished` is
//! emitted exactly once and is the last event. Adding fields is not a version
//! change; readers must ignore fields they do not know.

use std::io::Write;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;

use chrono::{SecondsFormat, Utc};
use log::warn;
use serde::Serialize;

use super::report::{self, RunContext, RunLog};

/// Marks an event line on stderr.
pub const EVENT_PREFIX: &str = "RUSTRUNNER_EVENT ";

/// Version of the event schema, sent as `"v"` with every event.
pub const SCHEMA_VERSION: u32 = 1;

/// How a run ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RunStatus {
    Succeeded,
    Failed,
    /// Ended by a termination signal (the GUI's Stop).
    Stopped,
}

/// Counters for the end of a run.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct RunSummary {
    /// Steps in the workflow.
    pub total: usize,
    /// Steps that succeeded in this run.
    pub succeeded: usize,
    pub failed: usize,
    /// Steps not run: `up_to_date` (outputs are current), or never reached.
    pub skipped: usize,
    /// Steps that needed more than one attempt.
    pub retried: usize,
    /// Steps that were mocked (counted in `succeeded` too). Absent when none.
    #[serde(skip_serializing_if = "is_zero")]
    pub mocked: usize,
    /// Non-blocking output checks that failed.
    pub check_warnings: usize,
    pub duration_secs: f64,
    /// Why the run did not succeed.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

fn is_false(b: &bool) -> bool {
    !*b
}

fn is_zero(n: &usize) -> bool {
    *n == 0
}

/// One event of a run.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "event", rename_all = "snake_case")]
pub enum Event {
    RunStarted {
        workflow: String,
        run_id: String,
        steps: Vec<String>,
        dry_run: bool,
    },
    StepStarted {
        step: String,
        attempt: u32,
        max_attempts: u32,
    },
    StepRetrying {
        step: String,
        attempt: u32,
        max_attempts: u32,
        delay_secs: u64,
        reason: String,
    },
    StepSucceeded {
        step: String,
        attempts: u32,
        /// The step was mocked: its outputs are placeholders and the tool did
        /// not run. Absent for a real run.
        #[serde(skip_serializing_if = "is_false")]
        mocked: bool,
    },
    StepFailed {
        step: String,
        reason: String,
        attempts: u32,
    },
    StepSkipped {
        step: String,
        reason: String,
    },
    CheckFailed {
        step: String,
        kind: String,
        blocking: bool,
        message: String,
    },
    RunFinished {
        status: RunStatus,
        summary: RunSummary,
        /// Where the run's HTML report was written, if it was.
        #[serde(skip_serializing_if = "Option::is_none")]
        report: Option<String>,
    },
}

/// The wire form of an event: the envelope fields plus the event itself.
#[derive(Serialize)]
struct Envelope<'a> {
    v: u32,
    ts: String,
    #[serde(flatten)]
    event: &'a Event,
}

/// Renders an event as the line written to stderr, without the newline.
pub fn render_line(event: &Event) -> String {
    let envelope = Envelope {
        v: SCHEMA_VERSION,
        ts: Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true),
        event,
    };
    // Serializing plain strings and numbers cannot fail.
    let json = serde_json::to_string(&envelope).unwrap_or_else(|_| "{}".to_string());
    format!("{}{}", EVENT_PREFIX, json)
}

struct Inner {
    /// `None` when events are off.
    writer: Option<Mutex<Box<dyn Write + Send>>>,
    /// Set once `run_finished` has been written.
    finished: AtomicBool,
    /// Running totals, kept even with events off so the engine has one code
    /// path; the CLI's signal handler reads them to report a stopped run.
    tally: Mutex<RunSummary>,
    started: Instant,
    /// Serializes `emit` so that the "nothing after `run_finished`" rule and
    /// the run log see the same order as the writer, with or without one.
    gate: Mutex<()>,
    /// What the events said, kept for the run report.
    log: Mutex<RunLog>,
    /// Where and how to write the run report; `None` for a dry run.
    report: Mutex<Option<RunContext>>,
    /// Held while the run is being finished, so two finishers (the engine and
    /// the signal handler) never race and the loser waits for the winner.
    finishing: Mutex<()>,
}

/// Where run events go. Cheap to clone; clones share the writer and tallies.
///
/// A disabled sink (the default) drops events, so call sites need no checks.
#[derive(Clone)]
pub struct EventSink {
    inner: Arc<Inner>,
}

impl Default for EventSink {
    fn default() -> Self {
        Self::disabled()
    }
}

impl std::fmt::Debug for EventSink {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("EventSink")
            .field("enabled", &self.is_enabled())
            .finish()
    }
}

impl EventSink {
    fn new(writer: Option<Box<dyn Write + Send>>) -> Self {
        Self {
            inner: Arc::new(Inner {
                writer: writer.map(Mutex::new),
                finished: AtomicBool::new(false),
                tally: Mutex::new(RunSummary::default()),
                started: Instant::now(),
                gate: Mutex::new(()),
                log: Mutex::new(RunLog::default()),
                report: Mutex::new(None),
                finishing: Mutex::new(()),
            }),
        }
    }

    /// A sink that drops every event.
    pub fn disabled() -> Self {
        Self::new(None)
    }

    /// A sink that writes prefixed event lines to stderr.
    pub fn stderr() -> Self {
        Self::new(Some(Box::new(std::io::stderr())))
    }

    /// A sink that writes prefixed event lines to `writer`.
    pub fn to_writer(writer: impl Write + Send + 'static) -> Self {
        Self::new(Some(Box::new(writer)))
    }

    /// Whether events are written anywhere.
    pub fn is_enabled(&self) -> bool {
        self.inner.writer.is_some()
    }

    /// Writes one event. A write error (for example a reader that went away)
    /// is ignored: reporting progress must never fail the run itself.
    /// `run_finished` is written at most once, and nothing is written after
    /// it: on a Stop the signal handler finishes the run while worker threads
    /// may still be reporting the steps it is killing.
    ///
    /// Every event is also folded into the run log the report is built from,
    /// whether or not a writer is attached.
    pub fn emit(&self, event: Event) {
        // The flag is checked under the gate, so no event can slip in
        // between `run_finished` being decided and being written.
        let _gate = self.inner.gate.lock().unwrap_or_else(|e| e.into_inner());
        let is_finish = matches!(event, Event::RunFinished { .. });
        if is_finish {
            if self.inner.finished.swap(true, Ordering::SeqCst) {
                return;
            }
        } else if self.inner.finished.load(Ordering::SeqCst) {
            return;
        }
        self.inner
            .log
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .apply(&event, Utc::now());

        let Some(writer) = &self.inner.writer else {
            return;
        };
        let mut line = render_line(&event);
        line.push('\n');
        let mut writer = writer.lock().unwrap_or_else(|e| e.into_inner());
        let _ = writer.write_all(line.as_bytes());
        let _ = writer.flush();
    }

    /// Turns on the run report: when the run finishes, `run.json` and
    /// `report.html` are written to `ctx.runs_dir` and `run_finished` carries
    /// the path. Left off, as for a dry run, nothing is written.
    pub fn enable_report(&self, ctx: RunContext) {
        *self.inner.report.lock().unwrap_or_else(|e| e.into_inner()) = Some(ctx);
    }

    /// Remembers what a failed attempt of `step` wrote to stderr, for the report.
    pub fn note_stderr(&self, step: &str, stderr: &str) {
        self.inner
            .log
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .note_stderr(step, stderr);
    }

    /// Records one resource sample of the engine process, for the report.
    pub fn record_resource(&self, cpu_percent: f32, memory_mb: u64) {
        let t = self.inner.started.elapsed().as_secs_f64();
        self.inner
            .log
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .add_sample(t, cpu_percent, memory_mb);
    }

    /// Updates the running totals.
    pub fn update_tally(&self, update: impl FnOnce(&mut RunSummary)) {
        let mut tally = self.inner.tally.lock().unwrap_or_else(|e| e.into_inner());
        update(&mut tally);
    }

    /// Snapshot of the running totals.
    pub fn tally(&self) -> RunSummary {
        self.inner
            .tally
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }

    /// Emits `run_finished` with the current totals (once; later calls do
    /// nothing). `error` explains a run that did not succeed.
    ///
    /// When the report is enabled it is written first, so the event can name
    /// it. A report that cannot be written is logged and never fails the run.
    pub fn finish(&self, status: RunStatus, error: Option<String>) {
        let _finishing = self
            .inner
            .finishing
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        if self.inner.finished.load(Ordering::SeqCst) {
            return;
        }
        let mut summary = self.tally();
        summary.duration_secs =
            (self.inner.started.elapsed().as_secs_f64() * 1000.0).round() / 1000.0;
        summary.error = error;
        let report = self.write_report(status, &summary);
        self.emit(Event::RunFinished {
            status,
            summary,
            report,
        });
    }

    /// Writes the run report if it is enabled; the path as text on success.
    fn write_report(&self, status: RunStatus, summary: &RunSummary) -> Option<String> {
        let ctx = self
            .inner
            .report
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()?;
        let record = self
            .inner
            .log
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .build_record(&ctx, status, summary.clone(), Utc::now());
        match report::write_run(&ctx.runs_dir, &record) {
            Ok(path) => Some(path.to_string_lossy().into_owned()),
            Err(e) => {
                warn!("Could not write the run report: {}", e);
                None
            }
        }
    }
}

/// A new id for a run: UTC start time plus the process id.
pub fn new_run_id() -> String {
    format!(
        "{}-{}",
        Utc::now().format("%Y%m%dT%H%M%SZ"),
        std::process::id()
    )
}

#[cfg(test)]
pub(crate) mod testing {
    use super::*;

    /// A writer whose contents the test can read back.
    #[derive(Clone, Default)]
    pub struct SharedBuffer(pub Arc<Mutex<Vec<u8>>>);

    impl Write for SharedBuffer {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            self.0.lock().unwrap().extend_from_slice(buf);
            Ok(buf.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    impl SharedBuffer {
        /// The parsed events written so far, in order.
        pub fn events(&self) -> Vec<serde_json::Value> {
            let text = String::from_utf8(self.0.lock().unwrap().clone()).unwrap();
            text.lines()
                .map(|line| {
                    let json = line
                        .strip_prefix(EVENT_PREFIX)
                        .unwrap_or_else(|| panic!("line without prefix: {line}"));
                    serde_json::from_str(json).unwrap()
                })
                .collect()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::testing::SharedBuffer;
    use super::*;

    #[test]
    fn test_line_has_prefix_envelope_and_snake_case_event() {
        let line = render_line(&Event::StepRetrying {
            step: "align".into(),
            attempt: 1,
            max_attempts: 3,
            delay_secs: 5,
            reason: "exit status 2".into(),
        });
        let json = line.strip_prefix(EVENT_PREFIX).expect("prefix");
        assert!(!line.contains('\n'));
        let value: serde_json::Value = serde_json::from_str(json).unwrap();
        assert_eq!(value["v"], 1);
        assert_eq!(value["event"], "step_retrying");
        assert_eq!(value["step"], "align");
        assert_eq!(value["attempt"], 1);
        assert_eq!(value["max_attempts"], 3);
        assert_eq!(value["delay_secs"], 5);
        assert!(value["ts"].as_str().unwrap().ends_with('Z'));
    }

    #[test]
    fn test_strings_with_newlines_and_quotes_stay_on_one_line() {
        let line = render_line(&Event::StepFailed {
            step: "a".into(),
            reason: "line one\nline \"two\"".into(),
            attempts: 1,
        });
        assert_eq!(line.lines().count(), 1);
        let value: serde_json::Value =
            serde_json::from_str(line.strip_prefix(EVENT_PREFIX).unwrap()).unwrap();
        assert_eq!(value["reason"], "line one\nline \"two\"");
    }

    #[test]
    fn test_disabled_sink_writes_nothing_but_keeps_tally() {
        let sink = EventSink::disabled();
        assert!(!sink.is_enabled());
        sink.emit(Event::StepSucceeded {
            step: "a".into(),
            attempts: 1,
            mocked: false,
        });
        sink.update_tally(|t| t.succeeded += 1);
        assert_eq!(sink.tally().succeeded, 1);
    }

    #[test]
    fn test_run_finished_is_written_once() {
        let buf = SharedBuffer::default();
        let sink = EventSink::to_writer(buf.clone());
        sink.update_tally(|t| {
            t.total = 2;
            t.failed = 1;
        });
        sink.finish(RunStatus::Failed, Some("boom".into()));
        sink.finish(RunStatus::Stopped, None);

        let events = buf.events();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0]["event"], "run_finished");
        assert_eq!(events[0]["status"], "failed");
        assert_eq!(events[0]["summary"]["total"], 2);
        assert_eq!(events[0]["summary"]["failed"], 1);
        assert_eq!(events[0]["summary"]["error"], "boom");
    }

    #[test]
    fn test_nothing_is_written_after_run_finished() {
        let buf = SharedBuffer::default();
        let sink = EventSink::to_writer(buf.clone());
        sink.emit(Event::StepStarted {
            step: "a".into(),
            attempt: 1,
            max_attempts: 1,
        });
        sink.finish(RunStatus::Stopped, Some("terminated by a signal".into()));
        // A worker thread reporting the step the Stop just killed.
        sink.clone().emit(Event::StepFailed {
            step: "a".into(),
            reason: "killed".into(),
            attempts: 1,
        });

        let names: Vec<_> = buf
            .events()
            .iter()
            .map(|e| e["event"].as_str().unwrap().to_string())
            .collect();
        assert_eq!(names, vec!["step_started", "run_finished"]);
    }

    #[test]
    fn test_summary_omits_error_on_success() {
        let buf = SharedBuffer::default();
        let sink = EventSink::to_writer(buf.clone());
        sink.finish(RunStatus::Succeeded, None);
        let events = buf.events();
        assert_eq!(events[0]["status"], "succeeded");
        assert!(events[0]["summary"].get("error").is_none());
    }

    #[test]
    fn test_run_id_format() {
        let id = new_run_id();
        assert!(
            id.contains('T') && id.contains('Z') && id.contains('-'),
            "{id}"
        );
    }
}
