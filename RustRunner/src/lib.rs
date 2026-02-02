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

    #[test]
    fn test_version_format() {
        let parts: Vec<&str> = VERSION.split('.').collect();
        assert!(parts.len() >= 2, "Version should have at least major.minor");
        for part in parts {
            assert!(part.parse::<u32>().is_ok(), "Version components should be numeric");
        }
    }
}
