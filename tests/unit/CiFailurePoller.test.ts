/**
 * Unit tests for CiFailurePoller (Ingestion-sources spec §3.1).
 * Drives the real poller against a real in-memory FailureLedger with an
 * injected `gh` runner + initiative lookup, so every §3.1 behavior is
 * exercised deterministically (no network, no real gh).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { FailureLedger } from '../../src/monitoring/FailureLedger.js';
import {
  CiFailurePoller, ciCategoryFromName, currentFailures, scrubSecrets,
} from '../../src/monitoring/CiFailurePoller.js';

function ghJson(runs: unknown[]): () => string {
  return () => JSON.stringify(runs);
}

describe('ciCategoryFromName (deterministic allow-list, never raw name)', () => {
  it('maps test/build job names; everything else → unknown', () => {
    expect(ciCategoryFromName('Unit Tests (node 20)')).toBe('test-failure');
    expect(ciCategoryFromName('e2e')).toBe('test-failure');
    expect(ciCategoryFromName('Build')).toBe('build-failure');
    expect(ciCategoryFromName('Type Check')).toBe('build-failure');
    expect(ciCategoryFromName('Deploy to prod')).toBe('unknown');
    expect(ciCategoryFromName(undefined)).toBe('unknown');
  });
});

describe('currentFailures (flaky guard — latest run per head SHA)', () => {
  it('keeps a SHA whose latest run failed; drops one recovered on re-run', () => {
    const runs = [
      { headSha: 'aaa', conclusion: 'failure', createdAt: '2026-01-01T00:00:00Z', name: 'test' },
      { headSha: 'aaa', conclusion: 'success', createdAt: '2026-01-01T01:00:00Z', name: 'test' }, // re-run recovered
      { headSha: 'bbb', conclusion: 'success', createdAt: '2026-01-01T00:00:00Z', name: 'test' },
      { headSha: 'bbb', conclusion: 'failure', createdAt: '2026-01-01T02:00:00Z', name: 'test' }, // latest = failure
    ];
    const out = currentFailures(runs);
    const shas = out.map((r) => r.headSha);
    expect(shas).toEqual(['bbb']); // aaa recovered (dropped), bbb still failing (kept)
  });
  it('ignores runs without a head SHA', () => {
    expect(currentFailures([{ conclusion: 'failure', name: 'x' }])).toEqual([]);
  });
});

describe('scrubSecrets (best-effort, spec §5)', () => {
  it('redacts gh tokens / sk- keys / JWTs / labeled secrets', () => {
    expect(scrubSecrets('token ghp_' + 'A'.repeat(36))).not.toContain('A'.repeat(36));
    expect(scrubSecrets('key sk-' + 'b'.repeat(24))).toContain('sk-REDACTED');
    expect(scrubSecrets('password: hunter2hunter2hunter2')).toContain('REDACTED');
  });
  it('leaves ordinary text intact', () => {
    expect(scrubSecrets('run 42 on main (abc123) — failure')).toBe('run 42 on main (abc123) — failure');
  });
});

describe('CiFailurePoller.tick (the §3.1 source behavior)', () => {
  let ledger: FailureLedger;
  beforeEach(() => { ledger = new FailureLedger({ dbPath: ':memory:', machineId: 'tb' }); });
  afterEach(() => ledger.close());

  function poller(over: Partial<Parameters<typeof makeOpts>[0]> = {}) {
    return new CiFailurePoller(makeOpts(over));
  }
  function makeOpts(over: any = {}) {
    return {
      ledger,
      resolveByMergeCommit: over.resolveByMergeCommit ?? (() => undefined),
      resolveRepo: over.resolveRepo ?? (() => 'JKHeadley/instar'),
      runGh: over.runGh ?? ghJson([]),
      isLeaseHolder: over.isLeaseHolder,
      maxRunsPerTick: over.maxRunsPerTick,
      onError: over.onError ?? (() => {}),
    };
  }

  it('files a mapped failure as automatic with the initiative + constant filedBy', () => {
    const p = poller({
      runGh: ghJson([{ headSha: 'sha1', conclusion: 'failure', name: 'Unit Tests', headBranch: 'feat/x', databaseId: 9, createdAt: '2026-01-01T00:00:00Z' }]),
      resolveByMergeCommit: (oid: string) => (oid === 'sha1' ? { id: 'init-x', projectId: 'p1', specPath: 'docs/specs/x.md' } : undefined),
    });
    expect(p.tick()).toBe(1);
    const recs = ledger.list({ source: 'ci' as never });
    expect(recs).toHaveLength(1);
    expect(recs[0].category).toBe('test-failure');
    expect(recs[0].attribution).toBe('automatic');
    expect(recs[0].initiativeId).toBe('init-x');
    expect(recs[0].filedBy).toBe('source:ci');
    expect(recs[0].causeCommitOid).toBe('sha1');
  });

  it('files an unmapped failure as inferred with no initiative (noFeatureLink)', () => {
    const p = poller({
      runGh: ghJson([{ headSha: 'sha2', conclusion: 'failure', name: 'Build', createdAt: '2026-01-01T00:00:00Z' }]),
    });
    expect(p.tick()).toBe(1);
    const recs = ledger.list({ source: 'ci' as never });
    expect(recs[0].attribution).toBe('inferred');
    expect(recs[0].initiativeId).toBeUndefined();
    expect(recs[0].category).toBe('build-failure');
  });

  it('skips a run mapped to a failure-learning-loop-origin initiative (loop self-exclusion §4.3)', () => {
    const p = poller({
      runGh: ghJson([{ headSha: 'sha3', conclusion: 'failure', name: 'test', createdAt: '2026-01-01T00:00:00Z' }]),
      resolveByMergeCommit: () => ({ id: 'failure-insight-foo', origin: 'failure-learning-loop' }),
    });
    expect(p.tick()).toBe(0);
    expect(ledger.list({ source: 'ci' as never })).toHaveLength(0);
  });

  it('refuses an untrusted/garbage repo string (skips the tick)', () => {
    const p = poller({ resolveRepo: () => 'evil/../../repo --limit 9999', runGh: ghJson([{ headSha: 's', conclusion: 'failure', name: 'test', createdAt: 'z' }]) });
    expect(p.tick()).toBe(0);
  });

  it('fail-open: gh throwing files nothing and does not raise', () => {
    const p = poller({ runGh: () => { throw new Error('gh: not authenticated'); } });
    expect(() => expect(p.tick()).toBe(0)).not.toThrow();
  });

  it('honors the per-tick write cap', () => {
    const many = Array.from({ length: 10 }, (_, i) => ({ headSha: `s${i}`, conclusion: 'failure', name: 'test', createdAt: `2026-01-01T00:0${i}:00Z` }));
    const p = poller({ runGh: ghJson(many), maxRunsPerTick: 3 });
    expect(p.tick()).toBe(3);
  });

  it('only polls on the fenced-lease holder', () => {
    const p = poller({ isLeaseHolder: () => false, runGh: ghJson([{ headSha: 's', conclusion: 'failure', name: 'test', createdAt: 'z' }]) });
    expect(p.tick()).toBe(0);
  });

  it('uses the shared authenticated runtime on the default gh path', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-gh-runtime-'));
    try {
      const marker = path.join(dir, 'ci-gh-env.txt');
      const executable = path.join(dir, 'gh');
      fs.writeFileSync(executable, `#!/bin/sh\nprintf '%s|%s' "$GH_TOKEN" "$GITHUB_TOKEN" > "${marker}"\nprintf '[]'\n`, { mode: 0o700 });
      const p = new CiFailurePoller({
        ledger,
        resolveByMergeCommit: () => undefined,
        resolveRepo: () => 'JKHeadley/instar',
        githubRuntime: () => ({
          executable,
          env: {
            ...process.env,
            PATH: dir,
            GH_TOKEN: 'agent-token',
            GITHUB_TOKEN: 'agent-token',
          },
        }),
        onError: () => {},
      });
      expect(p.tick()).toBe(0);
      expect(fs.readFileSync(marker, 'utf8')).toBe('agent-token|agent-token');
    } finally {
      SafeFsExecutor.safeRmSync(dir, {
        recursive: true,
        force: true,
        operation: 'tests/unit/CiFailurePoller.test.ts',
      });
    }
  });
});
