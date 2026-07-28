/**
 * Behavioral tests for SessionManager.cleanupStaleSessions() — finished-session
 * registry retention (session-listing hygiene, CMT-1936).
 *
 * The observed production problem (Mac Mini, 2026-07-09): 52 of 53 rows in
 * GET /sessions were finished background runs (22 mentor-stage-a headless
 * one-shots, 28 job-* records) retained in the listing, read by the operator
 * as "duplicate sessions running". Two unbounded holes made it worse:
 * `failed` records were NEVER pruned, and a record with a missing/unparseable
 * `endedAt` was skipped forever.
 *
 * Covers both sides of every decision boundary:
 * - killed AND failed records prune after killedTtlMinutes (fresh ones stay)
 * - completed job (jobSlug) AND headless (launchLane) records prune after
 *   completedJobTtlMinutes (fresh ones stay)
 * - completed interactive records prune after completedTtlHours (fresh stay)
 * - missing endedAt falls back to startedAt; neither parseable → pruned
 * - hard cap maxFinished prunes oldest-ended terminal records first
 * - config knobs (sessions.retention) override every default (via the
 *   boot-time config snapshot — a change applies at the next server restart);
 *   running sessions are never touched
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { SessionManager } from '../../src/core/SessionManager.js';
import { StateManager } from '../../src/core/StateManager.js';
import type { SessionManagerConfig, Session } from '../../src/core/types.js';

const HOUR_MS = 60 * 60 * 1000;

function baseConfig(tmpDir: string): SessionManagerConfig {
  return {
    tmuxPath: '/usr/bin/tmux',
    claudePath: '/usr/local/bin/claude',
    projectDir: tmpDir,
    maxSessions: 3,
    protectedSessions: [],
    completionPatterns: [],
    framework: 'claude-code',
  } as unknown as SessionManagerConfig;
}

let seq = 0;
function makeSession(over: Partial<Session>): Session {
  seq += 1;
  return {
    id: `sess-${seq}`,
    name: `s-${seq}`,
    status: 'completed',
    tmuxSession: `instar-s-${seq}`,
    startedAt: new Date(Date.now() - 26 * HOUR_MS).toISOString(),
    ...over,
  } as Session;
}

describe('SessionManager.cleanupStaleSessions — bounded finished-session retention', () => {
  let tmpDir: string;
  let state: StateManager;
  let manager: SessionManager;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-retention-test-'));
    const stateDir = path.join(tmpDir, 'state');
    fs.mkdirSync(stateDir, { recursive: true });
    state = new StateManager(stateDir);
    manager = new SessionManager(baseConfig(tmpDir), state);
  });

  afterEach(() => {
    manager.stopMonitoring();
    SafeFsExecutor.safeRmSync(tmpDir, {
      recursive: true, force: true,
      operation: 'tests/unit/SessionManager-retention.test.ts',
    });
  });

  const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
  const ids = () => state.listSessions().map((s) => s.id).sort();

  it('prunes killed AND failed records after the killed TTL; keeps fresh ones', () => {
    const oldKilled = makeSession({ status: 'killed', endedAt: ago(2 * HOUR_MS) });
    const freshKilled = makeSession({ status: 'killed', endedAt: ago(10 * 60 * 1000) });
    const oldFailed = makeSession({ status: 'failed', endedAt: ago(2 * HOUR_MS) });
    const freshFailed = makeSession({ status: 'failed', endedAt: ago(10 * 60 * 1000) });
    for (const s of [oldKilled, freshKilled, oldFailed, freshFailed]) state.saveSession(s);

    const cleaned = manager.cleanupStaleSessions();

    expect(cleaned.sort()).toEqual([oldFailed.id, oldKilled.id].sort());
    expect(ids()).toEqual([freshFailed.id, freshKilled.id].sort());
  });

  it('gives completed BACKGROUND records (jobSlug OR launchLane:headless) the short TTL', () => {
    // The exact production shape: a mentor-stage-a headless one-shot — no
    // jobSlug, launchLane 'headless' — previously kept 24h on the interactive TTL.
    const oldHeadless = makeSession({ launchLane: 'headless', endedAt: ago(2 * HOUR_MS) });
    const freshHeadless = makeSession({ launchLane: 'headless', endedAt: ago(10 * 60 * 1000) });
    const oldJob = makeSession({ jobSlug: 'health-check', endedAt: ago(2 * HOUR_MS) });
    const oldInteractive = makeSession({ endedAt: ago(2 * HOUR_MS) }); // interactive: 24h TTL — stays
    for (const s of [oldHeadless, freshHeadless, oldJob, oldInteractive]) state.saveSession(s);

    const cleaned = manager.cleanupStaleSessions();

    expect(cleaned.sort()).toEqual([oldHeadless.id, oldJob.id].sort());
    expect(ids()).toEqual([freshHeadless.id, oldInteractive.id].sort());
  });

  it('prunes completed interactive records after 24h', () => {
    const old = makeSession({ endedAt: ago(25 * HOUR_MS) });
    const fresh = makeSession({ endedAt: ago(23 * HOUR_MS) });
    state.saveSession(old);
    state.saveSession(fresh);

    expect(manager.cleanupStaleSessions()).toEqual([old.id]);
    expect(ids()).toEqual([fresh.id]);
  });

  it('falls back to startedAt when endedAt is missing (the pre-fix forever-skipped hole)', () => {
    const noEndedOld = makeSession({ status: 'killed', endedAt: undefined, startedAt: ago(3 * HOUR_MS) });
    const noEndedFresh = makeSession({ status: 'killed', endedAt: undefined, startedAt: ago(5 * 60 * 1000) });
    state.saveSession(noEndedOld);
    state.saveSession(noEndedFresh);

    expect(manager.cleanupStaleSessions()).toEqual([noEndedOld.id]);
    expect(ids()).toEqual([noEndedFresh.id]);
  });

  it('treats a terminal record with NO parseable timestamp as expired', () => {
    const garbage = makeSession({
      status: 'completed',
      endedAt: 'not-a-date',
      startedAt: 'also-not-a-date',
      jobSlug: 'x',
    });
    state.saveSession(garbage);

    expect(manager.cleanupStaleSessions()).toEqual([garbage.id]);
    expect(ids()).toEqual([]);
  });

  it('never touches running or starting sessions', () => {
    const running = makeSession({ status: 'running', startedAt: ago(48 * HOUR_MS) });
    const starting = makeSession({ status: 'starting', startedAt: ago(48 * HOUR_MS) });
    state.saveSession(running);
    state.saveSession(starting);

    expect(manager.cleanupStaleSessions()).toEqual([]);
    expect(ids()).toEqual([running.id, starting.id].sort());
  });

  it('hard-caps retained terminal records at maxFinished, pruning oldest-ended first', () => {
    const retentionCfg = { ...baseConfig(tmpDir), retention: { maxFinished: 3 } } as SessionManagerConfig;
    const capped = new SessionManager(retentionCfg, state);
    try {
      const sessions = [1, 2, 3, 4, 5].map((i) =>
        makeSession({ endedAt: ago(i * 60 * 1000), startedAt: ago(HOUR_MS) }), // all inside 24h TTL
      );
      for (const s of sessions) state.saveSession(s);

      const cleaned = capped.cleanupStaleSessions();

      // Oldest-ended = largest "ago" = sessions[4] and sessions[3]
      expect(cleaned.sort()).toEqual([sessions[3].id, sessions[4].id].sort());
      expect(ids()).toEqual([sessions[0].id, sessions[1].id, sessions[2].id].sort());
    } finally {
      capped.stopMonitoring();
    }
  });

  it('honors every sessions.retention knob (boot-time config snapshot)', () => {
    const retentionCfg = {
      ...baseConfig(tmpDir),
      retention: { killedTtlMinutes: 5, completedJobTtlMinutes: 5, completedTtlHours: 1 },
    } as SessionManagerConfig;
    const tuned = new SessionManager(retentionCfg, state);
    try {
      const killed = makeSession({ status: 'killed', endedAt: ago(10 * 60 * 1000) });
      const job = makeSession({ jobSlug: 'j', endedAt: ago(10 * 60 * 1000) });
      const interactive = makeSession({ endedAt: ago(2 * HOUR_MS) });
      const freshInteractive = makeSession({ endedAt: ago(30 * 60 * 1000) });
      for (const s of [killed, job, interactive, freshInteractive]) state.saveSession(s);

      const cleaned = tuned.cleanupStaleSessions();

      expect(cleaned.sort()).toEqual([interactive.id, job.id, killed.id].sort());
      expect(ids()).toEqual([freshInteractive.id]);
    } finally {
      tuned.stopMonitoring();
    }
  });

  it('ignores a nonsensical retention config (negative / non-numeric) and keeps the defaults', () => {
    const retentionCfg = {
      ...baseConfig(tmpDir),
      retention: { killedTtlMinutes: -5, completedTtlHours: 'soon', maxFinished: Number.NaN },
    } as unknown as SessionManagerConfig;
    const bad = new SessionManager(retentionCfg, state);
    try {
      const freshKilled = makeSession({ status: 'killed', endedAt: ago(30 * 60 * 1000) }); // < default 60m
      const oldKilled = makeSession({ status: 'killed', endedAt: ago(2 * HOUR_MS) });      // > default 60m
      state.saveSession(freshKilled);
      state.saveSession(oldKilled);

      expect(bad.cleanupStaleSessions()).toEqual([oldKilled.id]);
      expect(ids()).toEqual([freshKilled.id]);
    } finally {
      bad.stopMonitoring();
    }
  });
});
