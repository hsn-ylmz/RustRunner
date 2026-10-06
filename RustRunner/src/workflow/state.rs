//! Workflow State Persistence
//!
//! Provides automatic state saving for workflow execution, enabling
//! resume functionality after interruption.
//!
//! State is saved to `.rustrunner/{key}.state` after each step completion.
//! The key is the workflow's stable id (`metadata.id`) when it has one, so a
//! rename keeps the history. Workflows without an id fall back to the stem of
//! the workflow file name; when an id appears on such a workflow, the old
//! state file is moved to the id-keyed name the first time it runs.

use std::collections::{HashMap, HashSet};
use std::error::Error;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

use log::info;
use serde::{Deserialize, Serialize};

use super::model::WorkflowMetadata;

/// Persistent state for a workflow execution.
///
/// Tracks which steps have completed and any failures,
/// allowing execution to resume from the last successful point.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct WorkflowState {
    /// Path to the workflow file this state belongs to
    pub workflow_path: String,

    /// Set of step IDs that have completed successfully
    pub completed_steps: HashSet<String>,

    /// ID of the step that failed (if any)
    pub failed_step: Option<String>,

    /// Last time the state was updated
    pub timestamp: SystemTime,

    /// Number of attempts the most recent run of each step needed
    /// (absent in state files written before retries existed).
    #[serde(default)]
    pub step_attempts: HashMap<String, u32>,

    /// Name of the workflow the last run executed, from its metadata
    /// (absent in state files written before metadata existed).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workflow_name: Option<String>,

    /// Version of the workflow the last run executed, from its metadata.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workflow_version: Option<String>,

    /// Stable id of the workflow (`metadata.id`); keys the state file when set
    /// (absent for workflows without an id and in older state files).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workflow_id: Option<String>,

    /// Directory the `.rustrunner/` folder lives in; not persisted.
    #[serde(skip)]
    base_dir: Option<PathBuf>,
}

impl WorkflowState {
    /// Creates a new empty state for a workflow.
    pub fn new(workflow_path: &str) -> Self {
        Self {
            workflow_path: workflow_path.to_string(),
            completed_steps: HashSet::new(),
            failed_step: None,
            timestamp: SystemTime::now(),
            step_attempts: HashMap::new(),
            workflow_name: None,
            workflow_version: None,
            workflow_id: None,
            base_dir: None,
        }
    }

    /// Records the id, name and version of the workflow being run.
    pub fn set_metadata(&mut self, metadata: Option<&WorkflowMetadata>) {
        self.workflow_id = metadata.and_then(|m| m.id.clone());
        self.workflow_name = metadata.and_then(|m| m.name.clone());
        self.workflow_version = metadata.and_then(|m| m.version.clone());
    }

    /// Records how many attempts a step used.
    pub fn record_attempts(&mut self, step_id: &str, attempts: u32) {
        self.step_attempts.insert(step_id.to_string(), attempts);
    }

    /// Keys this state's file on a workflow id instead of the file stem.
    pub fn with_id(mut self, id: Option<&str>) -> Self {
        self.workflow_id = id.map(String::from);
        self
    }

    /// Directs this state's file to `<dir>/.rustrunner/` instead of the
    /// current directory.
    pub fn in_dir(mut self, dir: Option<&Path>) -> Self {
        self.base_dir = dir.map(Path::to_path_buf);
        self
    }

    /// Saves the state to a file.
    ///
    /// State is saved to `.rustrunner/{workflow_stem}.state` in the base
    /// directory (the current directory unless set with [`Self::in_dir`]).
    pub fn save(&self) -> Result<(), Box<dyn Error>> {
        let state_file = self.state_file_path();
        if let Some(parent) = state_file.parent() {
            fs::create_dir_all(parent)?;
        }

        let json = serde_json::to_string_pretty(self)?;
        fs::write(&state_file, json)?;

        info!("Saved workflow state to {}", state_file.display());
        Ok(())
    }

    /// Loads state from the current directory.
    ///
    /// Returns an error if no state file exists or it can't be read.
    pub fn load(workflow_path: &str) -> Result<Self, Box<dyn Error>> {
        Self::load_in(workflow_path, None)
    }

    /// Loads state from `<dir>/.rustrunner/` (the current directory when
    /// `dir` is `None`), keyed on the workflow file stem.
    pub fn load_in(workflow_path: &str, dir: Option<&Path>) -> Result<Self, Box<dyn Error>> {
        Self::load_keyed(workflow_path, None, dir)
    }

    /// Like [`Self::load_in`], keyed on the workflow `id` when there is one.
    ///
    /// With an id, a state file written under the old file-stem name is read
    /// when no id-keyed file exists yet (see [`Self::migrate_legacy`] to move
    /// it). The returned state is keyed on `id` either way.
    pub fn load_keyed(
        workflow_path: &str,
        id: Option<&str>,
        dir: Option<&Path>,
    ) -> Result<Self, Box<dyn Error>> {
        let state_file = Self::existing_state_file(workflow_path, id, dir)
            .unwrap_or_else(|| Self::state_file_path_for(workflow_path, id, dir));

        let content = fs::read_to_string(&state_file)?;
        let mut state: WorkflowState = serde_json::from_str(&content)?;

        info!("Loaded workflow state from {}", state_file.display());
        info!("Previously completed: {:?}", state.completed_steps);

        // The file may predate the id; it is saved under the id from now on.
        state.workflow_id = id.map(String::from);
        Ok(state.in_dir(dir))
    }

    /// Returns true if a persisted state file exists for the given workflow.
    ///
    /// Lets callers distinguish "no prior run" (fresh start, expected) from
    /// "a state file exists but failed to load" (corrupt - worth a warning).
    pub fn state_file_exists(workflow_path: &str) -> bool {
        Self::state_file_exists_in(workflow_path, None)
    }

    /// Like [`Self::state_file_exists`], looking under `dir`.
    pub fn state_file_exists_in(workflow_path: &str, dir: Option<&Path>) -> bool {
        Self::state_file_exists_keyed(workflow_path, None, dir)
    }

    /// Like [`Self::state_file_exists_in`], keyed on the workflow `id`
    /// (including the legacy file-stem fallback).
    pub fn state_file_exists_keyed(
        workflow_path: &str,
        id: Option<&str>,
        dir: Option<&Path>,
    ) -> bool {
        Self::existing_state_file(workflow_path, id, dir).is_some()
    }

    /// Moves a state file written under the old file-stem name to the
    /// id-keyed name, so a workflow that has just been given an id keeps its
    /// resume history. Does nothing without an id, when the id-keyed file
    /// already exists (it wins and the old file is left alone), or when there
    /// is no old file. Returns true when a file was moved.
    pub fn migrate_legacy(
        workflow_path: &str,
        id: Option<&str>,
        dir: Option<&Path>,
    ) -> Result<bool, Box<dyn Error>> {
        let Some(id) = id else { return Ok(false) };
        let target = Self::state_file_path_for(workflow_path, Some(id), dir);
        let legacy = Self::state_file_path_for(workflow_path, None, dir);
        if target == legacy || target.exists() || !legacy.exists() {
            return Ok(false);
        }
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::rename(&legacy, &target)?;
        info!(
            "Moved the saved state of this workflow to {} (it is now keyed on its id)",
            target.display()
        );
        Ok(true)
    }

    /// The state file to read: the keyed one, else (with an id) the legacy
    /// file-stem one.
    fn existing_state_file(
        workflow_path: &str,
        id: Option<&str>,
        dir: Option<&Path>,
    ) -> Option<PathBuf> {
        let keyed = Self::state_file_path_for(workflow_path, id, dir);
        if keyed.exists() {
            return Some(keyed);
        }
        if id.is_some() {
            let legacy = Self::state_file_path_for(workflow_path, None, dir);
            if legacy.exists() {
                return Some(legacy);
            }
        }
        None
    }

    /// Returns the path to the state file.
    fn state_file_path(&self) -> PathBuf {
        Self::state_file_path_for(
            &self.workflow_path,
            self.workflow_id.as_deref(),
            self.base_dir.as_deref(),
        )
    }

    /// Returns the state file path for a workflow: keyed on `id` when given,
    /// else on the stem of the workflow file name.
    fn state_file_path_for(workflow_path: &str, id: Option<&str>, dir: Option<&Path>) -> PathBuf {
        let key = match id {
            Some(id) => id,
            None => Path::new(workflow_path)
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("workflow"),
        };

        let relative = Path::new(".rustrunner").join(format!("{}.state", key));
        match dir {
            Some(dir) => dir.join(relative),
            None => relative,
        }
    }

    /// Marks a step as completed.
    pub fn mark_completed(&mut self, step_id: &str) {
        self.completed_steps.insert(step_id.to_string());
        self.failed_step = None;
        self.timestamp = SystemTime::now();
    }

    /// Marks a step as failed.
    pub fn mark_failed(&mut self, step_id: &str) {
        self.failed_step = Some(step_id.to_string());
        self.timestamp = SystemTime::now();
    }

    /// Returns true if this state represents a resumed execution.
    pub fn is_resume(&self) -> bool {
        !self.completed_steps.is_empty() || self.failed_step.is_some()
    }

    /// Clears all state (for fresh start).
    pub fn clear(&mut self) {
        self.completed_steps.clear();
        self.failed_step = None;
        self.step_attempts.clear();
        self.timestamp = SystemTime::now();
    }

    /// Deletes the state file.
    pub fn delete(&self) -> Result<(), Box<dyn Error>> {
        let state_file = self.state_file_path();
        if state_file.exists() {
            fs::remove_file(&state_file)?;
            info!("Deleted state file: {}", state_file.display());
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn test_state_creation() {
        let state = WorkflowState::new("test.yaml");
        assert_eq!(state.workflow_path, "test.yaml");
        assert!(state.completed_steps.is_empty());
        assert!(!state.is_resume());
    }

    #[test]
    fn test_record_attempts_roundtrip_and_old_state_compat() {
        let mut state = WorkflowState::new("t.yaml");
        state.record_attempts("align", 3);
        let json = serde_json::to_string(&state).unwrap();
        let loaded: WorkflowState = serde_json::from_str(&json).unwrap();
        assert_eq!(loaded.step_attempts.get("align"), Some(&3));

        // A state file written before `step_attempts` existed still loads.
        let mut value: serde_json::Value = serde_json::from_str(&json).unwrap();
        value.as_object_mut().unwrap().remove("step_attempts");
        let old: WorkflowState = serde_json::from_value(value).unwrap();
        assert!(old.step_attempts.is_empty());
    }

    #[test]
    fn test_metadata_roundtrip_and_old_state_compat() {
        let mut state = WorkflowState::new("t.yaml");
        state.set_metadata(Some(&WorkflowMetadata::new(Some("qc"), Some("1.2"))));
        let json = serde_json::to_string(&state).unwrap();
        let loaded: WorkflowState = serde_json::from_str(&json).unwrap();
        assert_eq!(loaded.workflow_name.as_deref(), Some("qc"));
        assert_eq!(loaded.workflow_version.as_deref(), Some("1.2"));

        state.set_metadata(None);
        let json = serde_json::to_string(&state).unwrap();
        assert!(!json.contains("workflow_name"));
        // State files written before metadata existed still load.
        let old: WorkflowState = serde_json::from_str(&json).unwrap();
        assert!(old.workflow_name.is_none() && old.workflow_version.is_none());
    }

    #[test]
    fn test_save_and_load_in_dir_round_trip() {
        let dir = tempdir().unwrap();
        let mut state = WorkflowState::new("/elsewhere/flow.yaml").in_dir(Some(dir.path()));
        state.mark_completed("a");
        state.save().unwrap();
        assert!(dir.path().join(".rustrunner/flow.state").exists());
        assert!(WorkflowState::state_file_exists_in(
            "flow.yaml",
            Some(dir.path())
        ));

        let loaded = WorkflowState::load_in("flow.yaml", Some(dir.path())).unwrap();
        assert!(loaded.completed_steps.contains("a"));
        // The loaded state keeps writing to the same directory.
        loaded.delete().unwrap();
        assert!(!dir.path().join(".rustrunner/flow.state").exists());
    }

    #[test]
    fn test_mark_completed() {
        let mut state = WorkflowState::new("test.yaml");
        state.mark_completed("step1");

        assert!(state.completed_steps.contains("step1"));
        assert!(state.is_resume());
    }

    #[test]
    fn test_mark_failed() {
        let mut state = WorkflowState::new("test.yaml");
        state.mark_failed("step2");

        assert_eq!(state.failed_step, Some("step2".to_string()));
        assert!(state.is_resume());
    }

    #[test]
    fn test_state_serialization_roundtrip() {
        // Test serialization/deserialization without filesystem cwd changes
        let mut state = WorkflowState::new("test_roundtrip.yaml");
        state.mark_completed("step1");
        state.mark_completed("step2");

        let json = serde_json::to_string_pretty(&state).unwrap();
        let loaded: WorkflowState = serde_json::from_str(&json).unwrap();

        assert_eq!(loaded.completed_steps.len(), 2);
        assert!(loaded.completed_steps.contains("step1"));
        assert!(loaded.completed_steps.contains("step2"));
        assert_eq!(loaded.workflow_path, "test_roundtrip.yaml");
    }

    #[test]
    fn test_state_save_creates_dir() {
        let temp_dir = tempdir().unwrap();
        let rustrunner_dir = temp_dir.path().join(".rustrunner");

        // Manually write state file to temp location
        let mut state = WorkflowState::new("test_save.yaml");
        state.mark_completed("step1");

        fs::create_dir_all(&rustrunner_dir).unwrap();
        let state_file = rustrunner_dir.join("test_save.state");
        let json = serde_json::to_string_pretty(&state).unwrap();
        fs::write(&state_file, &json).unwrap();

        assert!(state_file.exists());

        // Read it back
        let content = fs::read_to_string(&state_file).unwrap();
        let loaded: WorkflowState = serde_json::from_str(&content).unwrap();
        assert!(loaded.completed_steps.contains("step1"));
    }

    #[test]
    fn test_state_delete_existing_file() {
        let temp_dir = tempdir().unwrap();
        let state_file = temp_dir.path().join("test.state");

        // Create a file
        fs::write(&state_file, "{}").unwrap();
        assert!(state_file.exists());

        // Delete it
        fs::remove_file(&state_file).unwrap();
        assert!(!state_file.exists());
    }

    #[test]
    fn test_state_clear() {
        let mut state = WorkflowState::new("test.yaml");
        state.mark_completed("step1");
        state.mark_failed("step2");

        state.clear();

        assert!(state.completed_steps.is_empty());
        assert!(state.failed_step.is_none());
        assert!(!state.is_resume());
    }

    #[test]
    fn test_state_failed_step_tracking() {
        let mut state = WorkflowState::new("test.yaml");

        state.mark_failed("step3");
        assert_eq!(state.failed_step, Some("step3".to_string()));
        assert!(state.is_resume());

        // Completing after failure should clear failed status
        state.mark_completed("step3");
        assert!(state.failed_step.is_none());
        assert!(state.completed_steps.contains("step3"));
    }

    #[test]
    fn test_state_multiple_completions() {
        let mut state = WorkflowState::new("test.yaml");

        state.mark_completed("step1");
        state.mark_completed("step2");
        state.mark_completed("step3");

        assert_eq!(state.completed_steps.len(), 3);
        assert!(state.is_resume());
    }

    #[test]
    fn test_state_load_nonexistent() {
        let result = WorkflowState::load("/nonexistent/path/workflow.yaml");
        assert!(result.is_err());
    }

    #[test]
    fn test_state_delete_nonexistent() {
        let state = WorkflowState::new("/nonexistent/workflow.yaml");
        // Should not error when deleting a non-existent file
        let result = state.delete();
        assert!(result.is_ok());
    }

    #[test]
    fn test_state_is_not_resume_when_empty() {
        let state = WorkflowState::new("test.yaml");
        assert!(!state.is_resume());
    }

    #[test]
    fn test_state_is_resume_with_failed() {
        let mut state = WorkflowState::new("test.yaml");
        state.mark_failed("step1");
        assert!(state.is_resume());
    }

    #[test]
    fn test_id_keys_the_state_file_and_round_trips() {
        let dir = tempdir().unwrap();
        let mut state = WorkflowState::new("any/name.yaml")
            .with_id(Some("abc-1"))
            .in_dir(Some(dir.path()));
        state.mark_completed("a");
        state.save().unwrap();
        assert!(dir.path().join(".rustrunner/abc-1.state").exists());
        assert!(!dir.path().join(".rustrunner/name.state").exists());

        // Any file name finds it again.
        let loaded =
            WorkflowState::load_keyed("elsewhere/renamed.yaml", Some("abc-1"), Some(dir.path()))
                .unwrap();
        assert!(loaded.completed_steps.contains("a"));
        assert_eq!(loaded.workflow_id.as_deref(), Some("abc-1"));
        // Without the id the file stem is used and nothing is found.
        assert!(WorkflowState::load_in("elsewhere/renamed.yaml", Some(dir.path())).is_err());
    }

    #[test]
    fn test_distinct_ids_never_collide_even_for_look_alike_names() {
        // "R&D" and "R D" slugify to the same stem; ids keep them apart.
        let dir = tempdir().unwrap();
        for (id, step) in [("id-one", "x"), ("id-two", "y")] {
            let mut s = WorkflowState::new("r_d.yaml")
                .with_id(Some(id))
                .in_dir(Some(dir.path()));
            s.mark_completed(step);
            s.save().unwrap();
        }
        let one = WorkflowState::load_keyed("r_d.yaml", Some("id-one"), Some(dir.path())).unwrap();
        let two = WorkflowState::load_keyed("r_d.yaml", Some("id-two"), Some(dir.path())).unwrap();
        assert!(one.completed_steps.contains("x") && !one.completed_steps.contains("y"));
        assert!(two.completed_steps.contains("y") && !two.completed_steps.contains("x"));
    }

    #[test]
    fn test_old_state_file_without_id_loads_and_is_read_through_the_id() {
        let dir = tempdir().unwrap();
        let mut old = WorkflowState::new("flow.yaml").in_dir(Some(dir.path()));
        old.mark_completed("a");
        old.save().unwrap();
        let json = fs::read_to_string(dir.path().join(".rustrunner/flow.state")).unwrap();
        assert!(!json.contains("workflow_id"));

        // Falls back to the old file until it is migrated.
        let via_id =
            WorkflowState::load_keyed("flow.yaml", Some("new-id"), Some(dir.path())).unwrap();
        assert!(via_id.completed_steps.contains("a"));
        assert!(WorkflowState::state_file_exists_keyed(
            "flow.yaml",
            Some("new-id"),
            Some(dir.path())
        ));
        assert!(!dir.path().join(".rustrunner/new-id.state").exists());
    }

    #[test]
    fn test_migrate_legacy_moves_once_and_never_overwrites() {
        let dir = tempdir().unwrap();
        let state_dir = dir.path().join(".rustrunner");
        fs::create_dir_all(&state_dir).unwrap();
        let mut old = WorkflowState::new("flow.yaml").in_dir(Some(dir.path()));
        old.mark_completed("old_step");
        old.save().unwrap();

        // No id: nothing to do.
        assert!(!WorkflowState::migrate_legacy("flow.yaml", None, Some(dir.path())).unwrap());
        assert!(WorkflowState::migrate_legacy("flow.yaml", Some("id9"), Some(dir.path())).unwrap());
        assert!(state_dir.join("id9.state").exists());
        assert!(!state_dir.join("flow.state").exists());
        // Second call: nothing left to move.
        assert!(
            !WorkflowState::migrate_legacy("flow.yaml", Some("id9"), Some(dir.path())).unwrap()
        );

        // An id-keyed file already present wins; the old file stays put.
        let mut again = WorkflowState::new("flow.yaml").in_dir(Some(dir.path()));
        again.mark_completed("newer_old");
        again.save().unwrap();
        assert!(
            !WorkflowState::migrate_legacy("flow.yaml", Some("id9"), Some(dir.path())).unwrap()
        );
        assert!(state_dir.join("flow.state").exists());
        let kept = WorkflowState::load_keyed("flow.yaml", Some("id9"), Some(dir.path())).unwrap();
        assert!(kept.completed_steps.contains("old_step"));
    }

    #[test]
    fn test_set_metadata_records_the_id() {
        let mut state = WorkflowState::new("w.yaml");
        state.set_metadata(Some(&WorkflowMetadata::new(None, None).with_id("zz")));
        assert_eq!(state.workflow_id.as_deref(), Some("zz"));
        state.set_metadata(None);
        assert_eq!(state.workflow_id, None);
    }
}
