/**
 * What the running version is, in words, and which updates it may be offered.
 *
 * RustRunner 1.0.0-beta.1 is the open beta. The rules, kept here so they are
 * tested rather than implied by a library default:
 *
 *   - A build whose version has a prerelease part (`1.0.0-beta.1`) follows the
 *     prerelease line: it is offered the next beta and the final 1.0.0.
 *   - A build without one (`0.11.1`, `1.0.0`) is offered stable releases only.
 *     A beta published on GitHub as a "pre-release" never reaches it.
 *   - Nobody is downgraded: a beta user is not moved back to 0.11.x.
 *
 * For this to hold, a beta tag must be published on GitHub as a "pre-release"
 * (the release workflow leaves a draft; tick the box when publishing it).
 *
 * electron-updater already sets `allowPrerelease` from the current version;
 * `setupAutoUpdater` sets it from this module as well, so the intent is
 * written down and tested, and a library change cannot alter it silently.
 */

export interface VersionInfo {
  /** The version as written, without a leading `v`. */
  version: string;
  /** Prerelease label (`beta`, `alpha`, `rc`), or null for a stable version. */
  channel: string | null;
  /** Short wording for the UI: "1.0.0-beta.1 (open beta)", or the bare version. */
  label: string;
}

const SEMVER = /^v?(\d+\.\d+\.\d+)(?:-([0-9A-Za-z-]+)(?:\.[0-9A-Za-z.-]+)?)?(?:\+[0-9A-Za-z.-]+)?$/;

export function describeVersion(raw: string): VersionInfo {
  const text = raw.trim();
  const match = SEMVER.exec(text);
  const version = text.replace(/^v/, '');
  if (!match) return { version, channel: null, label: version };
  const channel = match[2] ? match[2].toLowerCase() : null;
  let suffix = '';
  if (channel === 'beta') suffix = ' (open beta)';
  else if (channel) suffix = ` (${channel} build)`;
  return { version, channel, label: `${version}${suffix}` };
}

export interface UpdatePolicy {
  /** electron-updater `allowPrerelease`. */
  allowPrerelease: boolean;
  /** electron-updater `allowDowngrade`. */
  allowDowngrade: boolean;
}

export function updatePolicyFor(currentVersion: string): UpdatePolicy {
  return { allowPrerelease: describeVersion(currentVersion).channel !== null, allowDowngrade: false };
}
