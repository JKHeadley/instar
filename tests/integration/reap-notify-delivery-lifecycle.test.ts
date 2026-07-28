// safe-git-allow: test fixture cleanup uses fs.rmSync on tmp dirs only.
/**
 * Reap → durable notify record lifecycle (reap-notify spec R1.3) with REAL
 * components composed end-to-end: ReapNotifier v2 → PendingRelayStore →
 * ReapNoticeDrain → ReapLog. Covers enqueued→sent, enqueued→
 * send-failed-escalated (failing adapter), the quota-shed simulation
 * (migrator pre-grace evidence → per-topic notices + queue entries), and the
 * P17/P19 burst invariants over the real store.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { PendingRelayStore } from '../../src/messaging/pending-relay-store.js';
import { ReapNotifier } from '../../src/monitoring/ReapNotifier.js';
import { ReapNoticeDrain } from '../../src/monitoring/ReapNoticeDrain.js';
import { ReapLog } from '../../src/monitoring/ReapLog.js';
import { ResumeQueue } from '../../src/monitoring/ResumeQueue.js';
import { ResumeQueueDrainer } from '../../src/monitoring/ResumeQueueDrainer.js';
import { SessionMigrator, type SessionMigratorDeps } from '../../src/monitoring/SessionMigrator.js';

let tmpDir: string;
let stateDir: string;
let store: PendingRelayStore;
let reapLog: ReapLog;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reap-notify-lifecycle-'));
  stateDir = path.join(tmpDir, '.instar');
  fs.mkdirSync(path.join(stateDir, 'state'), { recursive: true });
  store = PendingRelayStore.open('lifecycle', stateDir);
  reapLog = new ReapLog(stateDir);
});

afterEach(() => {
  store.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeNotifier(over?: { resolveTopic?: (t: string) => number | null }) {
  return new ReapNotifier(
    {
      resolveTopic: over?.resolveTopic ?? (() => 42),
      lifelineTopic: () => 999,
      send: () => {},
      enqueueNotice: (input) =>
        store.enqueue({
          delivery_id: input.delivery_id,
          topic_id: input.topic_id,
          text_hash: 'h'.repeat(64),
          text: input.text,
          next_attempt_at: input.next_attempt_at,
        }),
      recordNotify: (e) => reapLog.recordNotify(e),
      quietHoursEndAt: () => null,
      summaryReleaseAt: (now) => now, // release immediately for the test
    },
    { enabled: true, coalesceWindowMs: 60_000, maxBuffer: 100, perTopic: true, maxImmediatePerFlush: 5, drainEnabled: true },
  );
}

function makeDrain(sendFails: boolean, maxAttempts = 2) {
  const sent: Array<{ topicId: number; text: string }> = [];
  const attention: string[] = [];
  const drain = new ReapNoticeDrain(
    {
      store,
      sendToTopic: async (topicId, text) => {
        if (sendFails) throw new Error('telegram down');
        sent.push({ topicId, text });
      },
      recordNotify: (e) => reapLog.recordNotify(e),
      emitAttention: async (item) => { attention.push(item.id); },
      bootId: 'boot-lifecycle',
    },
    { maxAttempts, backoffBaseMs: 1 },
  );
  return { drain, sent, attention };
}

const reap = (notifier: ReapNotifier, name: string, midWork = false) =>
  notifier.onReaped({
    session: { name, tmuxSession: name },
    reason: 'quota-shed',
    disposition: 'terminal',
    origin: 'autonomous',
    midWork,
  });

describe('reap → durable notify lifecycle (R1.3)', () => {
  it('enqueued → sent: the full pair lands in the reap-log and the row goes terminal', async () => {
    const notifier = makeNotifier();
    reap(notifier, 'alpha', true);
    await notifier.flush();

    // The enqueued record exists before any delivery.
    let notifies = reapLog.read().filter((e) => e.type === 'notify');
    expect(notifies.map((e) => e.outcome)).toEqual(['enqueued']);

    const { drain, sent } = makeDrain(false);
    const result = await drain.tick();
    expect(result.sent).toBe(1);
    expect(sent[0].topicId).toBe(42);
    expect(sent[0].text).toContain('alpha');

    notifies = reapLog.read().filter((e) => e.type === 'notify');
    expect(notifies.map((e) => e.outcome)).toEqual(['enqueued', 'sent']);
    expect(notifies[1].noticeId).toBe(notifies[0].noticeId); // the PAIR shares the id
  });

  it('enqueued → send-failed-escalated via a failing adapter; ONE aggregated item', async () => {
    const notifier = makeNotifier();
    reap(notifier, 'beta');
    await notifier.flush();

    const { drain, attention } = makeDrain(true, 2);
    await drain.tick(); // attempt 2 → escalates (row starts at attempts=1)
    const notifies = reapLog.read().filter((e) => e.type === 'notify');
    expect(notifies.map((e) => e.outcome)).toEqual(['enqueued', 'send-failed-escalated']);
    expect(attention).toEqual(['reap-notice-drain:escalations']);
  });

  it('a held notice survives a simulated restart (R1.6) and delivers after release', async () => {
    const notifier = new ReapNotifier(
      {
        resolveTopic: () => 42,
        lifelineTopic: () => 999,
        send: () => {},
        enqueueNotice: (input) =>
          store.enqueue({
            delivery_id: input.delivery_id,
            topic_id: input.topic_id,
            text_hash: 'h'.repeat(64),
            text: input.text,
            next_attempt_at: input.next_attempt_at,
          }),
        recordNotify: (e) => reapLog.recordNotify(e),
        quietHoursEndAt: (now) => now + 3600_000, // in quiet hours for 1h
        summaryReleaseAt: (now) => now,
      },
      { enabled: true, coalesceWindowMs: 60_000, maxBuffer: 100, perTopic: true, maxImmediatePerFlush: 5, drainEnabled: true },
    );
    reap(notifier, 'held-one');
    await notifier.flush();

    // Simulated restart purge with the 60-min cutoff: the held row survives.
    const now = Date.now();
    const purged = store.purgeStaleClaimable(new Date(now - 3600_000).toISOString(), new Date(now).toISOString());
    expect(purged).toBe(0);
    expect(store.count()).toBe(1);

    // Not due yet — the drain leaves it alone.
    const { drain, sent } = makeDrain(false);
    expect((await drain.tick()).sent).toBe(0);

    // After the hold passes, it delivers. (Drain with a future-skewed clock.)
    const late = new ReapNoticeDrain(
      {
        store,
        sendToTopic: async (topicId, text) => { sent.push({ topicId, text }); },
        recordNotify: (e) => reapLog.recordNotify(e),
        bootId: 'boot-late',
        now: () => Date.now() + 2 * 3600_000,
      },
      { backoffBaseMs: 1 },
    );
    expect((await late.tick()).sent).toBe(1);
  });
});

describe('quota-shed simulation (R2.1/R2.2 end-to-end)', () => {
  it('migrator pre-grace evidence flows into per-topic notices + queue entries', async () => {
    const queue = new ResumeQueue({ stateDir }, { dryRun: false });
    queue.start();
    const notifier = makeNotifier({ resolveTopic: (t) => (t === 'working-1' ? 11 : t === 'working-2' ? 12 : null) });

    // A toy "kill authority": stamps killer-supplied evidence onto the reap
    // event exactly like terminateSession does, then fans out to the real
    // notifier + queue (the sessionReaped listener's shape).
    const terminate = async (session: { id: string; tmuxSession: string; name: string }, evidence: string[]) => {
      reapLog.recordReaped({
        session: session.name,
        tmuxSession: session.tmuxSession,
        reason: 'quota-shed',
        origin: 'autonomous',
        midWork: evidence.length > 0,
        workEvidence: evidence,
      });
      queue.considerEnqueue({
        sessionName: session.name,
        tmuxSession: session.tmuxSession,
        topicId: session.tmuxSession === 'working-1' ? 11 : 12,
        resumeUuid: null,
        cwd: tmpDir,
        reason: 'quota-shed',
        disposition: 'terminal',
        origin: 'autonomous',
        workEvidence: evidence,
      });
      notifier.onReaped({
        session: { name: session.name, tmuxSession: session.tmuxSession },
        reason: 'quota-shed',
        disposition: 'terminal',
        origin: 'autonomous',
        midWork: evidence.length > 0,
      });
      return { terminated: true };
    };

    const sessions = [
      { id: 's1', tmuxSession: 'working-1', name: 'working-1', jobSlug: 'job-1' },
      { id: 's2', tmuxSession: 'working-2', name: 'working-2', jobSlug: 'job-2' },
    ];
    const deps: SessionMigratorDeps = {
      listRunningSessions: () => sessions,
      sendKey: () => true,
      killSession: () => true,
      isSessionAlive: () => true, // both survive Ctrl+C → force-kill path
      pauseScheduler: () => {},
      resumeScheduler: () => {},
      respawnJob: async () => {},
      getAccountStatuses: () => [
        {
          email: 'backup@test.io', name: 'B', isActive: false, hasToken: true,
          tokenExpired: false, isStale: false, weeklyPercent: 10, fiveHourPercent: 5, weeklyResetsAt: null,
        },
      ],
      switchAccount: async () => ({ success: true, message: 'ok' }),
      // The pre-grace snapshot — computed BEFORE Ctrl+C (R2.1).
      collectWorkEvidence: () => ['open-commitment'],
      quotaUsagePercent: () => 100,
      terminateSession: async (id, _reason, opts) => {
        const session = sessions.find((s) => s.id === id)!;
        return terminate(session, opts?.workEvidence ?? []);
      },
    };
    const migrator = new SessionMigrator({
      stateDir: path.join(tmpDir, 'migrator'),
      thresholds: { gracePeriodMs: 10 },
    });
    migrator.setDeps(deps);
    await migrator.checkAndMigrate({ percentUsed: 95, activeAccountEmail: 'active@test.io' });
    await notifier.flush();

    // Queue: both mid-work sessions entered (strong signal from the snapshot).
    const queued = queue.list().filter((e) => e.status === 'queued');
    expect(queued.map((e) => e.stableKey).sort()).toEqual(['topic:11', 'topic:12']);
    expect(queued[0].workEvidence).toContain('open-commitment');

    // Notices: one durable row per affected topic + lifeline index.
    const rows = store.selectClaimableReapNotices(new Date(Date.now() + 60_000).toISOString(), 100);
    const topics = rows.map((r) => r.topic_id).sort((a, b) => a - b);
    expect(topics).toEqual([11, 12, 999]);

    // Reap-log: midWork stamped on both reaped entries.
    const reaped = reapLog.read().filter((e) => e.type === 'reaped');
    expect(reaped.every((e) => e.midWork === true)).toBe(true);
    queue.stop();
  });
});

describe('burst invariants over the real store (P17/P19)', () => {
  it('N reaps across M topics → ≤M topic rows + 1 lifeline, ≤cap immediate releases, zero new topics', async () => {
    const M = 10;
    const N = 40;
    const notifier = new ReapNotifier(
      {
        resolveTopic: (t) => Number(t.split('-')[1]) % M, // 40 reaps over 10 topics
        lifelineTopic: () => 999,
        send: () => {},
        enqueueNotice: (input) =>
          store.enqueue({
            delivery_id: input.delivery_id,
            topic_id: input.topic_id,
            text_hash: 'h'.repeat(64),
            text: input.text,
            next_attempt_at: input.next_attempt_at,
          }),
        recordNotify: (e) => reapLog.recordNotify(e),
        quietHoursEndAt: () => null,
        summaryReleaseAt: (now) => now + 10 * 60_000,
        resumeQueuedFor: () => true,
      },
      { enabled: true, coalesceWindowMs: 60_000, maxBuffer: 100, perTopic: true, maxImmediatePerFlush: 5, drainEnabled: true },
    );
    for (let i = 0; i < N; i++) reap(notifier, `s-${i}`, true);
    await notifier.flush();

    const all = store.selectClaimableReapNotices(new Date(Date.now() + 3600_000).toISOString(), 100);
    expect(all.length).toBeLessThanOrEqual(M + 1); // ≤M topic messages + 1 lifeline
    const distinctTopics = new Set(all.map((r) => r.topic_id));
    expect(distinctTopics.size).toBeLessThanOrEqual(M + 1); // zero NEW topics — only existing ids
    const nowIso = new Date(Date.now() + 1000).toISOString();
    const immediate = store.selectClaimableReapNotices(nowIso, 100);
    expect(immediate.length).toBeLessThanOrEqual(5); // maxImmediatePerFlush

    // Global release throttle (R1.5): one drain pass sends ≤ perPassSendCap.
    const { drain, sent } = makeDrain(false);
    await drain.tick();
    expect(sent.length).toBeLessThanOrEqual(15);
  });

  it('K entries vs a permanently-rejecting spawn target → bounded attempts, breaker opens, ONE aggregated item id, zero per-entry items', async () => {
    const K = 6;
    // server.ts raiseResumeAggregated folds EVERY give-up class into one
    // rolling attention item with this FIXED id (P17) — mirror that here so
    // the invariant under test is the real production surface.
    const attentionIds: string[] = [];
    const raiseAggregated = () => attentionIds.push('resume-queue:aggregate');
    const queue = new ResumeQueue({ stateDir, raiseAggregated }, { dryRun: false, maxAttempts: 3 });
    queue.start();
    for (let i = 0; i < K; i++) {
      queue.considerEnqueue({
        sessionName: `burst-${i}`,
        tmuxSession: `tmux-burst-${i}`,
        topicId: 100 + i,
        resumeUuid: null,
        cwd: tmpDir,
        reason: 'quota-shed',
        disposition: 'terminal',
        origin: 'autonomous',
        workEvidence: ['build-or-autonomous-active'],
      });
    }
    expect(queue.list().filter((e) => e.status === 'queued')).toHaveLength(K);

    let spawnAttempts = 0;
    const drainer = new ResumeQueueDrainer(
      {
        queue,
        pressureTier: () => 'normal',
        canSpawnSession: () => true,
        sessionCountOk: () => true,
        migrationInFlight: () => false,
        liveSessionForTopic: () => false,
        currentResumeUuid: () => null,
        topicOwnerElsewhere: () => false,
        topicBindingMatches: () => true,
        operatorStopSince: () => false,
        jobCheck: () => ({ ok: true }),
        pathExists: () => true,
        respawnTopic: async () => {
          spawnAttempts++;
          throw new Error('spawn target permanently rejects');
        },
        triggerJob: async () => 'skipped',
        spawnAliveAfterGrace: async () => false,
        raiseAggregated,
        audit: () => {},
      },
      { requiredCalmTicks: 0, maxAttempts: 3, breakerThreshold: 3, breakerCooldownMin: 30 },
    );

    // Drive ticks until the breaker opens — bounded, never unbounded retries.
    let ticks = 0;
    while (!drainer.status().breakerOpen && ticks < 10) {
      await drainer.tick();
      ticks++;
    }

    // Breaker opened after exactly breakerThreshold consecutive failures;
    // ONE candidate attempted per tick — per-attempt cost bounded by ticks.
    expect(drainer.status().breakerOpen).toBe(true);
    expect(spawnAttempts).toBe(3);
    expect(ticks).toBe(3);
    expect((await drainer.tick()).blocked).toBe('breaker-open');
    expect(spawnAttempts).toBe(3); // breaker-open ticks attempt nothing

    // Exactly ONE aggregated attention item id; zero per-entry items.
    expect(attentionIds).toEqual(['resume-queue:aggregate']);
    // No entry was burned past its attempt budget; the queue is intact.
    const statuses = queue.list().map((e) => e.status);
    expect(statuses.filter((s) => s === 'queued')).toHaveLength(K);
    expect(queue.list().every((e) => e.attempts <= 1)).toBe(true);
    queue.stop();
  });
});
