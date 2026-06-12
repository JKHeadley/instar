// safe-git-allow: test fixture cleanup uses fs.rmSync on tmp dirs only.
/**
 * Work-evidence vocabulary + chokepoint threading (reap-notify spec R2.1/R2.2).
 *
 * Matrix per spec Testing §unit: killer-supplied wins, chokepoint enum clamp
 * drops unknown names, fallback expected-empty for guard-cleared kills,
 * knownDead skip, closure-error → no evidence, critical-tier marker not
 * eligible, eligibility classifier both sides.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const mockTmuxSessions = new Set<string>();

vi.mock('node:child_process', () => {
  const handle = (args?: string[]) => {
    if (!args) return '';
    if (args[0] === 'new-session') {
      const sIdx = args.indexOf('-s');
      if (sIdx >= 0 && args[sIdx + 1]) mockTmuxSessions.add(args[sIdx + 1]);
      return '';
    }
    if (args[0] === 'kill-session') {
      const target = args[2]?.replace(/^=/, '');
      if (target) mockTmuxSessions.delete(target);
      return '';
    }
    if (args[0] === 'has-session') {
      const target = args[2]?.replace(/^=/, '');
      if (target && !mockTmuxSessions.has(target)) throw new Error('no session');
      return '';
    }
    return '';
  };
  return {
    execFileSync: vi.fn().mockImplementation((_cmd: string, args?: string[]) => handle(args)),
    execFile: vi.fn().mockImplementation(
      (_cmd: string, args: string[], _opts: unknown, cb?: (e: Error | null, r: { stdout: string }) => void) => {
        if (typeof _opts === 'function') cb = _opts as typeof cb;
        try { const out = handle(args); if (cb) cb(null, { stdout: String(out) }); }
        catch (e) { if (cb) cb(e as Error, { stdout: '' }); }
      },
    ),
  };
});

import {
  clampWorkEvidence,
  isMidWork,
  evidenceEligible,
  strongEvidence,
  weakEvidence,
} from '../../src/core/WorkEvidence.js';
import { ReapGuard, type ReapGuardDeps } from '../../src/core/ReapGuard.js';
import { SessionManager } from '../../src/core/SessionManager.js';
import { StateManager } from '../../src/core/StateManager.js';
import type { Session, SessionManagerConfig } from '../../src/core/types.js';

// ── Pure vocabulary functions ─────────────────────────────────────────

describe('WorkEvidence — clamp (R2.1)', () => {
  it('drops unknown names, non-strings, and duplicates; preserves order', () => {
    expect(
      clampWorkEvidence([
        'build-or-autonomous-active',
        'made-up-evidence',
        42,
        null,
        'active-process',
        'build-or-autonomous-active',
      ]),
    ).toEqual(['build-or-autonomous-active', 'active-process']);
  });

  it('returns [] for non-arrays', () => {
    expect(clampWorkEvidence('active-process')).toEqual([]);
    expect(clampWorkEvidence(undefined)).toEqual([]);
  });
});

describe('WorkEvidence — midWork + eligibility classifier (R2.1/R2.2)', () => {
  it('midWork = any non-marker evidence; marker-only is NOT midWork', () => {
    expect(isMidWork(['active-subagent'])).toBe(true);
    expect(isMidWork(['active-process'])).toBe(true);
    expect(isMidWork(['unverified-under-pressure'])).toBe(false);
    expect(isMidWork([])).toBe(false);
  });

  it('one strong signal ⇒ eligible regardless of topic binding', () => {
    expect(evidenceEligible(['open-commitment'], false)).toBe(true);
    expect(evidenceEligible(['structural-long-work'], true)).toBe(true);
  });

  it('weak-alone never queues: one weak signal is ineligible even topic-bound', () => {
    expect(evidenceEligible(['active-process'], true)).toBe(false);
    expect(evidenceEligible(['active-process'], false)).toBe(false);
  });

  it('two DISTINCT weak signals are eligible ONLY when topic-bound', () => {
    expect(evidenceEligible(['active-process', 'recent-user-message'], true)).toBe(true);
    expect(evidenceEligible(['active-process', 'recent-user-message'], false)).toBe(false);
  });

  it('markers never count toward eligibility', () => {
    expect(evidenceEligible(['unverified-under-pressure'], true)).toBe(false);
    expect(evidenceEligible(['unverified-under-pressure', 'active-process'], true)).toBe(false);
  });

  it('class helpers split the vocabulary correctly', () => {
    const all = ['open-commitment', 'active-process', 'unverified-under-pressure'];
    expect(strongEvidence(all)).toEqual(['open-commitment']);
    expect(weakEvidence(all)).toEqual(['active-process']);
  });
});

// ── ReapGuard.workEvidence (observe-only fallback) ────────────────────

function guardDeps(overrides: Partial<ReapGuardDeps> = {}): ReapGuardDeps {
  return {
    protectedSessions: () => [],
    isRecoveryActive: () => false,
    hasPendingInjection: () => false,
    isRelayLeaseActive: () => false,
    topicBinding: () => null,
    recentUserMessage: () => false,
    activeCommitmentForTopic: () => false,
    activeSubagentCount: () => 0,
    buildOrAutonomousActive: () => false,
    hasActiveProcesses: () => false,
    ...overrides,
  };
}

const fakeSession = (over: Partial<Session> = {}): Session => ({
  id: 's-1',
  name: 'sess',
  status: 'running',
  tmuxSession: 'tmux-sess',
  startedAt: new Date().toISOString(),
  ...over,
});

describe('ReapGuard.workEvidence — observe-only collection (R2.1)', () => {
  it('collects ALL positive work signals, not first-hit', () => {
    const guard = new ReapGuard(
      guardDeps({
        topicBinding: () => 7,
        recentUserMessage: () => true,
        activeCommitmentForTopic: () => true,
        activeSubagentCount: () => 2,
        hasActiveProcesses: () => true,
      }),
      { minAgeMs: 0 },
    );
    const evidence = guard.workEvidence(fakeSession());
    expect(evidence).toContain('recent-user-message');
    expect(evidence).toContain('open-commitment');
    expect(evidence).toContain('active-subagent');
    expect(evidence).toContain('active-process');
  });

  it('expected-empty for a guard-cleared kill (all sources negative)', () => {
    const guard = new ReapGuard(guardDeps(), { minAgeMs: 0 });
    expect(guard.workEvidence(fakeSession())).toEqual([]);
  });

  it('a throwing closure contributes NOTHING (no keep-true fail-safe here)', () => {
    const guard = new ReapGuard(
      guardDeps({
        hasActiveProcesses: () => {
          throw new Error('ps fork failed');
        },
        activeSubagentCount: () => 1,
      }),
      { minAgeMs: 0 },
    );
    const evidence = guard.workEvidence(fakeSession());
    expect(evidence).toEqual(['active-subagent']); // error closure asserted nothing
  });

  it('skipForkChecks: fork-based closures NOT run, marker stamped instead', () => {
    const forkProbe = vi.fn(() => true);
    const guard = new ReapGuard(
      guardDeps({ hasActiveProcesses: forkProbe, mainProcessActive: forkProbe as never }),
      { minAgeMs: 0 },
    );
    const evidence = guard.workEvidence(fakeSession(), { skipForkChecks: true });
    expect(forkProbe).not.toHaveBeenCalled();
    expect(evidence).toEqual(['unverified-under-pressure']);
  });
});

// ── terminateSession threading (the chokepoint) ───────────────────────

describe('terminateSession — evidence threading (R2.1)', () => {
  let tmpDir: string;
  let state: StateManager;
  let manager: SessionManager;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-evidence-'));
    const stateDir = path.join(tmpDir, 'state');
    fs.mkdirSync(stateDir, { recursive: true });
    state = new StateManager(stateDir);
    const config: SessionManagerConfig = {
      tmuxPath: '/usr/bin/tmux',
      claudePath: '/usr/local/bin/claude',
      projectDir: tmpDir,
      maxSessions: 5,
      protectedSessions: [],
      completionPatterns: ['Session complete'],
    };
    manager = new SessionManager(config, state);
    mockTmuxSessions.clear();
  });

  afterEach(() => {
    manager.stopMonitoring();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('killer-supplied evidence wins and is clamped (unknown names dropped, not stored)', async () => {
    const session = await manager.spawnSession({ name: 'victim', prompt: 'p' });
    const reaped: Array<{ midWork?: boolean; workEvidence?: string[] }> = [];
    manager.on('sessionReaped', (e) => reaped.push(e));

    const result = await manager.terminateSession(session.id, 'quota-shed', {
      origin: 'autonomous',
      workEvidence: ['build-or-autonomous-active', 'totally-bogus', 'active-process'],
    });
    expect(result.terminated).toBe(true);
    expect(reaped).toHaveLength(1);
    expect(reaped[0].workEvidence).toEqual(['build-or-autonomous-active', 'active-process']);
    expect(reaped[0].midWork).toBe(true);

    const record = state.getSession(session.id)!;
    expect(record.endedMidWork).toBe(true);
    expect(record.endedWorkEvidence).toEqual(['build-or-autonomous-active', 'active-process']);
  });

  it('falls back to the guard observe-only collection when the killer supplied nothing', async () => {
    const session = await manager.spawnSession({ name: 'busy', prompt: 'p' });
    // Threading proof: a guard whose blockedReason clears the kill but whose
    // observe-only collection still surfaces evidence (the race between the
    // gate check and the stamp is real in production).
    manager.setReapGuard({
      blockedReason: () => null,
      workEvidence: () => ['active-subagent'],
    } as unknown as ReapGuard);
    const reaped: Array<{ midWork?: boolean; workEvidence?: string[] }> = [];
    manager.on('sessionReaped', (e) => reaped.push(e));

    const result = await manager.terminateSession(session.id, 'age-limit', {
      origin: 'autonomous',
    });
    expect(result.terminated).toBe(true);
    expect(reaped[0].workEvidence).toEqual(['active-subagent']);
    expect(reaped[0].midWork).toBe(true);
  });

  it('bypassActiveProcessKeep excludes active-process from the FALLBACK (the killer proved idle)', async () => {
    const session = await manager.spawnSession({ name: 'proven-idle', prompt: 'p' });
    manager.setReapGuard(
      new ReapGuard(guardDeps({ hasActiveProcesses: () => true }), { minAgeMs: 0 }),
    );
    const reaped: Array<{ midWork?: boolean; workEvidence?: string[] }> = [];
    manager.on('sessionReaped', (e) => reaped.push(e));

    const result = await manager.terminateSession(session.id, 'reaped-idle', {
      origin: 'autonomous',
      bypassActiveProcessKeep: true,
    });
    expect(result.terminated).toBe(true);
    expect(reaped[0].workEvidence).toEqual([]); // active-process NOT re-asserted
    expect(reaped[0].midWork).toBe(false);
  });

  it('an explicit EMPTY killer-supplied array is authoritative (no fallback run)', async () => {
    const session = await manager.spawnSession({ name: 'idle-proven', prompt: 'p' });
    const fallbackSpy = vi.fn(() => ['active-process']);
    manager.setReapGuard({
      blockedReason: () => null,
      workEvidence: fallbackSpy,
    } as unknown as ReapGuard);
    const reaped: Array<{ midWork?: boolean; workEvidence?: string[] }> = [];
    manager.on('sessionReaped', (e) => reaped.push(e));

    const result = await manager.terminateSession(session.id, 'reaped-idle', {
      origin: 'autonomous',
      workEvidence: [],
    });
    expect(result.terminated).toBe(true);
    expect(fallbackSpy).not.toHaveBeenCalled();
    expect(reaped[0].workEvidence).toEqual([]);
    expect(reaped[0].midWork).toBe(false);
  });

  it('critical pressure tier: fallback stamps the marker, which is NOT midWork', async () => {
    const session = await manager.spawnSession({ name: 'pressured', prompt: 'p' });
    manager.setReapGuard(
      new ReapGuard(guardDeps({ hasActiveProcesses: () => true }), { minAgeMs: 0 }),
    );
    manager.setPressureTierProvider(() => 'critical');
    const reaped: Array<{ midWork?: boolean; workEvidence?: string[] }> = [];
    manager.on('sessionReaped', (e) => reaped.push(e));

    const result = await manager.terminateSession(session.id, 'quota-shed', {
      origin: 'autonomous',
      bypassActiveProcessKeep: true,
    });
    expect(result.terminated).toBe(true);
    expect(reaped[0].workEvidence).toEqual(['unverified-under-pressure']);
    expect(reaped[0].midWork).toBe(false);
    expect(state.getSession(session.id)!.endedMidWork).toBe(false);
  });

  it('knownDead skips evidence stamping entirely', async () => {
    const session = await manager.spawnSession({ name: 'tombstone', prompt: 'p' });
    const reaped: Array<{ midWork?: boolean; workEvidence?: string[] }> = [];
    manager.on('sessionReaped', (e) => reaped.push(e));

    const result = await manager.terminateSession(session.id, 'boot-purge', {
      origin: 'autonomous',
      knownDead: true,
    });
    expect(result.terminated).toBe(true);
    expect(reaped[0].workEvidence).toEqual([]);
    expect(reaped[0].midWork).toBe(false);
    const record = state.getSession(session.id)!;
    expect(record.endedMidWork).toBeUndefined();
    expect(record.endedWorkEvidence).toBeUndefined();
  });
});
