/**
 * Installing the tool installer (micromamba).
 *
 * When the engine reports that micromamba is missing (a `setup_failed` event),
 * the app can fetch the official static binary for this platform. Kept free of
 * Electron imports so it can be unit-tested.
 *
 * Safety rules, all enforced here and covered by tests:
 * - only https URLs are fetched (also for every redirect);
 * - the version and the SHA-256 of each platform's binary are pinned below, and
 *   the bytes are verified before anything is written under the final name,
 *   made executable or used;
 * - the file is written next to its destination and renamed into place, so a
 *   failed or interrupted install never leaves a half-written binary behind.
 *
 * To update micromamba: change the version, then take each hash from the
 * release page (https://github.com/mamba-org/micromamba-releases/releases),
 * which lists a SHA-256 digest for every asset.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as https from 'https';
import * as path from 'path';

export interface MicromambaAsset {
  /** Where to download the binary from. */
  url: string;
  /** Lower-case hex SHA-256 of the binary. */
  sha256: string;
}

/** The release the app installs. */
export const MICROMAMBA_VERSION = '2.9.0-0';

const RELEASE_BASE = `https://github.com/mamba-org/micromamba-releases/releases/download/${MICROMAMBA_VERSION}`;

/** Official static binaries by platform key (see {@link platformKey}). */
export const MICROMAMBA_MANIFEST: Readonly<Record<string, MicromambaAsset>> = {
  'osx-arm64': {
    url: `${RELEASE_BASE}/micromamba-osx-arm64`,
    sha256: 'ec2a072f028e1a7cf20f3e2e74d5a8127cf5a5f27636375b5359811565f4e5be',
  },
  'osx-64': {
    url: `${RELEASE_BASE}/micromamba-osx-64`,
    sha256: '1e71054bb3ac9a076e21f7ec48acfef536f9b3f1408f371a942784bf5ef83d8a',
  },
  'linux-64': {
    url: `${RELEASE_BASE}/micromamba-linux-64`,
    sha256: '366cd9cd8be14df1ab8ed50352a82111082a36686b2d389fdb79a92c3fafb3e3',
  },
  'linux-aarch64': {
    url: `${RELEASE_BASE}/micromamba-linux-aarch64`,
    sha256: '9f93b974adcb4d166996af969b6cd371287d1a3e52733704727884d9b74cb7a7',
  },
  'win-64': {
    url: `${RELEASE_BASE}/micromamba-win-64.exe`,
    sha256: 'a6d804394b2418991c4e29562853eaace2f2ce9d9da661a98e74e02e8dbb44b0',
  },
};

/** Largest download accepted; the real binaries are 11 to 22 MB. */
export const MAX_DOWNLOAD_BYTES = 64 * 1024 * 1024;

/** The manifest key for a Node platform and architecture, or null when there is none. */
export function platformKey(platform: string, arch: string): string | null {
  if (platform === 'darwin') return arch === 'arm64' ? 'osx-arm64' : arch === 'x64' ? 'osx-64' : null;
  if (platform === 'linux') return arch === 'x64' ? 'linux-64' : arch === 'arm64' ? 'linux-aarch64' : null;
  if (platform === 'win32') return arch === 'x64' ? 'win-64' : null;
  return null;
}

/** The file name of the binary on `platform`. */
export function binaryFileName(platform: string): string {
  return platform === 'win32' ? 'micromamba.exe' : 'micromamba';
}

/**
 * Environment variable that points the install at a local fixture, for tests of
 * the app only: its value is JSON `{"url": "file:///...", "sha256": "..."}`.
 * Ignored by a packaged app.
 */
export const TEST_SOURCE_ENV = 'RUSTRUNNER_TEST_MICROMAMBA_SOURCE';

export interface ResolvedSource {
  asset: MicromambaAsset;
  /** Whether a file:// URL may be fetched. True only for the test override. */
  allowFile: boolean;
}

/**
 * Chooses what to download. A packaged app always uses the pinned manifest; an
 * app run from source may be pointed at a local fixture by the test override.
 */
export function resolveSource(opts: {
  platform: string;
  arch: string;
  isPackaged: boolean;
  env: Record<string, string | undefined>;
}): ResolvedSource | { error: string } {
  const override = opts.env[TEST_SOURCE_ENV];
  if (override && !opts.isPackaged) {
    try {
      const parsed = JSON.parse(override) as Partial<MicromambaAsset>;
      if (typeof parsed.url === 'string' && typeof parsed.sha256 === 'string') {
        return { asset: { url: parsed.url, sha256: parsed.sha256.toLowerCase() }, allowFile: true };
      }
    } catch {
      /* fall through to the error below */
    }
    return { error: `${TEST_SOURCE_ENV} is not valid JSON with "url" and "sha256".` };
  }
  const key = platformKey(opts.platform, opts.arch);
  const asset = key ? MICROMAMBA_MANIFEST[key] : undefined;
  if (!asset) {
    return {
      error:
        `There is no ready-made tool installer for ${opts.platform} (${opts.arch}). ` +
        'Download micromamba from https://micro.mamba.pm/ and put it on your PATH.',
    };
  }
  return { asset, allowFile: false };
}

/**
 * Where the installer goes. An explicit `RUSTRUNNER_MICROMAMBA` is the file the
 * engine will look for, so that is where it goes. Otherwise a packaged app
 * installs under the person's home (its own folder is read-only), and an app
 * run from source installs where the engine looks first when run from source:
 * `RustRunner/runtime/micromamba`.
 */
export function installTarget(opts: {
  platform: string;
  isPackaged: boolean;
  env: Record<string, string | undefined>;
  homeDir: string;
  sourceRuntimeDir: string;
}): string {
  const explicit = opts.env.RUSTRUNNER_MICROMAMBA;
  if (explicit) return explicit;
  const name = binaryFileName(opts.platform);
  return opts.isPackaged
    ? path.join(opts.homeDir, '.rustrunner', 'bin', name)
    : path.join(opts.sourceRuntimeDir, name);
}

/** Fetches `url` and returns its bytes. */
export type Fetcher = (url: string) => Promise<Buffer>;

/** Throws unless `url` may be fetched: https always, file only when allowed. */
export function assertFetchable(url: string, allowFile: boolean): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Not a valid address: ${url}`);
  }
  if (parsed.protocol === 'https:') return parsed;
  if (parsed.protocol === 'file:' && allowFile) return parsed;
  throw new Error(`Refusing to download over ${parsed.protocol.replace(':', '')}: only https is allowed.`);
}

const MAX_REDIRECTS = 5;

/** A fetcher over https that follows redirects, every hop https again. */
export function httpsFetcher(maxBytes: number = MAX_DOWNLOAD_BYTES): Fetcher {
  const get = (url: string, redirects: number): Promise<Buffer> =>
    new Promise((resolve, reject) => {
      let parsed: URL;
      try {
        parsed = assertFetchable(url, false);
      } catch (e) {
        reject(e);
        return;
      }
      const req = https.get(parsed, (res) => {
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400 && res.headers.location) {
          res.resume();
          if (redirects >= MAX_REDIRECTS) {
            reject(new Error('Too many redirects while downloading.'));
            return;
          }
          // A relative Location is resolved against the current address.
          get(new URL(res.headers.location, parsed).toString(), redirects + 1).then(resolve, reject);
          return;
        }
        if (status !== 200) {
          res.resume();
          reject(new Error(`The download failed (HTTP ${status}).`));
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > maxBytes) {
            req.destroy(new Error('The download is larger than expected; stopped.'));
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => resolve(Buffer.concat(chunks)));
        res.on('error', reject);
      });
      req.setTimeout(60_000, () => req.destroy(new Error('The download timed out.')));
      req.on('error', reject);
    });
  return (url) => get(url, 0);
}

/** A fetcher that also reads file:// URLs; for the test override only. */
export function fileOrHttpsFetcher(maxBytes: number = MAX_DOWNLOAD_BYTES): Fetcher {
  const https_ = httpsFetcher(maxBytes);
  return async (url) => {
    const parsed = assertFetchable(url, true);
    if (parsed.protocol === 'file:') {
      const data = await fs.promises.readFile(parsed);
      if (data.length > maxBytes) throw new Error('The file is larger than expected.');
      return data;
    }
    return https_(url);
  };
}

export type InstallResult = { ok: true; path: string } | { ok: false; error: string };

/**
 * Downloads `source`, checks its SHA-256 and puts it at `target`, executable.
 * Nothing is written under `target` unless the checksum matches.
 */
export async function installMicromamba(opts: {
  source: ResolvedSource;
  target: string;
  fetcher?: Fetcher;
}): Promise<InstallResult> {
  const { asset, allowFile } = opts.source;
  try {
    assertFetchable(asset.url, allowFile);
    const fetcher = opts.fetcher ?? (allowFile ? fileOrHttpsFetcher() : httpsFetcher());
    const data = await fetcher(asset.url);

    const actual = crypto.createHash('sha256').update(data).digest('hex');
    if (actual !== asset.sha256.toLowerCase()) {
      return {
        ok: false,
        error:
          'The downloaded file did not match its expected checksum, so it was thrown away. ' +
          'Try again, or download micromamba yourself from https://micro.mamba.pm/.',
      };
    }

    const dir = path.dirname(opts.target);
    await fs.promises.mkdir(dir, { recursive: true });
    const temp = path.join(dir, `.${path.basename(opts.target)}.${process.pid}.download`);
    try {
      await fs.promises.writeFile(temp, data, { mode: 0o600 });
      await fs.promises.chmod(temp, 0o755);
      await fs.promises.rename(temp, opts.target);
    } catch (e) {
      await fs.promises.rm(temp, { force: true });
      throw e;
    }
    return { ok: true, path: opts.target };
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    return { ok: false, error: `Could not install the tool installer: ${detail}` };
  }
}
