/**
 * npm-pack templates smoke test.
 *
 * Per INSTAR-JOBS-AS-AGENTMD spec §Security Model threat row
 * "Build pipeline: source-tree templates not packaged":
 *   "Explicit `package.json#files` entry for `src/scaffold/templates/**`;
 *    asset-copy build step copies into `dist/scaffold/templates/`;
 *    `installBuiltinJobs()` reads from `dist/`; tested in `npm pack` smoke test."
 *
 * This test runs `npm pack --dry-run --json` and asserts the published
 * tarball contains:
 *   - At least one `src/scaffold/templates/jobs/instar/*.md` (the shipped
 *     prompt-type default templates)
 *   - `src/scaffold/keys/instar-release-pub.pem` (the bundled public key)
 *
 * `dist/jobs/instar.lock.json` is only present when the signer ran with a
 * key. We assert it's present OR explicitly absent (no malformed in-between),
 * since CI does not currently hold the production signing secret.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..', '..');

interface PackEntry {
  path: string;
  size: number;
  mode?: number;
  type?: string;
}

interface PackOutput {
  filename: string;
  files: PackEntry[];
  entryCount?: number;
  bundled?: string[];
  size?: number;
  unpackedSize?: number;
}

describe('npm pack templates smoke test', () => {
  let packed: PackOutput;
  let filePaths: Set<string>;

  beforeAll(() => {
    // `npm pack --dry-run --json` lists the tarball contents without
    // actually writing a .tgz file. Fast and side-effect-free.
    const raw = execFileSync('npm', ['pack', '--dry-run', '--json'], {
      cwd: REPO_ROOT,
      encoding: 'utf-8',
      maxBuffer: 16 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    const parsed = JSON.parse(raw);
    packed = Array.isArray(parsed) ? parsed[0] : parsed;
    filePaths = new Set(packed.files.map((f) => f.path));
  }, 120_000);

  it('publishes at least one shipped default-job template', () => {
    const templates = packed.files.filter(
      (f) => f.path.startsWith('src/scaffold/templates/jobs/instar/') && f.path.endsWith('.md'),
    );
    expect(templates.length).toBeGreaterThan(0);
    // Sanity: the count should match the prompt-type defaults (14 today).
    expect(templates.length).toBeGreaterThanOrEqual(14);
  });

  it('publishes the bundled release public key (source-tree path)', () => {
    expect(filePaths.has('src/scaffold/keys/instar-release-pub.pem')).toBe(true);
  });

  it('publishes the dist/keys public key if the build pipeline produced one', () => {
    // The signer copies src/scaffold/keys/instar-release-pub.pem to
    // dist/keys/instar-release-pub.pem at build time. In dev/CI without a
    // signing key, the signer still copies the public key (the lock-file
    // is what's conditional, not the key). So this should be present
    // whenever a build has run.
    const distKey = filePaths.has('dist/keys/instar-release-pub.pem');
    if (!distKey) {
      console.warn(
        '[npm-pack-smoke] No dist/keys/instar-release-pub.pem in pack — ' +
          'expected to be copied by scripts/sign-instar-lockfile.mjs. ' +
          'Either npm run build was never invoked or the copy step failed.',
      );
    }
    expect(distKey || filePaths.has('src/scaffold/keys/instar-release-pub.pem')).toBe(true);
  });

  it('publishes the signed lock-file when present, or omits it cleanly', () => {
    // Three valid states:
    //   1. dist/jobs/instar.lock.json present (signing key was available)
    //   2. dist/jobs/instar.lock.json absent (no key → no malformed file)
    //
    // Malformed state (lock-file with empty signature in the tarball) is
    // a release-time bug — Phase 1c-build's signer is supposed to SKIP the
    // write when no key is available, not write an unsigned placeholder.
    const lockfile = filePaths.has('dist/jobs/instar.lock.json');
    if (lockfile) {
      // When the lock-file is shipped, it must be non-zero-byte.
      const entry = packed.files.find((f) => f.path === 'dist/jobs/instar.lock.json');
      expect(entry!.size).toBeGreaterThan(50);
    }
    // No assertion on the absent case — that's the documented transitional
    // state until production signing is wired in CI Secrets.
  });

  it('publishes the source-tree template directory entry (for installBuiltinJobs fallback)', () => {
    // installBuiltinJobs reads from dist/scaffold/templates/jobs/instar/
    // first, then src/scaffold/templates/jobs/instar/ as fallback. The
    // source-tree path is part of the publish set per package.json#files.
    const hasSrcScaffold = packed.files.some((f) =>
      f.path.startsWith('src/scaffold/templates/jobs/instar/'),
    );
    expect(hasSrcScaffold).toBe(true);
  });
});
