import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  MICROMAMBA_MANIFEST,
  TEST_SOURCE_ENV,
  assertFetchable,
  binaryFileName,
  fileOrHttpsFetcher,
  httpsFetcher,
  installMicromamba,
  installTarget,
  platformKey,
  resolveSource,
} from './micromambaInstall';

const sha = (data: Buffer | string) => crypto.createHash('sha256').update(data).digest('hex');

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-install-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('the pinned manifest', () => {
  it('has an https URL and a 64 digit hash for every platform', () => {
    for (const [key, asset] of Object.entries(MICROMAMBA_MANIFEST)) {
      expect(asset.url, key).toMatch(/^https:\/\/github\.com\/mamba-org\/micromamba-releases\/releases\/download\/\d/);
      expect(asset.sha256, key).toMatch(/^[0-9a-f]{64}$/);
      expect(asset.url, key).toContain(key);
    }
  });

  it('covers the platforms the app is built for', () => {
    expect(platformKey('darwin', 'arm64')).toBe('osx-arm64');
    expect(platformKey('darwin', 'x64')).toBe('osx-64');
    expect(platformKey('linux', 'x64')).toBe('linux-64');
    expect(platformKey('linux', 'arm64')).toBe('linux-aarch64');
    expect(platformKey('win32', 'x64')).toBe('win-64');
    expect(platformKey('freebsd', 'x64')).toBeNull();
    for (const key of ['osx-arm64', 'osx-64', 'linux-64', 'linux-aarch64', 'win-64']) {
      expect(MICROMAMBA_MANIFEST[key]).toBeDefined();
    }
  });
});

describe('resolveSource', () => {
  const base = { platform: 'darwin', arch: 'arm64', isPackaged: false };

  it('uses the pinned manifest and refuses file addresses by default', () => {
    const source = resolveSource({ ...base, env: {} });
    expect('error' in source).toBe(false);
    if (!('error' in source)) {
      expect(source.asset).toEqual(MICROMAMBA_MANIFEST['osx-arm64']);
      expect(source.allowFile).toBe(false);
    }
  });

  it('says so when there is no build for the platform', () => {
    const source = resolveSource({ ...base, platform: 'freebsd', env: {} });
    expect('error' in source && source.error).toMatch(/no ready-made tool installer/i);
  });

  it('accepts the test override only when the app runs from source', () => {
    const override = JSON.stringify({ url: 'file:///tmp/x', sha256: 'AB'.repeat(32) });
    const env = { [TEST_SOURCE_ENV]: override };
    const fromSource = resolveSource({ ...base, env });
    expect('error' in fromSource).toBe(false);
    if (!('error' in fromSource)) {
      expect(fromSource.allowFile).toBe(true);
      expect(fromSource.asset.sha256).toBe('ab'.repeat(32));
    }
    // A packaged app ignores it completely and uses the pinned release.
    const packaged = resolveSource({ ...base, isPackaged: true, env });
    expect('error' in packaged).toBe(false);
    if (!('error' in packaged)) {
      expect(packaged.allowFile).toBe(false);
      expect(packaged.asset.url.startsWith('https://')).toBe(true);
    }
  });

  it('rejects a broken override instead of falling back silently', () => {
    const source = resolveSource({ ...base, env: { [TEST_SOURCE_ENV]: '{nope' } });
    expect('error' in source && source.error).toContain(TEST_SOURCE_ENV);
  });
});

describe('installTarget', () => {
  const common = { platform: 'linux', homeDir: '/home/p', sourceRuntimeDir: '/repo/RustRunner/runtime' };

  it('installs into the source tree when run from source, under home when packaged', () => {
    expect(installTarget({ ...common, isPackaged: false, env: {} })).toBe(
      path.join('/repo/RustRunner/runtime', 'micromamba')
    );
    expect(installTarget({ ...common, isPackaged: true, env: {} })).toBe(
      path.join('/home/p', '.rustrunner', 'bin', 'micromamba')
    );
  });

  it('puts the file where RUSTRUNNER_MICROMAMBA says the engine will look', () => {
    expect(installTarget({ ...common, isPackaged: true, env: { RUSTRUNNER_MICROMAMBA: '/opt/mm' } })).toBe('/opt/mm');
  });

  it('names the binary .exe on Windows', () => {
    expect(binaryFileName('win32')).toBe('micromamba.exe');
    expect(binaryFileName('darwin')).toBe('micromamba');
  });
});

describe('assertFetchable', () => {
  it('allows https only, and file only when asked', () => {
    expect(() => assertFetchable('https://example.org/x', false)).not.toThrow();
    expect(() => assertFetchable('http://example.org/x', false)).toThrow(/only https/);
    expect(() => assertFetchable('http://example.org/x', true)).toThrow(/only https/);
    expect(() => assertFetchable('file:///tmp/x', false)).toThrow(/only https/);
    expect(() => assertFetchable('file:///tmp/x', true)).not.toThrow();
    expect(() => assertFetchable('ftp://example.org/x', true)).toThrow();
    expect(() => assertFetchable('not a url', true)).toThrow(/valid address/);
  });

  it('the production fetcher refuses anything but https, even a file address', async () => {
    await expect(httpsFetcher()('file:///etc/hosts')).rejects.toThrow(/only https/);
    await expect(httpsFetcher()('http://127.0.0.1:1/x')).rejects.toThrow(/only https/);
  });
});

describe('installMicromamba', () => {
  const payload = Buffer.from('#!/bin/sh\necho fake micromamba\n');

  it('verifies the checksum, then installs the file executable', async () => {
    const source = { asset: { url: 'https://example.org/mm', sha256: sha(payload) }, allowFile: false };
    const target = path.join(dir, 'runtime', 'micromamba');
    const result = await installMicromamba({ source, target, fetcher: async () => payload });
    expect(result).toEqual({ ok: true, path: target });
    expect(fs.readFileSync(target)).toEqual(payload);
    if (process.platform !== 'win32') {
      expect(fs.statSync(target).mode & 0o111).not.toBe(0);
    }
    // No temporary download is left beside it.
    expect(fs.readdirSync(path.dirname(target))).toEqual(['micromamba']);
  });

  it('writes nothing when the checksum does not match', async () => {
    const source = { asset: { url: 'https://example.org/mm', sha256: sha('something else') }, allowFile: false };
    const target = path.join(dir, 'runtime', 'micromamba');
    const result = await installMicromamba({ source, target, fetcher: async () => payload });
    expect(result.ok).toBe(false);
    expect('error' in result && result.error).toMatch(/checksum/);
    expect(fs.existsSync(target)).toBe(false);
    expect(fs.existsSync(path.dirname(target))).toBe(false);
  });

  it('does not touch an installed binary when a later download is bad', async () => {
    const target = path.join(dir, 'micromamba');
    fs.writeFileSync(target, 'old');
    const source = { asset: { url: 'https://example.org/mm', sha256: sha(payload) }, allowFile: false };
    const result = await installMicromamba({ source, target, fetcher: async () => Buffer.from('tampered') });
    expect(result.ok).toBe(false);
    expect(fs.readFileSync(target, 'utf-8')).toBe('old');
  });

  it('refuses a non-https address without calling the fetcher', async () => {
    let called = false;
    const source = { asset: { url: 'http://example.org/mm', sha256: sha(payload) }, allowFile: false };
    const result = await installMicromamba({
      source,
      target: path.join(dir, 'micromamba'),
      fetcher: async () => {
        called = true;
        return payload;
      },
    });
    expect(called).toBe(false);
    expect('error' in result && result.error).toMatch(/only https/);
  });

  it('refuses a file address unless the source allows it, and reads it when it does', async () => {
    const fixture = path.join(dir, 'fixture');
    fs.writeFileSync(fixture, payload);
    const url = new URL(`file://${fixture}`).toString();
    const asset = { url, sha256: sha(payload) };

    const refused = await installMicromamba({ source: { asset, allowFile: false }, target: path.join(dir, 'a') });
    expect(refused.ok).toBe(false);
    expect(fs.existsSync(path.join(dir, 'a'))).toBe(false);

    const target = path.join(dir, 'b');
    const allowed = await installMicromamba({ source: { asset, allowFile: true }, target });
    expect(allowed).toEqual({ ok: true, path: target });
    expect(fs.readFileSync(target)).toEqual(payload);
    await expect(fileOrHttpsFetcher()('http://example.org/x')).rejects.toThrow(/only https/);
  });

  it('reports a failed download in plain words', async () => {
    const source = { asset: { url: 'https://example.org/mm', sha256: sha(payload) }, allowFile: false };
    const result = await installMicromamba({
      source,
      target: path.join(dir, 'micromamba'),
      fetcher: async () => {
        throw new Error('The download failed (HTTP 404).');
      },
    });
    expect('error' in result && result.error).toBe(
      'Could not install the tool installer: The download failed (HTTP 404).'
    );
  });
});
