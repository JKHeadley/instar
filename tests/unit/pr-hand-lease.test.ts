// safe-git-allow: test fixture cleanup uses fs.rmSync on tmp dirs only.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PrHandLease, canonicalPushKey } from '../../src/core/PrHandLease';

function tmpStateDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pr-hand-lease-'));
}

describe('canonicalPushKey', () => {
  // cwd is irrelevant for the explicit-refspec fast path; use a real dir.
  const cwd = process.cwd();

  it('explicit branch: git push origin foo → refs/heads/foo', () => {
    expect(canonicalPushKey('git push origin foo', cwd)).toBe('branch:refs/heads/foo');
  });

  it('HEAD:foo and HEAD:refs/heads/foo derive the SAME key', () => {
    const a = canonicalPushKey('git push origin HEAD:foo', cwd);
    const b = canonicalPushKey('git push origin HEAD:refs/heads/foo', cwd);
    expect(a).toBe('branch:refs/heads/foo');
    expect(b).toBe('branch:refs/heads/foo');
    expect(a).toBe(b);
  });

  it('catches a push inside a composite command (cd && git push)', () => {
    expect(canonicalPushKey('cd repo && git push origin foo', cwd)).toBe('branch:refs/heads/foo');
  });

  it('catches an env-prefixed push', () => {
    expect(canonicalPushKey('GIT_SSH_COMMAND=ssh git push origin foo', cwd)).toBe('branch:refs/heads/foo');
  });

  it('a non-push git command derives no key (fail-open)', () => {
    expect(canonicalPushKey('git status', cwd)).toBeNull();
    expect(canonicalPushKey('ls -la', cwd)).toBeNull();
  });

  it('a ref deletion is not gated', () => {
    expect(canonicalPushKey('git push origin --delete foo', cwd)).toBeNull();
    expect(canonicalPushKey('git push origin :refs/heads/foo', cwd)).toBeNull();
  });

  it('a tag / non-heads ref derives no key (not the branch surface)', () => {
    expect(canonicalPushKey('git push origin HEAD:refs/tags/v1', cwd)).toBeNull();
  });
});

describe('PrHandLease store', () => {
  let stateDir: string;
  let now: number;
  let running: string[];
  let audits: Record<string, unknown>[];
  let attentions: { kind: string; detail: string }[];

  function make(machineId = 'machine-A') {
    return new PrHandLease({
      stateDir,
      machineId,
      runningSessionNames: () => running,
      now: () => now,
      onAudit: (r) => audits.push(r),
      onAttention: (i) => attentions.push(i),
    });
  }

  beforeEach(() => {
    stateDir = tmpStateDir();
    now = 1_000_000;
    running = [];
    audits = [];
    attentions = [];
  });
  afterEach(() => {
    try { fs.rmSync(stateDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('no lease → allow', () => {
    const s = make();
    expect(s.evaluate('branch:refs/heads/x', 100, 'sess-x').decision).toBe('allow');
  });

  it('acquire then own-topic push → allow (respawn survival via topicId, B2)', () => {
    const s = make();
    s.acquireOrRenew('branch:refs/heads/x', { topicId: 100, sessionId: 'sess-old' });
    // same topic, DIFFERENT (respawned) session id → still mine
    const r = s.evaluate('branch:refs/heads/x', 100, 'sess-new-after-respawn');
    expect(r.decision).toBe('allow');
    expect(r.reason).toBe('own-topic');
  });

  it('live foreign lease → deny', () => {
    const s = make();
    running = ['sess-holder'];
    s.acquireOrRenew('branch:refs/heads/x', { topicId: 100, sessionId: 'sess-holder' });
    const r = s.evaluate('branch:refs/heads/x', 999, 'sess-other');
    expect(r.decision).toBe('deny');
    expect(r.reason).toBe('live-foreign-lease');
  });

  it('fresh foreign lease (within TTL) → deny without probing', () => {
    const s = make();
    running = []; // holder NOT in running set, but lease is fresh → TTL-gate keeps it live
    s.acquireOrRenew('branch:refs/heads/x', { topicId: 100, sessionId: 'sess-holder' });
    expect(s.evaluate('branch:refs/heads/x', 999, 'sess-other').decision).toBe('deny');
  });

  it('dead same-machine holder past TTL → stale → allow (caller may auto-heal)', () => {
    const s = make();
    running = [];
    s.acquireOrRenew('branch:refs/heads/x', { topicId: 100, sessionId: 'sess-holder' });
    now += 31 * 60 * 1000; // past 30m TTL, holder absent → dead
    const r = s.evaluate('branch:refs/heads/x', 999, 'sess-other');
    expect(r.decision).toBe('allow');
    expect(r.reason).toBe('stale-dead');
  });

  it('foreign-MACHINE holder within ceiling → NEVER judged dead → deny (M6)', () => {
    const s = make('machine-A');
    running = []; // its session is absent locally (it is on machine-B)
    // write a foreign-machine record directly via a machine-B store sharing the dir
    const sB = make('machine-B');
    sB.acquireOrRenew('branch:refs/heads/x', { topicId: 100, sessionId: 'sess-on-B' });
    now += 31 * 60 * 1000; // past TTL — but holder is foreign-machine
    const r = s.evaluate('branch:refs/heads/x', 999, 'sess-other');
    expect(r.decision).toBe('deny');
    expect(r.reason).toBe('foreign-machine-within-ceiling');
  });

  it('LIVE same-machine holder past maxHold ceiling → escalate, NOT seize (codex#3)', () => {
    const s = make();
    running = ['sess-holder']; // still alive
    s.acquireOrRenew('branch:refs/heads/x', { topicId: 100, sessionId: 'sess-holder' });
    now += 91 * 60 * 1000; // past 90m ceiling, still live
    const r = s.evaluate('branch:refs/heads/x', 999, 'sess-other');
    expect(r.decision).toBe('escalate');
    expect(r.reason).toBe('live-holder-past-ceiling');
  });

  it('takeOverIfStale: two healers race → exactly one wins, loser yields (B3)', () => {
    const s = make();
    running = [];
    const orig = s.acquireOrRenew('branch:refs/heads/x', { topicId: 100, sessionId: 'sess-dead' });
    now += 31 * 60 * 1000;
    const observed = { holderTopicId: 100, acquiredAt: orig.acquiredAt };
    const win = s.takeOverIfStale('branch:refs/heads/x', observed, { topicId: 200, sessionId: 'sess-200' });
    const lose = s.takeOverIfStale('branch:refs/heads/x', observed, { topicId: 300, sessionId: 'sess-300' });
    expect(win).not.toBeNull();
    expect(win!.holderTopicId).toBe(200);
    expect(lose).toBeNull(); // CAS precondition no longer matches → loser yields
  });

  it('dryRun foreign lease → ignored (allow), and is written so a peer can see it (§5)', () => {
    const s = make();
    running = ['sess-holder'];
    s.acquireOrRenew('branch:refs/heads/x', { topicId: 100, sessionId: 'sess-holder', dryRun: true });
    const r = s.evaluate('branch:refs/heads/x', 999, 'sess-other');
    expect(r.decision).toBe('allow');
    expect(r.reason).toBe('foreign-dryrun-ignored');
    // written + visible in list
    expect(s.list().find((l) => l.key === 'branch:refs/heads/x')?.dryRun).toBe(true);
  });

  it('corrupt state file → fail-OPEN (allow), recurrence raises attention (M10/M-B)', () => {
    const s = make();
    fs.mkdirSync(path.join(stateDir, 'state'), { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'state', 'pr-hand-leases.json'), '{ this is not json');
    for (let i = 0; i < 3; i++) {
      expect(s.evaluate('branch:refs/heads/x', 999, 'sess-other').decision).toBe('allow');
    }
    expect(attentions.some((a) => a.kind === 'pr-lease-failopen')).toBe(true);
  });

  it('tombstone ≤5s → successor acquires through without yielding (M8)', () => {
    const s = make();
    s.acquireOrRenew('branch:refs/heads/x', { topicId: 100, sessionId: 'sess-100' });
    s.release('branch:refs/heads/x', 100, 'merged');
    // a different hand sees the tombstone → allow (free), not deny
    expect(s.evaluate('branch:refs/heads/x', 200, 'sess-200').decision).toBe('allow');
  });

  it('list() reports DERIVED liveness, never the raw record', () => {
    const s = make();
    running = ['sess-holder'];
    s.acquireOrRenew('branch:refs/heads/x', { topicId: 100, sessionId: 'sess-holder' });
    expect(s.list()[0].liveness).toBe('live');
  });

  it('stateFileRelPath is the path the BackupManager denylist must exclude', () => {
    expect(PrHandLease.stateFileRelPath()).toBe('state/pr-hand-leases.json');
  });
});
