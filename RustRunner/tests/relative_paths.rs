//! The CLI resolves a relative workflow path and a relative `--working-dir`
//! against the directory it was started in, exactly once.

#![cfg(unix)]

use std::fs;
use std::process::Command;

const WORKFLOW: &str = r#"
steps:
  - id: write
    tool: bash
    command: "echo hi > {output}"
    input: []
    output: [out/result.txt]
    previous: []
    next: []
"#;

#[test]
fn relative_workflow_path_and_working_dir_resolve_from_the_launch_directory() {
    let root = tempfile::tempdir().unwrap();
    fs::create_dir(root.path().join("flows")).unwrap();
    fs::create_dir(root.path().join("data")).unwrap();
    fs::write(root.path().join("flows/rel.yaml"), WORKFLOW).unwrap();

    let out = Command::new(env!("CARGO_BIN_EXE_rustrunner"))
        .current_dir(root.path())
        .args(["flows/rel.yaml", "--working-dir", "data"])
        .output()
        .unwrap();
    let text = format!(
        "{}{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
    assert!(out.status.success(), "{text}");

    // Outputs and the saved run state land in the working directory itself,
    // not in a doubled `data/data/`.
    assert!(root.path().join("data/out/result.txt").exists(), "{text}");
    assert!(
        root.path().join("data/.rustrunner/rel.state").exists(),
        "{text}"
    );
    assert!(!root.path().join("data/data").exists(), "{text}");
}
