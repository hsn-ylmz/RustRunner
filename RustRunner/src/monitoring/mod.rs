//! Resource Monitoring Module
//!
//! Provides utilities for tracking system resource usage and
//! execution timeline during workflow runs.
//!
//! # Components
//!
//! - [`ResourceMonitor`]: CPU and memory usage tracking
//! - [`ExecutionTimeline`]: Step start/end timing for Gantt charts

pub mod resource;
pub mod timeline;

pub use resource::{ResourceMonitor, ResourceSample};
pub use timeline::{EventType, ExecutionTimeline, TimelineEvent};
