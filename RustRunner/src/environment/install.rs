//! How a step gets its tool: the `install` block of a step.
//!
//! The app's tool catalog says where each tool comes from, and the step
//! carries that so the engine can honour it:
//!
//! | `kind` | What the engine does |
//! |---|---|
//! | `conda` | Creates (once) an environment that holds exactly `package==version` (and any `constraints`, extra specs such as `polars<2` for a dependency that breaks the tool, which also name the environment); the environment name includes the version, so a pin is never silently replaced by another version. `channel` is searched before conda-forge. `osx64: true` installs the Intel build on Apple silicon (it runs under Rosetta) for tools whose native build is broken or missing. |
//! | `external` | Downloads one file for the current platform into the app data directory (`~/.rustrunner/tools`), checks its SHA-256 and unpacks archives. The folder with the binary is put first on the step's `PATH`, for that step only. |
//! | `system` | Expects `binary` on the `PATH`; nothing is installed. A missing binary is reported before the run starts. |
//!
//! A step without `install` keeps the original behaviour (system tool, or the
//! environment named for its tool in `env_map.json`).

use std::collections::BTreeMap;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::Command;

use log::{debug, info};
use serde::{Deserialize, Serialize};

fn is_false(value: &bool) -> bool {
    !*value
}

/// Where a step's tool comes from.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Install {
    /// A conda package, installed with micromamba.
    Conda {
        package: String,
        /// Exact version. Without it the newest one is installed, into an
        /// environment named for the package alone.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        version: Option<String>,
        /// Channel searched first (default `bioconda`); conda-forge always follows.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        channel: Option<String>,
        /// Install the osx-64 build on Apple silicon (runs under Rosetta).
        #[serde(default, skip_serializing_if = "is_false")]
        osx64: bool,
        /// Extra package specs installed beside the package, such as `polars<2`.
        /// For a tool whose newest dependency is known to break it. Part of the
        /// environment name, so a different set is a different environment.
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        constraints: Vec<String>,
    },
    /// A binary (or archive holding it) downloaded from a fixed address.
    External {
        /// File name of the executable the step runs.
        binary: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        version: Option<String>,
        /// Download address per platform (`linux-64`, `linux-aarch64`,
        /// `osx-64`, `osx-arm64`, `win-64`). `{version}` is replaced by the
        /// version. Only `https://` and `file://` are accepted.
        url: BTreeMap<String, String>,
        /// Hex SHA-256 of the downloaded file, per platform.
        sha256: BTreeMap<String, String>,
        /// Licence note shown to the person (not used by the engine).
        #[serde(default, skip_serializing_if = "Option::is_none")]
        license: Option<String>,
    },
    /// A program the computer already has on its `PATH`.
    System { binary: String },
}

/// The platform names `install` uses (the conda subdir names).
pub const PLATFORMS: [&str; 5] = ["linux-64", "linux-aarch64", "osx-64", "osx-arm64", "win-64"];

/// The platform this build runs on, or `unknown`.
pub fn current_platform() -> &'static str {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("linux", "x86_64") => "linux-64",
        ("linux", "aarch64") => "linux-aarch64",
        ("macos", "x86_64") => "osx-64",
        ("macos", "aarch64") => "osx-arm64",
        ("windows", "x86_64") => "win-64",
        _ => "unknown",
    }
}

/// Where downloaded tools live: `$HOME/.rustrunner/tools` (the HOME the engine
/// runs with, so a sandboxed HOME keeps everything inside the sandbox).
pub fn tools_root() -> PathBuf {
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .unwrap_or_else(|_| ".".to_string());
    PathBuf::from(home).join(".rustrunner").join("tools")
}

/// Keeps letters, digits, `.`, `_` and `-`; everything else becomes `_`.
fn sanitize(text: &str) -> String {
    text.chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-') {
                c
            } else {
                '_'
            }
        })
        .collect()
}

/// A version string is safe to put in a package spec and an environment name.
fn is_plain_version(version: &str) -> bool {
    let mut chars = version.chars();
    matches!(chars.next(), Some(c) if c.is_ascii_alphanumeric())
        && chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '+' | '-'))
}

/// An extra package spec such as `polars<2` or `numpy>=1.26,<2`: a plain package
/// name followed by comparison operators and plain versions, nothing a shell or
/// micromamba could read as an option.
fn is_plain_constraint(spec: &str) -> bool {
    let name_end = spec
        .find(|c: char| !(c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-')))
        .unwrap_or(spec.len());
    let (name, rest) = spec.split_at(name_end);
    let starts_plain = name
        .chars()
        .next()
        .is_some_and(|c| c.is_ascii_alphanumeric());
    starts_plain
        && !rest.is_empty()
        && rest.starts_with(['<', '>', '=', '!', '~'])
        && rest.chars().all(|c| {
            c.is_ascii_alphanumeric()
                || matches!(
                    c,
                    '.' | '_' | '+' | '-' | '<' | '>' | '=' | '!' | '~' | ',' | '*'
                )
        })
}

/// A binary name has no path parts.
fn is_plain_binary_name(name: &str) -> bool {
    !name.is_empty()
        && name != "."
        && name != ".."
        && !name.contains(['/', '\\', '\0'])
        && !name.starts_with('-')
}

fn is_hex_sha256(text: &str) -> bool {
    text.len() == 64 && text.chars().all(|c| c.is_ascii_hexdigit())
}

impl Install {
    /// Problems that make the block unusable, written for the person who has
    /// to fix the workflow. Empty when it is fine.
    pub fn problems(&self) -> Vec<String> {
        let mut problems = Vec::new();
        match self {
            Install::Conda {
                package,
                version,
                channel,
                constraints,
                ..
            } => {
                for spec in constraints {
                    if !is_plain_constraint(spec) {
                        problems.push(format!(
                            "extra package '{}' must be a package name with a version limit such as polars<2",
                            spec
                        ));
                    }
                }
                let plain_name = !package.is_empty()
                    && package
                        .chars()
                        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'));
                if !plain_name {
                    problems.push(format!(
                        "conda package '{}' is not a plain package name",
                        package
                    ));
                }
                if let Some(version) = version {
                    if !is_plain_version(version) {
                        problems.push(format!(
                            "version '{}' must be one exact version such as 1.20 (letters, digits, '.', '_', '+', '-')",
                            version
                        ));
                    }
                }
                if let Some(channel) = channel {
                    let ok = !channel.is_empty()
                        && channel
                            .chars()
                            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'));
                    if !ok {
                        problems.push(format!("channel '{}' is not a plain channel name", channel));
                    }
                }
            }
            Install::External {
                binary,
                version,
                url,
                sha256,
                ..
            } => {
                if !is_plain_binary_name(binary) {
                    problems.push(format!(
                        "binary '{}' must be a file name without folders",
                        binary
                    ));
                }
                if let Some(version) = version {
                    if !is_plain_version(version) {
                        problems.push(format!("version '{}' is not a plain version", version));
                    }
                }
                if url.is_empty() {
                    problems.push("no download address is given for any platform".to_string());
                }
                for (platform, address) in url {
                    if !PLATFORMS.contains(&platform.as_str()) {
                        problems.push(format!(
                            "'{}' is not a platform name ({})",
                            platform,
                            PLATFORMS.join(", ")
                        ));
                    }
                    if !(address.starts_with("https://") || address.starts_with("file://")) {
                        problems.push(format!(
                            "the {} download address must start with https://",
                            platform
                        ));
                    }
                    match sha256.get(platform) {
                        Some(sum) if is_hex_sha256(sum) => {}
                        Some(_) => problems.push(format!(
                            "the {} sha256 must be 64 hexadecimal characters",
                            platform
                        )),
                        None => problems.push(format!(
                            "the {} download has no sha256; downloads are always verified",
                            platform
                        )),
                    }
                }
                for platform in sha256.keys() {
                    if !url.contains_key(platform) {
                        problems.push(format!("a sha256 is given for {} but no address", platform));
                    }
                }
            }
            Install::System { binary } => {
                if !is_plain_binary_name(binary) {
                    problems.push(format!(
                        "binary '{}' must be a file name without folders",
                        binary
                    ));
                }
            }
        }
        problems
    }

    /// A one-line description for logs and the dry run.
    pub fn describe(&self) -> String {
        match self {
            Install::Conda {
                package,
                version,
                constraints,
                ..
            } => {
                let base = match version {
                    Some(v) => format!("conda {}=={}", package, v),
                    None => format!("conda {} (any version)", package),
                };
                if constraints.is_empty() {
                    base
                } else {
                    format!("{} with {}", base, constraints.join(" "))
                }
            }
            Install::External {
                binary, version, ..
            } => match version {
                Some(v) => format!("download {} {}", binary, v),
                None => format!("download {}", binary),
            },
            Install::System { binary } => format!("system {}", binary),
        }
    }

    /// The conda environment for `platform`, or `None` for other kinds. The
    /// name holds the version (and `-osx64` when the Intel build is used), so
    /// every pin has its own environment.
    pub fn conda_env_name(&self, platform: &str) -> Option<String> {
        let Install::Conda {
            package,
            version,
            osx64,
            constraints,
            ..
        } = self
        else {
            return None;
        };
        let mut name = sanitize(package);
        if let Some(version) = version {
            name.push('-');
            name.push_str(&sanitize(version));
        }
        if !constraints.is_empty() {
            // Another set of extra packages is another environment.
            let digest = sha256_hex(constraints.join("\n").as_bytes());
            name.push_str("-x");
            name.push_str(&digest[..8]);
        }
        if *osx64 && platform == "osx-arm64" {
            name.push_str("-osx64");
        }
        Some(name)
    }

    /// The package spec micromamba installs: `package==version` for a pin.
    pub fn conda_spec(&self) -> Option<String> {
        match self {
            Install::Conda {
                package, version, ..
            } => Some(match version {
                Some(v) => format!("{}=={}", package, v),
                None => package.clone(),
            }),
            _ => None,
        }
    }

    /// Every spec micromamba installs into the environment: the package pin and
    /// then the extra packages, if any.
    pub fn conda_specs(&self) -> Vec<String> {
        let mut specs: Vec<String> = self.conda_spec().into_iter().collect();
        if let Install::Conda { constraints, .. } = self {
            specs.extend(constraints.iter().cloned());
        }
        specs
    }

    /// Channels to search, in order.
    pub fn conda_channels(&self) -> Vec<String> {
        let first = match self {
            Install::Conda {
                channel: Some(c), ..
            } => c.clone(),
            _ => "bioconda".to_string(),
        };
        let mut channels = vec![first];
        if !channels.iter().any(|c| c == "conda-forge") {
            channels.push("conda-forge".to_string());
        }
        channels
    }

    /// The `CONDA_SUBDIR` to install with on `platform`, if not the native one.
    pub fn conda_subdir(&self, platform: &str) -> Option<&'static str> {
        match self {
            Install::Conda { osx64: true, .. } if platform == "osx-arm64" => Some("osx-64"),
            _ => None,
        }
    }

    /// What goes into the step's definition hash in place of an environment
    /// name, so changing a pin or a download re-runs the step.
    pub fn hash_label(&self, platform: &str) -> Option<String> {
        match self {
            Install::Conda { .. } => self.conda_env_name(platform),
            Install::External { binary, sha256, .. } => Some(format!(
                "external:{}:{}",
                binary,
                sha256.get(platform).map(String::as_str).unwrap_or("")
            )),
            Install::System { .. } => None,
        }
    }

    /// The folder an external download lives in, named for the binary and the
    /// start of its checksum (a new checksum is a new folder).
    fn external_dir(&self, root: &Path, platform: &str) -> Result<PathBuf, String> {
        let Install::External { binary, sha256, .. } = self else {
            return Err("not an external install".to_string());
        };
        let sum = sha256
            .get(platform)
            .ok_or_else(|| format!("'{}' has no download for {}", binary, platform))?;
        let short: String = sum.chars().take(12).collect();
        Ok(root.join(format!(
            "{}-{}",
            sanitize(binary),
            short.to_ascii_lowercase()
        )))
    }

    /// The download address for `platform`, with `{version}` filled in.
    fn download_url(&self, platform: &str) -> Result<String, String> {
        let Install::External {
            binary,
            version,
            url,
            ..
        } = self
        else {
            return Err("not an external install".to_string());
        };
        let template = url.get(platform).ok_or_else(|| {
            format!(
                "'{}' has no download for this computer ({}). Available: {}",
                binary,
                platform,
                url.keys().cloned().collect::<Vec<_>>().join(", ")
            )
        })?;
        Ok(template.replace("{version}", version.as_deref().unwrap_or("")))
    }

    /// The folder to put on the `PATH` for an external tool that is already
    /// installed, or `None` when it is not (or not verified).
    pub fn installed_path_dir(&self, root: &Path, platform: &str) -> Option<PathBuf> {
        let dir = self.external_dir(root, platform).ok()?;
        let relative = fs::read_to_string(dir.join(VERIFIED_MARKER)).ok()?;
        let bin_dir = dir.join(relative.trim());
        let Install::External { binary, .. } = self else {
            return None;
        };
        find_binary_in(&bin_dir, binary).map(|_| bin_dir)
    }

    /// Makes sure an external tool is downloaded, verified and unpacked, and
    /// returns the folder to put on the `PATH`. Does nothing when a verified
    /// copy is already there.
    pub fn ensure_external(&self, root: &Path, platform: &str) -> Result<PathBuf, String> {
        if let Some(dir) = self.installed_path_dir(root, platform) {
            debug!("External tool already installed in {}", dir.display());
            return Ok(dir);
        }
        let Install::External { binary, sha256, .. } = self else {
            return Err("not an external install".to_string());
        };
        // Asked first: its message lists the platforms that do have a download.
        let address = self.download_url(platform)?;
        let expected = sha256
            .get(platform)
            .ok_or_else(|| format!("'{}' has no checksum for {}", binary, platform))?
            .to_ascii_lowercase();
        let final_dir = self.external_dir(root, platform)?;
        fs::create_dir_all(root)
            .map_err(|e| format!("could not create {}: {}", root.display(), e))?;

        // Work in a folder of our own so a failed or interrupted download
        // never leaves something that looks installed.
        let staging = root.join(format!(
            ".partial-{}-{}",
            sanitize(binary),
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&staging);
        fs::create_dir_all(&staging)
            .map_err(|e| format!("could not create {}: {}", staging.display(), e))?;
        let result = self.fetch_into(&address, &expected, &staging, binary);
        let bin_dir = match result {
            Ok(dir) => dir,
            Err(e) => {
                let _ = fs::remove_dir_all(&staging);
                return Err(e);
            }
        };
        let relative = bin_dir
            .strip_prefix(&staging)
            .unwrap_or(Path::new(""))
            .to_string_lossy()
            .to_string();
        if let Err(e) = fs::write(staging.join(VERIFIED_MARKER), &relative) {
            let _ = fs::remove_dir_all(&staging);
            return Err(format!("could not record the download: {}", e));
        }

        let _ = fs::remove_dir_all(&final_dir);
        if let Err(e) = fs::rename(&staging, &final_dir) {
            let _ = fs::remove_dir_all(&staging);
            // Another run may have finished the same download first.
            if let Some(dir) = self.installed_path_dir(root, platform) {
                return Ok(dir);
            }
            return Err(format!(
                "could not install into {}: {}",
                final_dir.display(),
                e
            ));
        }
        info!("Installed '{}' into {}", binary, final_dir.display());
        Ok(final_dir.join(relative))
    }

    /// Downloads `address` into `staging`, verifies it and unpacks it. Returns
    /// the folder (inside `staging`) that holds the binary.
    fn fetch_into(
        &self,
        address: &str,
        expected: &str,
        staging: &Path,
        binary: &str,
    ) -> Result<PathBuf, String> {
        let file_name = address
            .rsplit('/')
            .next()
            .filter(|n| !n.is_empty())
            .map(sanitize)
            .unwrap_or_else(|| "download".to_string());
        let download = staging.join(format!("download-{}", file_name));

        if let Some(local) = address.strip_prefix("file://") {
            fs::copy(local, &download).map_err(|e| format!("could not read {}: {}", local, e))?;
        } else {
            info!("Downloading {}", address);
            let output = Command::new("curl")
                .args(["-fsSL", "--retry", "2", "-o"])
                .arg(&download)
                .arg(address)
                .output()
                .map_err(|e| format!("could not run curl to download {}: {}", address, e))?;
            if !output.status.success() {
                return Err(format!(
                    "download of {} failed: {}",
                    address,
                    String::from_utf8_lossy(&output.stderr).trim()
                ));
            }
        }

        let actual =
            sha256_file(&download).map_err(|e| format!("could not read the download: {}", e))?;
        if actual != expected {
            return Err(format!(
                "the download of {} does not match its checksum (expected {}, got {}); nothing was installed",
                address, expected, actual
            ));
        }

        let lower = file_name.to_ascii_lowercase();
        let unpack_dir = staging.join("unpacked");
        fs::create_dir_all(&unpack_dir).map_err(|e| e.to_string())?;
        let archive_flags: Option<&str> = if lower.ends_with(".tar.gz") || lower.ends_with(".tgz") {
            Some("-xzf")
        } else if lower.ends_with(".tar.bz2") || lower.ends_with(".tbz2") {
            Some("-xjf")
        } else if lower.ends_with(".tar.xz") {
            Some("-xJf")
        } else {
            None
        };
        if let Some(flags) = archive_flags {
            let output = Command::new("tar")
                .arg(flags)
                .arg(&download)
                .arg("-C")
                .arg(&unpack_dir)
                .output()
                .map_err(|e| format!("could not run tar: {}", e))?;
            if !output.status.success() {
                return Err(format!(
                    "could not unpack {}: {}",
                    file_name,
                    String::from_utf8_lossy(&output.stderr).trim()
                ));
            }
        } else if lower.ends_with(".zip") {
            let output = Command::new("unzip")
                .args(["-q", "-o"])
                .arg(&download)
                .arg("-d")
                .arg(&unpack_dir)
                .output()
                .map_err(|e| format!("could not run unzip: {}", e))?;
            if !output.status.success() {
                return Err(format!(
                    "could not unpack {}: {}",
                    file_name,
                    String::from_utf8_lossy(&output.stderr).trim()
                ));
            }
        } else {
            // A bare executable: it must be called what the step runs.
            fs::copy(&download, unpack_dir.join(binary)).map_err(|e| e.to_string())?;
        }
        let _ = fs::remove_file(&download);

        let found = find_binary_in(&unpack_dir, binary)
            .ok_or_else(|| format!("the download does not contain a file named '{}'", binary))?;
        make_executable(&found)
            .map_err(|e| format!("could not make '{}' runnable: {}", binary, e))?;
        found
            .parent()
            .map(Path::to_path_buf)
            .ok_or_else(|| "binary has no folder".to_string())
    }
}

/// Written into a finished install folder: the folder (relative) to put on the
/// `PATH`. A folder without it is a failed or foreign download and is replaced.
const VERIFIED_MARKER: &str = ".rustrunner-verified";

/// Finds a file called `binary` (or `binary.exe`) in `dir` or below.
fn find_binary_in(dir: &Path, binary: &str) -> Option<PathBuf> {
    let direct = dir.join(binary);
    if direct.is_file() {
        return Some(direct);
    }
    let entries = fs::read_dir(dir).ok()?;
    let mut subdirs = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name();
        if path.is_file() && (name == binary || name.to_string_lossy() == format!("{}.exe", binary))
        {
            return Some(path);
        }
        if path.is_dir() {
            subdirs.push(path);
        }
    }
    subdirs.sort();
    subdirs.iter().find_map(|d| find_binary_in(d, binary))
}

#[cfg(unix)]
fn make_executable(path: &Path) -> std::io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    let mut perms = fs::metadata(path)?.permissions();
    perms.set_mode(perms.mode() | 0o755);
    fs::set_permissions(path, perms)
}

#[cfg(not(unix))]
fn make_executable(_path: &Path) -> std::io::Result<()> {
    Ok(())
}

/// The first executable called `binary` on the `PATH`.
pub fn find_on_path(binary: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path).find_map(|dir| {
        let candidate = dir.join(binary);
        is_executable_file(&candidate).then_some(candidate)
    })
}

#[cfg(unix)]
fn is_executable_file(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    fs::metadata(path)
        .map(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
        .unwrap_or(false)
}

#[cfg(not(unix))]
fn is_executable_file(path: &Path) -> bool {
    path.is_file() || path.with_extension("exe").is_file()
}

/// The `PATH` value with `dir` first.
pub fn path_with_first(dir: &Path) -> Option<std::ffi::OsString> {
    let mut entries = vec![dir.to_path_buf()];
    if let Some(existing) = std::env::var_os("PATH") {
        entries.extend(std::env::split_paths(&existing));
    }
    std::env::join_paths(entries).ok()
}

// ---------------------------------------------------------------------------
// SHA-256 (FIPS 180-4). Small and dependency free: downloads are verified
// with it, and a wrong implementation would be caught by the known-answer
// tests below.
// ---------------------------------------------------------------------------

const K: [u32; 64] = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

struct Sha256 {
    state: [u32; 8],
    buffer: Vec<u8>,
    length: u64,
}

impl Sha256 {
    fn new() -> Self {
        Self {
            state: [
                0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab,
                0x5be0cd19,
            ],
            buffer: Vec::with_capacity(64),
            length: 0,
        }
    }

    fn compress(state: &mut [u32; 8], block: &[u8]) {
        let mut w = [0u32; 64];
        for (i, chunk) in block.chunks_exact(4).enumerate() {
            w[i] = u32::from_be_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]);
        }
        for i in 16..64 {
            let s0 = w[i - 15].rotate_right(7) ^ w[i - 15].rotate_right(18) ^ (w[i - 15] >> 3);
            let s1 = w[i - 2].rotate_right(17) ^ w[i - 2].rotate_right(19) ^ (w[i - 2] >> 10);
            w[i] = w[i - 16]
                .wrapping_add(s0)
                .wrapping_add(w[i - 7])
                .wrapping_add(s1);
        }
        let [mut a, mut b, mut c, mut d, mut e, mut f, mut g, mut h] = *state;
        for i in 0..64 {
            let s1 = e.rotate_right(6) ^ e.rotate_right(11) ^ e.rotate_right(25);
            let ch = (e & f) ^ (!e & g);
            let t1 = h
                .wrapping_add(s1)
                .wrapping_add(ch)
                .wrapping_add(K[i])
                .wrapping_add(w[i]);
            let s0 = a.rotate_right(2) ^ a.rotate_right(13) ^ a.rotate_right(22);
            let maj = (a & b) ^ (a & c) ^ (b & c);
            let t2 = s0.wrapping_add(maj);
            h = g;
            g = f;
            f = e;
            e = d.wrapping_add(t1);
            d = c;
            c = b;
            b = a;
            a = t1.wrapping_add(t2);
        }
        for (slot, value) in state.iter_mut().zip([a, b, c, d, e, f, g, h]) {
            *slot = slot.wrapping_add(value);
        }
    }

    fn update(&mut self, mut data: &[u8]) {
        self.length += data.len() as u64;
        if !self.buffer.is_empty() {
            let take = (64 - self.buffer.len()).min(data.len());
            self.buffer.extend_from_slice(&data[..take]);
            data = &data[take..];
            if self.buffer.len() == 64 {
                let block = std::mem::take(&mut self.buffer);
                Self::compress(&mut self.state, &block);
            }
        }
        while data.len() >= 64 {
            Self::compress(&mut self.state, &data[..64]);
            data = &data[64..];
        }
        self.buffer.extend_from_slice(data);
    }

    fn finish(mut self) -> String {
        let bit_length = self.length * 8;
        let mut tail = std::mem::take(&mut self.buffer);
        tail.push(0x80);
        while tail.len() % 64 != 56 {
            tail.push(0);
        }
        tail.extend_from_slice(&bit_length.to_be_bytes());
        for block in tail.chunks_exact(64) {
            Self::compress(&mut self.state, block);
        }
        self.state.iter().map(|w| format!("{:08x}", w)).collect()
    }
}

/// Lower-case hex SHA-256 of `data`.
pub fn sha256_hex(data: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(data);
    hasher.finish()
}

/// Lower-case hex SHA-256 of a file, read in chunks.
pub fn sha256_file(path: &Path) -> std::io::Result<String> {
    let mut file = fs::File::open(path)?;
    let mut hasher = Sha256::new();
    let mut chunk = vec![0u8; 1 << 16];
    loop {
        let n = file.read(&mut chunk)?;
        if n == 0 {
            break;
        }
        hasher.update(&chunk[..n]);
    }
    Ok(hasher.finish())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn conda(version: Option<&str>, osx64: bool) -> Install {
        Install::Conda {
            package: "star".to_string(),
            version: version.map(String::from),
            channel: None,
            osx64,
            constraints: Vec::new(),
        }
    }

    fn external(url: &str, sum: &str, binary: &str) -> Install {
        let mut urls = BTreeMap::new();
        let mut sums = BTreeMap::new();
        for platform in PLATFORMS {
            urls.insert(platform.to_string(), url.to_string());
            sums.insert(platform.to_string(), sum.to_string());
        }
        Install::External {
            binary: binary.to_string(),
            version: Some("1.2.3".to_string()),
            url: urls,
            sha256: sums,
            license: Some("MIT".to_string()),
        }
    }

    #[test]
    fn test_sha256_known_answers() {
        assert_eq!(
            sha256_hex(b""),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
        assert_eq!(
            sha256_hex(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        assert_eq!(
            sha256_hex(b"abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"),
            "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1"
        );
    }

    #[test]
    fn test_sha256_block_boundaries_and_chunked_updates_agree() {
        let data: Vec<u8> = (0..1000u32).map(|i| (i % 251) as u8).collect();
        let whole = sha256_hex(&data);
        for split in [1usize, 55, 56, 63, 64, 65, 127, 128, 999] {
            let mut hasher = Sha256::new();
            hasher.update(&data[..split]);
            hasher.update(&data[split..]);
            assert_eq!(hasher.finish(), whole, "split at {}", split);
        }
        // A million 'a' is the third FIPS test vector.
        let mut hasher = Sha256::new();
        for _ in 0..1000 {
            hasher.update(&[b'a'; 1000]);
        }
        assert_eq!(
            hasher.finish(),
            "cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0"
        );
    }

    #[test]
    fn test_conda_env_name_holds_the_version() {
        assert_eq!(
            conda(Some("2.7.10b"), false).conda_env_name("linux-64"),
            Some("star-2.7.10b".to_string())
        );
        assert_eq!(
            conda(None, false).conda_env_name("linux-64"),
            Some("star".to_string())
        );
        // Two pins never share an environment.
        assert_ne!(
            conda(Some("2.7.10b"), false).conda_env_name("linux-64"),
            conda(Some("2.7.11b"), false).conda_env_name("linux-64")
        );
    }

    fn with_constraints(constraints: &[&str]) -> Install {
        Install::Conda {
            package: "pod5".into(),
            version: Some("0.3.48".into()),
            channel: None,
            osx64: false,
            constraints: constraints.iter().map(|c| c.to_string()).collect(),
        }
    }

    #[test]
    fn test_extra_packages_follow_the_pin_and_name_the_environment() {
        let plain = with_constraints(&[]);
        let limited = with_constraints(&["polars<2"]);
        assert_eq!(plain.conda_specs(), ["pod5==0.3.48"]);
        assert_eq!(limited.conda_specs(), ["pod5==0.3.48", "polars<2"]);
        assert_eq!(
            plain.conda_env_name("linux-64"),
            Some("pod5-0.3.48".to_string())
        );
        let name = limited.conda_env_name("linux-64").unwrap();
        assert!(name.starts_with("pod5-0.3.48-x"), "{name}");
        assert_eq!(name.len(), "pod5-0.3.48-x".len() + 8);
        assert_ne!(
            limited.conda_env_name("linux-64"),
            with_constraints(&["polars<1.9"]).conda_env_name("linux-64")
        );
        // Changing the extra packages changes the step's definition hash.
        assert_ne!(plain.hash_label("linux-64"), limited.hash_label("linux-64"));
        assert!(limited.describe().contains("with polars<2"));
        assert!(limited.problems().is_empty());
    }

    #[test]
    fn test_extra_packages_must_be_plain_specs() {
        for good in ["polars<2", "numpy>=1.26,<2", "pyarrow!=21.0", "x==1.*"] {
            assert!(with_constraints(&[good]).problems().is_empty(), "{good}");
        }
        for bad in [
            "",
            "polars",
            "<2",
            "-polars<2",
            "polars<2; rm -rf ~",
            "a b<2",
            "polars<$X",
        ] {
            assert!(!with_constraints(&[bad]).problems().is_empty(), "{bad:?}");
        }
    }

    #[test]
    fn test_extra_packages_round_trip_through_yaml() {
        let step: Install = serde_yaml::from_str(
            "kind: conda\npackage: pod5\nversion: '0.3.48'\nconstraints: ['polars<2']\n",
        )
        .unwrap();
        assert_eq!(step, with_constraints(&["polars<2"]));
        let text = serde_yaml::to_string(&step).unwrap();
        assert!(text.contains("polars<2"), "{text}");
        let none = serde_yaml::to_string(&with_constraints(&[])).unwrap();
        assert!(!none.contains("constraints"), "{none}");
    }

    #[test]
    fn test_osx64_only_changes_apple_silicon() {
        let pin = conda(Some("2.7.10b"), true);
        assert_eq!(
            pin.conda_env_name("osx-arm64"),
            Some("star-2.7.10b-osx64".to_string())
        );
        assert_eq!(pin.conda_subdir("osx-arm64"), Some("osx-64"));
        for platform in ["linux-64", "linux-aarch64", "osx-64", "win-64"] {
            assert_eq!(
                pin.conda_env_name(platform),
                Some("star-2.7.10b".to_string())
            );
            assert_eq!(pin.conda_subdir(platform), None);
        }
        assert_eq!(
            conda(Some("2.7.10b"), false).conda_subdir("osx-arm64"),
            None
        );
    }

    #[test]
    fn test_conda_spec_and_channels() {
        assert_eq!(
            conda(Some("2.7.10b"), false).conda_spec(),
            Some("star==2.7.10b".to_string())
        );
        assert_eq!(conda(None, false).conda_spec(), Some("star".to_string()));
        assert_eq!(
            conda(None, false).conda_channels(),
            ["bioconda", "conda-forge"]
        );
        let custom = Install::Conda {
            package: "x".into(),
            version: None,
            channel: Some("conda-forge".into()),
            osx64: false,
            constraints: Vec::new(),
        };
        assert_eq!(custom.conda_channels(), ["conda-forge"]);
        let other = Install::Conda {
            package: "x".into(),
            version: None,
            channel: Some("my-channel".into()),
            osx64: false,
            constraints: Vec::new(),
        };
        assert_eq!(other.conda_channels(), ["my-channel", "conda-forge"]);
    }

    #[test]
    fn test_yaml_round_trip_and_defaults() {
        let step: Install =
            serde_yaml::from_str("kind: conda\npackage: samtools\nversion: '1.24'\n").unwrap();
        assert_eq!(
            step,
            Install::Conda {
                package: "samtools".into(),
                version: Some("1.24".into()),
                channel: None,
                osx64: false,
                constraints: Vec::new()
            }
        );
        let text = serde_yaml::to_string(&step).unwrap();
        assert!(
            !text.contains("osx64"),
            "default flag is not written: {text}"
        );
        let system: Install = serde_yaml::from_str("kind: system\nbinary: minimap2\n").unwrap();
        assert_eq!(
            system,
            Install::System {
                binary: "minimap2".into()
            }
        );
        assert!(serde_yaml::from_str::<Install>("kind: nonsense\n").is_err());
    }

    #[test]
    fn test_problems_name_the_fix() {
        assert!(conda(Some("2.7.10b"), false).problems().is_empty());
        assert!(!conda(Some("1.0; rm -rf ~"), false).problems().is_empty());
        let bad_package = Install::Conda {
            package: "a b".into(),
            version: None,
            channel: None,
            osx64: false,
            constraints: Vec::new(),
        };
        assert!(!bad_package.problems().is_empty());
        let good = external("https://example.org/t.tar.gz", &"a".repeat(64), "tool");
        assert!(good.problems().is_empty(), "{:?}", good.problems());
        assert!(!external("http://example.org/t", &"a".repeat(64), "tool")
            .problems()
            .is_empty());
        assert!(!external("https://example.org/t", "abc", "tool")
            .problems()
            .is_empty());
        assert!(
            !external("https://example.org/t", &"a".repeat(64), "../tool")
                .problems()
                .is_empty()
        );
        assert!(!Install::System {
            binary: "a/b".into()
        }
        .problems()
        .is_empty());
    }

    #[test]
    fn test_hash_label_changes_with_the_pin_and_the_checksum() {
        assert_ne!(
            conda(Some("1"), false).hash_label("linux-64"),
            conda(Some("2"), false).hash_label("linux-64")
        );
        assert_eq!(
            Install::System { binary: "x".into() }.hash_label("linux-64"),
            None
        );
        let a = external("https://e.org/t", &"a".repeat(64), "t");
        let b = external("https://e.org/t", &"b".repeat(64), "t");
        assert_ne!(a.hash_label("linux-64"), b.hash_label("linux-64"));
    }

    /// A tool "download": a tiny shell script, as a bare file and as a tarball.
    fn make_download(dir: &Path) -> (PathBuf, String) {
        let file = dir.join("hello-tool");
        fs::write(&file, "#!/bin/sh\necho hello from the tool\n").unwrap();
        let sum = sha256_file(&file).unwrap();
        (file, sum)
    }

    #[test]
    fn test_external_bare_binary_is_downloaded_verified_and_reused() {
        let source = TempDir::new().unwrap();
        let root = TempDir::new().unwrap();
        let (file, sum) = make_download(source.path());
        let install = external(&format!("file://{}", file.display()), &sum, "hello-tool");

        assert!(install
            .installed_path_dir(root.path(), "linux-64")
            .is_none());
        let dir = install.ensure_external(root.path(), "linux-64").unwrap();
        assert!(dir.join("hello-tool").is_file());
        assert_eq!(
            install.installed_path_dir(root.path(), "linux-64"),
            Some(dir.clone())
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = fs::metadata(dir.join("hello-tool"))
                .unwrap()
                .permissions()
                .mode();
            assert_ne!(mode & 0o111, 0, "must be executable");
        }

        // A second call reuses it: it works even after the source is gone.
        fs::remove_file(&file).unwrap();
        assert_eq!(
            install.ensure_external(root.path(), "linux-64").unwrap(),
            dir
        );
    }

    #[test]
    fn test_external_wrong_checksum_installs_nothing() {
        let source = TempDir::new().unwrap();
        let root = TempDir::new().unwrap();
        let (file, _) = make_download(source.path());
        let install = external(
            &format!("file://{}", file.display()),
            &"0".repeat(64),
            "hello-tool",
        );
        let error = install
            .ensure_external(root.path(), "linux-64")
            .unwrap_err();
        assert!(error.contains("checksum"), "{error}");
        assert!(install
            .installed_path_dir(root.path(), "linux-64")
            .is_none());
        // No half-finished folders are left behind.
        let leftovers: Vec<_> = fs::read_dir(root.path()).unwrap().flatten().collect();
        assert!(leftovers.is_empty(), "{:?}", leftovers);
    }

    #[test]
    fn test_external_tarball_is_unpacked_and_binary_found_in_subfolder() {
        let source = TempDir::new().unwrap();
        let root = TempDir::new().unwrap();
        let pack = source.path().join("pack").join("tool-1.2.3").join("bin");
        fs::create_dir_all(&pack).unwrap();
        fs::write(pack.join("hello-tool"), "#!/bin/sh\necho hi\n").unwrap();
        fs::write(pack.parent().unwrap().join("README"), "x").unwrap();
        let tarball = source.path().join("tool.tar.gz");
        let status = Command::new("tar")
            .arg("-czf")
            .arg(&tarball)
            .arg("-C")
            .arg(source.path().join("pack"))
            .arg("tool-1.2.3")
            .status()
            .unwrap();
        assert!(status.success());
        let sum = sha256_file(&tarball).unwrap();
        let install = external(&format!("file://{}", tarball.display()), &sum, "hello-tool");
        let dir = install.ensure_external(root.path(), "osx-arm64").unwrap();
        assert!(dir.ends_with("bin"), "{}", dir.display());
        assert!(dir.join("hello-tool").is_file());
    }

    #[test]
    fn test_external_archive_without_the_binary_is_an_error() {
        let source = TempDir::new().unwrap();
        let root = TempDir::new().unwrap();
        fs::create_dir_all(source.path().join("pack")).unwrap();
        fs::write(source.path().join("pack").join("other"), "x").unwrap();
        let tarball = source.path().join("t.tgz");
        assert!(Command::new("tar")
            .arg("-czf")
            .arg(&tarball)
            .arg("-C")
            .arg(source.path().join("pack"))
            .arg("other")
            .status()
            .unwrap()
            .success());
        let sum = sha256_file(&tarball).unwrap();
        let install = external(&format!("file://{}", tarball.display()), &sum, "hello-tool");
        let error = install
            .ensure_external(root.path(), "linux-64")
            .unwrap_err();
        assert!(error.contains("hello-tool"), "{error}");
        assert!(fs::read_dir(root.path()).unwrap().next().is_none());
    }

    #[test]
    fn test_external_missing_platform_names_the_platforms() {
        let root = TempDir::new().unwrap();
        let mut urls = BTreeMap::new();
        let mut sums = BTreeMap::new();
        urls.insert("linux-64".to_string(), "https://e.org/t".to_string());
        sums.insert("linux-64".to_string(), "a".repeat(64));
        let install = Install::External {
            binary: "t".into(),
            version: None,
            url: urls,
            sha256: sums,
            license: None,
        };
        let error = install
            .ensure_external(root.path(), "osx-arm64")
            .unwrap_err();
        assert!(
            error.contains("osx-arm64") && error.contains("linux-64"),
            "{error}"
        );
    }

    #[test]
    fn test_version_is_filled_into_the_url_template() {
        let install = external(
            "https://e.org/v{version}/t-{version}.tgz",
            &"a".repeat(64),
            "t",
        );
        assert_eq!(
            install.download_url("linux-64").unwrap(),
            "https://e.org/v1.2.3/t-1.2.3.tgz"
        );
    }

    #[test]
    fn test_find_on_path_and_path_with_first() {
        // `sh` is on every PATH the tests run with.
        assert!(find_on_path("sh").is_some());
        assert!(find_on_path("definitely-not-a-program-xyz").is_none());
        let joined = path_with_first(Path::new("/tmp/first-dir")).unwrap();
        let first = std::env::split_paths(&joined).next().unwrap();
        assert_eq!(first, PathBuf::from("/tmp/first-dir"));
    }
}
