//! End-to-end checks for the `install` block of a step (conda pins, checked
//! downloads, system tools): the real binary with a throw-away HOME, so
//! nothing is written to the real `~/.rustrunner`. Conda is replaced by a
//! fake `micromamba` on the PATH that records what it was asked to do.

#![cfg(unix)]

use std::collections::BTreeMap;
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};

use rustrunner::environment::install::{current_platform, sha256_file, Install, PLATFORMS};
use rustrunner::workflow::{Step, Workflow};
use tempfile::TempDir;

struct Sandbox {
    root: TempDir,
}

impl Sandbox {
    fn new() -> Self {
        let root = TempDir::new().unwrap();
        for dir in ["home", "work", "bin", "src"] {
            fs::create_dir_all(root.path().join(dir)).unwrap();
        }
        Sandbox { root }
    }

    fn path(&self, rel: &str) -> PathBuf {
        self.root.path().join(rel)
    }

    /// A micromamba that logs its arguments. `run` executes the script as the
    /// real one would, with a marker so the test can see which environment
    /// was used.
    fn fake_micromamba(&self) {
        let script = r#"#!/bin/sh
echo "$@ [CONDA_SUBDIR=${CONDA_SUBDIR:-}]" >> "$FAKE_MAMBA_LOG"
case "$1" in
  env)
    echo "  Name  Active  Path"
    ls "$FAKE_MAMBA_ENVS" 2>/dev/null | while read -r e; do echo "  $e    /x/$e"; done
    ;;
  create)
    # create -y -n NAME ...
    mkdir -p "$FAKE_MAMBA_ENVS/$4"
    ;;
  run)
    # run -n NAME bash SCRIPT
    export FAKE_ENV="$3"
    exec "$4" "$5"
    ;;
esac
"#;
        let path = self.path("bin/micromamba");
        fs::write(&path, script).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).unwrap();
        fs::create_dir_all(self.path("fake-envs")).unwrap();
    }

    fn run(&self, steps: Vec<Step>) -> Output {
        let yaml = serde_yaml::to_string(&Workflow::from_steps(steps)).unwrap();
        fs::write(self.path("work/wf.yaml"), yaml).unwrap();
        let path = format!(
            "{}:{}",
            self.path("bin").display(),
            std::env::var("PATH").unwrap_or_default()
        );
        Command::new(env!("CARGO_BIN_EXE_rustrunner"))
            .arg(self.path("work/wf.yaml"))
            .arg("--working-dir")
            .arg(self.path("work"))
            .env("HOME", self.path("home"))
            .env("PATH", path)
            .env("FAKE_MAMBA_LOG", self.path("mamba.log"))
            .env("FAKE_MAMBA_ENVS", self.path("fake-envs"))
            .output()
            .unwrap()
    }

    fn mamba_log(&self) -> String {
        fs::read_to_string(self.path("mamba.log")).unwrap_or_default()
    }
}

fn text(out: &Output) -> String {
    format!(
        "{}{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    )
}

fn conda(package: &str, version: &str, osx64: bool) -> Install {
    Install::Conda {
        package: package.into(),
        version: Some(version.into()),
        channel: None,
        osx64,
    }
}

fn external_for_all_platforms(file: &Path, sha: &str, binary: &str) -> Install {
    let mut url = BTreeMap::new();
    let mut sums = BTreeMap::new();
    for platform in PLATFORMS {
        url.insert(platform.to_string(), format!("file://{}", file.display()));
        sums.insert(platform.to_string(), sha.to_string());
    }
    Install::External {
        binary: binary.into(),
        version: None,
        url,
        sha256: sums,
        license: Some("MIT".into()),
    }
}

#[test]
fn a_pinned_conda_tool_gets_its_own_environment_named_for_the_version() {
    let sb = Sandbox::new();
    sb.fake_micromamba();
    let step = Step::new("align", "star", "echo \"env=$FAKE_ENV\" > env.txt")
        .with_output("env.txt")
        .with_install(conda("star", "2.7.10b", false));
    let out = sb.run(vec![step]);
    assert!(out.status.success(), "{}", text(&out));

    let log = sb.mamba_log();
    assert!(
        log.contains("create -y -n star-2.7.10b -c bioconda -c conda-forge star==2.7.10b"),
        "{log}"
    );
    assert!(log.contains("run -n star-2.7.10b bash"), "{log}");
    assert_eq!(
        fs::read_to_string(sb.path("work/env.txt")).unwrap().trim(),
        "env=star-2.7.10b"
    );
    // The legacy env map is left alone: no mapping was invented for the tool.
    assert!(!sb.path("home/.rustrunner/tools").exists());
}

#[test]
fn two_pins_of_one_package_use_two_environments() {
    let sb = Sandbox::new();
    sb.fake_micromamba();
    let a = Step::new("a", "samtools", "echo $FAKE_ENV > a.txt")
        .with_output("a.txt")
        .with_install(conda("samtools", "1.20", false));
    let b = Step::new("b", "samtools", "echo $FAKE_ENV > b.txt")
        .with_output("b.txt")
        .with_install(conda("samtools", "1.24", false));
    let out = sb.run(vec![a, b]);
    assert!(out.status.success(), "{}", text(&out));
    assert_eq!(
        fs::read_to_string(sb.path("work/a.txt")).unwrap().trim(),
        "samtools-1.20"
    );
    assert_eq!(
        fs::read_to_string(sb.path("work/b.txt")).unwrap().trim(),
        "samtools-1.24"
    );
}

#[test]
fn the_osx64_flag_installs_the_intel_build_only_on_apple_silicon() {
    let sb = Sandbox::new();
    sb.fake_micromamba();
    let step = Step::new("align", "star", "true").with_install(conda("star", "2.7.10b", true));
    let out = sb.run(vec![step]);
    assert!(out.status.success(), "{}", text(&out));
    let log = sb.mamba_log();
    if current_platform() == "osx-arm64" {
        assert!(log.contains("create -y -n star-2.7.10b-osx64"), "{log}");
        assert!(log.contains("[CONDA_SUBDIR=osx-64]"), "{log}");
    } else {
        assert!(log.contains("create -y -n star-2.7.10b -c"), "{log}");
        assert!(!log.contains("CONDA_SUBDIR=osx-64"), "{log}");
    }
}

#[test]
fn changing_the_pin_reruns_the_step() {
    let sb = Sandbox::new();
    sb.fake_micromamba();
    // The step writes made.txt itself so freshness has an output to look at.
    let step = |version: &str| {
        let mut s = Step::new("s", "samtools", "echo run >> runs.txt; touch made.txt")
            .with_output("made.txt")
            .with_install(conda("samtools", version, false));
        s.threads = 1;
        s
    };
    assert!(sb.run(vec![step("1.20")]).status.success());
    assert!(sb.run(vec![step("1.20")]).status.success());
    assert_eq!(
        fs::read_to_string(sb.path("work/runs.txt"))
            .unwrap()
            .lines()
            .count(),
        1
    );
    assert!(sb.run(vec![step("1.24")]).status.success());
    assert_eq!(
        fs::read_to_string(sb.path("work/runs.txt"))
            .unwrap()
            .lines()
            .count(),
        2
    );
}

#[test]
fn an_external_tool_is_downloaded_verified_and_found_through_path() {
    let sb = Sandbox::new();
    let tool = sb.path("src/hello-tool");
    fs::write(&tool, "#!/bin/sh\necho \"hello $1\"\n").unwrap();
    let sha = sha256_file(&tool).unwrap();
    let step = Step::new("greet", "hello-tool", "hello-tool world > greeting.txt")
        .with_output("greeting.txt")
        .with_install(external_for_all_platforms(&tool, &sha, "hello-tool"));
    let out = sb.run(vec![step]);
    assert!(out.status.success(), "{}", text(&out));
    assert_eq!(
        fs::read_to_string(sb.path("work/greeting.txt"))
            .unwrap()
            .trim(),
        "hello world"
    );
    // It lives in the app data folder of the (sandboxed) HOME ...
    let installed: Vec<_> = fs::read_dir(sb.path("home/.rustrunner/tools"))
        .unwrap()
        .flatten()
        .collect();
    assert_eq!(installed.len(), 1);
    // ... and is not on the PATH of anything else: a plain step cannot see it.
    let plain = Step::new(
        "plain",
        "bash",
        "command -v hello-tool > plain.txt || echo none > plain.txt",
    );
    let mut plain = plain;
    plain.output = vec!["plain.txt".into()];
    assert!(sb.run(vec![plain]).status.success());
    assert_eq!(
        fs::read_to_string(sb.path("work/plain.txt"))
            .unwrap()
            .trim(),
        "none"
    );
}

#[test]
fn an_external_download_with_the_wrong_checksum_is_refused() {
    let sb = Sandbox::new();
    let tool = sb.path("src/hello-tool");
    fs::write(&tool, "#!/bin/sh\necho tampered\n").unwrap();
    let step = Step::new("greet", "hello-tool", "hello-tool > greeting.txt")
        .with_output("greeting.txt")
        .with_install(external_for_all_platforms(
            &tool,
            &"0".repeat(64),
            "hello-tool",
        ));
    let out = sb.run(vec![step]);
    assert!(!out.status.success());
    assert!(text(&out).contains("checksum"), "{}", text(&out));
    assert!(!sb.path("work/greeting.txt").exists());
}

#[test]
fn a_missing_system_tool_is_reported_before_anything_runs() {
    let sb = Sandbox::new();
    let first = Step::new("first", "bash", "touch first.txt").with_output("first.txt");
    let second = Step::new(
        "second",
        "no-such-program-xyz",
        "no-such-program-xyz --version",
    )
    .with_install(Install::System {
        binary: "no-such-program-xyz".into(),
    })
    .depends_on("first");
    let out = sb.run(vec![first, second]);
    assert!(!out.status.success());
    let all = text(&out);
    assert!(
        all.contains("no-such-program-xyz") && all.contains("PATH"),
        "{all}"
    );
    assert!(
        !sb.path("work/first.txt").exists(),
        "nothing should have run"
    );
}

#[test]
fn a_system_tool_that_exists_just_runs() {
    let sb = Sandbox::new();
    let tool = sb.path("bin/my-sys-tool");
    fs::write(&tool, "#!/bin/sh\necho system ok\n").unwrap();
    fs::set_permissions(&tool, fs::Permissions::from_mode(0o755)).unwrap();
    let step = Step::new("s", "my-sys-tool", "my-sys-tool > out.txt")
        .with_output("out.txt")
        .with_install(Install::System {
            binary: "my-sys-tool".into(),
        });
    let out = sb.run(vec![step]);
    assert!(out.status.success(), "{}", text(&out));
    assert_eq!(
        fs::read_to_string(sb.path("work/out.txt")).unwrap().trim(),
        "system ok"
    );
}

#[test]
fn a_dry_run_installs_nothing() {
    let sb = Sandbox::new();
    sb.fake_micromamba();
    let step =
        Step::new("align", "star", "STAR --version").with_install(conda("star", "2.7.10b", false));
    let yaml = serde_yaml::to_string(&Workflow::from_steps(vec![step])).unwrap();
    fs::write(sb.path("work/wf.yaml"), yaml).unwrap();
    let out = Command::new(env!("CARGO_BIN_EXE_rustrunner"))
        .arg(sb.path("work/wf.yaml"))
        .arg("--working-dir")
        .arg(sb.path("work"))
        .arg("--dry-run")
        .env("HOME", sb.path("home"))
        .env(
            "PATH",
            format!(
                "{}:{}",
                sb.path("bin").display(),
                std::env::var("PATH").unwrap()
            ),
        )
        .env("FAKE_MAMBA_LOG", sb.path("mamba.log"))
        .env("FAKE_MAMBA_ENVS", sb.path("fake-envs"))
        .output()
        .unwrap();
    assert!(out.status.success(), "{}", text(&out));
    assert!(
        text(&out).contains("Install: conda star==2.7.10b"),
        "{}",
        text(&out)
    );
    assert!(
        sb.mamba_log().is_empty(),
        "dry run must not call micromamba"
    );
}
