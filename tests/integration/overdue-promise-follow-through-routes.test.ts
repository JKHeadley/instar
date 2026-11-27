// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.

/**
 * Tier 2 — overdue-promise follow-through through the full HTTP pipeline
 * (docs/specs/overdue-promise-follow-through.md). The real router with a real
 * CommitmentTracker and a fake Telegram transport + session manager.
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

describe('overdue promise follow-through — routes', () => {
  let dir: string;
  let tracker: CommitmentTracker;
  let url: string;
  let close: () => Promise<void>;
  let sends: Array<{ topicId: number; text: string }>;
  let injected: Array<{ session: string; text: string }>;
  let onTopicMessage: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'overdue-promise-int-'));
    fs.mkdirSync(path.join(dir, 'state'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ authToken: 'test', commitments: { checkInReminder: { enabled: true, dryRun: false } } }));
    const liveConfig = new LiveConfig(dir);
    tracker = new CommitmentTracker({ stateDir: dir, liveConfig });
    sends = []; injected = [];
    onTopicMessage = vi.fn();
    const telegram = {
      sendToTopic: vi.fn(async (topicId: number, text: string) => { sends.push({ topicId, text }); return { message_id: sends.length }; }),
      getSessionForTopic: (topicId: number) => (topicId === 7 ? 'echo-topic-7' : null),
      onTopicMessage,
      createAttentionItem: vi.fn(async () => undefined),
    };
    const sessionManager = {
      isSessionAlive: (s: string) => s === 'echo-topic-7',
      injectPasteNotificationObserved: vi.fn(async (session: string, text: string) => { injected.push({ session, text }); return { state: 'submitted' }; }),
    };
    const app = express();
    app.use(express.json());
    const ctx: any = {
      commitmentTracker: tracker,
      telegram,
      sessionManager,
      liveConfig,
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
  const promise = (topicId: number, agentResponse: string, minutesAgo: number) => tracker.record({
    type: 'one-time-action', userRequest: 'x', agentResponse, topicId, source: 'agent',
    beaconEnabled: true, softDeadlineAt: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
  } as never);

  it('a pass tells the person once, and hands the promise to the RUNNING session as a system notice (never the inbound pipeline)', async () => {
    const c = promise(7, 'Laptop run time by noon', 30);
    const r1 = await api('/commitments/check-in-reminder/pass', { method: 'POST', body: '{}' });
    expect(r1.status).toBe(200);
    expect(r1.body.late).toMatchObject({ ran: true, topicsSent: 1, rowsNoticed: 1, handoffsAccepted: 1 });
    expect(sends).toHaveLength(1);
    expect(sends[0]).toMatchObject({ topicId: 7 });
    expect(sends[0].text).toContain("isn't marked done");
    expect(injected).toHaveLength(1);
    expect(injected[0].session).toBe('echo-topic-7');
    expect(injected[0].text).toContain(`[promise overdue: ${c.id}`);
    expect(onTopicMessage).not.toHaveBeenCalled(); // no Chief of Staff gate, no "✓ Delivered", no standby
    const r2 = await api('/commitments/check-in-reminder/pass', { method: 'POST', body: '{}' });
    expect(r2.body.late.topicsSent).toBe(0);
    expect(sends).toHaveLength(1);
  });

  it('two late promises in one conversation → one message; a topic with no running session gets the notice but no handoff', async () => {
    promise(9, 'first', 30);
    promise(9, 'second', 20);
    const r = await api('/commitments/check-in-reminder/pass', { method: 'POST', body: '{}' });
    expect(r.body.late).toMatchObject({ topicsSent: 1, rowsNoticed: 2, handoffsAccepted: 0, handoffsNotAccepted: 2 });
    expect(sends).toHaveLength(1);
    expect(sends[0].text).toContain("These were due and aren't marked done");
    expect(injected).toHaveLength(0);
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
