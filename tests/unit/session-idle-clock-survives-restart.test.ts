/**
 * The idle clock must survive a server restart.
 *
 * Observed production failure (sagemind agent, laptop, 2026-10-22): `GET /health`
 * reported `sessions: {current: 20, max: 20}` and a spawn was refused with
 * "Max sessions (20) reached". All twenty sessions were idle at a prompt — 17 of
 * them for 17 to 64 hours — against a 240-minute topic-bound idle threshold, on a
 * server that had restarted three times that day (1.3.1391 → 1.3.1394 → 1.3.1399).
 *
 * Cause: `SessionManager.idlePromptSince` is an in-memory Map, so each restart
 * reset every session's observed-idle clock to zero. An agent that restarts more
 * often than the threshold can therefore never close an idle conversation, and
 * its session slots fill until no new conversation can start at all.
 *
 * Both sides of every decision boundary are covered: a usable recorded instant
 * resumes the clock, and each unusable one (absent, unparseable, future-dated,
 * refuted by a transcript that advanced) falls back to "now" — the pre-existing
 * behaviour, and the safe direction, because a seeded clock only ever brings a
 * kill forward.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { SessionManager } from '../../src/core/SessionManager.js';
import { StateManager } from '../../src/core/StateManager.js';
import { resolveIdleSinceSeed } from '../../src/core/idleSincePersistence.js';
import type { SessionManagerConfig, Session } from '../../src/core/types.js';

const MIN_MS = 60 * 1000;
/** The production threshold for a session bound to a live messaging topic. */
const BOUND_IDLE_KILL_MINUTES = 240;

describe('resolveIdleSinceSeed — which recorded instants may seed the clock', () => {
  const now = Date.parse('2026-10-22T20:00:00.000Z');

  it('seeds from a usable recorded instant', () => {
    const v = resolveIdleSinceSeed({
      persistedIdleSince: '2026-10-22T14:00:00.000Z',
      transcriptMtimeMs: null,
      now,
    });
    expect(v.reason).toBe('seeded');
    expect(v.seedAtMs).toBe(Date.parse('2026-10-22T14:00:00.000Z'));
  });

  it('falls back to now when the record carries no instant', () => {
    expect(resolveIdleSinceSeed({ transcriptMtimeMs: null, now })).toEqual({
      seedAtMs: null, reason: 'no-persisted-value',
    });
    expect(resolveIdleSinceSeed({ persistedIdleSince: '', transcriptMtimeMs: null, now })).toEqual({
      seedAtMs: null, reason: 'no-persisted-value',
    });
  });

  it('falls back to now on an unparseable instant', () => {
    expect(resolveIdleSinceSeed({
      persistedIdleSince: 'not-a-date', transcriptMtimeMs: null, now,
    })).toEqual({ seedAtMs: null, reason: 'unparseable' });
  });

  it('falls back to now on a future-dated instant (clock step or bad write)', () => {
    expect(resolveIdleSinceSeed({
      persistedIdleSince: new Date(now + 60 * MIN_MS).toISOString(),
      transcriptMtimeMs: null,
      now,
    })).toEqual({ seedAtMs: null, reason: 'in-future' });
  });

  it('falls back to now when the transcript advanced after the recorded instant', () => {
    const idleSince = '2026-10-22T14:00:00.000Z';
    expect(resolveIdleSinceSeed({
      persistedIdleSince: idleSince,
      transcriptMtimeMs: Date.parse(idleSince) + 5 * MIN_MS, // the session did work since
      now,
    })).toEqual({ seedAtMs: null, reason: 'transcript-advanced' });
  });

  it('still seeds when the transcript predates the recorded instant', () => {
    const idleSince = '2026-10-22T14:00:00.000Z';
    const v = resolveIdleSinceSeed({
      persistedIdleSince: idleSince,
      transcriptMtimeMs: Date.parse(idleSince) - 5 * MIN_MS,
      now,
    });
    expect(v.reason).toBe('seeded');
    expect(v.seedAtMs).toBe(Date.parse(idleSince));
  });

  it('seeds an exactly-equal transcript mtime (no work AFTER the instant)', () => {
    const idleSince = '2026-10-22T14:00:00.000Z';
    const v = resolveIdleSinceSeed({
      persistedIdleSince: idleSince,
      transcriptMtimeMs: Date.parse(idleSince),
      now,
    });
    expect(v.reason).toBe('seeded');
  });
});

describe('SessionManager idle clock — durable across a restart', () => {
  let tmpDir: string;
  let stateDir: string;
  let state: StateManager;
  let manager: SessionManager;

  const baseConfig = (dir: string): SessionManagerConfig => ({
    tmuxPath: '/usr/bin/tmux',
    claudePath: '/usr/local/bin/claude',
    projectDir: dir,
    maxSessions: 20,
    protectedSessions: [],
    completionPatterns: [],
    framework: 'claude-code',
  } as unknown as SessionManagerConfig);

  const makeSession = (over: Partial<Session> = {}): Session => ({
    id: 'sess-idle-1',
    name: 'calendar management',
    status: 'running',
    tmuxSession: 'sagemind-calendar-management',
    startedAt: new Date(Date.now() - 20 * 60 * MIN_MS).toISOString(),
    ...over,
  } as Session);

  /** A fresh manager over the SAME state directory = a server restart. */
  const restart = (): SessionManager => {
    manager.stopMonitoring();
    state = new StateManager(stateDir);
    manager = new SessionManager(baseConfig(tmpDir), state);
    // No transcript on disk in the fixture; make "cannot read" explicit so the
    // test exercises the seeding decision rather than a filesystem accident.
    (manager as unknown as { transcriptMtimeMs: (s: Session) => number | null })
      .transcriptMtimeMs = () => null;
    return manager;
  };

  const seed = (m: SessionManager, s: Session, now: number) =>
    (m as unknown as { seedIdleClock: (s: Session, now: number) => void }).seedIdleClock(s, now);
  const clear = (m: SessionManager, s: Session) =>
    (m as unknown as { clearIdleClock: (s: Session) => void }).clearIdleClock(s);
  const observedIdleMs = (m: SessionManager, s: Session, now: number) =>
    now - (m as unknown as { idlePromptSince: Map<string, number> }).idlePromptSince.get(s.id)!;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-idle-clock-test-'));
    stateDir = path.join(tmpDir, 'state');
    fs.mkdirSync(stateDir, { recursive: true });
    state = new StateManager(stateDir);
    manager = new SessionManager(baseConfig(tmpDir), state);
    (manager as unknown as { transcriptMtimeMs: (s: Session) => number | null })
      .transcriptMtimeMs = () => null;
  });

  afterEach(() => {
    manager.stopMonitoring();
    SafeFsExecutor.safeRmSync(tmpDir, {
      recursive: true, force: true,
      operation: 'tests/unit/session-idle-clock-survives-restart.test.ts',
    });
  });

  it('records the idle-start instant on the session so it outlives the process', () => {
    const session = makeSession();
    state.saveSession(session);
    const now = Date.now();

    seed(manager, session, now);

    expect(session.idleSince).toBe(new Date(now).toISOString());
    expect(state.getSession(session.id)?.idleSince).toBe(new Date(now).toISOString());
  });

  it('REGRESSION: a restart no longer resets the clock, so a long-idle session can still be closed', () => {
    const session = makeSession();
    state.saveSession(session);
    const idleStart = Date.now() - (BOUND_IDLE_KILL_MINUTES + 30) * MIN_MS;

    // Generation 1 observes the session go idle.
    seed(manager, session, idleStart);
    expect(state.getSession(session.id)?.idleSince)
      .toBe(new Date(idleStart).toISOString());

    // The server restarts (an auto-update, ~every 30 minutes in production).
    const m2 = restart();
    const reloaded = state.getSession(session.id)!;
    const now = Date.now();
    seed(m2, reloaded, now);

    // The clock resumed instead of starting over, so the session is now past the
    // topic-bound threshold and the existing idle-kill can act on it. Before this
    // fix the observed idleness was 0 and no restart-prone agent ever got here.
    expect(observedIdleMs(m2, reloaded, now)).toBeGreaterThanOrEqual(
      BOUND_IDLE_KILL_MINUTES * MIN_MS,
    );
  });

  it('starts a fresh clock when the transcript shows work after the recorded instant', () => {
    const session = makeSession();
    const idleStart = Date.now() - 300 * MIN_MS;
    session.idleSince = new Date(idleStart).toISOString();
    state.saveSession(session);

    const m2 = restart();
    (m2 as unknown as { transcriptMtimeMs: (s: Session) => number | null })
      .transcriptMtimeMs = () => idleStart + 60 * MIN_MS; // worked after going "idle"
    const reloaded = state.getSession(session.id)!;
    const now = Date.now();
    seed(m2, reloaded, now);

    expect(observedIdleMs(m2, reloaded, now)).toBe(0);
    expect(state.getSession(session.id)?.idleSince).toBe(new Date(now).toISOString());
  });

  it('starts a fresh clock on an unusable recorded instant, and rewrites it', () => {
    const session = makeSession({ idleSince: 'garbage' });
    state.saveSession(session);

    const m2 = restart();
    const reloaded = state.getSession(session.id)!;
    const now = Date.now();
    seed(m2, reloaded, now);

    expect(observedIdleMs(m2, reloaded, now)).toBe(0);
    expect(state.getSession(session.id)?.idleSince).toBe(new Date(now).toISOString());
  });

  it('clears both halves when the session is observed active, so a restart cannot resurrect a stale clock', () => {
    const session = makeSession();
    state.saveSession(session);
    seed(manager, session, Date.now() - 300 * MIN_MS);
    expect(state.getSession(session.id)?.idleSince).toBeTruthy();

    clear(manager, session);

    expect(session.idleSince).toBeUndefined();
    expect(state.getSession(session.id)?.idleSince).toBeUndefined();

    // And after a restart the next idle observation starts from scratch.
    const m2 = restart();
    const reloaded = state.getSession(session.id)!;
    const now = Date.now();
    seed(m2, reloaded, now);
    expect(observedIdleMs(m2, reloaded, now)).toBe(0);
  });

  it('writes onto the FRESH on-disk record and refuses when that record is no longer the same running session', () => {
    // The monitor loop holds a shallow snapshot taken at tick start. If a
    // kill-to-respawn landed mid-tick, the on-disk record has moved on; saving
    // the stale snapshot back whole (status 'running') would resurrect it and
    // supersede the live record. The helpers must therefore write only the one
    // field, onto the record as it is NOW, and only if it is still the same
    // running session (second-pass review finding).
    const session = makeSession();
    state.saveSession(session);
    // A tick-start snapshot: a shallow copy of the record as it was on disk then.
    const snapshotOf = (): Session => ({ ...session });

    // 1. The record was killed after the snapshot was taken → no write at all.
    state.saveSession({ ...session, status: 'killed', endedAt: new Date().toISOString() });
    seed(manager, snapshotOf(), Date.now());
    expect(state.getSession(session.id)?.status).toBe('killed');
    expect(state.getSession(session.id)?.idleSince).toBeUndefined();

    // 2. The id now belongs to a different tmux session → no write.
    state.saveSession({ ...session, status: 'running', tmuxSession: 'sagemind-respawned-other' });
    seed(manager, snapshotOf(), Date.now());
    expect(state.getSession(session.id)?.idleSince).toBeUndefined();
    expect(state.getSession(session.id)?.tmuxSession).toBe('sagemind-respawned-other');

    // 3. Same running session, but a sibling field changed since the snapshot →
    //    the field lands WITHOUT clobbering the sibling.
    state.saveSession({ ...session, claudeSessionId: 'claude-uuid-set-after-snapshot' });
    const now = Date.now();
    const snapshot = snapshotOf();
    seed(manager, snapshot, now);
    const fresh = state.getSession(session.id)!;
    expect(fresh.idleSince).toBe(new Date(now).toISOString());
    expect(fresh.claudeSessionId).toBe('claude-uuid-set-after-snapshot');

    // 4. And the clear path obeys the same rule: killed on disk → untouched.
    state.saveSession({ ...fresh, status: 'killed' });
    clear(manager, { ...snapshot, idleSince: fresh.idleSince });
    expect(state.getSession(session.id)?.idleSince).toBe(fresh.idleSince);
    expect(state.getSession(session.id)?.status).toBe('killed');
  });

  it('is a no-op write when there is nothing to clear', () => {
    const session = makeSession();
    state.saveSession(session);
    expect(() => clear(manager, session)).not.toThrow();
    expect(state.getSession(session.id)?.idleSince).toBeUndefined();
  });
});
