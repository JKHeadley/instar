/**
 * Unit tests for the PromiseBeacon escalation ladder
 * (PROMISE-BEACON-ESCALATION-SPEC §3–§5, §7).
 *
 * Covers both sides of every decision boundary:
 *  - epoch-mismatch + escalation enabled → Rung 1 revive attempted (attempt
 *    incremented BEFORE spawn, in-flight + revivalMode set) — I1/I6.
 *  - dry-run → audit-only "would-revive", no spawn, no message (§5).
 *  - spawn refused → Rung 2 truthful, state-specific message; never a false
 *    "working"; in-flight cleared (§3.2, I5).
 *  - escalation OFF → legacy immediate transitionViolated preserved.
 *  - exponential backoff holds a second attempt (I1).
 *  - cap exhausted → Rung 3 violated + exactly one Attention item (§3.3).
 *  - resolveInFlight: confirmed re-stamps epoch; failed clears in-flight and
 *    never wedges the commitment (§3.1 deadlock contract).
 *  - global per-tick budget exhausted → Rung 2, not Rung 1 (I9).
 *  - quiet hours suppress escalation messaging (I7).
 *  - Rung-2 wording is conditional on the real recoverability state (golden).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { CommitmentTracker } from '../../src/monitoring/CommitmentTracker.js';
import { LiveConfig } from '../../src/config/LiveConfig.js';
import { LlmQueue } from '../../src/monitoring/LlmQueue.js';
import { ProxyCoordinator } from '../../src/monitoring/ProxyCoordinator.js';
import { PromiseBeacon, type EscalationConfig, type ReviveResult } from '../../src/monitoring/PromiseBeacon.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

function tmpState() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pb-escalation-'));
  fs.mkdirSync(path.join(dir, 'state'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'config.json'), '{}');
  return { dir, cleanup: () => SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/PromiseBeacon-escalation.test.ts' }) };
}

// Fixed injected clock (local noon) so quiet-hour math is deterministic and
// wall-clock-independent. inQuietHours() reads new Date(now).getHours/Minutes.
const FIXED_NOW_MS = new Date(2026, 5, 13, 12, 0, 0).getTime(); // local 12:00
const fmtHHMM = (mins: number) => `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;
// A 1-minute window 10 hours away from the injected clock → guaranteed NOT quiet
// (startMin < endMin, and `now` is never inside the tiny far-away window).
function neverQuietWindow(nowMs: number) {
  const d = new Date(nowMs);
  const cur = d.getHours() * 60 + d.getMinutes();
  const s = (cur + 600) % 1380; // kept < 1380 so end = s+1 < 1440 (no 24:00)
  return { start: fmtHHMM(s), end: fmtHHMM(s + 1) };
}
// start === end on the wrap-midnight branch ⇒ ALWAYS quiet.
const ALWAYS_QUIET = { start: '00:00', end: '00:00' };

interface Harness {
  beacon: PromiseBeacon;
  tracker: CommitmentTracker;
  sent: Array<{ topicId: number; text: string }>;
  audits: Array<{ decision: string; [k: string]: unknown }>;
  reviveCalls: number;
  attentionCalls: Array<{ id: string; detail: string }>;
  nowRef: { ms: number };
  setRevive: (fn: () => Promise<ReviveResult>) => void;
  setEpoch: (fn: () => string | null) => void;
  setSession: (fn: () => string | null) => void;
}

function makeHarness(dir: string, esc: EscalationConfig | undefined, opts: {
  quietHours?: { start: string; end: string };
  liveSessionCountForTopic?: () => number;
} = {}): Harness {
  const tracker = new CommitmentTracker({ stateDir: dir, liveConfig: new LiveConfig(dir) });
  const sent: Array<{ topicId: number; text: string }> = [];
  const audits: Array<{ decision: string; [k: string]: unknown }> = [];
  const attentionCalls: Array<{ id: string; detail: string }> = [];
  const nowRef = { ms: FIXED_NOW_MS };
  const state = { revive: async (): Promise<ReviveResult> => ({ sessionName: 'revived-sess' }),
                  epoch: (): string | null => 'NEW-EPOCH',
                  session: (): string | null => 'sess-1',
                  reviveCalls: 0 };

  const beacon = new PromiseBeacon({
    stateDir: dir,
    commitmentTracker: tracker,
    llmQueue: new LlmQueue({ maxDailyCents: 100 }),
    proxyCoordinator: new ProxyCoordinator(),
    captureSessionOutput: () => 'x',
    getSessionForTopic: () => state.session(),
    isSessionAlive: () => true,
    getSessionEpoch: () => state.epoch(),
    sendMessage: async (topicId, text) => { sent.push({ topicId, text }); },
    now: () => nowRef.ms,
    quietHours: opts.quietHours ?? neverQuietWindow(nowRef.ms),
    escalation: esc,
    requestRevive: async () => { state.reviveCalls += 1; return state.revive(); },
    raiseAttention: (id, detail) => { attentionCalls.push({ id, detail }); },
    ...(opts.liveSessionCountForTopic ? { liveSessionCountForTopic: opts.liveSessionCountForTopic } : {}),
  });
  beacon.on('escalation', (e) => audits.push(e as { decision: string }));

  return {
    beacon, tracker, sent, audits, attentionCalls, nowRef,
    get reviveCalls() { return state.reviveCalls; },
    setRevive: (fn) => { state.revive = fn; },
    setEpoch: (fn) => { state.epoch = fn; },
    setSession: (fn) => { state.session = fn; },
  } as Harness;
}

const ESC_LIVE: EscalationConfig = { enabled: true, dryRun: false };

function newCommitment(tracker: CommitmentTracker, over: Record<string, unknown> = {}) {
  return tracker.record({
    type: 'one-time-action', userRequest: 'ship the dashboard link', agentResponse: 'will send the link',
    topicId: 42, beaconEnabled: true, cadenceMs: 60_000, nextUpdateDueAt: '2099-01-01T00:00:00Z',
    sessionEpoch: 'OLD-EPOCH', ...over,
  });
}

describe('PromiseBeacon escalation ladder', () => {
  let dir: string; let cleanup: () => void;
  beforeEach(() => { ({ dir, cleanup } = tmpState()); });
  afterEach(() => cleanup());

  it('Rung 1: epoch mismatch + escalation enabled attempts a revive (attempt counted before spawn, in-flight + revivalMode set)', async () => {
    const h = makeHarness(dir, ESC_LIVE);
    h.beacon.start();
    const c = newCommitment(h.tracker); // sessionEpoch OLD, live epoch NEW → re-epoched
    await h.beacon.fire(c.id);

    expect(h.reviveCalls).toBe(1);
    const after = h.tracker.get(c.id)!;
    expect(after.escalationAttempts).toBe(1);
    expect(after.escalationInFlight).toBe(true);
    expect(after.revivalMode).toBe('status-only-until-revalidated');
    expect(after.currentRung).toBe('1');
    expect(after.status).toBe('pending'); // NOT terminalized
    h.beacon.stop();
  });

  it('dry-run: logs a "would-revive" audit and takes no real action', async () => {
    const h = makeHarness(dir, { enabled: true, dryRun: true });
    h.beacon.start();
    const c = newCommitment(h.tracker);
    await h.beacon.fire(c.id);

    expect(h.reviveCalls).toBe(0);
    expect(h.sent.length).toBe(0);
    expect(h.audits.some(a => a.decision === 'would-revive')).toBe(true);
    const after = h.tracker.get(c.id)!;
    expect(after.escalationAttempts ?? 0).toBe(0);
    h.beacon.stop();
  });

  it('spawn refused (quota) → Rung 2 honest "at capacity" message, never a false "working", in-flight cleared', async () => {
    const h = makeHarness(dir, ESC_LIVE);
    h.setRevive(async () => ({ sessionName: null, refusalReason: 'quota' }));
    h.beacon.start();
    const c = newCommitment(h.tracker);
    await h.beacon.fire(c.id);

    expect(h.sent.length).toBe(1);
    expect(h.sent[0].text).toMatch(/capacity|headroom/i);
    expect(h.sent[0].text).not.toMatch(/\bworking\b/i);
    const after = h.tracker.get(c.id)!;
    expect(after.escalationInFlight).toBeFalsy();
    expect(after.escalationAttempts).toBe(1); // attempt counted even though spawn refused
    expect(after.currentRung).toBe('2');
    h.beacon.stop();
  });

  it('escalation OFF → legacy immediate transitionViolated(session-lost) preserved', async () => {
    const h = makeHarness(dir, undefined); // no escalation config
    h.beacon.start();
    const c = newCommitment(h.tracker);
    await h.beacon.fire(c.id);

    const after = h.tracker.get(c.id)!;
    expect(after.status).toBe('violated');
    expect(after.resolution).toBe('session-lost');
    expect(h.reviveCalls).toBe(0);
    h.beacon.stop();
  });

  it('exponential backoff holds a second attempt within the floor window', async () => {
    const h = makeHarness(dir, ESC_LIVE);
    h.setRevive(async () => ({ sessionName: null, refusalReason: 'quota' }));
    h.beacon.start();
    const c = newCommitment(h.tracker);
    await h.beacon.fire(c.id); // attempt 1 → refusal → Rung 2
    expect(h.reviveCalls).toBe(1);

    // Immediately fire again (well within minEscalationIntervalMs=120s): held.
    await h.beacon.fire(c.id);
    expect(h.reviveCalls).toBe(1); // NOT re-attempted
    expect(h.audits.some(a => a.decision === 'backoff-hold')).toBe(true);
    h.beacon.stop();
  });

  it('cap exhausted → Rung 3 violated + exactly one Attention item', async () => {
    const h = makeHarness(dir, { enabled: true, dryRun: false, maxEscalationAttempts: 3 });
    h.beacon.start();
    const c = newCommitment(h.tracker);
    await h.tracker.mutate(c.id, prev => ({ ...prev, escalationAttempts: 3 }));

    await h.beacon.fire(c.id);

    const after = h.tracker.get(c.id)!;
    expect(after.status).toBe('violated');
    expect(after.resolution).toBe('session-lost-unrecovered');
    expect(after.currentRung).toBe('3');
    expect(h.attentionCalls.length).toBe(1);
    expect(h.attentionCalls[0].id).toBe(c.id);

    // A subsequent fire is a no-op (terminal) — no second Attention item.
    await h.beacon.fire(c.id);
    expect(h.attentionCalls.length).toBe(1);
    h.beacon.stop();
  });

  it('resolveInFlight confirmed: a settled new-epoch session re-stamps epoch and clears in-flight', async () => {
    const h = makeHarness(dir, { enabled: true, dryRun: false, reviveSettleMs: 30_000 });
    h.beacon.start();
    const c = newCommitment(h.tracker);
    await h.tracker.mutate(c.id, prev => ({
      ...prev, escalationInFlight: true, escalationAttemptId: 'a1',
      lastEscalationAt: new Date(h.nowRef.ms).toISOString(), revivalMode: 'status-only-until-revalidated',
    }));
    // Advance past the settle window; a live session with a NEW epoch exists.
    h.nowRef.ms += 31_000;
    h.setSession(() => 'sess-new');
    h.setEpoch(() => 'NEW-EPOCH'); // differs from OLD-EPOCH stamp

    await h.beacon.fire(c.id);

    const after = h.tracker.get(c.id)!;
    expect(after.sessionEpoch).toBe('NEW-EPOCH');
    expect(after.escalationInFlight).toBeFalsy();
    expect(after.currentRung).toBeFalsy();
    expect(after.status).toBe('pending');
    h.beacon.stop();
  });

  it('resolveInFlight failed: past settle+grace with no live session clears in-flight without wedging', async () => {
    const h = makeHarness(dir, { enabled: true, dryRun: false, reviveSettleMs: 30_000, escalationGraceMs: 10_000 });
    h.beacon.start();
    const c = newCommitment(h.tracker);
    await h.tracker.mutate(c.id, prev => ({
      ...prev, escalationInFlight: true, escalationAttemptId: 'a1',
      lastEscalationAt: new Date(h.nowRef.ms).toISOString(),
    }));
    h.nowRef.ms += 41_000; // past settle(30s)+grace(10s)
    h.setSession(() => null); // no live session

    await h.beacon.fire(c.id);

    const after = h.tracker.get(c.id)!;
    expect(after.escalationInFlight).toBeFalsy(); // cleared — not wedged
    expect(after.status).toBe('pending');
    h.beacon.stop();
  });

  it('global per-tick spawn budget exhausted → Rung 2 (quota-limited), not Rung 1', async () => {
    const h = makeHarness(dir, { enabled: true, dryRun: false, maxEscalationSpawnsPerTick: 0 });
    h.beacon.start();
    const c = newCommitment(h.tracker);
    await h.beacon.fire(c.id);

    expect(h.reviveCalls).toBe(0); // budget shed the spawn
    expect(h.sent.length).toBe(1);
    expect(h.sent[0].text).toMatch(/capacity|headroom/i);
    h.beacon.stop();
  });

  it('quiet hours suppress escalation entirely (no revive, no message)', async () => {
    const h = makeHarness(dir, ESC_LIVE, { quietHours: ALWAYS_QUIET });
    h.beacon.start();
    const c = newCommitment(h.tracker);
    await h.beacon.fire(c.id);

    expect(h.reviveCalls).toBe(0);
    expect(h.sent.length).toBe(0);
    const after = h.tracker.get(c.id)!;
    expect(after.beaconSuppressed).toBe(true);
    h.beacon.stop();
  });

  it('double-spawn detection: two live sessions for an in-flight topic increments the counter once (deduped)', async () => {
    let liveCount = 2; // partition/race signature: 2 live sessions for the topic
    const h = makeHarness(dir, { enabled: true, dryRun: false, reviveSettleMs: 30_000, escalationGraceMs: 10_000 },
      { liveSessionCountForTopic: () => liveCount });
    h.beacon.start();
    const c = newCommitment(h.tracker);
    await h.tracker.mutate(c.id, prev => ({
      ...prev, escalationInFlight: true, escalationAttemptId: 'd1',
      lastEscalationAt: new Date(h.nowRef.ms).toISOString(), // age 0 → resolveInFlight returns 'pending'
    }));

    expect(h.beacon.escalationMetrics().doubleSpawnCount).toBe(0);
    await h.beacon.fire(c.id); // detection runs at top of resolveInFlight
    expect(h.beacon.escalationMetrics().doubleSpawnCount).toBe(1);

    // Same attempt still in-flight + still 2 sessions → deduped, no double count.
    await h.beacon.fire(c.id);
    expect(h.beacon.escalationMetrics().doubleSpawnCount).toBe(1);
    expect(h.audits.filter(a => a.decision === 'double-spawn-detected').length).toBe(1);
    h.beacon.stop();
  });

  it('double-spawn detection: a single live session never increments the counter', async () => {
    const h = makeHarness(dir, { enabled: true, dryRun: false, reviveSettleMs: 30_000 },
      { liveSessionCountForTopic: () => 1 });
    h.beacon.start();
    const c = newCommitment(h.tracker);
    await h.tracker.mutate(c.id, prev => ({
      ...prev, escalationInFlight: true, escalationAttemptId: 'd2',
      lastEscalationAt: new Date(h.nowRef.ms).toISOString(),
    }));
    await h.beacon.fire(c.id);
    expect(h.beacon.escalationMetrics().doubleSpawnCount).toBe(0);
    h.beacon.stop();
  });

  it('golden: Rung-2 wording matches the real recoverability state and never lies', async () => {
    const cases: Array<{ reason: ReviveResult['refusalReason']; expect: RegExp; reject?: RegExp }> = [
      { reason: 'quota', expect: /capacity|headroom/i, reject: /\bworking\b/i },
      { reason: 'lease', expect: /can.?t auto-resume|operator may need/i },
      { reason: 'unbound', expect: /can.?t auto-resume|operator may need/i },
      { reason: 'resume-queue-owns', expect: /picking it back up|my session ended/i },
    ];
    for (const tc of cases) {
      const { dir: d, cleanup: cl } = tmpState();
      const h = makeHarness(d, ESC_LIVE);
      h.setRevive(async () => ({ sessionName: null, refusalReason: tc.reason }));
      h.beacon.start();
      const c = newCommitment(h.tracker);
      await h.beacon.fire(c.id);
      expect(h.sent.length).toBe(1);
      expect(h.sent[0].text).toMatch(tc.expect);
      if (tc.reject) expect(h.sent[0].text).not.toMatch(tc.reject);
      h.beacon.stop();
      cl();
    }
  });
});
