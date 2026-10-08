/**
 * Core domain: the engine's install kinds against the real micromamba, with no
 * catalog tool involved. A conda pin must really give that version, a
 * downloaded tool must be verified and found through PATH, and a system tool
 * must just run. (Nothing is downloaded from the network: the "download" is a
 * file:// address inside the sandbox.)
 */
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { SANDBOX, defineDomain, read, type Chain } from '../harness';

const PLATFORMS = ['linux-64', 'linux-aarch64', 'osx-64', 'osx-arm64', 'win-64'];

/** A tiny "tool" the chain pretends to download, and the install block that names it. */
function externalInstall(): Record<string, unknown> {
  const dir = path.join(SANDBOX, 'external-src');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'hello-tool');
  fs.writeFileSync(file, '#!/bin/sh\necho "hello from the downloaded tool"\n');
  const sha = createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  const url: Record<string, string> = {};
  const sums: Record<string, string> = {};
  for (const platform of PLATFORMS) {
    url[platform] = `file://${file}`;
    sums[platform] = sha;
  }
  return { kind: 'external', binary: 'hello-tool', version: '1.0', url, sha256: sums, license: 'MIT' };
}

const CHAINS: Chain[] = [
  {
    name: 'install-kinds',
    files: [],
    nodes: [
      {
        key: 'pinned',
        raw: {
          label: 'Pinned samtools',
          tool: 'samtools',
          command: 'samtools --version | head -1 > pinned_version.txt',
          output: 'pinned_version.txt',
          install: { kind: 'conda', package: 'samtools', version: '1.24', channel: 'bioconda' },
        },
      },
      {
        key: 'download',
        raw: {
          label: 'Downloaded tool',
          tool: 'hello-tool',
          command: 'hello-tool > downloaded.txt',
          output: 'downloaded.txt',
          install: externalInstall(),
        },
      },
      {
        key: 'system',
        raw: {
          label: 'System tool',
          tool: 'sh',
          command: 'sh -c "echo system ok" > system.txt',
          output: 'system.txt',
          install: { kind: 'system', binary: 'sh' },
        },
      },
    ],
    edges: [],
    verify: (dir) => [
      { ok: read(dir, 'pinned_version.txt').includes('samtools 1.24'), message: 'the conda pin gave samtools 1.24' },
      { ok: read(dir, 'downloaded.txt').includes('hello from the downloaded tool'), message: 'the verified download ran' },
      { ok: read(dir, 'system.txt').includes('system ok'), message: 'the system tool ran' },
      {
        ok: fs.existsSync(path.join(SANDBOX, 'home', '.rustrunner', 'tools')),
        message: 'the download went to the sandboxed app data folder',
      },
    ],
  },
];

defineDomain({
  domain: 'core',
  covers: [],
  chains: CHAINS,
});
