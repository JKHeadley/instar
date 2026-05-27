/**
 * Unit + real-I/O tests — Layer C of release-readiness-visibility (the canonical
 * ref scan for FeatureRolloutReconciler). Proves:
 *   1. When the flag is OFF, the wrapper falls back to the local scan (no git).
 *   2. When the flag is ON but canonicalRemote is missing, degradation fires + local fallback.
 *   3. Real fixture: specs + traces committed on a canonical remote → canonical
 *      scan returns artifacts derived from main, not the local working tree.
 *   4. Real fixture: an approved spec that exists ONLY on main (NOT locally) is
 *      still detected — the local scan would have missed it; this is the bug
 *      being fixed.
 *   5. A failing canonical fetch (bad remote) falls back to local scan + degrades.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { SafeGitExecutor } from '../../src/core/SafeGitExecutor.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import {
  scanSpecArtifactsWithCanonical,
  scanSpecArtifactsCanonical,
} from '../../src/core/featureRolloutScan.js';

describe('featureRolloutScan — canonical-ref (Layer C)', () => {
  let repo: string;
  let canon: string;

  function git(cwd: string, args: string[]) {
    return SafeGitExecutor.run(args, { cwd, operation: 'tests/unit/featureRolloutScan-canonical.test.ts:git' });
  }

  function writeSpec(rel: string, content: string) {
    const full = path.join(repo, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }

  beforeEach(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-layerc-'));
    canon = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-layerc-canon-'));
    git(repo, ['init', '-q', '-b', 'main']);
    git(repo, ['config', 'user.email', 'fix@i.l']);
    git(repo, ['config', 'user.name', 'Fix']);
    git(repo, ['config', 'commit.gpgsign', 'false']);
    writeSpec('README.md', '#');
    git(repo, ['add', '-A']); git(repo, ['commit', '-qm', 'init']);
  });

  afterEach(() => {
    for (const d of [repo, canon]) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/unit/featureRolloutScan-canonical.test.ts:afterEach' });
  });

  it('flag OFF → local-tree scan (no canonical fetch needed)', () => {
    writeSpec('docs/specs/local-only.md', '---\napproved: true\nreview-convergence: "x"\n---\n# Local only\n');
    const got = scanSpecArtifactsWithCanonical(repo, { canonicalRefScanEnabled: false });
    expect(got.find((a) => a.specPath === 'docs/specs/local-only.md')).toBeDefined();
  });

  it('flag ON but no canonicalRemote → degradation + local fallback', () => {
    writeSpec('docs/specs/local.md', '---\napproved: true\n---\n# L\n');
    const reasons: string[] = [];
    const got = scanSpecArtifactsWithCanonical(repo, {
      canonicalRefScanEnabled: true,
      onDegradation: (r) => reasons.push(r),
    });
    expect(reasons.length).toBe(1);
    expect(reasons[0]).toContain('no canonicalRemote');
    expect(got.find((a) => a.specPath === 'docs/specs/local.md')).toBeDefined();
  });

  it('canonical scan returns artifacts from main (the FIX: spec only on main, gone locally, is still detected)', () => {
    // Commit a spec on main, push to canon, then REMOVE the file locally before scanning.
    writeSpec('docs/specs/on-main-only.md', '---\napproved: true\nreview-convergence: "2026-05-27"\n---\n# OnMainOnly\n');
    git(repo, ['add', '-A']); git(repo, ['commit', '-qm', 'spec: on-main-only']);
    git(canon, ['init', '-q', '--bare']);
    git(repo, ['remote', 'add', 'canon', `file://${canon}`]);
    git(repo, ['push', '-q', 'canon', 'main']);

    // Simulate the bug: the developer's working tree DROPS the spec (different branch / cleaned worktree).
    fs.unlinkSync(path.join(repo, 'docs/specs/on-main-only.md'));

    // The OLD local scan would now miss it. The canonical scan must still see it.
    const got = scanSpecArtifactsWithCanonical(repo, {
      canonicalRefScanEnabled: true,
      canonicalRemote: 'canon',
    });
    const found = got.find((a) => a.specPath === 'docs/specs/on-main-only.md');
    expect(found).toBeDefined();
    expect(found?.approved).toBe(true);
    expect(found?.merged).toBe(true); // canonical semantics: on main IS merged
  }, 30_000);

  it('canonical scan picks up committed traces and joins them to specs by specPath', () => {
    writeSpec('docs/specs/with-trace.md', '---\napproved: true\nreview-convergence: "2026-05-27"\n---\n# T\n');
    writeSpec('.instar/instar-dev-traces/2026-05-27-test.json', JSON.stringify({
      specPath: 'docs/specs/with-trace.md', prNumber: 42, createdAt: '2026-05-27T00:00:00Z', phase: 'complete',
    }));
    git(repo, ['add', '-A']); git(repo, ['commit', '-qm', 'spec + trace']);
    git(canon, ['init', '-q', '--bare']);
    git(repo, ['remote', 'add', 'canon', `file://${canon}`]);
    git(repo, ['push', '-q', 'canon', 'main']);
    const got = scanSpecArtifactsCanonical({ repoPath: repo, canonicalRemote: 'canon' });
    const a = got.artifacts.find((x) => x.specPath === 'docs/specs/with-trace.md');
    expect(a?.traceExists).toBe(true);
    expect(a?.prNumber).toBe(42);
  }, 30_000);

  it('canonical scan failure (bad remote) falls back to local + emits ONE degradation', () => {
    writeSpec('docs/specs/local-too.md', '---\napproved: true\n---\n# x\n');
    const reasons: string[] = [];
    const got = scanSpecArtifactsWithCanonical(repo, {
      canonicalRefScanEnabled: true,
      canonicalRemote: 'no-such-remote',
      onDegradation: (r) => reasons.push(r),
    });
    expect(reasons.length).toBe(1);
    expect(reasons[0]).toMatch(/canonical-ref scan failed/i);
    // Local fallback still returns the local spec.
    expect(got.find((a) => a.specPath === 'docs/specs/local-too.md')).toBeDefined();
  }, 30_000);
});
