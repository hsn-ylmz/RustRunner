//! System tool classification
//!
//! Single source of truth for which tools are expected on the standard system
//! `PATH` and therefore never need a conda environment. Both the engine (which
//! decides what environments to create) and the step executor (which decides
//! how to launch a step) use this list, so they can never disagree.

/// Tools available in the standard system PATH that don't require conda.
pub const SYSTEM_TOOLS: &[&str] = &[
    "bash", "sh", "echo", "cat", "cp", "mv", "rm", "mkdir", "sleep", "touch", "ls", "grep", "sed",
    "awk", "head", "tail", "sort", "uniq", "wc", "cut", "tr", "tee", "curl", "wget", "gzip",
    "gunzip", "tar", "zip", "unzip", "bc", "date", "find", "xargs", "diff", "comm", "paste", "rev",
    "fold", "printf", "test", "true", "false",
];

/// Returns true if `tool` is a system tool (doesn't require conda).
pub fn is_system_tool(tool: &str) -> bool {
    SYSTEM_TOOLS.contains(&tool)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    #[test]
    fn test_list_has_no_duplicates() {
        let unique: HashSet<_> = SYSTEM_TOOLS.iter().collect();
        assert_eq!(unique.len(), SYSTEM_TOOLS.len());
    }

    #[test]
    fn test_every_system_tool_is_classified_as_system() {
        for tool in SYSTEM_TOOLS {
            assert!(is_system_tool(tool), "{tool} should be a system tool");
        }
    }

    #[test]
    fn test_bioinformatics_tools_are_not_system_tools() {
        for tool in ["samtools", "fastqc", "bwa", ""] {
            assert!(!is_system_tool(tool), "{tool:?} must need conda");
        }
    }

    /// Regression: the engine and step lists used to diverge, so e.g. `touch`
    /// got a conda environment created for it yet ran as a system tool.
    #[test]
    fn test_engine_and_step_classification_agree() {
        use crate::execution::engine::Engine;
        use crate::workflow::{Step, Workflow};

        for tool in ["touch", "ls", "date", "printf", "samtools"] {
            let step = Step::new("s", tool, format!("{tool} x"));
            let engine = Engine::new(Workflow::from_steps(vec![step]));
            let needs_env = engine.tools_requiring_environments();
            assert_eq!(
                needs_env.contains(&tool.to_string()),
                !is_system_tool(tool),
                "engine and step disagree on {tool}"
            );
        }
    }
}
