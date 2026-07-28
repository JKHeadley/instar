// safe-git-allow: test fixture cleanup uses fs.rmSync on tmp dirs only.
/**
 * honest-session-state-surfaces Findings (b) + (c) — end-to-end through REAL
 * components.
 *
 * (c) copy path: a REAL ReapNotifier wired (as server.ts wires it) to the
 *     CLAIMABILITY predicate of a REAL paused ResumeQueue must NOT emit "restart
 *     ... queued"; after unpause, an equivalent reap notice DOES.
 * (c) I2 guard path: the same paused ResumeQueue still reports OWNERSHIP
 *     (hasLiveQueuedEntryFor true) — the predicate the PromiseBeacon I2
 *     double-spawn guard reads — proving the copy fix did not re-open the
 *     double-spawn while paused.
 * (b) Tier1/Tier2 honest standby surfaces the REAL stuck reason through the
 *     real PresenceProxy fire path against a stuck pane.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ReapNotifier } from '../../src/monitoring/ReapNotifier.js';
import { ResumeQueue, type ResumeCandidateInput } from '../../src/monitoring/ResumeQueue.js';
import { PresenceProxy } from '../../src/monitoring/PresenceProxy.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import type { Session } from '../../src/core/types.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'standby-honesty-int-'));
});
afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function sess(name: string, tmux = name): Pick<Session, 'name' | 'tmuxSession'> {
  return { name, tmuxSession: tmux };
}

function candidate(over: Partial<ResumeCandidateInput> = {}): ResumeCandidateInput {
  return {
    sessionName: 'sess-int',
    tmuxSession: 'tmux-int',
    topicId: 42,
    resumeUuid: '11111111-1111-4111-8111-111111111111',
    cwd: '/tmp/project',
    reason: 'quota-shed',
    disposition: 'terminal',
    origin: 'autonomous',
    workEvidence: ['build-or-autonomous-active'],
    ...over,
  };
}

function makeQueue() {
  const stateDir = path.join(tmpDir, 'rq');
  fs.mkdirSync(stateDir, { recursive: true });
  let nowMs = 3_000_000_000_000;
  const q = new ResumeQueue(
    { stateDir, audit: () => {}, raiseAggregated: () => {}, now: () => nowMs },
    { dryRun: false },
  );
  return q;
}

// Wire a ReapNotifier exactly as server.ts does: the "restart is queued" copy
// reads the CLAIMABILITY predicate.
function makeNotifier(rq: ResumeQueue) {
  const sends: Array<{ topicId: number; text: string }> = [];
  const n = new ReapNotifier(
    {
      resolveTopic: () => 42,
      lifelineTopic: () => 999,
      send: (topicId, text) => { sends.push({ topicId, text }); },
      // Finding (c): copy reads claimability (paused-aware), NOT ownership.
      resumeQueuedFor: (tmuxSession) => rq.hasClaimableQueuedEntryFor(tmuxSession),
    },
    { enabled: true, coalesceWindowMs: 1, maxBuffer: 100, perTopic: true, maxImmediatePerFlush: 5 },
  );
  return { n, sends };
}

describe('(c) ReapNotifier "restart is queued" copy honors the paused queue', () => {
  it('PAUSED queue → notice does NOT claim a restart; I2 ownership predicate stays TRUE', async () => {
    const rq = makeQueue();
    rq.start();
    expect(rq.considerEnqueue(candidate()).enqueued).toBe(true);
    rq.pause('emergency-stop');

    const { n, sends } = makeNotifier(rq);
    n.onReaped({ session: sess('sess-int', 'tmux-int'), reason: 'quota-shed', disposition: 'terminal', midWork: true });
    await n.flush();

    expect(sends.length).toBeGreaterThanOrEqual(1);
    const text = sends.map(s => s.text).join('\n');
    expect(text).not.toMatch(/restart.*queued/i);

    // I2 double-spawn guard predicate (server.ts:11980) — ownership survives the pause.
    expect(rq.hasLiveQueuedEntryFor('tmux-int')).toBe(true);
  });

  it('UNPAUSED queue → an equivalent reap notice DOES claim a restart', async () => {
    const rq = makeQueue();
    rq.start();
    expect(rq.considerEnqueue(candidate()).enqueued).toBe(true);
    // not paused

    const { n, sends } = makeNotifier(rq);
    n.onReaped({ session: sess('sess-int', 'tmux-int'), reason: 'quota-shed', disposition: 'terminal', midWork: true });
    await n.flush();

    const text = sends.map(s => s.text).join('\n');
    expect(text).toMatch(/restart.*queued/i);
  });
});

describe('(b) PresenceProxy Tier1/Tier2 honest standby through the real fire path', () => {
  const POLICY_WEDGE = [
    '❯ msg one',
    '⏺ API Error: Claude Code is unable to respond to this request, which appears to violate our Usage Policy (https://www.anthropic.com/legal/aup).',
    '✻ Churned for 8s',
    '❯ msg two',
    '⏺ API Error: Claude Code is unable to respond to this request, which appears to violate our Usage Policy (https://www.anthropic.com/legal/aup).',
    '✻ Cogitated for 8s',
  ].join('\n');

  let cleanup: string[] = [];
  beforeEach(() => { cleanup = []; });
  afterEach(() => {
    for (const d of cleanup) {
      try { SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/integration/standby-honesty-reap-notice.test.ts:cleanup' }); } catch { /* ignore */ }
    }
  });

  function mkProxy(flag: boolean) {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-int-'));
    cleanup.push(stateDir);
    const sent: Array<{ topicId: number; text: string }> = [];
    const proxy = new PresenceProxy({
      stateDir,
      intelligence: null as any,
      agentName: 'echo',
      getProcessTree: () => [{ command: 'claude', pid: 1 }],
      isSessionAlive: () => true,
      getSessionForTopic: () => 'sess-1',
      captureSessionOutput: () => POLICY_WEDGE,
      sendMessage: async (topicId: number, text: string) => { sent.push({ topicId, text }); },
      getAuthorizedUserIds: () => [],
      standbyHonestyTiers: flag,
    } as any);
    proxy.start();
    return { proxy, sent };
  }

  function seed(proxy: any, topicId: number, tier1Fired = false) {
    const state = {
      topicId, sessionName: 'sess-1',
      userMessageAt: Date.now() - 5_000, userMessageText: 'hi',
      userMessageBaselineSnapshot: null,
      tier1FiredAt: tier1Fired ? Date.now() - 4_000 : null,
      tier1Snapshot: null, tier1SnapshotHash: null,
      tier2FiredAt: null, tier2Snapshot: null, tier2SnapshotHash: null,
      tier3FiredAt: null, tier3Assessment: null, tier3Summary: null, tier3RecheckCount: 0,
      silencedUntil: null, cancelled: false, llmCallCount: 0, lastLlmCallAt: 0,
      conversationHistory: [], lastAckText: null, lastAckAt: null,
    };
    (proxy as any).states.set(topicId, state);
    return state;
  }

  it('flag ON: Tier 1 carries the honest content-policy reason, not "actively working"', async () => {
    const { proxy, sent } = mkProxy(true);
    await (proxy as any).fireTier1(700, seed(proxy, 700));
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toMatch(/content-policy/i);
    expect(sent[0].text).not.toMatch(/actively working/i);
  });

  it('flag ON: Tier 2 carries the honest reason, not "still working"', async () => {
    const { proxy, sent } = mkProxy(true);
    await (proxy as any).fireTier2(701, seed(proxy, 701, true));
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toMatch(/content-policy/i);
    expect(sent[0].text).not.toMatch(/is still working/i);
  });
});
