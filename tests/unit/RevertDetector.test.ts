/**
 * Unit tests for RevertDetector (Ingestion-sources spec §3.2) — the highest-risk
 * untrusted-input source. Drives the real detector against a real in-memory
 * FailureLedger with an injected git runner.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { FailureLedger } from '../../src/monitoring/FailureLedger.js';
import { RevertDetector } from '../../src/monitoring/RevertDetector.js';
import type { OpenFailureInput } from '../../src/monitoring/FailureLedger.js';

const F = '\x1f';
const R = '\x1e';

/** Build `git log` output for the detector's --format. */
function log(commits: Array<{ hash: string; subject: string; body: string }>): string {
  return commits.map((c) => `${c.hash}${F}${c.subject}${F}${c.body}`).join(R) + R;
}

interface GitSpec {
  logOut: string;
  unreachable?: Set<string>;
  subjects?: Record<string, string>; // oid → subject (for revert² check)
  files?: Record<string, string[]>;  // oid → touched files
}
function fakeGit(spec: GitSpec) {
  return (args: string[]): string => {
    if (args[0] === 'log' && args.some((a) => a.startsWith('--grep'))) return spec.logOut;
    if (args[0] === 'cat-file') {
      const oid = String(args[2]).replace('^{commit}', '');
      if (spec.unreachable?.has(oid)) throw new Error('not found');
      return '';
    }
    if (args[0] === 'log' && args[1] === '-1') return spec.subjects?.[String(args[args.length - 1])] ?? 'a normal commit';
    if (args[0] === 'show') return (spec.files?.[String(args[args.length - 1])] ?? []).join('\n');
    return '';
  };
}

function seedOpen(ledger: FailureLedger, over: Partial<OpenFailureInput>) {
  return ledger.open({
    filedBy: 's1', source: 'bugfix-commit', severity: 'medium',
    summary: 'orig', detail: { redacted: 'r', full: 'f' }, category: 'logic',
    attribution: 'automatic', attributionConfidence: 0.9, ...over,
  })!;
}

describe('RevertDetector.parseReverts (pure)', () => {
  const d = new RevertDetector({ ledger: { } as never, resolveByCommit: () => undefined, cwd: '/tmp' });
  it('parses revert commits with a reverted OID; skips non-reverts + reverts w/o OID', () => {
    const out = d.parseReverts(log([
      { hash: 'h1', subject: 'Revert "feat: x"', body: 'This reverts commit abc123def456.' },
      { hash: 'h2', subject: 'feat: normal', body: 'not a revert' },
      { hash: 'h3', subject: 'Revert "y"', body: 'no oid line here' },
    ]));
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ hash: 'h1', revertedOid: 'abc123def456' });
  });
});

describe('RevertDetector.tick (§3.2 close-or-open + cross-check)', () => {
  let ledger: FailureLedger;
  beforeEach(() => { ledger = new FailureLedger({ dbPath: ':memory:', machineId: 'tb' }); });
  afterEach(() => ledger.close());

  function detector(spec: GitSpec, resolve: (oid: string) => any = () => undefined) {
    return new RevertDetector({ ledger, resolveByCommit: resolve, cwd: '/tmp', git: fakeGit(spec), onError: () => {} });
  }

  it('closes a matching OPEN record when the cross-check passes (reachable + diff intersects)', () => {
    const rec = seedOpen(ledger, { initiativeId: 'init-x', causeCommitOid: 'deadbeef1234' });
    const d = detector({
      logOut: log([{ hash: 'rev1', subject: 'Revert "feat"', body: 'This reverts commit deadbeef1234.' }]),
      files: { rev1: ['src/a.ts'], deadbeef1234: ['src/a.ts'] }, // intersect
    }, (oid) => (oid === 'deadbeef1234' ? { id: 'init-x' } : undefined));
    expect(d.tick()).toBe(1);
    expect(ledger.get(rec.id)!.status).toBe('resolved');
  });

  it('does NOT close on a failed cross-check (no file intersection) — opens an inferred forensic record instead', () => {
    const rec = seedOpen(ledger, { initiativeId: 'init-y', causeCommitOid: 'cafe00001111' });
    const d = detector({
      logOut: log([{ hash: 'rev2', subject: 'Revert "z"', body: 'This reverts commit cafe00001111.' }]),
      files: { rev2: ['src/other.ts'], cafe00001111: ['src/z.ts'] }, // NO intersection
    }, (oid) => (oid === 'cafe00001111' ? { id: 'init-y' } : undefined));
    d.tick();
    expect(ledger.get(rec.id)!.status).not.toBe('resolved'); // original NOT closed
    const reverts = ledger.list({ source: 'revert' as never });
    expect(reverts).toHaveLength(1);
    expect(reverts[0].attribution).toBe('inferred'); // untrusted → inferred
  });

  it('opens a resolved forensic record when there is no matching open record (cross-check ok → automatic)', () => {
    const d = detector({
      logOut: log([{ hash: 'rev3', subject: 'Revert "w"', body: 'This reverts commit 99998888aaaa.' }]),
      files: { rev3: ['src/w.ts'], '99998888aaaa': ['src/w.ts'] },
    }, () => ({ id: 'init-w' }));
    expect(d.tick()).toBe(1);
    const reverts = ledger.list({ source: 'revert' as never });
    expect(reverts).toHaveLength(1);
    expect(reverts[0].status).toBe('resolved'); // forensic, excluded from active clustering
    expect(reverts[0].attribution).toBe('automatic');
  });

  it('skips a revert-of-a-revert (re-land is not a failure)', () => {
    const d = detector({
      logOut: log([{ hash: 'rev4', subject: 'Revert "Revert ..."', body: 'This reverts commit 1212revertoid.' }]),
      subjects: { '1212revertoid': 'Revert "feat: original"' }, // the reverted commit is itself a revert
      files: { rev4: ['src/a.ts'], '1212revertoid': ['src/a.ts'] },
    });
    expect(d.tick()).toBe(0);
    expect(ledger.list({ source: 'revert' as never })).toHaveLength(0);
  });

  it('treats an unreachable reverted OID as untrusted (never closes; inferred)', () => {
    const rec = seedOpen(ledger, { initiativeId: 'init-u', causeCommitOid: 'baadf00d5678' });
    const d = detector({
      logOut: log([{ hash: 'rev5', subject: 'Revert "u"', body: 'This reverts commit baadf00d5678.' }]),
      unreachable: new Set(['baadf00d5678']),
      files: { rev5: ['src/u.ts'] },
    }, () => ({ id: 'init-u' }));
    d.tick();
    expect(ledger.get(rec.id)!.status).not.toBe('resolved');
    expect(ledger.list({ source: 'revert' as never })[0].attribution).toBe('inferred');
  });

  it('skips a revert mapped to a failure-learning-loop-origin initiative (loop self-exclusion §4.3)', () => {
    const d = detector({
      logOut: log([{ hash: 'rev6', subject: 'Revert "loop fix"', body: 'This reverts commit 7777loop8888.' }]),
      files: { rev6: ['src/a.ts'], '7777loop8888': ['src/a.ts'] },
    }, () => ({ id: 'failure-insight-x', origin: 'failure-learning-loop' }));
    expect(d.tick()).toBe(0);
    expect(ledger.list({ source: 'revert' as never })).toHaveLength(0);
  });

  it('is idempotent — a second tick does not re-close or re-open for the same revert', () => {
    seedOpen(ledger, { initiativeId: 'init-i', causeCommitOid: 'abcdef001111' });
    const d = detector({
      logOut: log([{ hash: 'rev7', subject: 'Revert "i"', body: 'This reverts commit abcdef001111.' }]),
      files: { rev7: ['src/i.ts'], abcdef001111: ['src/i.ts'] },
    }, () => ({ id: 'init-i' }));
    expect(d.tick()).toBe(1); // first closes
    expect(d.tick()).toBe(0); // second: no open record left → no action
  });

  it('fail-open: git log throwing files nothing and does not raise', () => {
    const d = new RevertDetector({
      ledger, resolveByCommit: () => undefined, cwd: '/tmp',
      git: () => { throw new Error('not a git repo'); }, onError: () => {},
    });
    expect(() => expect(d.tick()).toBe(0)).not.toThrow();
  });
});
