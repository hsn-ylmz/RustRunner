//! Execution Timeline
//!
//! Tracks step start/end times for generating execution
//! reports and Gantt charts.

use std::collections::HashMap;
use std::time::Instant;

/// Type of timeline event.
#[derive(Debug, Clone, PartialEq)]
pub enum EventType {
    /// Step started executing
    Started,
    /// Step completed successfully
    Completed,
    /// Step failed
    Failed,
}

/// A single event in the execution timeline.
#[derive(Debug, Clone)]
pub struct TimelineEvent {
    /// ID of the step
    pub step_id: String,
    /// Type of event
    pub event_type: EventType,
    /// When the event occurred
    pub timestamp: Instant,
}

/// Tracks the execution timeline of a workflow.
///
/// Records when each step starts, completes, or fails,
/// enabling generation of Gantt charts and timing reports.
#[derive(Debug, Clone)]
pub struct ExecutionTimeline {
    events: Vec<TimelineEvent>,
    start_time: Instant,
}

impl ExecutionTimeline {
    /// Creates a new timeline starting now.
    pub fn new() -> Self {
        Self {
            events: Vec::new(),
            start_time: Instant::now(),
        }
    }

    /// Records an event for a step.
    pub fn add_event(&mut self, step_id: String, event_type: EventType) {
        self.events.push(TimelineEvent {
            step_id,
            event_type,
            timestamp: Instant::now(),
        });
    }

    /// Returns all recorded events.
    pub fn get_events(&self) -> &[TimelineEvent] {
        &self.events
    }

    /// Returns the total elapsed time since timeline creation.
    pub fn elapsed(&self) -> std::time::Duration {
        self.start_time.elapsed()
    }

    /// Generates an ASCII Gantt chart representation.
    ///
    /// Each step is shown as a bar indicating when it ran
    /// relative to the total execution time.
    pub fn gantt_chart(&self) -> String {
        let mut output = String::from("\nExecution Timeline:\n\n");

        let total_time = Instant::now().duration_since(self.start_time).as_millis();

        if total_time == 0 {
            return output;
        }

        // Scale to 50 characters width
        let scale = 50.0 / total_time as f64;

        // Build step timing map
        let mut step_times: HashMap<String, (u128, u128)> = HashMap::new();

        for event in &self.events {
            let elapsed = event.timestamp.duration_since(self.start_time).as_millis();

            match event.event_type {
                EventType::Started => {
                    step_times
                        .entry(event.step_id.clone())
                        .or_insert((elapsed, 0))
                        .0 = elapsed;
                }
                EventType::Completed | EventType::Failed => {
                    if let Some(times) = step_times.get_mut(&event.step_id) {
                        times.1 = elapsed;
                    }
                }
            }
        }

        // Sort by start time
        let mut sorted_steps: Vec<_> = step_times.into_iter().collect();
        sorted_steps.sort_by_key(|(_, (start, _))| *start);

        // Generate chart
        for (step_id, (start, end)) in sorted_steps {
            if end > start {
                let start_pos = (start as f64 * scale) as usize;
                let duration = ((end - start) as f64 * scale).max(1.0) as usize;

                let mut bar = " ".repeat(start_pos);
                bar.push_str(&"#".repeat(duration));

                let duration_ms = end - start;
                output.push_str(&format!(
                    "{:12} |{}| ({} ms)\n",
                    truncate(&step_id, 12),
                    bar,
                    duration_ms
                ));
            }
        }

        output.push_str(&format!("\nTotal: {} ms\n", total_time));
        output
    }

    /// Returns step durations in milliseconds.
    pub fn get_durations(&self) -> HashMap<String, u128> {
        let mut starts: HashMap<String, u128> = HashMap::new();
        let mut durations: HashMap<String, u128> = HashMap::new();

        for event in &self.events {
            let elapsed = event.timestamp.duration_since(self.start_time).as_millis();

            match event.event_type {
                EventType::Started => {
                    starts.insert(event.step_id.clone(), elapsed);
                }
                EventType::Completed | EventType::Failed => {
                    if let Some(start) = starts.get(&event.step_id) {
                        durations.insert(event.step_id.clone(), elapsed - start);
                    }
                }
            }
        }

        durations
    }
}

impl Default for ExecutionTimeline {
    fn default() -> Self {
        Self::new()
    }
}

/// Truncates a string to a maximum length.
fn truncate(s: &str, max_len: usize) -> String {
    if s.len() <= max_len {
        format!("{:width$}", s, width = max_len)
    } else {
        format!("{}...", &s[..max_len - 3])
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::thread;
    use std::time::Duration;

    #[test]
    fn test_timeline_creation() {
        let timeline = ExecutionTimeline::new();
        assert!(timeline.events.is_empty());
    }

    #[test]
    fn test_add_events() {
        let mut timeline = ExecutionTimeline::new();
        timeline.add_event("step1".to_string(), EventType::Started);
        thread::sleep(Duration::from_millis(10));
        timeline.add_event("step1".to_string(), EventType::Completed);

        assert_eq!(timeline.events.len(), 2);
    }

    #[test]
    fn test_get_durations() {
        let mut timeline = ExecutionTimeline::new();
        timeline.add_event("step1".to_string(), EventType::Started);
        thread::sleep(Duration::from_millis(50));
        timeline.add_event("step1".to_string(), EventType::Completed);

        let durations = timeline.get_durations();
        assert!(durations.contains_key("step1"));
        assert!(*durations.get("step1").unwrap() >= 50);
    }

    #[test]
    fn test_timeline_elapsed() {
        let timeline = ExecutionTimeline::new();
        thread::sleep(Duration::from_millis(50));

        let elapsed = timeline.elapsed();
        assert!(elapsed.as_millis() >= 50);
    }

    #[test]
    fn test_gantt_chart_generation() {
        let mut timeline = ExecutionTimeline::new();

        timeline.add_event("step1".to_string(), EventType::Started);
        thread::sleep(Duration::from_millis(50));
        timeline.add_event("step1".to_string(), EventType::Completed);

        timeline.add_event("step2".to_string(), EventType::Started);
        thread::sleep(Duration::from_millis(50));
        timeline.add_event("step2".to_string(), EventType::Completed);

        let chart = timeline.gantt_chart();
        assert!(chart.contains("step1"));
        assert!(chart.contains("step2"));
        assert!(chart.contains("Total:"));
    }

    #[test]
    fn test_timeline_failed_event() {
        let mut timeline = ExecutionTimeline::new();

        timeline.add_event("step1".to_string(), EventType::Started);
        timeline.add_event("step1".to_string(), EventType::Failed);

        let events = timeline.get_events();
        assert_eq!(events.len(), 2);
        assert_eq!(events[1].event_type, EventType::Failed);
    }

    #[test]
    fn test_get_durations_empty() {
        let timeline = ExecutionTimeline::new();
        let durations = timeline.get_durations();

        assert!(durations.is_empty());
    }

    #[test]
    fn test_get_durations_only_started() {
        let mut timeline = ExecutionTimeline::new();
        timeline.add_event("step1".to_string(), EventType::Started);

        let durations = timeline.get_durations();
        assert!(!durations.contains_key("step1"));
    }

    #[test]
    fn test_timeline_default() {
        let timeline = ExecutionTimeline::default();
        assert!(timeline.events.is_empty());
    }

    #[test]
    fn test_get_events_returns_all() {
        let mut timeline = ExecutionTimeline::new();
        timeline.add_event("s1".to_string(), EventType::Started);
        timeline.add_event("s2".to_string(), EventType::Started);
        timeline.add_event("s1".to_string(), EventType::Completed);
        timeline.add_event("s2".to_string(), EventType::Failed);

        assert_eq!(timeline.get_events().len(), 4);
    }

    #[test]
    fn test_gantt_chart_empty() {
        let timeline = ExecutionTimeline::new();
        let chart = timeline.gantt_chart();
        // Should return header but no step bars
        assert!(chart.contains("Timeline"));
    }

    #[test]
    fn test_event_type_equality() {
        assert_eq!(EventType::Started, EventType::Started);
        assert_eq!(EventType::Completed, EventType::Completed);
        assert_eq!(EventType::Failed, EventType::Failed);
        assert_ne!(EventType::Started, EventType::Completed);
    }

    #[test]
    fn test_multiple_steps_durations() {
        let mut timeline = ExecutionTimeline::new();

        timeline.add_event("step1".to_string(), EventType::Started);
        thread::sleep(Duration::from_millis(20));
        timeline.add_event("step2".to_string(), EventType::Started);
        thread::sleep(Duration::from_millis(20));
        timeline.add_event("step1".to_string(), EventType::Completed);
        thread::sleep(Duration::from_millis(20));
        timeline.add_event("step2".to_string(), EventType::Completed);

        let durations = timeline.get_durations();
        assert!(durations.contains_key("step1"));
        assert!(durations.contains_key("step2"));
        assert!(*durations.get("step1").unwrap() >= 20);
        assert!(*durations.get("step2").unwrap() >= 20);
    }
}
