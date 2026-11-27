// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.
/**
 * The person's choices on a health problem (docs/specs/health-quick-actions.md): what each id is offered, that a
 * choice binds to one exact id, what a read says with something hidden, stopping and coming back, undo, machines
 * agreeing, and what the reporter and /health really do with an Ignore.
 */
import { describe, it, expect, afterAll, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HealthChoiceStore, MAX_CHOICES, offerFor, validateRow, isProtectedIssue, healthChoiceStoreFor } from '../../src/monitoring/healthChoices.js';
import { summarizeHealth } from '../../src/monitoring/healthIssues.js';
import { DegradationReporter } from '../../src/monitoring/DegradationReporter.js';
import { summarizeFeatureReliability, withoutComponents } from '../../src/monitoring/FeatureMetricsLedger.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/unit/health-choices.test.ts' }); });
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'health-choices-')); dirs.push(d); return d; };
const HOUR = 3_600_000;
const T0 = Date.parse('2026-11-05T12:00:00.000Z');

function store(dir = tmp()) {
  let t = T0;
  const s = new HealthChoiceStore({ stateDir: dir, origin: 'm1', now: () => t });
  return { s, dir, set: (n: number) => { t = n; }, at: () => t };
}
const ev = (feature: string, at = '2026-11-05T11:59:00.000Z') => ({ feature, timestamp: at, narrative: 'words' });
const degraded = { status: 'degraded', uptimeHuman: '2h' };

describe('what each item is offered', () => {
  it('a reported problem gets all three, and Ignore says what it does', () => {
    const o = offerFor(['Slack']);
    expect(o.choices).toEqual(['snooze', 'hide', 'ignore']);
    expect(o.ignoreSays).toMatch(/stop recording/);
    expect(o.ignoreSays).toMatch(/won’t have any record/);
    expect(o.choiceNote).toBeNull();
  });
  it('an unsorted problem says it might matter before Ignore', () => {
    expect(offerFor(['Brand.new'], true).ignoreSays).toMatch(/haven’t worked out/);
    expect(offerFor(['Slack'], false).ignoreSays).not.toMatch(/haven’t worked out/);
  });
  it('an LLM component gets Ignore, worded for what it can do', () => {
    const o = offerFor(['health:llm:PeerUserMeantJudge']);
    expect(o.choices).toContain('ignore');
    expect(o.ignoreSays).toMatch(/stop counting/);
  });
  it('a live reading can be hidden but not ignored, and says why', () => {
    for (const id of ['health:sessions-full', 'health:job-failures', 'health:claude-key', 'health:whatsapp', 'health:system-review', 'health:llm-unavailable']) {
      const o = offerFor([id]);
      expect(o.choices, id).toEqual(['snooze', 'hide']);
      expect(o.ignoreSays).toBeNull();
      expect(o.choiceNote).toMatch(/live reading/);
    }
  });
  it('security and data-loss items only get Hide for a while, and say so', () => {
    for (const id of ['SecretStore.writeMacOSKeychain', 'Threadline.identity', 'SessionMigrator.saveMigrationState', 'SharedStateLedger', 'something-corrupted-new', 'NewThing.credentialRead']) {
      expect(isProtectedIssue(id), id).toBe(true);
      const o = offerFor([id]);
      expect(o.choices, id).toEqual(['snooze']);
      expect(o.choiceNote).toMatch(/security or your data/);
    }
    expect(isProtectedIssue('Slack')).toBe(false);
    // The same rules behind an LLM reading, plus the components that decide what may happen.
    for (const id of ['health:llm:ExternalOperationGate', 'health:llm:MessageSentinel', 'health:llm:InputGuard', 'health:llm:CoherenceReviewer', 'health:llm:SecretStore.dualKeyRead', 'relay-script-modified-locally']) {
      expect(offerFor([id]).choices, id).toEqual(['snooze']);
    }
    expect(offerFor(['health:llm:PeerUserMeantJudge']).choices).toContain('ignore');
    expect(isProtectedIssue('token-burn-detection')).toBe(false);
  });
  it('the catch-alls get nothing: hiding one could hide a different problem', () => {
    for (const id of ['health:unnamed', 'health:unnamed-event']) expect(offerFor([id]).choices).toEqual([]);
    expect(offerFor(['health:unnamed']).choiceNote).toMatch(/different problem/);
  });
  it('an id no saved row could hold gets no choices, so it can’t hide now and vanish later', () => {
    expect(offerFor(['x'.repeat(201)]).choices).toEqual([]);
    expect(offerFor(['bad\nid']).choices).toEqual([]);
    expect(offerFor(['x'.repeat(200)]).choices).toContain('hide');
  });
  it('a row of several ids gets what all of them allow', () => {
    expect(offerFor(['Slack', 'SecretStore.dualKeyRead']).choices).toEqual(['snooze']);
    expect(offerFor(['Slack', 'health:llm:x']).ignoreSays).toMatch(/stop recording/);
  });
});

describe('a read with something hidden', () => {
  it('a hidden problem leaves the counts and the verdict, and is never called healthy', () => {
    const { s } = store();
    s.choose(['iMessage'], { mode: 'hide', title: 'iMessage isn’t connected', by: 'phone' });
    const r = summarizeHealth(degraded, [ev('iMessage')], {}, s);
    expect(r.counts.userAffecting).toBe(0);
    expect(r.issues).toEqual([]);
    expect(r.verdict).toBe('running');
    expect(r.headline).toBe('Running, with one thing you’ve hidden.');
    expect(r.hidden[0]).toMatchObject({ key: 'iMessage', mode: 'hide', happening: true, by: 'phone' });
    expect(r.hidden[0].line).toMatch(/still keeping track/);
  });
  it('hiding one problem leaves a different one showing', () => {
    const { s } = store();
    s.choose(['iMessage'], { mode: 'hide', title: 't', by: 'phone' });
    const r = summarizeHealth(degraded, [ev('iMessage'), ev('Slack')], {}, s);
    expect(r.issues.map((i) => i.id)).toEqual(['Slack']);
    expect(r.verdict).toBe('attention');
  });
  it('hiding one member of a family leaves a new member showing', () => {
    const { s } = store();
    const before = summarizeHealth(degraded, [ev('unjustifiedStopGate.db')]);
    expect(before.issues[0].id).toBe('unjustifiedStopGate.*');
    s.choose(before.issues[0].keys, { mode: 'hide', title: before.issues[0].title, by: 'phone' });
    expect(summarizeHealth(degraded, [ev('unjustifiedStopGate.db')], {}, s).issues).toEqual([]);
    const later = summarizeHealth(degraded, [ev('unjustifiedStopGate.db'), ev('unjustifiedStopGate.route')], {}, s);
    expect(later.issues[0].keys).toEqual(['unjustifiedStopGate.route']);
  });
  it('an ignored problem is never healthy either, because nobody knows', () => {
    const { s } = store();
    s.choose(['Slack'], { mode: 'ignore', title: 'Slack', by: 'phone' });
    const r = summarizeHealth({ status: 'ok' }, [], {}, s);
    expect(r.verdict).toBe('running');
    expect(r.hidden[0].happening).toBeNull();
    expect(r.hidden[0].line).toMatch(/can’t say/);
  });
  it('a hidden problem that has stopped lets the agent read healthy again', () => {
    const { s, set } = store();
    s.choose(['Slack'], { mode: 'hide', title: 'Slack', by: 'phone' });
    // Absent for a moment isn't stopped: right after a restart a real problem hasn't re-reported yet.
    const soon = summarizeHealth({ status: 'ok' }, [], {}, s);
    expect(soon.verdict).toBe('running');
    expect(soon.hidden[0].happening).toBe(true);
    set(T0 + 31 * 60_000);
    const r = summarizeHealth({ status: 'ok' }, [], {}, s);
    expect(r.verdict).toBe('healthy');
    expect(r.hidden[0].happening).toBe(false);
  });
  it('/health says degraded for a hidden reason: no invented "can’t name" row', () => {
    const { s } = store();
    s.choose(['health:sessions-full'], { mode: 'hide', title: 'x', by: 'phone' });
    const r = summarizeHealth({ status: 'degraded', sessions: { current: 2, max: 2 } }, [], {}, s);
    expect(r.issues).toEqual([]);
  });
  it('a real unnamed problem still shows, with nothing to hide it by', () => {
    const r = summarizeHealth({ status: 'degraded' }, [], {}, store().s);
    expect(r.issues[0]).toMatchObject({ id: 'health:unnamed', choices: [] });
    // A note on a running agent, never healthy and never "can't tell".
    expect(r.verdict).toBe('running');
  });
  it('iMessage down with no event in the window can still be hidden, and is never healthy', () => {
    const { s } = store();
    s.choose(['iMessage'], { mode: 'hide', title: 'iMessage isn’t connected', by: 'phone' });
    const r = summarizeHealth({ status: 'ok' }, [], { iMessage: 'down' }, s);
    expect(r.issues).toEqual([]);
    expect(r.verdict).toBe('running');
    expect(r.hidden[0].happening).toBe(true);
  });
  it('a read without choices is what it always was, and rows carry their offer', () => {
    const r = summarizeHealth(degraded, [ev('Slack')]);
    expect(r.hidden).toEqual([]);
    expect(r.issues[0]).toMatchObject({ keys: ['Slack'], choices: ['snooze', 'hide', 'ignore'], returnNote: null });
  });
});

describe('a snooze', () => {
  it('ends on time and the problem says it was hidden', () => {
    const { s, set } = store();
    s.choose(['Slack'], { mode: 'snooze', hours: 1, title: 'Slack', by: 'phone' });
    expect(s.hidesNow('Slack')).toBe(true);
    expect(summarizeHealth(degraded, [ev('Slack')], {}, s).issues).toEqual([]);
    set(T0 + HOUR - 1);
    expect(s.hidesNow('Slack')).toBe(true);
    set(T0 + HOUR);
    expect(s.hidesNow('Slack')).toBe(false);
    const r = summarizeHealth(degraded, [ev('Slack', new Date(T0 + HOUR - 60_000).toISOString())], {}, s);
    expect(r.issues[0].returnNote).toBe('You hid this for a while, and it’s still happening.');
    expect(r.hidden).toEqual([]);
    expect(r.verdict).toBe('attention');
  });
  it('that stopped and came back stays hidden until the end, says so while hidden, and says so when it returns', () => {
    const { s, set } = store();
    s.choose(['Slack'], { mode: 'snooze', hours: 24, title: 'Slack', by: 'phone' });
    set(T0 + HOUR);
    expect(summarizeHealth({ status: 'ok' }, [], {}, s).hidden[0].line).toMatch(/stopped for now/);
    set(T0 + 2 * HOUR);
    const during = summarizeHealth(degraded, [ev('Slack', new Date(T0 + 2 * HOUR - 1000).toISOString())], {}, s);
    expect(during.issues).toEqual([]);
    expect(during.hidden[0].line).toMatch(/It stopped, and then it came back/);
    set(T0 + 25 * HOUR);
    const after = summarizeHealth(degraded, [ev('Slack', new Date(T0 + 25 * HOUR - 1000).toISOString())], {}, s);
    expect(after.issues[0].returnNote).toBe('You hid this earlier. It stopped, and then it came back.');
  });
  it('a short absence is not a stop: a restart empties the events and the problem re-reports', () => {
    const { s, set } = store();
    s.choose(['Slack'], { mode: 'snooze', hours: 24, title: 'Slack', by: 'phone' });
    set(T0 + 10 * 60_000);
    summarizeHealth({ status: 'ok' }, [], {}, s);
    set(T0 + 15 * 60_000);
    const r = summarizeHealth(degraded, [ev('Slack', new Date(T0 + 14 * 60_000).toISOString())], {}, s);
    expect(r.hidden[0].line).not.toMatch(/came back/);
  });
  it('that stopped and stayed stopped says nothing and is forgotten after a week', () => {
    const { s, set } = store();
    s.choose(['Slack'], { mode: 'snooze', hours: 1, title: 'Slack', by: 'phone' });
    set(T0 + 2 * HOUR);
    expect(summarizeHealth({ status: 'ok' }, [], {}, s)).toMatchObject({ verdict: 'healthy', issues: [], hidden: [] });
    set(T0 + 2 * HOUR + 8 * 24 * HOUR);
    summarizeHealth({ status: 'ok' }, [], {}, s);
    expect(s.rows()).toEqual([]);
  });
});

describe('saving', () => {
  it('survives a restart, including what it saw', () => {
    const { s, dir } = store();
    s.choose(['Slack'], { mode: 'ignore', title: 'Slack', by: 'phone' });
    s.choose(['iMessage'], { mode: 'hide', title: 'iMessage', by: 'dashboard-or-agent' });
    const again = new HealthChoiceStore({ stateDir: dir, now: () => T0 });
    expect(again.isIgnored('Slack')).toBe(true);
    expect(again.hidesNow('iMessage')).toBe(true);
    expect(again.rows().find((r) => r.key === 'iMessage')?.by).toBe('dashboard-or-agent');
  });
  it('an unreadable file hides nothing, says so, and keeps the bad copy', () => {
    const dir = tmp();
    fs.mkdirSync(path.join(dir, 'state'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'state', 'health-choices.json'), '{ not json');
    const errors: string[] = [];
    const s = new HealthChoiceStore({ stateDir: dir, onError: (d) => errors.push(d) });
    expect(s.failedToRead).toBe(true);
    expect(s.hidesNow('Slack')).toBe(false);
    expect(errors).toEqual(['parse']);
    expect(fs.readdirSync(path.join(dir, 'state')).some((f) => f.includes('.unreadable-'))).toBe(true);
  });
  it('a choice that can’t be saved changes nothing and throws', () => {
    const { s, dir } = store();
    fs.mkdirSync(path.join(dir, 'state'), { recursive: true });
    const blocker = path.join(dir, 'state', `health-choices.json.${process.pid}.tmp`);
    fs.mkdirSync(blocker);
    expect(() => s.choose(['Slack'], { mode: 'hide', title: 't', by: 'phone' })).toThrow();
    expect(s.hidesNow('Slack')).toBe(false);
    SafeFsExecutor.safeRmSync(blocker, { recursive: true, force: true, operation: 'tests/unit/health-choices.test.ts' });
  });
  it('a file that can’t be read just now is never overwritten', () => {
    const { s, dir } = store();
    s.choose(['Slack'], { mode: 'ignore', title: 'Slack', by: 'phone' });
    const file = path.join(dir, 'state', 'health-choices.json');
    const saved = fs.readFileSync(file, 'utf8');
    fs.chmodSync(file, 0o000);
    try {
      const blocked = new HealthChoiceStore({ stateDir: dir, now: () => T0 });
      expect(blocked.failedToRead).toBe(true);
      expect(() => blocked.choose(['iMessage'], { mode: 'hide', title: 't', by: 'phone' })).toThrow();
      expect(blocked.merge([{ key: 'iMessage', mode: 'hide', at: new Date(T0).toISOString(), title: 't' }])).toBe(0);
      fs.chmodSync(file, 0o600);
      expect(fs.readFileSync(file, 'utf8')).toBe(saved);
      blocked.choose(['iMessage'], { mode: 'hide', title: 't', by: 'phone' });
      expect(blocked.isIgnored('Slack')).toBe(true);
      expect(blocked.hidesNow('iMessage')).toBe(true);
    } finally {
      fs.chmodSync(file, 0o600);
    }
  });
  it('writes who did what to its own log', () => {
    const { s, dir } = store();
    s.choose(['Slack'], { mode: 'ignore', title: 't', by: 'dashboard-or-agent' });
    s.undo('Slack', 'phone');
    const lines = fs.readFileSync(path.join(dir, 'logs', 'health-choices.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(lines.map((l) => [l.event, l.by])).toEqual([['choose', 'dashboard-or-agent'], ['undo', 'phone']]);
  });
  it('refuses past the cap rather than growing', () => {
    const { s } = store();
    for (let i = 0; i < MAX_CHOICES; i++) s.choose([`f${i}`], { mode: 'hide', title: 't', by: 'phone' });
    expect(() => s.choose(['one-more'], { mode: 'hide', title: 't', by: 'phone' })).toThrow();
    expect(s.hidesNow('one-more')).toBe(false);
  });
  it('one store per state directory, so the reporter and the routes agree', () => {
    const dir = tmp();
    expect(healthChoiceStoreFor(dir)).toBe(healthChoiceStoreFor(dir));
  });
});

describe('undo', () => {
  it('brings each kind back, and a problem still happening shows at once', () => {
    const { s } = store();
    for (const mode of ['snooze', 'hide', 'ignore'] as const) {
      s.choose(['Slack'], { mode, hours: mode === 'snooze' ? 1 : undefined, title: 'Slack', by: 'phone' });
      expect(s.hidesNow('Slack')).toBe(true);
      s.undo('Slack', 'phone');
      expect(s.hidesNow('Slack')).toBe(false);
      expect(s.isIgnored('Slack')).toBe(false);
      expect(summarizeHealth(degraded, [ev('Slack')], {}, s).issues[0].id).toBe('Slack');
    }
  });
  it('an undo at or past the end of a snooze still lands and still travels', () => {
    const a = store(); const b = store();
    a.s.choose(['Slack'], { mode: 'snooze', hours: 1, title: 'Slack', by: 'phone' });
    b.s.merge(a.s.rows());
    a.set(T0 + 2 * 3_600_000);
    a.s.undo('Slack', 'phone');
    expect(b.s.merge(a.s.rows())).toBe(1);
    expect(a.s.rows()[0]).toMatchObject({ removed: true, until: null });
    expect(new HealthChoiceStore({ stateDir: a.dir, now: () => T0 + 2 * 3_600_000 }).rows()[0].removed).toBe(true);
  });
  it('undoing what isn’t hidden says so', () => {
    expect(store().s.undo('Slack', 'phone')).toBeNull();
  });
});

describe('between machines', () => {
  it('a choice on one reaches another, an undo follows it, and a stale copy can’t revive it', () => {
    const a = store();
    const b = store();
    const [row] = a.s.choose(['Slack'], { mode: 'ignore', title: 'Slack', by: 'phone' });
    expect(b.s.merge(a.s.rows())).toBe(1);
    expect(b.s.isIgnored('Slack')).toBe(true);
    a.set(T0 + 1000);
    a.s.undo('Slack', 'phone');
    expect(b.s.merge(a.s.rows())).toBe(1);
    expect(b.s.isIgnored('Slack')).toBe(false);
    expect(b.s.merge([row])).toBe(0);
    expect(b.s.isIgnored('Slack')).toBe(false);
  });
  it('the same answer whichever order they hear it in', () => {
    const a = store(); const b = store();
    a.s.choose(['Slack'], { mode: 'hide', title: 'Slack', by: 'phone' });
    b.set(T0 + 5000);
    b.s.choose(['Slack'], { mode: 'snooze', hours: 1, title: 'Slack', by: 'phone' });
    const ra = a.s.rows(); const rb = b.s.rows();
    a.s.merge(rb); b.s.merge(ra);
    expect(a.s.rows()[0].mode).toBe('snooze');
    expect(b.s.rows()[0].mode).toBe('snooze');
  });
  it('a machine with a clock behind still beats its own earlier choice', () => {
    const a = store();
    a.s.choose(['Slack'], { mode: 'hide', title: 'Slack', by: 'phone' });
    a.set(T0 - HOUR);
    a.s.undo('Slack', 'phone');
    expect(a.s.hidesNow('Slack')).toBe(false);
    expect(Date.parse(a.s.rows()[0].at)).toBeGreaterThan(T0);
  });
  it('an undo stays for a machine offline a long time, so it can’t bring the choice back', () => {
    const a = store(); const b = store();
    const [row] = a.s.choose(['Slack'], { mode: 'ignore', title: 'Slack', by: 'phone' });
    a.set(T0 + 1000);
    a.s.undo('Slack', 'phone');
    a.set(T0 + 400 * 24 * 3_600_000);
    summarizeHealth({ status: 'ok' }, [], {}, a.s);
    expect(a.s.merge([row])).toBe(0);
    expect(a.s.isIgnored('Slack')).toBe(false);
    expect(b.s.rows()).toEqual([]);
  });
  it('a row from a peer never claims to be from the phone', () => {
    const a = store(); const b = store();
    a.s.choose(['Slack'], { mode: 'hide', title: 'Slack', by: 'phone' });
    b.s.merge(a.s.rows());
    expect(summarizeHealth(degraded, [ev('Slack')], {}, b.s).hidden[0].by).toBe('another-machine');
  });
  it('what a machine saw never crosses', () => {
    const a = store();
    a.s.choose(['Slack'], { mode: 'hide', title: 'Slack', by: 'phone' });
    expect(Object.keys(a.s.rows()[0]).sort()).toEqual(['at', 'by', 'key', 'mode', 'origin', 'removed', 'title', 'until']);
  });
  it('refuses what no surface could have offered, whichever machine sent it', () => {
    const good = { key: 'Slack', mode: 'hide', until: null, at: new Date(T0).toISOString(), title: 't', by: 'phone', origin: 'x', removed: false };
    expect(validateRow(good, T0)).not.toBeNull();
    for (const bad of [
      { ...good, key: 'SecretStore.dualKeyRead', mode: 'ignore' },
      { ...good, key: 'health:sessions-full', mode: 'ignore' },
      { ...good, key: 'health:unnamed' },
      { ...good, mode: 'snooze', until: new Date(T0 + 900 * HOUR).toISOString() },
      { ...good, mode: 'snooze', until: null },
      { ...good, mode: 'nope' },
      { ...good, at: new Date(T0 + 48 * HOUR).toISOString() },
      { ...good, key: 'a\nb' },
      'nothing',
    ]) expect(validateRow(bad, T0), JSON.stringify(bad)).toBeNull();
  });
  it('a peer’s words are scrubbed and capped', () => {
    const row = validateRow({ key: 'Slack', mode: 'hide', at: new Date(T0).toISOString(), title: `x${'y'.repeat(900)}` }, T0);
    expect(row!.title.length).toBeLessThanOrEqual(200);
  });
});

describe('what the reporter does', () => {
  const event = { feature: 'Slack', primary: 'p', fallback: 'f', reason: 'r', impact: 'i' };
  let dir: string;
  let s: HealthChoiceStore;
  let reporter: DegradationReporter;
  beforeEach(() => {
    DegradationReporter.resetForTesting();
    dir = tmp();
    s = new HealthChoiceStore({ stateDir: dir });
    reporter = DegradationReporter.getInstance();
    reporter.configure({ stateDir: dir, agentName: 'a', instarVersion: '0' });
    reporter.setIssuePolicy(s);
  });

  it('Ignore: nothing recorded, nothing filed, nothing alerted, and /health stops counting it', async () => {
    const feedback = vi.fn(async () => undefined);
    const telegram = vi.fn(async () => undefined);
    reporter.connectDownstream({ feedbackSubmitter: feedback as never, telegramSender: telegram as never, alertTopicId: 1, notifyUser: true } as never);
    reporter.report(event);
    await vi.waitFor(() => expect(feedback).toHaveBeenCalledTimes(1));
    feedback.mockClear();
    const before = reporter.getEvents().length;
    s.choose(['Slack'], { mode: 'ignore', title: 't', by: 'phone' });
    expect(reporter.getRecentEvents()).toEqual([]);
    expect(reporter.getUnreportedEvents()).toEqual([]);
    expect(reporter.hasDegradations()).toBe(false);
    reporter.report(event);
    await new Promise((r) => setTimeout(r, 20));
    expect(feedback).not.toHaveBeenCalled();
    expect(before).toBe(1);
    expect(fs.readFileSync(path.join(dir, 'degradations.json'), 'utf8').match(/"feature"/g)?.length).toBe(1);
  });
  it('Ignore never touches a different feature', () => {
    s.choose(['Slack'], { mode: 'ignore', title: 't', by: 'phone' });
    reporter.report({ ...event, feature: 'SlackAdapter.something' });
    expect(reporter.getRecentEvents().map((e) => e.feature)).toEqual(['SlackAdapter.something']);
  });
  it('undoing an Ignore brings a still-recent event back', () => {
    reporter.report(event);
    s.choose(['Slack'], { mode: 'ignore', title: 't', by: 'phone' });
    expect(reporter.getRecentEvents()).toEqual([]);
    s.undo('Slack', 'phone');
    expect(reporter.getRecentEvents().length).toBe(1);
  });
  it('Hide: still recorded and filed, but no alert and the digest won’t raise it', async () => {
    const feedback = vi.fn(async () => undefined);
    const telegram = vi.fn(async () => undefined);
    reporter.connectDownstream({ feedbackSubmitter: feedback as never, telegramSender: telegram as never, alertTopicId: 1, notifyUser: true } as never);
    s.choose(['Slack'], { mode: 'hide', title: 't', by: 'phone' });
    reporter.report(event);
    await vi.waitFor(() => expect(feedback).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 20));
    expect(telegram).not.toHaveBeenCalled();
    expect(reporter.getRecentEvents().length).toBe(1);
    expect(reporter.getUnreportedEvents()).toEqual([]);
  });
  it('Hide still lets the self-healer try, and a snooze ending lets the digest raise it', async () => {
    const telegram = vi.fn(async () => undefined);
    const healer = vi.fn(async () => false);
    reporter.connectDownstream({ telegramSender: telegram as never, alertTopicId: 1, notifyUser: true } as never);
    reporter.registerHealer('Slack', healer as never);
    s.choose(['Slack'], { mode: 'snooze', hours: 1, title: 't', by: 'phone' });
    reporter.report(event);
    await vi.waitFor(() => expect(healer).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 20));
    expect(telegram).not.toHaveBeenCalled();
    expect(reporter.getUnreportedEvents()).toEqual([]);
    s.undo('Slack', 'phone');
    expect(reporter.getUnreportedEvents().length).toBe(1);
  });
  it('a policy that throws leaves the problem in view', () => {
    reporter.setIssuePolicy({ isIgnored: () => { throw new Error('x'); }, hidesNow: () => { throw new Error('x'); } });
    reporter.report(event);
    expect(reporter.getRecentEvents().length).toBe(1);
  });
  it('configure installs the choices before any feature can report', () => {
    DegradationReporter.resetForTesting();
    const d = tmp();
    healthChoiceStoreFor(d).choose(['Slack'], { mode: 'ignore', title: 't', by: 'phone' });
    const fresh = DegradationReporter.getInstance();
    fresh.configure({ stateDir: d, agentName: 'a', instarVersion: '0' });
    fresh.report(event);
    expect(fresh.getEvents()).toEqual([]);
  });
});

describe('an LLM component', () => {
  const row = (feature: string, llmErrors: number) => ({ feature, realLlmCalls: 100, llmErrors, errorRate: llmErrors / 100 });
  it('stops counting when ignored, and the status follows what’s left', () => {
    const all = summarizeFeatureReliability([row('a', 60), row('b', 30)]);
    expect(all.status).toBe('failing');
    expect(withoutComponents(all, (f) => f === 'a').status).toBe('degraded');
    expect(withoutComponents(all, () => true)).toMatchObject({ status: 'ok', components: [] });
    expect(withoutComponents(all, () => false)).toBe(all);
  });
});
