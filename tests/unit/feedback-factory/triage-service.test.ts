import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createHarness, decisionRow, setReports, T0, type Harness } from '../../fixtures/feedbackTriageHarness.js';
import { SELF_HEAL_LADDER_MS } from '../../../src/feedback-factory/triage/FeedbackTriageService.js';

const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;
let h: Harness;
afterEach(() => h?.cleanup());

const dispositionFor = (map: Record<string, Record<string, unknown>>) => (packets: Array<{ clusterId: string }>) =>
  packets.map((p) => decisionRow(p.clusterId, map[p.clusterId] ?? {}));

describe('triage authority gate', () => {
  it('does nothing until the operator approves the triage authority', async () => {
    h = await createHarness({ approve: false });
    await h.addItem('a');
    const result = await h.service.tick();
    expect(result.reason).toBe('authority-awaiting-approval');
    expect(h.calls).toHaveLength(0);
    expect(h.service.summary().authority).toBe('awaiting-approval');
  });
});

describe('disposition → Initiative mapping', () => {
  it('work: Initiative stays active and class-review is done; it enters the ranked queue', async () => {
    h = await createHarness();
    const id = await h.addItem('a', { reports: 3 });
    const result = await h.service.tick();
    expect(result).toMatchObject({ result: 'succeeded', decided: 1 });
    const initiative = h.tracker.get(id)!;
    expect(initiative.status).toBe('active');
    expect(initiative.phases.find((p) => p.id === 'class-review')!.status).toBe('done');
    expect(initiative.phases.find((p) => p.id === 'spec')!.status).toBe('pending');
    expect(h.service.queue()).toMatchObject([{ initiativeId: id, executionState: 'queued', severity: 'medium' }]);
    expect(h.store.get(id)).toMatchObject({ state: 'work', ruleDefault: 'work', boundReportCount: 3 });
  });

  it('hold → paused with a 14-day review; ignore (shadowed) → paused hold ignore-shadow', async () => {
    h = await createHarness();
    const held = await h.addItem('h');
    const ignored = await h.addItem('i');
    h.decide.fn = dispositionFor({ h: { disposition: 'hold', reason: 'needs-evidence' }, i: { disposition: 'ignore', reason: 'low-value', severity: 'low' } });
    await h.service.tick();
    expect(h.tracker.get(held)!.status).toBe('paused');
    expect(h.store.get(held)).toMatchObject({ state: 'hold', reason: 'needs-evidence', nextReviewAt: T0 + 14 * DAY });
    expect(h.tracker.get(ignored)!.status).toBe('paused');
    expect(h.store.get(ignored)).toMatchObject({ state: 'hold', reason: 'ignore-shadow', wouldIgnoreReason: 'low-value' });
  });

  it('ignore once live (PIN record) → ignored with no timer, Initiative paused (never archived/abandoned)', async () => {
    h = await createHarness();
    h.service.setIgnoreLive(true, 'dashboard-pin:test');
    const id = await h.addItem('i');
    h.decide.fn = dispositionFor({ i: { disposition: 'ignore', reason: 'out-of-scope', severity: 'low' } });
    await h.service.tick();
    expect(h.store.get(id)).toMatchObject({ state: 'ignored', reason: 'out-of-scope', nextReviewAt: null });
    expect(h.tracker.get(id)!.status).toBe('paused');
  });

  it('an explicit config ignoreLive:false is a kill switch over the PIN record', async () => {
    h = await createHarness({ config: { ignoreLive: false } });
    h.service.setIgnoreLive(true, 'dashboard-pin:test');
    expect(h.service.ignoreLive()).toBe(false);
  });

  it('a low-confidence answer is held needs-evidence', async () => {
    h = await createHarness();
    const id = await h.addItem('a');
    h.decide.fn = dispositionFor({ a: { confidence: 0.5 } });
    await h.service.tick();
    expect(h.store.get(id)).toMatchObject({ state: 'hold', reason: 'needs-evidence' });
  });
});

describe('never-ignore second opinion (floor 3)', () => {
  it('a critical ignore with the other family agreeing is applied as ignore (shadowed while not live)', async () => {
    h = await createHarness();
    const id = await h.addItem('c', { reports: 2 });
    h.decide.fn = dispositionFor({ c: { disposition: 'ignore', reason: 'not-a-defect', severity: 'critical' } });
    await h.service.tick();
    expect(h.secondCalls).toBe(1);
    expect(h.store.get(id)).toMatchObject({ state: 'hold', reason: 'ignore-shadow' });
    expect(h.store.get(id)!.floors).toContain('f3-second-opinion-agrees');
  });
  it('disagreement → hold needs-review', async () => {
    h = await createHarness();
    h.second.verdict = false;
    const id = await h.addItem('c', { reports: 2 });
    h.decide.fn = dispositionFor({ c: { disposition: 'ignore', reason: 'not-a-defect', severity: 'high' } });
    await h.service.tick();
    expect(h.store.get(id)).toMatchObject({ state: 'hold', reason: 'needs-review' });
  });
  it('a second opinion from the SAME family as the triage authority does not count', async () => {
    h = await createHarness();
    h.second.framework = 'codex-cli';
    const id = await h.addItem('c', { reports: 2, description: 'possible data loss on restart' });
    h.decide.fn = dispositionFor({ c: { disposition: 'ignore', reason: 'low-value', severity: 'low' } });
    await h.service.tick();
    expect(h.store.get(id)).toMatchObject({ state: 'hold', reason: 'needs-review' });
  });
  it('no second family available → hold needs-review', async () => {
    h = await createHarness();
    h.second.available = false;
    const id = await h.addItem('c');
    h.decide.fn = dispositionFor({ c: { disposition: 'ignore', reason: 'low-value', severity: 'high' } });
    await h.service.tick();
    expect(h.store.get(id)).toMatchObject({ state: 'hold', reason: 'needs-review' });
    expect(h.store.get(id)!.floors).toContain('f3-no-second-family');
  });
});

describe('duplicates feed their target', () => {
  it('a duplicate of an earlier-decided work item adds its reports to the target effective recurrence', async () => {
    h = await createHarness();
    h.service.setIgnoreLive(true, 'dashboard-pin:test');
    await h.addItem('canon', { reports: 2, title: 'scheduler crashes on resume after sleep' });
    await h.service.tick();
    const dup = await h.addItem('dup', { reports: 3, title: 'scheduler crashes on resume after sleep again' });
    h.now.value += 31_000;
    h.decide.fn = dispositionFor({ dup: { disposition: 'ignore', reason: 'duplicate', duplicateOf: 'canon', severity: 'low' } });
    await h.service.tick();
    expect(h.store.get(dup)).toMatchObject({ state: 'ignored', reason: 'duplicate', duplicateOf: 'canon' });
    expect(h.service.queue()[0]).toMatchObject({ clusterId: 'canon', effectiveRecurrence: 5 });
  });
  it('a duplicate naming an item in the same batch (or a chain) is held', async () => {
    h = await createHarness();
    await h.addItem('x', { title: 'login page broken' });
    const y = await h.addItem('y', { title: 'login page broken badly' });
    h.decide.fn = dispositionFor({ y: { disposition: 'ignore', reason: 'duplicate', duplicateOf: 'x', severity: 'low' } });
    await h.service.tick();
    expect(h.store.get(y)).toMatchObject({ state: 'hold', reason: 'duplicate-unverified' });
  });
});

describe('stale-write guard (floor 9) and re-queue throttle (floor 10)', () => {
  it('a hold whose cluster gained reports during the call is not applied and is re-triaged next tick (throttle-exempt)', async () => {
    h = await createHarness();
    const id = await h.addItem('s');
    h.decide.fn = (packets) => { setReports(h, 's', 2); return packets.map((p) => decisionRow(p.clusterId, { disposition: 'hold', reason: 'needs-evidence' })); };
    await h.service.tick();
    expect(h.store.get(id)).toMatchObject({ state: 'queued', requeueReason: 'stale-write', requeueExempt: true });
    h.decide.fn = dispositionFor({});
    h.now.value += 31_000;
    await h.service.tick();
    expect(h.store.get(id)).toMatchObject({ state: 'work', boundReportCount: 2 });
  });
  it('a work decision is applied even when the count changed', async () => {
    h = await createHarness();
    const id = await h.addItem('s');
    h.decide.fn = (packets) => { setReports(h, 's', 4); return packets.map((p) => decisionRow(p.clusterId)); };
    await h.service.tick();
    expect(h.store.get(id)!.state).toBe('work');
  });
  it('new reports bring a hold back, at most once per 24 hours', async () => {
    h = await createHarness();
    const id = await h.addItem('r');
    h.decide.fn = dispositionFor({ r: { disposition: 'hold', reason: 'needs-evidence' } });
    await h.service.tick();
    setReports(h, 'r', 2);
    h.now.value += 31_000;
    await h.service.tick();
    expect(h.store.get(id)).toMatchObject({ state: 'hold', boundReportCount: 2, holdCount: 2 });
    setReports(h, 'r', 3);
    h.now.value += HOUR;
    const calls = h.calls.length;
    await h.service.tick();
    expect(h.calls.length).toBe(calls);
    expect(h.store.get(id)!.boundReportCount).toBe(2);
    h.now.value += DAY;
    await h.service.tick();
    expect(h.store.get(id)!.boundReportCount).toBe(3);
  });
  it('a hold comes back when its review timer passes', async () => {
    h = await createHarness();
    const id = await h.addItem('t');
    h.decide.fn = dispositionFor({ t: { disposition: 'hold', reason: 'needs-evidence' } });
    await h.service.tick();
    h.decide.fn = dispositionFor({});
    h.now.value += 13 * DAY;
    await h.service.tick();
    expect(h.store.get(id)!.state).toBe('hold');
    h.now.value += 2 * DAY;
    await h.service.tick();
    expect(h.store.get(id)!.state).toBe('work');
    expect(h.tracker.get(id)!.status).toBe('active');
  });
  it('re-triage calls are capped by their own sub-cap', async () => {
    h = await createHarness();
    const id = await h.addItem('q');
    h.decide.fn = dispositionFor({ q: { disposition: 'hold', reason: 'needs-evidence' } });
    await h.service.tick();
    h.store.reserveSubcap(1, 'retriage', 50, 50);
    setReports(h, 'q', 2);
    h.now.value += 31_000;
    const result = await h.service.tick();
    expect(result.reason).toBe('call-cap-reached');
    expect(h.store.get(id)!.state).toBe('queued');
  });
});

describe('operator changes win', () => {
  it('an operator reactivating a paused item is recorded as an override and re-triaged with it', async () => {
    h = await createHarness();
    const id = await h.addItem('o');
    h.decide.fn = dispositionFor({ o: { disposition: 'hold', reason: 'needs-evidence' } });
    await h.service.tick();
    await h.tracker.update(id, { status: 'active' });
    h.now.value += 31_000;
    h.decide.fn = dispositionFor({});
    await h.service.tick();
    expect(h.store.get(id)!.operatorOverride).toContain('paused -> active');
    expect(h.calls.at(-1)).toContain('operator changed status');
    expect(h.store.get(id)!.state).toBe('work');
  });
});

describe('spend and pauses', () => {
  it('pauses while the serving account is at ≥75% or unreadable', async () => {
    h = await createHarness();
    await h.addItem('a');
    h.quota.value = 80;
    expect((await h.service.tick()).reason).toBe('quota-pause');
    h.quota.value = null;
    h.now.value += 31_000;
    expect((await h.service.tick()).reason).toBe('quota-unreadable-pause');
    expect(h.calls).toHaveLength(0);
  });
  it('stops at maxCallsPerDay', async () => {
    h = await createHarness({ config: { maxCallsPerDay: 1, maxBatchChars: 4_000 } });
    for (const id of ['a', 'b', 'c']) await h.addItem(id, { description: 'x'.repeat(1_100) });
    const result = await h.service.tick();
    expect(h.calls).toHaveLength(1);
    expect(result.reason).toBe('call-cap-reached');
  });
});

describe('self-heal before notify (§6)', () => {
  it('three unusable batches start self-healing at once (status + one degradation row, no push), then re-probe at 30m, 1h, 4h, then one Attention item', async () => {
    h = await createHarness();
    await h.addItem('a');
    h.decide.fn = () => 'not json';
    for (let i = 0; i < 3; i++) { await h.service.tick(); h.now.value += 31_000; }
    expect(h.service.summary().authority).toBe('self-healing');
    expect(h.degradations).toEqual(['feedback-triage:authority-unusable']);
    expect(h.attention).toHaveLength(0);
    expect(h.calls).toHaveLength(6); // each batch retried once
    const calls = h.calls.length;
    await h.service.tick();
    expect(h.calls.length).toBe(calls);
    h.now.value += SELF_HEAL_LADDER_MS[0];
    await h.service.tick();
    expect(h.calls.length).toBe(calls + 1);
    h.now.value += SELF_HEAL_LADDER_MS[1];
    await h.service.tick();
    h.now.value += SELF_HEAL_LADDER_MS[2];
    await h.service.tick();
    expect(h.service.summary().authority).toBe('exhausted');
    expect(h.attention).toHaveLength(1);
    expect(h.attention[0].sourceContext).toBe('feedback-triage:authority-unusable');
  });
  it('a successful canary resumes triage silently', async () => {
    h = await createHarness();
    const id = await h.addItem('a');
    h.decide.fn = () => 'not json';
    for (let i = 0; i < 3; i++) { await h.service.tick(); h.now.value += 31_000; }
    h.decide.fn = (packets) => packets.map((p) => decisionRow(p.clusterId));
    h.now.value += SELF_HEAL_LADDER_MS[0];
    await h.service.tick();
    expect(h.service.summary().authority).toBe('active');
    expect(h.store.get(id)!.state).toBe('work');
    expect(h.attention).toHaveLength(0);
  });
  it('a different model answering is not recoverable: demoted and one Attention item at once', async () => {
    h = await createHarness();
    await h.addItem('a');
    h.model.model = 'some-other-model';
    const result = await h.service.tick();
    expect(result.reason).toBe('authority-mismatch');
    expect(h.attention).toHaveLength(1);
    expect(h.attention[0].sourceContext).toBe('feedback-triage:authority-mismatch');
    expect(h.service.summary().authority).toBe('paused');
  });
});

describe('ignore-rate brake', () => {
  it('engages over the fixed 95% threshold before a baseline exists, holding new ignores', async () => {
    h = await createHarness({ config: { maxBatchChars: 200_000 } });
    h.service.setIgnoreLive(true, 'dashboard-pin:test');
    const ids: string[] = [];
    for (let i = 0; i < 20; i++) ids.push(await h.addItem(`n${i}`));
    h.decide.fn = (packets) => packets.map((p) => decisionRow(p.clusterId, { disposition: 'ignore', reason: 'low-value', severity: 'low' }));
    await h.service.tick();
    const late = await h.addItem('late');
    h.now.value += 31_000;
    await h.service.tick();
    expect(h.store.get(late)).toMatchObject({ state: 'hold', reason: 'ignore-rate-brake' });
    expect(h.degradations).toContain('feedback-triage:ignore-rate');
  });
});

describe('audit and packets', () => {
  it('the audit log carries ids, dispositions and floors but never report text; packets are stored by reference', async () => {
    h = await createHarness();
    const id = await h.addItem('a', { description: 'SECRET-REPORT-BODY-TEXT unique words here' });
    await h.service.tick();
    const log = fs.readFileSync(path.join(h.dir, 'logs', 'feedback-triage.jsonl'), 'utf8');
    expect(log).toContain(id);
    expect(log).not.toContain('SECRET-REPORT-BODY-TEXT');
    const packetRef = h.store.get(id)!.packetRef!;
    expect(JSON.stringify(h.audit.readPacket(packetRef))).toContain('SECRET-REPORT-BODY-TEXT');
  });
});

describe('ignoreLiveRecommended (§7)', () => {
  it('turns true at ≥30 medium-or-strong graded shadow ignores with ≤10% wrong, never from weak grades', async () => {
    h = await createHarness({ config: { maxBatchChars: 200_000 } });
    for (let i = 0; i < 31; i++) await h.addItem(`s${i}`);
    h.decide.fn = (packets) => packets.map((p) => decisionRow(p.clusterId, { disposition: 'ignore', reason: 'low-value', severity: 'low' }));
    await h.service.tick();
    const decisions = h.store.decisionsSince(0);
    expect(decisions.length).toBeGreaterThanOrEqual(30);
    decisions.forEach((d, i) => h.store.recordGrade(1, { decisionSequence: d.sequence, rule: 'quiet-30d', grade: 'right', strength: 'weak', disposition: d.disposition, shadow: true }));
    expect(h.service.ignoreLiveEvidence().recommended).toBe(false);
    decisions.slice(0, 30).forEach((d, i) => h.store.recordGrade(1, { decisionSequence: d.sequence, rule: 'cross-family-sample', grade: i < 3 ? 'wrong' : 'right', strength: 'medium', disposition: d.disposition, shadow: true }));
    expect(h.service.ignoreLiveEvidence()).toMatchObject({ graded: 30, wrong: 3, recommended: true });
    expect(h.service.summary().ignoreLiveRecommended).toBe(true);
  });
});

describe('action list (§5)', () => {
  it('lists the authority approval once, never in the quiet window, at most once a day', async () => {
    h = await createHarness({ approve: false });
    h.now.value = Date.UTC(2026, 9, 7, 9, 0); // 02:00 Los Angeles
    expect(await h.service.sendActionList()).toMatchObject({ sent: false, reason: 'quiet-window' });
    h.now.value = T0; // 09:00 Los Angeles
    const first = await h.service.sendActionList();
    expect(first.sent).toBe(true);
    expect(h.attention[0].description).toContain('Approve the feedback sorting model');
    expect(await h.service.sendActionList()).toMatchObject({ sent: false, reason: 'already-sent-today' });
    h.now.value += DAY;
    expect(await h.service.sendActionList()).toMatchObject({ sent: false, reason: 'nothing-new' });
  });
  it('carries serious needs-review holds once each, at most 10 plus a count line, to the configured topic', async () => {
    h = await createHarness({ config: { actionTopicId: 4242, maxBatchChars: 200_000 } });
    h.second.verdict = false;
    for (let i = 0; i < 12; i++) await h.addItem(`v${i}`, { reports: 2 });
    await h.addItem('quiet', { reports: 1 });
    h.decide.fn = (packets) => packets.map((p) => decisionRow(p.clusterId, { disposition: 'ignore', reason: 'not-a-defect', severity: p.clusterId === 'quiet' ? 'medium' : 'high' }));
    // 'quiet' is a medium, one-report needs-review only if a keyword fires; give it one.
    h.reports.get('quiet')![0].description = 'possible leak';
    await h.service.tick();
    const result = await h.service.sendActionList();
    expect(result.sent).toBe(true);
    expect(h.sent).toHaveLength(1);
    const lines = h.sent[0].text.split('\n').filter((l) => l.startsWith('• '));
    expect(lines.filter((l) => l.includes('Held for review'))).toHaveLength(10);
    expect(h.sent[0].text).toContain('…and 2 more');
    expect(h.sent[0].text).toContain('1 other item(s) are held for review');
    expect(h.sent[0].text).toContain('https://agent.example/dashboard?tab=feedback-drain');
    h.now.value += DAY;
    await h.service.sendActionList();
    const second = h.sent[1]?.text ?? '';
    expect(second.split('\n').filter((l) => l.includes('Held for review'))).toHaveLength(2);
  });
});

describe('grading (triage-side record)', () => {
  it('a later work decision after new reports grades the earlier hold `superseded`, not wrong', async () => {
    h = await createHarness();
    const id = await h.addItem('g');
    h.decide.fn = dispositionFor({ g: { disposition: 'hold', reason: 'needs-evidence' } });
    await h.service.tick();
    setReports(h, 'g', 3);
    h.decide.fn = dispositionFor({});
    h.now.value += 31_000;
    await h.service.tick();
    expect(h.store.get(id)!.state).toBe('work');
    expect(h.store.gradeCounts()).toEqual([expect.objectContaining({ grade: 'superseded', strength: 'weak', n: 1 })]);
  });
  it('after 30 quiet days a hold is graded right (weak); the weekly sample re-judges shadow ignores cross-family (medium)', async () => {
    h = await createHarness();
    await h.addItem('w1');
    await h.addItem('w2');
    h.decide.fn = (packets) => packets.map((p) => decisionRow(p.clusterId, { disposition: 'ignore', reason: 'low-value', severity: 'low' }));
    // The first tick runs the weekly sample before any decision exists; the next one is a week later.
    await h.service.tick();
    h.second.verdict = false;
    h.now.value += 7 * DAY + 1;
    await h.service.tick();
    const medium = h.store.gradeCounts().filter((g) => g.strength === 'medium');
    expect(medium).toEqual([expect.objectContaining({ grade: 'wrong', n: 2, shadow: true })]);
    h.now.value += 31 * DAY;
    h.second.available = false;
    await h.service.tick();
    expect(h.store.gradeCounts().some((g) => g.strength === 'weak' && g.grade === 'right')).toBe(true);
    // Weak grades never count toward the live-ignore recommendation.
    expect(h.service.ignoreLiveEvidence().graded).toBe(2);
  });
});

describe('work-queue ceiling', () => {
  it('a work item is not re-triaged after 30 days while the executor is unavailable (clock paused)', async () => {
    h = await createHarness();
    const id = await h.addItem('k');
    await h.service.tick();
    h.now.value += 45 * DAY;
    const calls = h.calls.length;
    await h.service.tick();
    expect(h.store.get(id)!.state).toBe('work');
    expect(h.calls.length).toBe(calls);
    expect(h.service.summary().executor).toEqual({ available: false, reason: 'not-built' });
  });
});

describe('self-heal flapping breaker and baselines', () => {
  it('a third self-heal episode within 7 days escalates at once as flapping', async () => {
    h = await createHarness();
    await h.addItem('f');
    for (let episode = 0; episode < 3; episode++) {
      h.decide.fn = () => 'not json';
      for (let i = 0; i < 3; i++) { await h.service.tick(); h.now.value += 31_000; }
      h.decide.fn = () => [];
      h.now.value += SELF_HEAL_LADDER_MS[0];
      if (episode < 2) {
        // A canary for an empty decision set fails the schema; give the canary a valid answer instead.
        h.decide.fn = (packets) => packets.map((p) => decisionRow(p.clusterId, { disposition: 'hold', reason: 'needs-evidence' }));
        await h.service.tick();
        h.store.requeue(1, 'feedback-f', 'test-requeue', { exempt: true, countThrottle: false });
        h.now.value += 31_000;
      }
    }
    expect(h.attention.some((a) => a.id.includes(':flapping:'))).toBe(true);
  });
  it('the summary reports the rule-default and hold-everything baselines', async () => {
    h = await createHarness();
    await h.addItem('b1', { reports: 2 });
    await h.addItem('b2', { reports: 1 });
    h.decide.fn = dispositionFor({ b2: { disposition: 'hold', reason: 'needs-evidence' } });
    await h.service.tick();
    const summary = h.service.summary() as Record<string, any>;
    expect(summary.ruleDefaultAgreement).toMatchObject({ agree: 2, total: 2 });
    expect(summary.holdEverythingAgreement).toMatchObject({ agree: 1, total: 2 });
    expect(summary.workPrecision).toBeNull();
  });
});

describe('review fixes: deadlines, generations, quota order, sampling, action-list stamping', () => {
  it('a second opinion is not started without enough tick time; the item is held needs-review', async () => {
    h = await createHarness({ maxWallClockMs: 80_000 });
    const id = await h.addItem('c', { reports: 2 });
    h.decide.fn = dispositionFor({ c: { disposition: 'ignore', reason: 'not-a-defect', severity: 'critical' } });
    h.callAdvanceMs.value = 60_000; // the triage call used up most of an 80 s tick
    await h.service.tick();
    expect(h.secondCalls).toBe(0);
    expect(h.store.get(id)).toMatchObject({ state: 'hold', reason: 'needs-review' });
    expect(h.store.get(id)!.floors).toContain('f3-out-of-time');
  });

  it('the weekly sample stops at the tick deadline and resumes on the next tick', async () => {
    h = await createHarness({ config: { maxBatchChars: 200_000 }, maxWallClockMs: 80_000 });
    for (const id of ['w1', 'w2', 'w3']) await h.addItem(id);
    h.decide.fn = (packets) => packets.map((p) => decisionRow(p.clusterId, { disposition: 'ignore', reason: 'low-value', severity: 'low' }));
    await h.service.tick();
    h.second.advanceMs = 60_000; // each cross-family call takes 60 s of an 80 s tick
    h.now.value += 7 * DAY + 1;
    await h.service.tick();
    const medium = () => h.store.gradeCounts().filter((g) => g.strength === 'medium').reduce((n, g) => n + g.n, 0);
    expect(medium()).toBe(1);
    h.now.value += 31_000;
    await h.service.tick();
    expect(medium()).toBe(2);
    h.now.value += 31_000;
    await h.service.tick();
    expect(medium()).toBe(3);
  });

  it('a decision that already carries a weak grade is still eligible for the cross-family sample', async () => {
    h = await createHarness();
    await h.addItem('q');
    h.decide.fn = dispositionFor({ q: { disposition: 'ignore', reason: 'low-value', severity: 'low' } });
    await h.service.tick();
    const decision = h.store.decisionsSince(0)[0];
    h.store.recordGrade(1, { decisionSequence: decision.sequence, rule: 'quiet-30d', grade: 'right', strength: 'weak', disposition: decision.disposition, shadow: true });
    h.now.value += 7 * DAY + 1;
    await h.service.tick();
    const grades = h.store.gradeCounts();
    expect(grades.some((g) => g.strength === 'weak')).toBe(true);
    expect(grades.some((g) => g.strength === 'medium')).toBe(true);
  });

  it('a fresh authority approval starts with a clean unusable count', async () => {
    h = await createHarness();
    await h.addItem('a');
    h.decide.fn = () => 'not json';
    for (let i = 0; i < 2; i++) { await h.service.tick(); h.now.value += 31_000; }
    h.approve('replace');
    await h.service.tick();
    expect(h.service.summary().authority).toBe('active');
    expect(h.degradations).not.toContain('feedback-triage:authority-unusable');
  });

  it('the quota pause applies before the self-heal canary', async () => {
    h = await createHarness();
    await h.addItem('a');
    h.decide.fn = () => 'not json';
    for (let i = 0; i < 3; i++) { await h.service.tick(); h.now.value += 31_000; }
    expect(h.service.summary().authority).toBe('self-healing');
    const calls = h.calls.length;
    h.quota.value = 80;
    h.now.value += SELF_HEAL_LADDER_MS[0];
    const result = await h.service.tick();
    expect(result.reason).toBe('quota-pause');
    expect(h.calls.length).toBe(calls);
  });

  it('the action list stamps exactly the items it showed (authority line first, the rest wait)', async () => {
    h = await createHarness({ config: { maxBatchChars: 200_000 } });
    h.second.verdict = false;
    for (let i = 0; i < 12; i++) await h.addItem(`v${i}`, { reports: 2 });
    h.decide.fn = (packets) => packets.map((p) => decisionRow(p.clusterId, { disposition: 'ignore', reason: 'not-a-defect', severity: 'high' }));
    await h.service.tick();
    h.approve('revoke');
    const first = await h.service.sendActionList();
    expect(first.sent).toBe(true);
    const text = h.attention.at(-1)!.description!;
    const shownHolds = text.split('\n').filter((l) => l.includes('Held for review')).length;
    expect(text).toContain('Approve the feedback sorting model');
    expect(shownHolds).toBe(9);
    expect(h.store.inState('hold').filter((r) => r.notifiedAt !== null)).toHaveLength(9);
    h.now.value += DAY;
    await h.service.sendActionList();
    const second = h.attention.at(-1)!.description!;
    expect(second).not.toContain('Approve the feedback sorting model');
    expect(second.split('\n').filter((l) => l.includes('Held for review'))).toHaveLength(3);
  });
});
