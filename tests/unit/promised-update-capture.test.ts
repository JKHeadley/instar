/**
 * Tier 1 — PromisedUpdateCapture against a REAL CommitmentTracker, plus the
 * reconciler's promised-update branch (docs/specs/promised-update-capture.md).
 *
 * The whole lifecycle of the live miss (topic 137342, 2026-11-07): the message
 * goes out → a dated commitment exists → no message follows → at the time the
 * reminder posts one honest line and hands the promise back to the session.
 * And the other side: a later message closes it, so nothing fires.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CommitmentTracker } from '../../src/monitoring/CommitmentTracker.js';
import { LiveConfig } from '../../src/config/LiveConfig.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import {
  PromisedUpdateCapture,
  chainPromisedUpdateCapture,
  resolvePromisedUpdateCaptureEnabled,
  isPromisedUpdateCommitment,
  PROMISED_UPDATE_GRACE_MS,
  SAME_REPORT_WINDOW_MS,
  type LoggedMessage,
} from '../../src/monitoring/PromisedUpdateCapture.js';
import { CheckInReminderReconciler } from '../../src/monitoring/CheckInReminderReconciler.js';

const TZ = 'America/Los_Angeles';
const PROMISE_AT = Date.parse('2026-11-08T01:01:59.000Z'); // 5:01 PM PST
const TOPIC = 137342;

let stateDir: string;
let tracker: CommitmentTracker;
let now: number;

beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'promised-update-'));
  fs.mkdirSync(path.join(stateDir, 'state'), { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'config.json'), '{}');
  tracker = new CommitmentTracker({ stateDir, liveConfig: new LiveConfig(stateDir) });
  now = PROMISE_AT;
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(PROMISE_AT);
});
afterEach(() => {
  vi.useRealTimers();
  SafeFsExecutor.safeRmSync(stateDir, { recursive: true, force: true, operation: 'tests/unit/promised-update-capture.test.ts' });
});

function capture(enabled = true) {
  return new PromisedUpdateCapture({ tracker, enabled: () => enabled, timeZone: () => TZ, now: () => now, log: () => {} });
}

function msg(over: Partial<LoggedMessage> = {}): LoggedMessage {
  return {
    messageId: 140584,
    topicId: TOPIC,
    text: 'Still splitting the slow step. Next update by about 7 PM.',
    fromUser: false,
    timestamp: new Date(now).toISOString(),
    provenance: 'agent',
    ...over,
  };
}

const openPromises = () => tracker.getActive().filter(isPromisedUpdateCommitment);

describe('recording', () => {
  it('an agent message promising a time records one dated commitment', () => {
    const out = capture().onMessageLogged(msg());
    expect(out.recorded).toBeTruthy();
    const [c] = openPromises();
    expect(c.topicId).toBe(TOPIC);
    expect(c.checkInAt).toBe(new Date(Date.parse('2026-11-08T03:00:00.000Z') + PROMISED_UPDATE_GRACE_MS).toISOString());
    expect(c.agentResponse).toBe('Next update by about 7 PM.');
    expect(c.userRequest).toMatch(/promised for 7:00\s?PM/);
    expect(c.beaconEnabled).toBe(false);
    expect(c.status).toBe('pending');
  });

  it('the same message logged twice makes one commitment (externalKey)', () => {
    const cap = capture();
    cap.onMessageLogged(msg());
    cap.onMessageLogged(msg());
    expect(openPromises()).toHaveLength(1);
  });

  it('user messages, automation and unknown provenance record nothing', () => {
    const cap = capture();
    cap.onMessageLogged(msg({ fromUser: true, provenance: 'user' }));
    cap.onMessageLogged(msg({ provenance: 'automation', messageId: 2 }));
    cap.onMessageLogged(msg({ provenance: undefined, messageId: 3 }));
    expect(openPromises()).toHaveLength(0);
  });

  it('a message with no promised time records nothing', () => {
    capture().onMessageLogged(msg({ text: 'Fixed the slow step; tests pass.' }));
    expect(openPromises()).toHaveLength(0);
  });

  it('records nothing when disabled', () => {
    capture(false).onMessageLogged(msg());
    expect(openPromises()).toHaveLength(0);
  });

  it('a message with no topic records nothing', () => {
    capture().onMessageLogged(msg({ topicId: null }));
    expect(openPromises()).toHaveLength(0);
  });

  it('never throws into the message path, even when the tracker does', () => {
    const broken = new PromisedUpdateCapture({
      tracker: { getActive: () => { throw new Error('store down'); }, record: () => { throw new Error('x'); }, deliver: () => null } as never,
      enabled: () => true, log: () => {},
    });
    expect(() => broken.onMessageLogged(msg())).not.toThrow();
  });
});

describe('closing — a later message is the update', () => {
  it('a later agent message in the same topic closes the promise as delivered', () => {
    const cap = capture();
    cap.onMessageLogged(msg());
    now = PROMISE_AT + 90 * 60_000;
    const out = cap.onMessageLogged(msg({ messageId: 140600, text: 'Update: the freeze is gone.', timestamp: new Date(now).toISOString() }));
    expect(out.closed).toHaveLength(1);
    expect(openPromises()).toHaveLength(0);
    expect(tracker.get(out.closed[0])?.status).toBe('delivered');
  });

  it('a follow-on message seconds later (the same report, split) does not close it', () => {
    const cap = capture();
    cap.onMessageLogged(msg());
    now = PROMISE_AT + 20_000;
    cap.onMessageLogged(msg({ messageId: 140585, text: 'PR link: #123', timestamp: new Date(now).toISOString() }));
    expect(openPromises()).toHaveLength(1);
    expect(SAME_REPORT_WINDOW_MS).toBeGreaterThan(20_000);
  });

  it('a later message that promises a new time closes the old one and records the new one', () => {
    const cap = capture();
    cap.onMessageLogged(msg());
    now = PROMISE_AT + 2 * 3_600_000;
    cap.onMessageLogged(msg({ messageId: 140700, text: 'Freeze found. Next update by 9 PM.', timestamp: new Date(now).toISOString() }));
    const open = openPromises();
    expect(open).toHaveLength(1);
    expect(open[0].agentResponse).toBe('Next update by 9 PM.');
  });

  it('a short promise kept on time closes (the reply is not read as the same report)', () => {
    const cap = capture();
    cap.onMessageLogged(msg({ text: "I'll report back in 3 minutes." }));
    now = PROMISE_AT + 3 * 60_000;
    const out = cap.onMessageLogged(msg({ messageId: 140590, text: 'Done: all green.', timestamp: new Date(now).toISOString() }));
    expect(out.closed).toHaveLength(1);
    expect(openPromises()).toHaveLength(0);
  });

  it('a corrected time sent moments later replaces the first promise', () => {
    const cap = capture();
    cap.onMessageLogged(msg());
    now = PROMISE_AT + 2 * 60_000;
    cap.onMessageLogged(msg({ messageId: 140586, text: 'Correction: next update by 8 PM.', timestamp: new Date(now).toISOString() }));
    const open = openPromises();
    expect(open).toHaveLength(1);
    expect(open[0].agentResponse).toBe('Correction: next update by 8 PM.');
  });

  it('a message in another topic does not close it', () => {
    const cap = capture();
    cap.onMessageLogged(msg());
    now = PROMISE_AT + 3_600_000;
    cap.onMessageLogged(msg({ topicId: 999, messageId: 5, text: 'Other topic.', timestamp: new Date(now).toISOString() }));
    expect(openPromises()).toHaveLength(1);
  });

  it('an automation message (a reminder or notice) does not close it', () => {
    const cap = capture();
    cap.onMessageLogged(msg());
    now = PROMISE_AT + 3_600_000;
    cap.onMessageLogged(msg({ messageId: 6, provenance: 'automation', text: 'Health notice', timestamp: new Date(now).toISOString() }));
    expect(openPromises()).toHaveLength(1);
  });

  it('does not touch other commitments in the topic', () => {
    const other = tracker.record({ type: 'one-time-action', userRequest: 'deploy', agentResponse: 'will deploy', topicId: TOPIC, beaconEnabled: false, followThroughOptOutReason: 'test' });
    const cap = capture();
    cap.onMessageLogged(msg());
    now = PROMISE_AT + 3_600_000;
    cap.onMessageLogged(msg({ messageId: 7, text: 'Done.', timestamp: new Date(now).toISOString() }));
    expect(tracker.get(other.id)?.status).toBe('pending');
  });
});

describe('when nothing follows — the reminder fires and hands the promise back', () => {
  function reconciler(send: any, resume?: any) {
    return new CheckInReminderReconciler(
      { tracker, send, now: () => now, log: () => {}, ...(resume ? { resumePromisedUpdate: resume } : {}) },
      { enabled: true, dryRun: false },
    );
  }

  it('before the time (plus grace): nothing is sent', async () => {
    capture().onMessageLogged(msg());
    now = Date.parse('2026-11-08T03:10:00.000Z'); // 7:10 PM, inside the grace
    const send = vi.fn(async () => undefined);
    const rep = await reconciler(send).runPass();
    expect(send).not.toHaveBeenCalled();
    expect(rep.sent).toBe(0);
  });

  it('after the time: one honest line, then the promise goes back to the session', async () => {
    capture().onMessageLogged(msg());
    now = Date.parse('2026-11-08T03:16:00.000Z'); // 7:16 PM
    const send = vi.fn(async () => undefined);
    const resume = vi.fn(async () => undefined);
    const rep = await reconciler(send, resume).runPass();
    expect(rep.sent).toBe(1);
    expect(send).toHaveBeenCalledTimes(1);
    const [topicId, text] = send.mock.calls[0] as unknown as [number, string];
    expect(topicId).toBe(TOPIC);
    expect(text).toMatch(/I said you'd have my next update by 7:00\s?PM, and I haven't sent it\./);
    expect(text).toContain("I'm picking it back up now");
    expect(text).toContain('Next update by about 7 PM.');
    expect(resume).toHaveBeenCalledTimes(1);
    expect((resume.mock.calls[0] as unknown as [{ topicId: number }])[0].topicId).toBe(TOPIC);
    // Exactly once: a second pass sends nothing more.
    await reconciler(send, resume).runPass();
    expect(send).toHaveBeenCalledTimes(1);
    expect(resume).toHaveBeenCalledTimes(1);
  });

  it('without a resume path the line never claims a pickup', async () => {
    capture().onMessageLogged(msg());
    now = Date.parse('2026-11-08T03:16:00.000Z');
    const send = vi.fn(async () => undefined);
    await reconciler(send).runPass();
    expect((send.mock.calls[0] as unknown as [number, string])[1]).not.toContain('picking it back up');
  });

  it('a failed handoff is reported but the reminder stays sent (no second reminder)', async () => {
    capture().onMessageLogged(msg());
    now = Date.parse('2026-11-08T03:16:00.000Z');
    const send = vi.fn(async () => undefined);
    const resume = vi.fn(async () => { throw new Error('no session path'); });
    const rep = await reconciler(send, resume).runPass();
    expect(rep.sent).toBe(1);
    expect(rep.errors.some((e) => e.error.startsWith('resume-handoff-failed'))).toBe(true);
    await reconciler(send, resume).runPass();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('a send that could not be stamped does not hand off (so a re-send cannot hand off twice)', async () => {
    capture().onMessageLogged(msg());
    now = Date.parse('2026-11-08T03:16:00.000Z');
    const send = vi.fn(async () => undefined);
    const resume = vi.fn(async () => undefined);
    const realMutate = tracker.mutate.bind(tracker);
    let calls = 0;
    const flaky = {
      getAll: () => tracker.getAll(),
      mutate: async (id: string, fn: any) => { calls++; if (calls === 2) throw new Error('disk full'); return realMutate(id, fn); },
    };
    const r = new CheckInReminderReconciler({ tracker: flaky as any, send, now: () => now, log: () => {}, resumePromisedUpdate: resume }, { enabled: true, dryRun: false });
    const rep = await r.runPass();
    expect(rep.errors.some((e) => e.error.startsWith('sent-but-unstamped'))).toBe(true);
    expect(resume).not.toHaveBeenCalled();
    // The next pass re-sends (deduped downstream), stamps, and only then hands off — once.
    await r.runPass();
    expect(resume).toHaveBeenCalledTimes(1);
  });

  it('an update sent in time means the reminder never fires', async () => {
    const cap = capture();
    cap.onMessageLogged(msg());
    now = Date.parse('2026-11-08T02:55:00.000Z');
    cap.onMessageLogged(msg({ messageId: 140590, text: 'Here is the 7 PM update.', timestamp: new Date(now).toISOString() }));
    now = Date.parse('2026-11-08T04:00:00.000Z');
    const send = vi.fn(async () => undefined);
    await reconciler(send).runPass();
    expect(send).not.toHaveBeenCalled();
  });

  it('a non-promised-update dated commitment keeps the original reminder text and no handoff', async () => {
    tracker.record({ type: 'one-time-action', userRequest: 'check in on the release', agentResponse: 'will check Friday', topicId: TOPIC, checkInAt: '2026-11-08T02:00:00.000Z', beaconEnabled: false, followThroughOptOutReason: 'test' });
    now = Date.parse('2026-11-08T04:00:00.000Z');
    const send = vi.fn(async () => undefined);
    const resume = vi.fn(async () => undefined);
    await reconciler(send, resume).runPass();
    expect((send.mock.calls[0] as unknown as [number, string])[1]).toContain('Check-in I promised you');
    expect(resume).not.toHaveBeenCalled();
  });
});

describe('wiring helpers', () => {
  it('chainPromisedUpdateCapture keeps the earlier observer and adds the capture', () => {
    const seen: number[] = [];
    const adapter: { onMessageLogged: ((e: LoggedMessage) => void) | null } = { onMessageLogged: (e) => seen.push(e.messageId) };
    expect(chainPromisedUpdateCapture(adapter, capture())).toBe(true);
    adapter.onMessageLogged!(msg());
    expect(seen).toEqual([140584]);
    expect(openPromises()).toHaveLength(1);
  });

  it('chainPromisedUpdateCapture is a no-op without an adapter', () => {
    expect(chainPromisedUpdateCapture(null, capture())).toBe(false);
  });

  it('the gate follows the check-in reminder, and its own flag overrides', () => {
    expect(resolvePromisedUpdateCaptureEnabled(undefined, { developmentAgent: true })).toBe(true);
    expect(resolvePromisedUpdateCaptureEnabled(undefined, {})).toBe(false);
    expect(resolvePromisedUpdateCaptureEnabled({ checkInReminder: { enabled: true } }, {})).toBe(true);
    expect(resolvePromisedUpdateCaptureEnabled({ checkInReminder: { enabled: false } }, { developmentAgent: true })).toBe(false);
    expect(resolvePromisedUpdateCaptureEnabled({ checkInReminder: { enabled: true }, promisedUpdateCapture: { enabled: false } }, {})).toBe(false);
    expect(resolvePromisedUpdateCaptureEnabled({ promisedUpdateCapture: { enabled: true } }, {})).toBe(true);
  });
});
