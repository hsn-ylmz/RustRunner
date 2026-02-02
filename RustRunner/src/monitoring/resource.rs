//! Resource Usage Monitoring
//!
//! Tracks CPU and memory usage during workflow execution
//! for performance analysis and reporting.

use std::time::{Duration, Instant};

use sysinfo::{get_current_pid, Pid, ProcessRefreshKind, System};

/// A single resource usage sample.
#[derive(Debug, Clone)]
pub struct ResourceSample {
    /// When this sample was taken
    pub timestamp: Instant,
    /// CPU usage percentage (0-100+)
    pub cpu_usage: f32,
    /// Memory usage in megabytes
    pub memory_mb: u64,
}

/// Monitors system resource usage for the current process.
///
/// # Example
///
/// ```rust,ignore
/// use rustrunner::monitoring::ResourceMonitor;
/// use std::time::Duration;
/// use std::thread;
///
/// let mut monitor = ResourceMonitor::new();
///
/// // Take samples periodically
/// for _ in 0..5 {
///     monitor.sample();
///     thread::sleep(Duration::from_millis(500));
/// }
///
/// println!("{}", monitor.get_summary());
/// ```
pub struct ResourceMonitor {
    system: System,
    process_id: Pid,
    samples: Vec<ResourceSample>,
    warmup_done: bool,
    last_sample: Option<Instant>,
    min_interval: Duration,
}

impl ResourceMonitor {
    /// Creates a new resource monitor for the current process.
    pub fn new() -> Self {
        Self {
            system: System::new(),
            process_id: get_current_pid().expect("Failed to get process ID"),
            samples: Vec::new(),
            warmup_done: false,
            last_sample: None,
            min_interval: Duration::from_millis(250),
        }
    }

    /// Sets the minimum interval between samples.
    pub fn with_min_interval(mut self, interval: Duration) -> Self {
        self.min_interval = interval;
        self
    }

    /// Takes a resource usage sample.
    ///
    /// The first call performs CPU warmup (required for accurate readings).
    /// Subsequent calls are rate-limited by `min_interval`.
    pub fn sample(&mut self) {
        let pid = self.process_id;
        let now = Instant::now();

        // Create refresh kind for CPU and memory
        let refresh_kind = ProcessRefreshKind::new()
            .with_cpu()
            .with_memory();

        // First call: warmup
        if !self.warmup_done {
            self.system.refresh_processes_specifics(refresh_kind);
            self.warmup_done = true;
            self.last_sample = Some(now);
            return;
        }

        // Rate limiting
        if let Some(last) = self.last_sample {
            if now.duration_since(last) < self.min_interval {
                return;
            }
        }

        // Refresh process info
        self.system.refresh_processes_specifics(refresh_kind);
        self.last_sample = Some(now);

        // Record sample
        if let Some(process) = self.system.process(pid) {
            let mem_mb = process.memory() / (1024 * 1024);
            let cpu = process.cpu_usage();

            self.samples.push(ResourceSample {
                timestamp: now,
                cpu_usage: cpu,
                memory_mb: mem_mb,
            });
        }
    }

    /// Returns a human-readable summary of resource usage.
    pub fn get_summary(&self) -> String {
        if self.samples.is_empty() {
            return "No resource data collected".to_string();
        }

        let avg_cpu: f32 =
            self.samples.iter().map(|s| s.cpu_usage).sum::<f32>() / self.samples.len() as f32;

        let max_memory = self.samples.iter().map(|s| s.memory_mb).max().unwrap_or(0);

        let min_memory = self.samples.iter().map(|s| s.memory_mb).min().unwrap_or(0);

        format!(
            "Resource Usage:\n  Average CPU: {:.1}%\n  Peak Memory: {} MB\n  Min Memory: {} MB\n  Samples: {}",
            avg_cpu, max_memory, min_memory, self.samples.len()
        )
    }

    /// Returns all collected samples.
    pub fn get_samples(&self) -> &[ResourceSample] {
        &self.samples
    }

    /// Returns the peak memory usage in MB.
    pub fn peak_memory_mb(&self) -> u64 {
        self.samples.iter().map(|s| s.memory_mb).max().unwrap_or(0)
    }

    /// Returns the average CPU usage.
    pub fn average_cpu(&self) -> f32 {
        if self.samples.is_empty() {
            return 0.0;
        }
        self.samples.iter().map(|s| s.cpu_usage).sum::<f32>() / self.samples.len() as f32
    }
}

impl Default for ResourceMonitor {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::thread;

    #[test]
    fn test_monitor_creation() {
        let monitor = ResourceMonitor::new();
        assert!(monitor.samples.is_empty());
    }

    #[test]
    fn test_sampling() {
        let mut monitor = ResourceMonitor::new();

        // First sample is warmup
        monitor.sample();
        assert!(monitor.samples.is_empty());

        // Wait and take another sample
        thread::sleep(Duration::from_millis(300));
        monitor.sample();

        // Should have one sample now
        assert!(!monitor.samples.is_empty());
    }

    #[test]
    fn test_monitor_with_min_interval() {
        let mut monitor = ResourceMonitor::new()
            .with_min_interval(Duration::from_millis(200));

        // First sample is warmup
        monitor.sample();

        // Immediate second sample should be skipped (within min_interval)
        monitor.sample();
        assert!(monitor.get_samples().is_empty());

        // Wait past the min_interval and sample again
        thread::sleep(Duration::from_millis(250));
        monitor.sample();
        assert!(!monitor.get_samples().is_empty());
    }

    #[test]
    fn test_monitor_peak_memory() {
        let mut monitor = ResourceMonitor::new();
        monitor.sample(); // warmup

        thread::sleep(Duration::from_millis(300));
        monitor.sample();

        // peak_memory_mb returns a value (u64, always >= 0)
        let _peak = monitor.peak_memory_mb();
        // Just verify it doesn't panic
        assert!(monitor.get_samples().len() >= 1);
    }

    #[test]
    fn test_monitor_average_cpu() {
        let mut monitor = ResourceMonitor::new();

        // No samples yet
        assert_eq!(monitor.average_cpu(), 0.0);

        monitor.sample(); // warmup

        thread::sleep(Duration::from_millis(300));
        monitor.sample();

        let avg_cpu = monitor.average_cpu();
        assert!(avg_cpu >= 0.0);
    }

    #[test]
    fn test_monitor_multiple_samples() {
        let mut monitor = ResourceMonitor::new();
        monitor.sample(); // warmup

        for _ in 0..3 {
            thread::sleep(Duration::from_millis(300));
            monitor.sample();
        }

        assert!(monitor.get_samples().len() >= 3);
    }

    #[test]
    fn test_monitor_summary_format() {
        let mut monitor = ResourceMonitor::new();
        monitor.sample(); // warmup

        thread::sleep(Duration::from_millis(300));
        monitor.sample();

        let summary = monitor.get_summary();
        assert!(summary.contains("Resource Usage"));
        assert!(summary.contains("Average CPU"));
        assert!(summary.contains("Peak Memory"));
        assert!(summary.contains("Samples"));
    }

    #[test]
    fn test_monitor_summary_empty() {
        let monitor = ResourceMonitor::new();
        let summary = monitor.get_summary();
        assert!(summary.contains("No resource data collected"));
    }

    #[test]
    fn test_monitor_default() {
        let monitor = ResourceMonitor::default();
        assert!(monitor.samples.is_empty());
    }

    #[test]
    fn test_monitor_get_samples_empty() {
        let monitor = ResourceMonitor::new();
        assert!(monitor.get_samples().is_empty());
    }

    #[test]
    fn test_peak_memory_no_samples() {
        let monitor = ResourceMonitor::new();
        assert_eq!(monitor.peak_memory_mb(), 0);
    }
}
