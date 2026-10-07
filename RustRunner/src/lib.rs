//! RustRunner - Visual Workflow Execution Engine
//!
//! A desktop application for creating and executing bioinformatics pipelines
//! through a visual, node-based interface. Designed for researchers who need
//! powerful workflow automation without command-line expertise.
//!
//! # Architecture
//!
//! The library is organized into four main modules:
//!
//! - [`workflow`]: Data structures and parsing for workflow definitions
//! - [`execution`]: Core execution engine with parallel scheduling
//! - [`environment`]: Conda/micromamba integration for tool management
//! - [`monitoring`]: Resource usage tracking and execution timeline
//!
//! # Example
//!
//! ```rust,no_run
//! use rustrunner::workflow::Workflow;
//! use rustrunner::execution::Engine;
//! use rustrunner::load_workflow;
//!
//! fn main() -> Result<(), Box<dyn std::error::Error>> {
//!     // Load a workflow from YAML
//!     let workflow = load_workflow("pipeline.yaml")?;
//!
//!     // Create execution engine
//!     let mut engine = Engine::new(workflow);
//!     engine.set_max_parallel(4);
//!     engine.set_working_dir("/data/analysis");
//!
//!     // Execute the workflow
//!     engine.run()?;
//!     Ok(())
//! }
//! ```

pub mod environment;
pub mod execution;
pub mod monitoring;
pub mod workflow;

// Re-export commonly used types
pub use environment::conda;
pub use execution::engine::Engine;
pub use workflow::model::{Step, Workflow};
pub use workflow::parser::load_workflow;

/// Library version
pub const VERSION: &str = env!("CARGO_PKG_VERSION");

/// Application name
pub const APP_NAME: &str = "RustRunner";

/// `version` as shown to people: a beta build says it is the open beta
/// (`1.0.0-beta.1 (open beta)`), any other version is returned unchanged.
pub fn version_label(version: &str) -> String {
    match version.split_once('-') {
        Some((_, pre)) if pre == "beta" || pre.starts_with("beta.") => {
            format!("{version} (open beta)")
        }
        _ => version.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_library_version() {
        assert!(!VERSION.is_empty());
        assert!(VERSION.contains('.'));
    }

    #[test]
    fn test_app_name() {
        assert_eq!(APP_NAME, "RustRunner");
    }

    #[test]
    fn test_module_exports_step() {
        let step = Step::new("test", "bash", "echo test");
        assert_eq!(step.id, "test");
        assert_eq!(step.tool, "bash");
    }

    #[test]
    fn test_module_exports_workflow() {
        let workflow = Workflow::new();
        assert!(workflow.is_empty());
    }

    /// True for `MAJOR.MINOR.PATCH` with an optional `-pre.release` part.
    fn is_semver(version: &str) -> bool {
        let (core, pre) = match version.split_once('-') {
            Some((core, pre)) => (core, Some(pre)),
            None => (version, None),
        };
        let numeric = core.split('.').count() == 3
            && core
                .split('.')
                .all(|p| !p.is_empty() && p.chars().all(|c| c.is_ascii_digit()));
        let pre_ok = pre.is_none_or(|p| {
            !p.is_empty()
                && p.split('.').all(|id| {
                    !id.is_empty() && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
                })
        });
        numeric && pre_ok
    }

    #[test]
    fn test_version_format() {
        assert!(
            is_semver(VERSION),
            "{VERSION} is not MAJOR.MINOR.PATCH[-pre.release]"
        );
    }

    #[test]
    fn test_version_label_marks_only_beta_builds() {
        assert_eq!(version_label("1.0.0-beta.1"), "1.0.0-beta.1 (open beta)");
        assert_eq!(version_label("1.0.0-beta"), "1.0.0-beta (open beta)");
        assert_eq!(version_label("0.11.1"), "0.11.1");
        assert_eq!(version_label("1.0.0"), "1.0.0");
        assert_eq!(version_label("1.0.0-rc.1"), "1.0.0-rc.1");
        assert_eq!(version_label("1.0.0-betamax"), "1.0.0-betamax");
    }

    #[test]
    fn test_semver_check_accepts_stable_and_prerelease() {
        for ok in [
            "0.11.1",
            "1.0.0",
            "1.0.0-beta.1",
            "2.3.4-rc.2",
            "1.0.0-alpha",
        ] {
            assert!(is_semver(ok), "{ok} should be valid");
        }
        for bad in ["1.0", "1.0.0-", "1.0.x", "1.0.0-beta..1", "", "v1.0.0"] {
            assert!(!is_semver(bad), "{bad} should be rejected");
        }
    }
}
