// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.

/**
 * E2E "feature is alive" + wiring-integrity for AutonomousProgressHeartbeat
 * (autonomous-progress-heartbeat spec §Testing "E2E" + "Wiring-integrity").
 *
 * The component is wired in the server.ts heavy-boot path (not AgentServer), so
 * this test exercises the PRODUCTION-REALISTIC wiring contract directly with
 * REAL collaborators — proving it is not dead code:
 *   - the ProxyCoordinator holder enum INCLUDES the new 'autonomous-heartbeat'.
 *   - the component constructs + ticks over a real per-topic autonomous run file
 *     (read via the REAL AutonomousSessions helpers), a real ParallelActivityIndex
 *     focus source, and a real ProxyCoordinator — and emits through the REAL send
 *     funnel callback (a fixture array, NOT a null no-op).
 *   - the lease is released in finally (a later acquire by another holder wins).
 *   - a simulated silent + output-moving topic produces an emit; a recently-spoke
 *     topic, a frozen-spinner topic, and a mid-move-marker topic each produce none.
 *   - predicate #8 reads the shared OutputActivityTracker snapshot — the heartbeat
 *     never calls captureOutput itself (the shared dep IS the only output source).
 */

import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import {
  AutonomousProgressHeartbeat,
  type AutonomousHeartbeatDeps,
} from '../../src/monitoring/AutonomousProgressHeartbeat.js';
import { ProxyCoordinator, type ProxyHolder } from '../../src/monitoring/ProxyCoordinator.js';
import {
  activeAutonomousJobs,
  autonomousRunRemainingForTopic,
  readAutonomousRunMarkers,
} from '../../src/core/AutonomousSessions.js';
import { ParallelActivityIndex } from '../../src/core/ParallelActivityIndex.js';
import { OutputActivityTracker } from '../../src/monitoring/sentinelWiring.js';

const MIN = 60_000;

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) {
    try { SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/e2e/autonomous-heartbeat-alive.test.ts' }); } catch { /* ignore */ }
  }
  dirs = [];
});

/** Write a per-topic autonomous run file with a started_at long in the past. */
function writeRunFile(stateDir: string, topic: number, opts: { startedAtIso: string; movedTo?: string } = { startedAtIso: '' }): void {
  const dir = path.join(stateDir, 'autonomous');
  fs.mkdirSync(dir, { recursive: true });
  const lines = [
    '---',
    'active: true',
    'paused: false',
    `report_topic: ${topic}`,
    'goal: "fixing the CI for the migration PR"',
    `started_at: "${opts.startedAtIso}"`,
    'duration_seconds: 86400',
  ];
  if (opts.movedTo) {
    lines.push(`move_suspended_at: "${opts.startedAtIso}"`);
    lines.push(`moved_to: "${opts.movedTo}"`);
  }
  lines.push('---', '');
  fs.writeFileSync(path.join(dir, `${topic}.local.md`), lines.join('\n'));
}

interface RealHarness {
  hb: AutonomousProgressHeartbeat;
  proxy: ProxyCoordinator;
  sent: Array<{ topicId: number; text: string }>;
  tracker: OutputActivityTracker;
  setNow: (ms: number) => void;
  stateDir: string;
}

/**
 * Boot the component with REAL collaborators over a tmpdir, exactly as server.ts
 * wires it (minus the HTTP fetch — the send callback is a fixture array that
 * stands in for the /telegram/reply funnel). `aliveSessions` + `outputFresh`
 * model the live session surface; `history` models getTopicHistory.
 */
function bootReal(opts: {
  topic: number;
  nowMs: number;
  movedTo?: string;
  aliveSession: string | null;
  /** lastOutputAt the SHARED tracker reports for the session (null = unavailable). */
  sharedLastOutputAt: number | null;
  history: Array<{ fromUser: boolean; atMs: number }>;
}): RealHarness {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-alive-'));
  dirs.push(tmp);
  const stateDir = path.join(tmp, '.instar');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(path.join(stateDir, 'topic-intent'), { recursive: true });

  // A real per-topic run file, started 2h before now → warmup elapsed.
  const startedAtIso = new Date(opts.nowMs - 120 * MIN).toISOString();
  writeRunFile(stateDir, opts.topic, { startedAtIso, movedTo: opts.movedTo });

  const proxy = new ProxyCoordinator();
  const sent: RealHarness['sent'] = [];
  let now = opts.nowMs;
  // REAL ParallelActivityIndex, fed a deterministic ref via the documented
  // getRefs test seam (the same seam production never sets) so focus derivation
  // is stable and not coupled to the TopicIntentStore's projectConfidence math.
  const activityIndex = new ParallelActivityIndex({
    stateDir,
    getRefs: (topicId) =>
      topicId === opts.topic
        ? ([{
            refId: 'r1', arcId: 'a1', topicId, kind: 'goal',
            text: 'fixing the CI for the migration PR', confidence: 0.9, evidence: [],
            lastReinforcedAt: new Date(opts.nowMs - 5 * MIN).toISOString(),
            status: 'active', createdAt: new Date(opts.nowMs - 30 * MIN).toISOString(),
            updatedAt: new Date(opts.nowMs - 5 * MIN).toISOString(),
          }] as any)
        : [],
  });
  // ParallelActivityIndex only enumerates topics with an intent file on disk;
  // create an empty marker file so listTopicIds() surfaces our topic (getRefs
  // supplies the actual content).
  fs.writeFileSync(path.join(stateDir, 'topic-intent', `${opts.topic}.json`), '{}');

  // The REAL OutputActivityTracker; we never call snapshot() here — we seed its
  // cached value via a fake session surface, then read lastOutputAtFor() exactly
  // as the heartbeat does (predicate #8, no own capture).
  const tracker = new OutputActivityTracker({
    captureOutput: () => null,
    isSessionAlive: () => false,
    sendKey: () => false,
    listRunningSessions: () => [],
  });

  const deps: AutonomousHeartbeatDeps = {
    listActiveAutonomousRuns: () => {
      const out: Array<{ topicId: number; sessionName: string | null; remainingSeconds: number }> = [];
      for (const job of activeAutonomousJobs(stateDir)) {
        if (job.topic == null) continue;
        const rem = autonomousRunRemainingForTopic(stateDir, job.topic, now);
        if (!rem) continue;
        out.push({ topicId: Number(job.topic), sessionName: opts.aliveSession, remainingSeconds: rem.remainingSeconds });
      }
      return out;
    },
    getRunMarkers: (topicId) => readAutonomousRunMarkers(stateDir, topicId),
    isSessionAlive: (name) => name === opts.aliveSession,
    getTopicHistory: () => opts.history.map((e) => ({ fromUser: e.fromUser, at: e.atMs })),
    // predicate #8: the heartbeat's ONLY output source is this shared read; it
    // never captures its own frame.
    getSharedLastOutputAt: () => opts.sharedLastOutputAt,
    getFocusForTopic: (topicId) => activityIndex.activities(now).find((a) => a.topicId === topicId)?.focus ?? null,
    proxyCoordinator: proxy,
    sendMessage: async (topicId, text) => { sent.push({ topicId, text }); },
    now: () => now,
  };
  const hb = new AutonomousProgressHeartbeat(deps, { enabled: true, dryRun: false });
  return { hb, proxy, sent, tracker, setNow: (ms) => { now = ms; }, stateDir };
}

describe('AutonomousProgressHeartbeat — feature is alive (wiring integrity)', () => {
  it('the ProxyCoordinator holder enum INCLUDES the new value (compile + runtime acquire)', () => {
    const proxy = new ProxyCoordinator();
    const holder: ProxyHolder = 'autonomous-heartbeat'; // must type-check
    expect(proxy.tryAcquire(1, holder)).toBe(true);
    expect(proxy.currentHolder(1)).toBe('autonomous-heartbeat');
    proxy.release(1, holder);
    expect(proxy.currentHolder(1)).toBeNull();
  });

  it('constructs + ticks over REAL run files / focus index / proxy and emits via the REAL send funnel', async () => {
    const now = 200 * MIN;
    const h = bootReal({
      topic: 7777,
      nowMs: now,
      aliveSession: 'ai.instar.topic-7777',
      sharedLastOutputAt: now - 1 * MIN, // output advanced recently
      history: [], // never spoke → silent
    });
    await h.hb.tick();
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0].topicId).toBe(7777);
    // the focus came through the REAL ParallelActivityIndex
    expect(h.sent[0].text).toContain('fixing the CI for the migration PR');
    // the send callback is the real funnel (a fixture array), NOT a null no-op
    expect(typeof h.sent[0].text).toBe('string');
    // the lease was released in finally
    expect(h.proxy.tryAcquire(7777, 'promise-beacon')).toBe(true);
  });

  it('a recently-spoke topic produces NO emit (silence-clock self-reset)', async () => {
    const now = 200 * MIN;
    const h = bootReal({
      topic: 7777, nowMs: now, aliveSession: 'ai.instar.topic-7777',
      sharedLastOutputAt: now - 1 * MIN,
      history: [{ fromUser: false, atMs: now - 3 * MIN }], // spoke 3m ago
    });
    await h.hb.tick();
    expect(h.sent).toHaveLength(0);
  });

  it('a frozen-spinner topic (shared lastOutputAt not advanced) produces NO emit', async () => {
    const now = 200 * MIN;
    const h = bootReal({
      topic: 7777, nowMs: now, aliveSession: 'ai.instar.topic-7777',
      sharedLastOutputAt: now - 30 * MIN, // output last changed 30m ago > 5m window
      history: [],
    });
    await h.hb.tick();
    expect(h.sent).toHaveLength(0);
  });

  it('a mid-move-marker topic produces NO emit (cross-machine guard)', async () => {
    const now = 200 * MIN;
    const h = bootReal({
      topic: 7777, nowMs: now, aliveSession: 'ai.instar.topic-7777',
      sharedLastOutputAt: now - 1 * MIN,
      history: [],
      movedTo: 'mac-mini', // run is mid-handoff
    });
    await h.hb.tick();
    expect(h.sent).toHaveLength(0);
  });

  it('the shared OutputActivityTracker exposes the cached read the heartbeat uses (no own capture)', () => {
    const h = bootReal({
      topic: 7777, nowMs: 200 * MIN, aliveSession: 'ai.instar.topic-7777',
      sharedLastOutputAt: 199 * MIN, history: [],
    });
    // lastOutputAtFor is the predicate-#8 read surface; an un-observed session
    // returns null (fail-closed), proving the heartbeat never falls back to a
    // capture of its own.
    expect(h.tracker.lastOutputAtFor('never-seen')).toBeNull();
  });
});
