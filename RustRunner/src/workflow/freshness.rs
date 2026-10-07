//! Up-to-date checks (Snakemake-style).
//!
//! A step can be skipped when running it again would change nothing. That is
//! the case when all of the following hold:
//!
//! 1. the step finished successfully before, including its blocking output
//!    checks (it is in the state's `completed_steps`);
//! 2. a hash of the step's effective definition matches the hash the state
//!    recorded when the step last succeeded;
//! 3. it declares outputs, and all of them exist;
//! 4. no input is newer than the oldest output;
//! 5. none of the steps it depends on has to run.
//!
//! Anything else makes the step stale and it runs, together with everything
//! downstream of it. [`assess`] returns the stale steps with the first reason
//! found, which the engine logs and the dry run prints.

use std::collections::{BTreeMap, HashMap};
use std::fmt;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

use serde::Serialize;

use super::model::{OutputCheck, Step, Workflow};
use super::state::WorkflowState;

/// Why a step has to run.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StaleReason {
    /// The step is mocked: it only creates placeholder outputs, so it runs
    /// every time and is never recorded as done.
    Mocked,
    /// The state has no successful earlier run of the step.
    NotCompleted,
    /// The step succeeded before, but the state holds no definition hash for
    /// it (a state file written by an older version): treated as unknown.
    DefinitionUnknown,
    /// The command, tool, environment, threads, inputs, outputs or checks
    /// differ from the last successful run.
    DefinitionChanged,
    /// The step declares no outputs, so there is nothing to compare.
    NoOutputs,
    /// A declared output does not exist (the path is named).
    OutputsMissing(String),
    /// An input was modified after the oldest output (the input is named).
    InputNewer(String),
    /// A step this one depends on has to run.
    Upstream(String),
}

impl fmt::Display for StaleReason {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            StaleReason::Mocked => write!(f, "mocked (placeholder outputs, never up to date)"),
            StaleReason::NotCompleted => write!(f, "not completed in an earlier run"),
            StaleReason::DefinitionUnknown => {
                write!(f, "definition unknown (saved by an older version)")
            }
            StaleReason::DefinitionChanged => write!(f, "definition changed"),
            StaleReason::NoOutputs => write!(f, "no declared outputs"),
            StaleReason::OutputsMissing(path) => write!(f, "outputs missing ({})", path),
            StaleReason::InputNewer(path) => write!(f, "input newer ({})", path),
            StaleReason::Upstream(step) => write!(f, "upstream step '{}' will run", step),
        }
    }
}

/// The parts of a step that decide what it produces. Retries, timeouts and
/// colours are left out: they change how a step runs, not what it computes.
#[derive(Serialize)]
struct Definition<'a> {
    tool: &'a str,
    command: &'a str,
    /// Conda environment the tool is mapped to, if any.
    env: Option<&'a str>,
    threads: usize,
    input: &'a [String],
    output: &'a [String],
    checks: &'a [OutputCheck],
    /// Named slots are ordered by name (a `HashMap` would hash differently on
    /// every run) and left out when empty, so the hash of a step without
    /// slots is the one recorded before slots existed.
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    named_inputs: BTreeMap<&'a str, &'a [String]>,
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    named_outputs: BTreeMap<&'a str, &'a [String]>,
    /// Content digest of each bundled file the command runs
    /// (`{app_resource:...}`), so an app update that changes a script runs the
    /// step again. Left out when the command names none.
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    resources: BTreeMap<String, String>,
}

/// Hash of a step's effective definition, as recorded in the run state.
///
/// Wildcard steps are hashed after expansion, so each expanded step has its
/// own hash. `env` is the conda environment mapped to the step's tool.
///
/// The hash is FNV-1a (64 bit) over a canonical JSON form. It has to stay
/// stable across Rust versions because it is stored on disk, which rules out
/// `DefaultHasher`; it is not a security feature.
pub fn definition_hash(step: &Step, env: Option<&str>) -> String {
    let definition = Definition {
        tool: &step.tool,
        command: &step.command,
        env,
        threads: step.threads,
        input: &step.input,
        output: &step.output,
        checks: &step.checks,
        named_inputs: ordered(&step.named_inputs),
        named_outputs: ordered(&step.named_outputs),
        resources: if step.is_structured() {
            super::resources::digests(&step.command)
        } else {
            BTreeMap::new()
        },
    };
    // Serializing plain strings and numbers cannot fail.
    let canonical = serde_json::to_string(&definition).unwrap_or_default();

    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in canonical.bytes() {
        hash ^= u64::from(byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("{:016x}", hash)
}

fn ordered(slots: &HashMap<String, Vec<String>>) -> BTreeMap<&str, &[String]> {
    slots
        .iter()
        .map(|(name, files)| (name.as_str(), files.as_slice()))
        .collect()
}

/// Resolves exact paths (named slot files, which are never split at commas)
/// against `base`.
fn resolve_exact(entries: &[String], base: Option<&Path>) -> Vec<(String, PathBuf)> {
    entries
        .iter()
        .filter(|f| !f.trim().is_empty())
        .map(|f| {
            let path = match base {
                Some(base) => base.join(f),
                None => PathBuf::from(f),
            };
            (f.clone(), path)
        })
        .collect()
}

/// Every output of the step with its resolved path: `output` (split at
/// commas) and then the named outputs.
fn output_files(step: &Step, base: Option<&Path>) -> Vec<(String, PathBuf)> {
    let mut files = resolve_paths(&step.output, base);
    files.extend(resolve_exact(&named_files(&step.named_outputs), base));
    files
}

/// Every input of the step with its resolved path.
fn input_files(step: &Step, base: Option<&Path>) -> Vec<(String, PathBuf)> {
    let mut files = resolve_paths(&step.input, base);
    files.extend(resolve_exact(&named_files(&step.named_inputs), base));
    files
}

/// The files of all slots, ordered by slot name.
fn named_files(slots: &HashMap<String, Vec<String>>) -> Vec<String> {
    ordered(slots)
        .into_values()
        .flat_map(|files| files.iter().cloned())
        .collect()
}

/// Splits a comma-separated list of paths and resolves relative ones against
/// `base` (the directory the steps run in).
fn resolve_paths(entries: &[String], base: Option<&Path>) -> Vec<(String, PathBuf)> {
    entries
        .iter()
        .flat_map(|s| s.split(','))
        .map(str::trim)
        .filter(|f| !f.is_empty())
        .map(|f| {
            let path = match base {
                Some(base) => base.join(f),
                None => PathBuf::from(f),
            };
            (f.to_string(), path)
        })
        .collect()
}

fn modified(path: &Path) -> Option<SystemTime> {
    fs::metadata(path).and_then(|m| m.modified()).ok()
}

/// Checks the step's own files: outputs exist and none is older than an input.
fn file_staleness(step: &Step, base: Option<&Path>) -> Option<StaleReason> {
    let outputs = output_files(step, base);
    if outputs.is_empty() {
        return Some(StaleReason::NoOutputs);
    }

    let mut oldest_output: Option<SystemTime> = None;
    for (name, path) in &outputs {
        match modified(path) {
            Some(time) => {
                oldest_output = Some(oldest_output.map_or(time, |old| old.min(time)));
            }
            None => return Some(StaleReason::OutputsMissing(name.clone())),
        }
    }
    let oldest_output = oldest_output?;

    // An input that does not exist cannot be compared. If it is produced by
    // an upstream step, that step's own checks cover it; if the step really
    // needs it, running the step reports the problem.
    input_files(step, base)
        .into_iter()
        .find(|(_, path)| modified(path).is_some_and(|time| time > oldest_output))
        .map(|(name, _)| StaleReason::InputNewer(name))
}

/// Why a step has to run on its own account, ignoring its dependencies.
fn own_staleness(
    step: &Step,
    state: &WorkflowState,
    base: Option<&Path>,
    env_of: &dyn Fn(&Step) -> Option<String>,
) -> Option<StaleReason> {
    if step.mock {
        return Some(StaleReason::Mocked);
    }
    if !state.completed_steps.contains(&step.id) {
        return Some(StaleReason::NotCompleted);
    }
    match state.step_hashes.get(&step.id) {
        None => return Some(StaleReason::DefinitionUnknown),
        Some(recorded) => {
            let env = env_of(step);
            if *recorded != definition_hash(step, env.as_deref()) {
                return Some(StaleReason::DefinitionChanged);
            }
        }
    }
    file_staleness(step, base)
}

/// Finds the steps that have to run, with the first reason for each.
///
/// A step missing from the result is up to date. Staleness propagates along
/// `previous`: when a step has to run, so does everything downstream of it,
/// because its outputs are about to change.
///
/// `base` is the directory relative paths refer to (the working directory).
/// `env_of` gives the conda environment a step's tool is mapped to.
pub fn assess(
    workflow: &Workflow,
    state: &WorkflowState,
    base: Option<&Path>,
    env_of: &dyn Fn(&Step) -> Option<String>,
) -> HashMap<String, StaleReason> {
    let by_id: HashMap<&str, &Step> = workflow.steps.iter().map(|s| (s.id.as_str(), s)).collect();
    let mut stale: HashMap<String, StaleReason> = HashMap::new();
    // Steps whose verdict is final: true = has to run.
    let mut verdict: HashMap<&str, bool> = HashMap::new();

    for step in &workflow.steps {
        decide(step, &by_id, state, base, env_of, &mut verdict, &mut stale);
    }
    stale
}

/// Depth-first verdict for one step. Returns true when it has to run.
fn decide<'a>(
    step: &'a Step,
    by_id: &HashMap<&'a str, &'a Step>,
    state: &WorkflowState,
    base: Option<&Path>,
    env_of: &dyn Fn(&Step) -> Option<String>,
    verdict: &mut HashMap<&'a str, bool>,
    stale: &mut HashMap<String, StaleReason>,
) -> bool {
    if let Some(&known) = verdict.get(step.id.as_str()) {
        return known;
    }
    // Provisional answer while this step is being decided; a dependency loop
    // (which the validator rejects) therefore cannot recurse forever.
    verdict.insert(step.id.as_str(), false);

    let mut reason = None;
    // Every dependency is decided, even after one is found stale, so that all
    // stale steps end up in the result.
    for dep_id in &step.previous {
        if let Some(dep) = by_id.get(dep_id.as_str()) {
            let dep_runs = decide(dep, by_id, state, base, env_of, verdict, stale);
            if dep_runs && reason.is_none() {
                reason = Some(StaleReason::Upstream(dep.id.clone()));
            }
        }
    }
    // The step's own reason is the more useful one when it has one.
    let reason = own_staleness(step, state, base, env_of).or(reason);

    let runs = reason.is_some();
    if let Some(reason) = reason {
        stale.insert(step.id.clone(), reason);
    }
    verdict.insert(step.id.as_str(), runs);
    runs
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workflow::wildcards::expand_workflow_wildcards;
    use std::time::Duration;
    use tempfile::{tempdir, TempDir};

    fn no_env(_: &Step) -> Option<String> {
        None
    }

    /// Moves a file's modification time to `secs` seconds after the epoch
    /// base used by these tests.
    fn set_mtime(path: &Path, offset_secs: u64) {
        let time = SystemTime::UNIX_EPOCH + Duration::from_secs(1_700_000_000 + offset_secs);
        let file = fs::OpenOptions::new().write(true).open(path).unwrap();
        file.set_modified(time).unwrap();
    }

    fn touch(dir: &Path, name: &str, offset_secs: u64) {
        let path = dir.join(name);
        fs::write(&path, "data\n").unwrap();
        set_mtime(&path, offset_secs);
    }

    /// `a` (in.txt -> a.out) and `b` (a.out -> b.out), with a clean saved run.
    fn chain() -> (Workflow, WorkflowState, TempDir) {
        let dir = tempdir().unwrap();
        touch(dir.path(), "in.txt", 0);
        touch(dir.path(), "a.out", 10);
        touch(dir.path(), "b.out", 20);
        let workflow = Workflow::from_steps(vec![
            Step::new("a", "bash", "cp in.txt a.out")
                .with_input("in.txt")
                .with_output("a.out"),
            Step::new("b", "bash", "cp a.out b.out")
                .with_input("a.out")
                .with_output("b.out")
                .depends_on("a"),
        ]);
        let state = recorded_state(&workflow, &["a", "b"]);
        (workflow, state, dir)
    }

    fn recorded_state(workflow: &Workflow, done: &[&str]) -> WorkflowState {
        let mut state = WorkflowState::new("wf.yaml");
        for step in workflow
            .steps
            .iter()
            .filter(|s| done.contains(&s.id.as_str()))
        {
            state.mark_completed(&step.id);
            state.record_definition(&step.id, definition_hash(step, None));
        }
        state
    }

    fn reasons(
        workflow: &Workflow,
        state: &WorkflowState,
        dir: &TempDir,
    ) -> HashMap<String, StaleReason> {
        assess(workflow, state, Some(dir.path()), &no_env)
    }

    #[test]
    fn test_mocked_step_is_always_stale_even_with_a_clean_record() {
        let (mut workflow, state, dir) = chain();
        workflow.steps[0].mock = true;
        let stale = reasons(&workflow, &state, &dir);
        assert_eq!(stale["a"], StaleReason::Mocked);
        assert_eq!(stale["b"], StaleReason::Upstream("a".into()));
    }

    #[test]
    fn test_up_to_date_chain_has_nothing_to_run() {
        let (workflow, state, dir) = chain();
        assert!(reasons(&workflow, &state, &dir).is_empty());
    }

    #[test]
    fn test_reason_never_ran() {
        let (workflow, _, dir) = chain();
        let state = WorkflowState::new("wf.yaml");
        let stale = reasons(&workflow, &state, &dir);
        assert_eq!(stale["a"], StaleReason::NotCompleted);
        assert_eq!(stale["b"], StaleReason::NotCompleted);
    }

    #[test]
    fn test_reason_outputs_missing_and_downstream_follows() {
        let (workflow, state, dir) = chain();
        fs::remove_file(dir.path().join("a.out")).unwrap();
        let stale = reasons(&workflow, &state, &dir);
        assert_eq!(stale["a"], StaleReason::OutputsMissing("a.out".into()));
        assert_eq!(stale["b"], StaleReason::Upstream("a".into()));
        assert_eq!(stale["a"].to_string(), "outputs missing (a.out)");
    }

    #[test]
    fn test_one_missing_output_of_several_is_enough() {
        let dir = tempdir().unwrap();
        touch(dir.path(), "x.out", 5);
        let workflow = Workflow::from_steps(vec![
            Step::new("s", "bash", "true").with_outputs(vec!["x.out, y.out".to_string()])
        ]);
        let state = recorded_state(&workflow, &["s"]);
        assert_eq!(
            reasons(&workflow, &state, &dir)["s"],
            StaleReason::OutputsMissing("y.out".into())
        );
    }

    #[test]
    fn test_reason_input_newer_and_downstream_follows() {
        let (workflow, state, dir) = chain();
        set_mtime(&dir.path().join("in.txt"), 50);
        let stale = reasons(&workflow, &state, &dir);
        assert_eq!(stale["a"], StaleReason::InputNewer("in.txt".into()));
        assert_eq!(stale["b"], StaleReason::Upstream("a".into()));
    }

    #[test]
    fn test_input_with_the_same_time_as_the_output_is_up_to_date() {
        let (workflow, state, dir) = chain();
        set_mtime(&dir.path().join("in.txt"), 10);
        assert!(reasons(&workflow, &state, &dir).is_empty());
    }

    #[test]
    fn test_input_newer_than_only_the_older_of_two_outputs_is_stale() {
        let dir = tempdir().unwrap();
        touch(dir.path(), "in.txt", 15);
        touch(dir.path(), "o1", 10);
        touch(dir.path(), "o2", 30);
        let workflow = Workflow::from_steps(vec![Step::new("s", "bash", "true")
            .with_input("in.txt")
            .with_outputs(vec!["o1".to_string(), "o2".to_string()])]);
        let state = recorded_state(&workflow, &["s"]);
        assert_eq!(
            reasons(&workflow, &state, &dir)["s"],
            StaleReason::InputNewer("in.txt".into())
        );
    }

    #[test]
    fn test_reason_definition_changed_reruns_it_and_everything_downstream() {
        let (mut workflow, state, dir) = chain();
        workflow.steps[0].command = "cp -f in.txt a.out".to_string();
        let stale = reasons(&workflow, &state, &dir);
        assert_eq!(stale["a"], StaleReason::DefinitionChanged);
        assert_eq!(stale["b"], StaleReason::Upstream("a".into()));
    }

    #[test]
    fn test_changing_a_leaf_leaves_its_parent_alone() {
        let (mut workflow, state, dir) = chain();
        workflow.steps[1].command = "cat a.out > b.out".to_string();
        let stale = reasons(&workflow, &state, &dir);
        assert_eq!(stale.len(), 1);
        assert_eq!(stale["b"], StaleReason::DefinitionChanged);
    }

    #[test]
    fn test_legacy_hash_is_pinned() {
        // Recorded before named slots existed: steps without slots must keep
        // hashing to this value so saved runs stay up to date.
        let step = Step::new("s", "bash", "echo {input} > {output}")
            .with_input("i")
            .with_output("o")
            .with_threads(2);
        assert_eq!(definition_hash(&step, Some("env")), "4203e63d81b45c6b");
    }

    #[test]
    fn test_each_defining_field_changes_the_hash() {
        let base = Step::new("s", "bash", "echo hi")
            .with_input("i")
            .with_output("o")
            .with_threads(2);
        let reference = definition_hash(&base, None);
        let mut changed = vec![
            Step {
                tool: "sh".into(),
                ..base.clone()
            },
            Step {
                command: "echo ho".into(),
                ..base.clone()
            },
            Step {
                threads: 4,
                ..base.clone()
            },
            Step {
                input: vec!["j".into()],
                ..base.clone()
            },
            Step {
                output: vec!["p".into()],
                ..base.clone()
            },
        ];
        changed.push(
            base.clone()
                .with_check(OutputCheck::new(crate::workflow::CheckKind::Exists)),
        );
        for step in &changed {
            assert_ne!(definition_hash(step, None), reference);
        }
        assert_ne!(definition_hash(&base, Some("env_a")), reference);
        assert_ne!(
            definition_hash(&base, Some("env_a")),
            definition_hash(&base, Some("env_b"))
        );
    }

    #[test]
    fn test_settings_that_do_not_change_the_result_keep_the_hash() {
        let base = Step::new("s", "bash", "echo hi").with_output("o");
        let tweaked = base
            .clone()
            .with_retries(3)
            .with_timeout_secs(60)
            .depends_on("other");
        assert_eq!(
            definition_hash(&base, None),
            definition_hash(&tweaked, None)
        );
    }

    #[test]
    fn test_hash_is_stable() {
        // Stored on disk: it must not change between releases.
        let step = Step::new("s", "bash", "echo hi").with_output("o");
        assert_eq!(definition_hash(&step, None), "77723a638754fe45");
    }

    #[test]
    fn test_state_without_hashes_is_unknown_and_runs() {
        let (workflow, _, dir) = chain();
        let mut old = WorkflowState::new("wf.yaml");
        old.mark_completed("a");
        old.mark_completed("b");
        let stale = reasons(&workflow, &old, &dir);
        assert_eq!(stale["a"], StaleReason::DefinitionUnknown);
        assert_eq!(stale["b"], StaleReason::DefinitionUnknown);
    }

    #[test]
    fn test_step_without_outputs_always_runs() {
        let dir = tempdir().unwrap();
        let workflow = Workflow::from_steps(vec![Step::new("s", "bash", "true")]);
        let state = recorded_state(&workflow, &["s"]);
        assert_eq!(
            reasons(&workflow, &state, &dir)["s"],
            StaleReason::NoOutputs
        );
    }

    #[test]
    fn test_failed_check_state_is_not_up_to_date() {
        // A step whose blocking check failed is never in `completed_steps`.
        let (workflow, mut state, dir) = chain();
        state.invalidate("b");
        assert_eq!(
            reasons(&workflow, &state, &dir)["b"],
            StaleReason::NotCompleted
        );
    }

    #[test]
    fn test_independent_branch_stays_up_to_date() {
        let dir = tempdir().unwrap();
        touch(dir.path(), "x.out", 5);
        touch(dir.path(), "y.out", 5);
        let workflow = Workflow::from_steps(vec![
            Step::new("x", "bash", "true").with_output("x.out"),
            Step::new("y", "bash", "true").with_output("y.out"),
        ]);
        let state = recorded_state(&workflow, &["x", "y"]);
        fs::remove_file(dir.path().join("x.out")).unwrap();
        let stale = reasons(&workflow, &state, &dir);
        assert!(stale.contains_key("x"));
        assert!(!stale.contains_key("y"));
    }

    #[test]
    fn test_diamond_marks_the_join_once_with_an_upstream_reason() {
        let dir = tempdir().unwrap();
        for name in ["root.out", "l.out", "r.out", "join.out"] {
            touch(dir.path(), name, 5);
        }
        let workflow = Workflow::from_steps(vec![
            Step::new("root", "bash", "true").with_output("root.out"),
            Step::new("l", "bash", "true")
                .with_output("l.out")
                .depends_on("root"),
            Step::new("r", "bash", "true")
                .with_output("r.out")
                .depends_on("root"),
            Step::new("join", "bash", "true")
                .with_output("join.out")
                .depends_on("l")
                .depends_on("r"),
        ]);
        let state = recorded_state(&workflow, &["root", "l", "r", "join"]);
        fs::remove_file(dir.path().join("l.out")).unwrap();
        let stale = reasons(&workflow, &state, &dir);
        assert_eq!(stale.len(), 2);
        assert_eq!(stale["l"], StaleReason::OutputsMissing("l.out".into()));
        assert_eq!(stale["join"], StaleReason::Upstream("l".into()));
    }

    #[test]
    fn test_steps_listed_before_their_dependencies_are_still_propagated() {
        let (mut workflow, state, dir) = chain();
        workflow.steps.reverse();
        fs::remove_file(dir.path().join("a.out")).unwrap();
        let stale = reasons(&workflow, &state, &dir);
        assert_eq!(stale["b"], StaleReason::Upstream("a".into()));
    }

    #[test]
    fn test_wildcard_expanded_steps_are_tracked_one_by_one() {
        let dir = tempdir().unwrap();
        let mut workflow =
            Workflow::from_steps(vec![Step::new("align", "bash", "cp {input} {output}")
                .with_input("{sample}.fq")
                .with_output("{sample}.bam")]);
        let mut files = HashMap::new();
        files.insert(
            "sample".to_string(),
            vec!["a.fq".to_string(), "b.fq".to_string()],
        );
        expand_workflow_wildcards(&mut workflow, &files).unwrap();
        assert_eq!(workflow.steps.len(), 2);

        for name in ["a.fq", "b.fq"] {
            touch(dir.path(), name, 0);
        }
        for name in ["a.bam", "b.bam"] {
            touch(dir.path(), name, 10);
        }
        let all: Vec<String> = workflow.steps.iter().map(|s| s.id.clone()).collect();
        let done: Vec<&str> = all.iter().map(String::as_str).collect();
        let state = recorded_state(&workflow, &done);
        assert!(reasons(&workflow, &state, &dir).is_empty());

        // Touching one sample's input re-runs only that sample's step.
        set_mtime(&dir.path().join("b.fq"), 99);
        let stale = reasons(&workflow, &state, &dir);
        assert_eq!(stale.len(), 1);
        let (id, reason) = stale.iter().next().unwrap();
        assert!(id.contains('b'), "{id}");
        assert_eq!(*reason, StaleReason::InputNewer("b.fq".into()));

        // Editing the command template changes every expanded step.
        for step in &mut workflow.steps {
            step.command = step.command.replace("cp ", "cp -f ");
        }
        let stale = reasons(&workflow, &state, &dir);
        assert_eq!(stale.len(), 2);
        assert!(stale.values().all(|r| *r == StaleReason::DefinitionChanged));
    }

    #[test]
    fn test_a_dependency_loop_terminates() {
        let dir = tempdir().unwrap();
        let workflow = Workflow::from_steps(vec![
            Step::new("p", "bash", "true")
                .with_output("p.out")
                .depends_on("q"),
            Step::new("q", "bash", "true")
                .with_output("q.out")
                .depends_on("p"),
        ]);
        let state = WorkflowState::new("wf.yaml");
        assert_eq!(reasons(&workflow, &state, &dir).len(), 2);
    }

    // ---- named slots ----

    #[test]
    fn test_slot_files_are_part_of_the_hash() {
        let base = Step::new("s", "bash", "cat {a} > {b}")
            .with_named_input("a", &["x.txt"])
            .with_named_output("b", &["y.txt"]);
        let reference = definition_hash(&base, None);
        assert_eq!(reference, definition_hash(&base.clone(), None));
        let changed = [
            base.clone().with_named_input("a", &["z.txt"]),
            base.clone().with_named_input("c", &["w.txt"]),
            base.clone().with_named_output("b", &["y2.txt"]),
            base.clone().with_named_output("d", &["v.txt"]),
        ];
        for step in &changed {
            assert_ne!(definition_hash(step, None), reference);
        }
    }

    #[test]
    fn test_slot_hash_does_not_depend_on_insertion_order() {
        let names: Vec<String> = (0..12).map(|i| format!("slot{i}")).collect();
        let build = |order: Vec<&String>| {
            let mut step = Step::new("s", "bash", "true");
            for name in order {
                step.named_inputs
                    .insert(name.clone(), vec![format!("{name}.txt")]);
            }
            definition_hash(&step, None)
        };
        let forward = build(names.iter().collect());
        let backward = build(names.iter().rev().collect());
        assert_eq!(forward, backward);
        // HashMap iteration order differs between maps; many rebuilds agree.
        for _ in 0..20 {
            assert_eq!(build(names.iter().collect()), forward);
        }
    }

    #[test]
    fn test_a_step_without_slots_hashes_as_before() {
        // The same value as test_legacy_hash_is_pinned, reached through a
        // step that has empty slot maps.
        let mut step = Step::new("s", "bash", "echo {input} > {output}")
            .with_input("i")
            .with_output("o")
            .with_threads(2);
        step.named_inputs.clear();
        step.named_outputs.clear();
        assert_eq!(definition_hash(&step, Some("env")), "4203e63d81b45c6b");
    }

    #[test]
    fn test_named_output_missing_makes_the_step_stale() {
        let dir = tempdir().unwrap();
        touch(dir.path(), "a.bam", 5);
        let workflow = Workflow::from_steps(vec![Step::new("s", "bash", "true")
            .with_named_output("bam", &["a.bam"])
            .with_named_output("bai", &["a.bai"])]);
        let state = recorded_state(&workflow, &["s"]);
        assert_eq!(
            reasons(&workflow, &state, &dir)["s"],
            StaleReason::OutputsMissing("a.bai".into())
        );
        touch(dir.path(), "a.bai", 5);
        assert!(reasons(&workflow, &state, &dir).is_empty());
    }

    #[test]
    fn test_named_input_newer_than_a_named_output_makes_the_step_stale() {
        let dir = tempdir().unwrap();
        touch(dir.path(), "ref.fa", 0);
        touch(dir.path(), "out.sam", 10);
        let workflow = Workflow::from_steps(vec![Step::new("s", "bash", "true")
            .with_named_input("ref", &["ref.fa"])
            .with_named_output("sam", &["out.sam"])]);
        let state = recorded_state(&workflow, &["s"]);
        assert!(reasons(&workflow, &state, &dir).is_empty());
        set_mtime(&dir.path().join("ref.fa"), 99);
        assert_eq!(
            reasons(&workflow, &state, &dir)["s"],
            StaleReason::InputNewer("ref.fa".into())
        );
    }

    #[test]
    fn test_slot_paths_with_commas_are_not_split() {
        let dir = tempdir().unwrap();
        touch(dir.path(), "a,b.txt", 0);
        touch(dir.path(), "o,p.txt", 10);
        let workflow = Workflow::from_steps(vec![Step::new("s", "bash", "true")
            .with_named_input("i", &["a,b.txt"])
            .with_named_output("o", &["o,p.txt"])]);
        let state = recorded_state(&workflow, &["s"]);
        assert!(reasons(&workflow, &state, &dir).is_empty());
        set_mtime(&dir.path().join("a,b.txt"), 50);
        assert_eq!(
            reasons(&workflow, &state, &dir)["s"],
            StaleReason::InputNewer("a,b.txt".into())
        );
    }

    #[test]
    fn test_a_step_with_only_named_outputs_counts_as_having_outputs() {
        let dir = tempdir().unwrap();
        touch(dir.path(), "x.out", 1);
        let workflow = Workflow::from_steps(vec![
            Step::new("s", "bash", "true").with_named_output("x", &["x.out"])
        ]);
        let state = recorded_state(&workflow, &["s"]);
        assert!(reasons(&workflow, &state, &dir).is_empty());
    }
}
