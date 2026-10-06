//! Workflow Execution Module
//!
//! Provides the core execution engine for running workflow steps,
//! including parallel scheduling, resource management, and
//! pause/resume functionality.
//!
//! # Architecture
//!
//! - [`checks`]: Post-step output checks
//! - [`engine`]: Main execution engine orchestrating workflow runs
//! - [`events`]: Machine-readable run events (`--json-events`)
//! - [`process`]: Process-group tracking and signal-driven termination
//! - [`step`]: Individual step execution logic
//! - [`tools`]: Shared system-tool classification

pub mod checks;
pub mod engine;
pub mod events;
pub mod process;
pub mod step;
pub mod tools;

pub use engine::Engine;
pub use events::EventSink;
