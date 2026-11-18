// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.

/**
 * Tier 2 — promise keeping through the full HTTP pipeline
 * (docs/specs/promise-keeping-before-the-deadline.md). The real router with a
 * real CommitmentTracker, a fake Telegram transport and a fake promise-work
 * runtime (the server-owned start path).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { AddressInfo } from 'node:net';
import { CommitmentTracker } from '../../src/monitoring/CommitmentTracker.js';
import { LiveConfig } from '../../src/config/LiveConfig.js';
import { createRoutes } from '../../src/server/routes.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

/** A clock time three hours ahead in this machine's zone, e.g. "4:07 PM" — always inside the detector's horizon. */
const inThreeHours = () => new Date(Date.now() + 3 * 3600_000).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });

describe('promise keeping — routes', () => {
  let dir: string;
  let tracker: CommitmentTracker;
  let url: string;
  let close: () => Promise<void>;
  let sends: Array<{ topicId: number; text: string }>;
  let history: Array<{ messageId: number; topicId: number; text: string; fromUser: boolean; timestamp: string; sessionName: string | null }>;
  let injected: Array<{ session: string; text: string }>;
  let spawns: Array<{ topicId: number; bootstrap: string; triggeredBy: string }>;
  let spawnImpl: (topicId: number) => Promise<string>;
  let capacityOk: boolean;
  let onTopicMessage: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'promise-keeping-int-'));
    fs.mkdirSync(path.join(dir, 'state'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ authToken: 'test', commitments: { checkInReminder: { enabled: true, dryRun: false } } }));
    const liveConfig = new LiveConfig(dir);
    tracker = new CommitmentTracker({ stateDir: dir, liveConfig });
    sends = []; injected = []; spawns = []; history = [];
    capacityOk = true;
    spawnImpl = async (topicId) => `echo-topic-${topicId}`;
    onTopicMessage = vi.fn();
    const telegram = {
      sendToTopic: vi.fn(async (topicId: number, text: string) => {
        sends.push({ topicId, text });
        const messageId = 1000 + sends.length;
        history.push({ messageId, topicId, text, fromUser: false, timestamp: new Date().toISOString(), sessionName: null });
        return { message_id: messageId, messageId };
      }),
      getSessionForTopic: (topicId: number) => (topicId === 7 ? 'echo-topic-7' : null),
      getTopicHistory: (topicId: number) => history.filter((h) => h.topicId === topicId),
      getCachedTopicTail: (topicId: number) => history.filter((h) => h.topicId === topicId),
      onTopicMessage,
      createAttentionItem: vi.fn(async () => undefined),
    };
    const sessionManager = {
      isSessionAlive: (s: string) => s === 'echo-topic-7',
      injectPasteNotificationObserved: vi.fn(async (session: string, text: string) => { injected.push({ session, text }); return { state: 'submitted' }; }),
    };
    const promiseWork = {
      getSessionForTopic: telegram.getSessionForTopic,
      isSessionAlive: sessionManager.isSessionAlive,
      injectObserved: sessionManager.injectPasteNotificationObserved,
      holdsLease: () => true,
      resumeQueueOwns: () => false,
      capacity: () => (capacityOk ? { ok: true as const } : { ok: false as const, reason: 'full' }),
      spawnPromiseWork: async (topicId: number, bootstrap: string, triggeredBy: string) => { spawns.push({ topicId, bootstrap, triggeredBy }); return spawnImpl(topicId); },
      findAttemptSession: () => null,
      workingPromiseSessions: () => 0,
      maxSessions: () => 10,
      listPromiseWorkSessions: () => [],
    };
    const app = express();
    app.use(express.json());
    const ctx: any = {
      commitmentTracker: tracker,
      telegram,
      sessionManager,
      liveConfig,
      promiseWork,
      config: { authToken: 'test', stateDir: dir, port: 0, commitments: { checkInReminder: { enabled: true, dryRun: false } } },
      stateDir: dir,
    };
    app.use(createRoutes(ctx));
    await new Promise<void>((resolve) => {
      const srv = app.listen(0, () => {
        url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
        close = () => new Promise<void>((r) => srv.close(() => r()));
        resolve();
      });
    });
  });

  afterEach(async () => {
    await close();
    SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/integration/overdue-promise-follow-through-routes.test.ts' });
  });

  const api = async (p: string, init?: RequestInit) => {
    const res = await fetch(url + p, { ...init, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test', ...(init?.headers ?? {}) } });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };
  const pass = () => api('/commitments/check-in-reminder/pass', { method: 'POST', body: '{}' });
  const promise = async (topicId: number, agentResponse: string, minutesAgo: number, lengthMin = 120) => {
    const c = tracker.record({
      type: 'one-time-action', userRequest: 'x', agentResponse, topicId, source: 'agent',
      beaconEnabled: true, softDeadlineAt: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
    } as never);
    // Backdate creation so the promise has a real length.
    await tracker.mutate(c.id, (r) => ({ ...r, createdAt: new Date(Date.now() - (minutesAgo + lengthMin) * 60_000).toISOString() }));
    return c;
  };

  it('a missed time goes to the RUNNING session as a system notice; the person gets nothing', async () => {
    const c = await promise(7, 'Laptop run time by noon', 10);
    const r = await pass();
    expect(r.status).toBe(200);
    expect(r.body.late.keeping).toMatchObject({ pickedUp: 1, notified: 1, lastResortTopics: 0 });
    expect(sends).toHaveLength(0);
    expect(injected).toHaveLength(1);
    expect(injected[0].text).toContain(`[instar promise follow-through — ${c.id}`);
    expect(injected[0].text).toContain('The person has NOT been told');
    expect(onTopicMessage).not.toHaveBeenCalled();
  });

  it('no running session → a start through the direct spawn path (never the inbound pipeline), no message', async () => {
    await promise(9, 'the scaling plan', 10);
    const r = await pass();
    expect(r.body.late.keeping.pending).toBe(1);
    await vi.waitFor(() => expect(spawns).toHaveLength(1));
    expect(spawns[0].topicId).toBe(9);
    expect(spawns[0].bootstrap).toContain('Do not acknowledge it to the person');
    expect(spawns[0].triggeredBy).toMatch(/^promise-work:CMT-\d+:pk-/);
    expect(onTopicMessage).not.toHaveBeenCalled();
    expect(sends).toHaveLength(0);
  });

  it('no capacity → held, and no message until the not-taken deadline passes', async () => {
    capacityOk = false;
    await promise(9, 'the scaling plan', 10);
    const r = await pass();
    expect(r.body.late.keeping.held).toMatchObject({ capacity: 1 });
    expect(sends).toHaveLength(0);
  });

  it('every start failing → one last-resort message after three failures, never asking the person to act', async () => {
    spawnImpl = async () => { throw new Error('spawn refused'); };
    const c = await promise(9, 'the scaling plan', 10);
    for (let i = 0; i < 3; i++) {
      await pass();
      await vi.waitFor(() => expect(tracker.get(c.id)?.pendingAttempt).toBeUndefined());
    }
    await pass();
    expect(sends).toHaveLength(1);
    expect(sends[0].text).toContain('I missed the time I gave you');
    expect(sends[0].text).toContain('Restarting the work failed.');
    expect(sends[0].text).not.toMatch(/reply|let me know/i);
    await pass();
    expect(sends).toHaveLength(1);
  });

  it('PATCH cannot move a time the person was given; reschedule sends the message and then moves it', async () => {
    const c = await promise(7, 'the scaling plan', 10);
    const later = new Date(Date.now() + 3 * 3600_000).toISOString();
    const patched = await api(`/commitments/${c.id}`, { method: 'PATCH', body: JSON.stringify({ softDeadlineAt: later }) });
    expect(patched.status).toBe(409);
    expect(patched.body.refusedBy).toBe('promise-keeping-given-time');
    const rs = await api(`/commitments/${c.id}/reschedule`, { method: 'POST', body: JSON.stringify({ newTime: later, message: 'I missed noon on the scaling plan; the load test is rerunning now.' }) });
    expect(rs.status).toBe(200);
    expect(sends).toHaveLength(1);
    expect(sends[0].text).toContain('the load test is rerunning now');
    expect(sends[0].text).toMatch(/New time: /);
    const row = tracker.get(c.id)!;
    expect(row.softDeadlineAt).toBe(later);
    expect(row.timeMovesAfterMiss).toBe(1);
    expect(row.rescheduleIntent).toBeUndefined();
  });

  it('reschedule refuses a credential in the message (422) and leaves the time', async () => {
    const c = await promise(7, 'the scaling plan', 10);
    const before = tracker.get(c.id)!.softDeadlineAt;
    const rs = await api(`/commitments/${c.id}/reschedule`, { method: 'POST', body: JSON.stringify({ newTime: new Date(Date.now() + 3600_000).toISOString(), message: 'token ghp_abcdefghijklmnopqrstuvwxyz0123456789AB' }) });
    expect(rs.status).toBe(422);
    expect(tracker.get(c.id)!.softDeadlineAt).toBe(before);
  });

  it('the grace: once, at most 15 minutes, the time is unchanged', async () => {
    const c = await promise(7, 'the scaling plan', 10);
    const before = tracker.get(c.id)!.softDeadlineAt;
    const g = await api(`/commitments/${c.id}/reschedule`, { method: 'POST', body: JSON.stringify({ grace: true, minutes: 10 }) });
    expect(g.status).toBe(200);
    expect(tracker.get(c.id)!.softDeadlineAt).toBe(before);
    const again = await api(`/commitments/${c.id}/reschedule`, { method: 'POST', body: JSON.stringify({ grace: true, minutes: 5 }) });
    expect(again.status).toBe(409);
    const other = await promise(7, 'other', 10);
    const tooLong = await api(`/commitments/${other.id}/reschedule`, { method: 'POST', body: JSON.stringify({ grace: true, minutes: 30 }) });
    expect(tooLong.status).toBe(400);
  });

  it('past its time, deliver needs the id of the message that gave the person the result', async () => {
    const c = await promise(7, 'the scaling plan', 10);
    const bare = await api(`/commitments/${c.id}/deliver`, { method: 'POST', body: '{}' });
    expect(bare.status).toBe(409);
    expect(bare.body.refusedBy).toBe('promise-keeping-deliver-evidence');
    history.push({ messageId: 555, topicId: 7, text: 'Here is the scaling plan', fromUser: false, timestamp: new Date().toISOString(), sessionName: 'echo-topic-7' });
    const ok = await api(`/commitments/${c.id}/deliver`, { method: 'POST', body: JSON.stringify({ deliveryMessageId: '555' }) });
    expect(ok.status).toBe(200);
    expect(tracker.get(c.id)!.status).toBe('delivered');
  });

  it('a first time on an untimed promise is still a PATCH, and records firstPromisedAt', async () => {
    const c = tracker.record({ type: 'one-time-action', userRequest: 'x', agentResponse: 'later', topicId: 7, source: 'agent', followThroughOptOutReason: 'fixture' } as never);
    const t = new Date(Date.now() + 3600_000).toISOString();
    const r = await api(`/commitments/${c.id}`, { method: 'PATCH', body: JSON.stringify({ softDeadlineAt: t }) });
    expect(r.status).toBe(200);
    expect(tracker.get(c.id)!.firstPromisedAt).toBe(t);
  });

  it('POST /commitments carries dateMissing for "by <time>" with no promised time; none when one is set', async () => {
    const noDate = await api('/commitments', { method: 'POST', body: JSON.stringify({
      type: 'one-time-action', userRequest: 'x', agentResponse: `I'll have it done before ${inThreeHours()}.`, topicId: 7, followThroughOptOutReason: 'fixture',
    }) });
    expect(noDate.status).toBe(201);
    expect(noDate.body.dateMissing?.suggestedSoftDeadlineAt).toMatch(/Z$/);
    const withDate = await api('/commitments', { method: 'POST', body: JSON.stringify({
      type: 'one-time-action', userRequest: 'x', agentResponse: `I'll have it done before ${inThreeHours()}.`, topicId: 7,
      beaconEnabled: true, softDeadlineAt: new Date(Date.now() + 3600_000).toISOString(),
    }) });
    expect(withDate.status).toBe(201);
    expect(withDate.body.dateMissing).toBeUndefined();
  });
});
