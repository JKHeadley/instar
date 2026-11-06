// safe-git-allow: test fixture creates a throwaway git repo in a tmp dir to resolve commit evidence.
/**
 * Promise review floor + priority (docs/specs/promise-review-and-priority.md).
 * Both sides of every §2.3 rule, the queue order, shadow mode, caps, reopen,
 * and the tracker-level priority / evidence / dedupe additions.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { CommitmentTracker, type Commitment } from '../../src/monitoring/CommitmentTracker.js';
import { PromiseReview, PromiseReviewError, resolvePromiseReviewConfig, type PromiseReviewConfig } from '../../src/monitoring/PromiseReview.js';
import { LiveConfig } from '../../src/config/LiveConfig.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

let stateDir: string;
let projectDir: string;
let t: CommitmentTracker;
let cfg: PromiseReviewConfig & { enabled?: boolean };
let review: PromiseReview;

function mk(over: Partial<Parameters<CommitmentTracker['record']>[0]> = {}): Commitment {
  const c = t.record({ type: 'one-time-action', userRequest: 'do the thing', agentResponse: `I will do thing ${Math.random()}`, topicId: 42, ...over });
  // A priority given at creation is treated as settled (set 2 h ago) unless a test says otherwise.
  if (over.priority) settle(c.id);
  return t.get(c.id)!;
}
function settle(id: string): void {
  (t as unknown as { mutateSync: (id: string, fn: (c: Commitment) => Commitment) => Commitment })
    .mutateSync(id, (c) => ({ ...c, prioritySetAt: new Date(Date.now() - 2 * 3_600_000).toISOString(), createdAt: new Date(Date.now() - 3 * 3_600_000).toISOString() }));
}

beforeEach(() => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'promise-review-'));
  stateDir = path.join(root, '.instar');
  projectDir = root;
  fs.mkdirSync(path.join(stateDir, 'state'), { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'config.json'), '{}');
  t = new CommitmentTracker({ stateDir, liveConfig: new LiveConfig(stateDir) });
  cfg = { enabled: true, closureDryRun: false };
  review = new PromiseReview({ tracker: t, stateDir, projectDir, config: () => resolvePromiseReviewConfig(cfg, cfg.enabled === true) });
});

afterEach(() => {
  SafeFsExecutor.safeRmSync(path.dirname(stateDir), { recursive: true, force: true, operation: 'tests/unit/PromiseReview.test.ts' });
});

const auditLines = () => fs.existsSync(review.auditPath)
  ? fs.readFileSync(review.auditPath, 'utf-8').trim().split('\n').map((l) => JSON.parse(l)) : [];

describe('priority on the tracker', () => {
  it('records a valid priority at creation and refuses an invalid one', () => {
    const c = mk({ priority: 'high', priorityReason: 'Justin is waiting' });
    expect(c.priority).toBe('high');
    expect(c.prioritySetBy).toBe('agent');
    expect(() => mk({ priority: 'urgent' as never })).toThrow(/priority must be/);
  });

  it('no priority means not assessed — never back-filled', () => {
    expect(mk().priority).toBeUndefined();
  });

  it('setPriority marks everHigh and keeps it after a downgrade; refuses terminal rows', () => {
    const c = mk();
    t.setPriority(c.id, 'high', 'waiting', 'agent');
    const low = t.setPriority(c.id, 'low', 'not anymore', 'agent')!;
    expect(low.priority).toBe('low');
    expect(low.everHigh).toBe(true);
    t.deliver(c.id);
    expect(t.setPriority(c.id, 'normal', undefined, 'agent')).toBeNull();
  });

  it('deliver can carry evidence, stored as the resolution', () => {
    const c = mk();
    expect(t.deliver(c.id, undefined, 'merged as PR #1')!.resolution).toBe('merged as PR #1');
  });

  it('a sentinel capture with the same request + promise text in the same topic within 24h is marked as a duplicate candidate, never merged', () => {
    const a = t.record({ type: 'one-time-action', source: 'sentinel', topicId: 7, userRequest: 'x', agentResponse: 'On it — checking now.' });
    const b = t.record({ type: 'one-time-action', source: 'sentinel', topicId: 7, userRequest: 'x', agentResponse: 'on it —  checking now' });
    expect(b.id).not.toBe(a.id);
    expect(b.duplicateCandidateOf).toBe(a.id);
    const other = t.record({ type: 'one-time-action', source: 'sentinel', topicId: 8, userRequest: 'x', agentResponse: 'On it — checking now.' });
    const agent = t.record({ type: 'one-time-action', source: 'agent', topicId: 7, userRequest: 'x', agentResponse: 'On it — checking now.' });
    const otherAsk = t.record({ type: 'one-time-action', source: 'sentinel', topicId: 7, userRequest: 'a different ask', agentResponse: 'On it — checking now.' });
    const keyed = t.record({ type: 'one-time-action', source: 'sentinel', topicId: 7, userRequest: 'x', agentResponse: 'On it — checking now.', externalKey: 'yield-safety:k1' });
    for (const r of [other, agent, otherAsk, keyed]) expect(r.duplicateCandidateOf).toBeUndefined();
  });
});

describe('review queue', () => {
  it('is disabled-shaped when the feature is off', () => {
    cfg.enabled = false;
    mk();
    expect(review.queue()).toMatchObject({ enabled: false, due: 0, items: [] });
    expect(review.peek()).toEqual({ enabled: false, due: 0, runnable: false });
  });

  it('orders waiting rows first, then never-reviewed newest first; skips closed and config-change rows', async () => {
    const old = mk({ agentResponse: 'old' });
    await t.mutate(old.id, (c) => ({ ...c, createdAt: '2026-08-01T00:00:00.000Z' }));
    const fresh = mk({ agentResponse: 'fresh' });
    const high = mk({ agentResponse: 'high', priority: 'high' });
    const done = mk({ agentResponse: 'done' });
    t.deliver(done.id);
    const ids = review.queue().items.map((r) => r.id);
    expect(ids[0]).toBe(high.id);
    expect(ids.indexOf(fresh.id)).toBeLessThan(ids.indexOf(old.id));
    expect(ids).not.toContain(done.id);
  });

  it('one routine row that just came due does not start a session on its own', async () => {
    const a = mk({ priority: 'normal' });
    await t.mutate(a.id, (c) => ({ ...c, lastReviewedAt: new Date(Date.now() - 7.5 * 86_400_000).toISOString() }));
    expect(review.peek()).toMatchObject({ due: 1, runnable: false });
    // ...but once it has waited a day past due, it does
    await t.mutate(a.id, (c) => ({ ...c, lastReviewedAt: new Date(Date.now() - 8.5 * 86_400_000).toISOString() }));
    expect(review.peek().runnable).toBe(true);
  });

  it('reserves a third of each batch for the oldest backlog, so new rows cannot starve it', async () => {
    const old = Array.from({ length: 6 }, (_, i) => mk({ agentResponse: `old ${i}` }));
    await review.apply('seed', old.map((r) => ({ id: r.id, action: 'keep' as const })));
    for (const r of old) await t.mutate(r.id, (c) => ({ ...c, lastReviewedAt: '2026-01-01T00:00:00.000Z' }));
    for (let i = 0; i < 10; i++) mk({ agentResponse: `new ${i}` });
    const ids = review.queue(6).items.map((r) => r.id);
    expect(ids.filter((id) => old.some((o) => o.id === id)).length).toBe(2);
    // old NEVER-reviewed rows are protected too
    const ancient = mk({ agentResponse: 'ancient unreviewed' });
    await t.mutate(ancient.id, (c) => ({ ...c, createdAt: '2025-01-01T00:00:00.000Z' }));
    expect(review.queue(6).items.map((r) => r.id)).toContain(ancient.id);
  });

  it('a kept row rests for its window; peek is runnable only with a batch, an urgent row, or a day-old wait', async () => {
    const a = mk();
    expect(review.peek().runnable).toBe(false); // one fresh row, nothing urgent
    await review.apply('r1', [{ id: a.id, action: 'keep' }]);
    expect(review.queue().due).toBe(0);
    for (let i = 0; i < 5; i++) mk();
    expect(review.peek().runnable).toBe(true);

  });

  it('redacts credentials out of row text', () => {
    mk({ agentResponse: `use token=${'z'.repeat(30)}` });
    const text = String(review.queue().items[0].agentResponse);
    expect(text).not.toContain('z'.repeat(30));
  });
});

describe('apply — the floor', () => {
  it('refuses when disabled, on a bad runId, or with too many decisions', async () => {
    cfg.enabled = false;
    await expect(review.apply('r', [{ id: 'CMT-001', action: 'keep' }])).rejects.toBeInstanceOf(PromiseReviewError);
    cfg.enabled = true;
    await expect(review.apply('bad id!', [{ id: 'x', action: 'keep' }])).rejects.toThrow(/runId/);
    await expect(review.apply('r', [])).rejects.toThrow(/decisions/);
  });

  it('keep and prioritize stamp the review; prioritize needs a reason', async () => {
    const a = mk();
    const b = mk();
    const out = await review.apply('r1', [
      { id: a.id, action: 'prioritize', priority: 'normal', reason: 'real work I own' },
      { id: b.id, action: 'prioritize', priority: 'high' },
    ]);
    expect(out.results.map((r) => r.outcome)).toEqual(['applied', 'refused']);
    expect(out.results[1].refusal).toBe('prioritize-needs-priority-and-reason');
    expect(t.get(a.id)).toMatchObject({ priority: 'normal', prioritySetBy: 'promise-review', reviewCount: 1, reviewRunId: 'r1' });
  });

  it('a closure needs an assessed priority', async () => {
    const a = mk();
    const out = await review.apply('r1', [{ id: a.id, action: 'archive', kind: 'obsolete', reason: 'the run this was for ended' }]);
    expect(out.results[0].refusal).toBe('closure-needs-assessed-priority');
    // a priority set in the SAME closing decision does not count: it must come from an earlier decision
    const same = await review.apply('r2', [{ id: mk().id, action: 'archive', kind: 'obsolete', priority: 'low', reason: 'the run this was for ended' }]);
    expect(same.results[0].refusal).toBe('closure-needs-assessed-priority');
    const row = mk();
    await review.apply('r3', [{ id: row.id, action: 'prioritize', priority: 'low', reason: 'a leftover from an old run' }]);
    // a fresh runId in the same session cannot close it: the priority is under an hour old
    const rotated = await review.apply('r4', [{ id: row.id, action: 'archive', kind: 'obsolete', reason: 'the run this was for ended' }]);
    expect(rotated.results[0].refusal).toBe('closure-needs-assessed-priority');
    settle(row.id);
    const ok = await review.apply('r5', [{ id: row.id, action: 'archive', kind: 'obsolete', reason: 'the run this was for ended' }]);
    expect(ok.results[0].outcome).toBe('applied');
  });

  it('a closure refused for no stored priority keeps the offered priority, and the row closes on the next run', async () => {
    const a = mk();
    const first = await review.apply('n1', [{ id: a.id, action: 'archive', kind: 'obsolete', priority: 'low', reason: 'the run it was for ended' }]);
    expect(first.results[0].refusal).toBe('closure-needs-assessed-priority');
    expect(t.get(a.id)).toMatchObject({ priority: 'low', prioritySetBy: 'promise-review', status: 'pending' });
    // a second apply in the SAME run cannot close it
    const same = await review.apply('n1', [{ id: a.id, action: 'archive', kind: 'obsolete', reason: 'the run it was for ended' }]);
    expect(same.results[0].refusal).toBe('closure-needs-assessed-priority');
    // it is due again within the next 6 h run, not a week later
    const sevenHoursAgo = new Date(Date.now() - 7 * 3_600_000).toISOString(); // ONE instant: the follow-up test compares them for equality
    await t.mutate(a.id, (c) => ({ ...c, lastReviewedAt: sevenHoursAgo, prioritySetAt: sevenHoursAgo }));
    expect(review.queue().items.map((r) => r.id)).toContain(a.id);
    const next = await review.apply('n2', [{ id: a.id, action: 'archive', kind: 'obsolete', reason: 'the run it was for ended' }]);
    expect(next.results[0].outcome).toBe('applied');
  });

  it('a row created high stays marked as once-waiting after an agent lowers it', async () => {
    const a = mk({ priority: 'high' });
    expect(a.everHigh).toBe(true);
    t.setPriority(a.id, 'low', 'someone lowered it', 'agent');
    settle(a.id);
    const out = await review.apply('e1', [{ id: a.id, action: 'archive', kind: 'obsolete', reason: 'probably not needed now' }]);
    expect(out.results[0].refusal).toBe('waiting-needs-evidence');
  });

  it('deliver needs evidence + a resolving reference; a reference that pre-dates the promise is refused', async () => {
    const a = mk({ priority: 'normal' });
    const noRef = await review.apply('r1', [{ id: a.id, action: 'deliver', evidence: 'it was merged yesterday' }]);
    expect(noRef.results[0].refusal).toBe('deliver-needs-evidence');
    const earlier = mk({ priority: 'normal' });
    t.deliver(earlier.id);
    await t.mutate(earlier.id, (c) => ({ ...c, resolvedAt: '2020-01-01T00:00:00.000Z' }));
    const stale = await review.apply('r2', [{ id: a.id, action: 'deliver', evidence: 'covered by the earlier one', evidenceRef: { kind: 'commitment', ref: earlier.id } }]);
    expect(stale.results[0].refusal).toBe('evidence-ref-unresolved');
    const later = mk({ priority: 'normal' });
    t.deliver(later.id);
    // a cited promise closed with no checked proof makes the reference unverifiable (accepted, not resolved)
    const weak = mk({ priority: 'normal' });
    const w = await review.apply('r2b', [{ id: weak.id, action: 'deliver', evidence: 'covered by the later delivery', evidenceRef: { kind: 'commitment', ref: later.id } }]);
    expect(w.results[0]).toMatchObject({ outcome: 'applied', evidenceRefResolved: false });
    await t.mutate(later.id, (x) => ({ ...x, evidenceRefResolved: true }));
    const good = await review.apply('r3', [{ id: a.id, action: 'deliver', evidence: 'covered by the later delivery', evidenceRef: { kind: 'commitment', ref: later.id } }]);
    expect(good.results[0]).toMatchObject({ outcome: 'applied', evidenceRefResolved: true });
    expect(t.get(a.id)).toMatchObject({ status: 'delivered', closedBy: 'promise-review', evidenceRefResolved: true });
    expect(t.get(a.id)!.resolution).toMatch(/^promise-review: covered by the later delivery/);
  });

  it('a file reference must be inside the project and newer than the promise; .git / traversal refused', async () => {
    const a = mk({ priority: 'normal' });
    fs.writeFileSync(path.join(projectDir, 'out.md'), 'done');
    const bad = await review.apply('r1', [{ id: a.id, action: 'deliver', evidence: 'the report file exists', evidenceRef: { kind: 'file', ref: '../etc/passwd' } }]);
    expect(bad.results[0].refusal).toBe('evidence-ref-unresolved');
    const good = await review.apply('r2', [{ id: a.id, action: 'deliver', evidence: 'the report file exists', evidenceRef: { kind: 'file', ref: 'out.md' } }]);
    expect(good.results[0].outcome).toBe('applied');
  });

  it('a commit reference resolves against the project repo; a non-git project is stored as unchecked', async () => {
    const a = mk({ priority: 'normal' });
    const unchecked = await review.apply('r1', [{ id: a.id, action: 'deliver', evidence: 'landed as commit abc1234', evidenceRef: { kind: 'commit', ref: 'abc1234' } }]);
    expect(unchecked.results[0]).toMatchObject({ outcome: 'applied', evidenceRefResolved: false });
    const b = mk({ priority: 'normal' });
    await t.mutate(b.id, (x) => ({ ...x, createdAt: new Date(Date.now() - 60_000).toISOString() }));
    execFileSync('git', ['init', '-q', projectDir]);
    execFileSync('git', ['-C', projectDir, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'x']);
    const sha = execFileSync('git', ['-C', projectDir, 'rev-parse', 'HEAD']).toString().trim();
    const ok = await review.apply('r2', [{ id: b.id, action: 'deliver', evidence: 'landed as the head commit', evidenceRef: { kind: 'commit', ref: sha } }]);
    expect(ok.results[0]).toMatchObject({ outcome: 'applied', evidenceRefResolved: true });
    // a sha not in this repo may live in another repository: stored unchecked, not refused
    const c = mk({ priority: 'normal' });
    const missing = await review.apply('r3', [{ id: c.id, action: 'deliver', evidence: 'landed as some commit', evidenceRef: { kind: 'commit', ref: 'deadbeefdeadbeef' } }]);
    expect(missing.results[0]).toMatchObject({ outcome: 'applied', evidenceRefResolved: false });
    // a commit that exists but pre-dates the promise cannot be its fulfilment
    const d = mk({ priority: 'normal' });
    await t.mutate(d.id, (x) => ({ ...x, createdAt: new Date(Date.now() + 3_600_000).toISOString() }));
    const before = await review.apply('r4', [{ id: d.id, action: 'deliver', evidence: 'landed as the head commit', evidenceRef: { kind: 'commit', ref: sha } }]);
    expect(before.results[0].refusal).toBe('evidence-ref-unresolved');
  });

  it('a row a person is or was waiting on cannot be archived or downgraded without evidence', async () => {
    const high = mk({ priority: 'high' });
    const r1 = await review.apply('r1', [{ id: high.id, action: 'archive', kind: 'obsolete', reason: 'probably no longer needed' }]);
    expect(r1.results[0].refusal).toBe('waiting-needs-evidence');
    const r2 = await review.apply('r2', [{ id: high.id, action: 'prioritize', priority: 'low', reason: 'downgrade it' }]);
    expect(r2.results[0].refusal).toBe('high-downgrade-needs-evidence');
    const dated = mk({ priority: 'normal', checkInAt: new Date(Date.now() + 86_400_000).toISOString() });
    const r3 = await review.apply('r3', [{ id: dated.id, action: 'archive', kind: 'obsolete', reason: 'moment has passed now' }]);
    expect(r3.results[0].refusal).toBe('waiting-needs-evidence');
    // unverifiable proof (a message) keeps a waiting row open
    const r4 = await review.apply('r4', [{ id: high.id, action: 'archive', kind: 'obsolete', reason: 'the user withdrew the ask', evidence: 'user said on 11-03 it is not needed', evidenceRef: { kind: 'message', ref: 'topic 42 msg 99' } }]);
    expect(r4.results[0].refusal).toBe('waiting-needs-resolved-evidence');
    // a resolved reference (the replacing promise was delivered) lets it close
    const replacement = mk({ priority: 'normal', agentResponse: 'the replacement' });
    t.deliver(replacement.id);
    // the replacement's own proof must have been checked for it to carry a waiting row
    const weakFirst = await review.apply('r4b', [{ id: high.id, action: 'archive', kind: 'superseded', supersededBy: replacement.id, reason: 'replaced by the delivered one', evidence: 'the replacement promise was delivered', evidenceRef: { kind: 'commitment', ref: replacement.id } }]);
    expect(weakFirst.results[0].refusal).toBe('waiting-needs-resolved-evidence');
    await t.mutate(replacement.id, (x) => ({ ...x, evidenceRefResolved: true }));
    const r5 = await review.apply('r5', [{ id: high.id, action: 'archive', kind: 'superseded', supersededBy: replacement.id, reason: 'replaced by the delivered one', evidence: 'the replacement promise was delivered', evidenceRef: { kind: 'commitment', ref: replacement.id } }]);
    expect(r5.results[0]).toMatchObject({ outcome: 'applied', evidenceRefResolved: true });
  });

  it('behavioral rows are never delivered and are archived only as superseded/duplicate of a live behavioral row', async () => {
    const rule = t.record({ type: 'behavioral', userRequest: 'u', agentResponse: 'a', behavioralRule: 'write plainly', priority: 'normal' });
    const rule2 = t.record({ type: 'behavioral', userRequest: 'u', agentResponse: 'b', behavioralRule: 'write plainly please', priority: 'normal' });
    settle(rule.id);
    settle(rule2.id);
    const task = mk({ priority: 'normal' });
    const out = await review.apply('r1', [
      { id: rule.id, action: 'deliver', evidence: 'rule followed for weeks', evidenceRef: { kind: 'other', ref: 'x' } },
      { id: rule.id, action: 'archive', kind: 'obsolete', reason: 'no longer relevant now' },
    ]);
    expect(out.results[0].refusal).toBe('behavioral-never-delivered');
    expect(out.results[1].refusal).toBe('duplicate-decision');
    const r2 = await review.apply('r2', [{ id: rule.id, action: 'archive', kind: 'obsolete', reason: 'no longer relevant now' }]);
    expect(r2.results[0].refusal).toBe('behavioral-needs-supersession');
    const r3 = await review.apply('r3', [{ id: rule.id, action: 'archive', kind: 'duplicate', duplicateOf: task.id, reason: 'same as the task row' }]);
    expect(r3.results[0].refusal).toBe('duplicate-target-invalid');
    const r4 = await review.apply('r4', [{ id: rule.id, action: 'archive', kind: 'duplicate', duplicateOf: rule2.id, reason: 'same rule as the other one' }]);
    expect(r4.results[0].outcome).toBe('applied');
    expect(t.get(rule.id)).toMatchObject({ status: 'withdrawn', supersededBy: rule2.id, closedBy: 'promise-review' });
  });

  it('never archives both copies of a duplicate pair in one batch', async () => {
    const a = mk({ priority: 'low' });
    const b = mk({ priority: 'low' });
    const out = await review.apply('r1', [
      { id: a.id, action: 'archive', kind: 'duplicate', duplicateOf: b.id, reason: 'same promise twice' },
      { id: b.id, action: 'archive', kind: 'duplicate', duplicateOf: a.id, reason: 'same promise twice' },
    ]);
    expect(out.results.every((r) => r.refusal === 'duplicate-target-invalid')).toBe(true);
    expect(t.get(a.id)!.status).toBe('pending');
  });

  it('repeated evidence wording is audited as a signal, not refused', async () => {
    const rows = [mk({ priority: 'low' }), mk({ priority: 'low' }), mk({ priority: 'low' })];
    const out = await review.apply('r1', rows.map((r) => ({ id: r.id, action: 'archive' as const, kind: 'obsolete' as const, reason: 'old window program ended' })));
    expect(out.results.map((r) => r.outcome)).toEqual(['applied', 'applied', 'applied']);
    expect(auditLines().every((l) => l.evidenceReused === true)).toBe(true);
  });

  it('a message reference resolves only to the agent\'s own later message in the same conversation', async () => {
    const msgs = new Map<number, { at: number; fromAgent: boolean }>([[100, { at: Date.now() + 1000, fromAgent: true }], [101, { at: Date.now() + 1000, fromAgent: false }]]);
    const withLog = new PromiseReview({ tracker: t, stateDir, projectDir, config: () => resolvePromiseReviewConfig(cfg, true), findMessage: (topic, id) => (topic === 42 ? msgs.get(id) ?? null : null) });
    const a = mk({ priority: 'high' });
    const userMsg = await withLog.apply('m1', [{ id: a.id, action: 'deliver', evidence: 'sent the answer in the topic', evidenceRef: { kind: 'message', ref: '101' } }]);
    expect(userMsg.results[0].refusal).toBe('evidence-ref-unresolved');
    const ok = await withLog.apply('m2', [{ id: a.id, action: 'deliver', evidence: 'sent the answer in the topic', evidenceRef: { kind: 'message', ref: '100' } }]);
    expect(ok.results[0]).toMatchObject({ outcome: 'applied', evidenceRefResolved: true });
  });

  it('caps closures per run and per day; a capped row is NOT stamped and stays due', async () => {
    cfg.maxClosuresPerRun = 2;
    const rows = Array.from({ length: 3 }, (_, i) => mk({ priority: 'low', agentResponse: `p${i}` }));
    const out = await review.apply('r1', rows.map((r, i) => ({ id: r.id, action: 'archive' as const, kind: 'obsolete' as const, reason: `ended run number ${i}` })));
    expect(out.results.map((r) => r.outcome)).toEqual(['applied', 'applied', 'capped']);
    expect(t.get(rows[2].id)!.lastReviewedAt).toBeUndefined();
    // a second request — same runId or a rotated one — is still capped (a rolling hour, not per request)
    const again = await review.apply('r1b', [{ id: rows[2].id, action: 'archive', kind: 'obsolete', reason: 'ended run number 2' }]);
    expect(again.results[0].outcome).toBe('capped');
    cfg.maxClosuresPerRun = 50;
    cfg.maxClosuresPerDay = 2;
    const day = await review.apply('r2', [{ id: rows[2].id, action: 'archive', kind: 'obsolete', reason: 'ended run number 2' }]);
    expect(day.results[0].outcome).toBe('capped');
  });

  it('reopening does not refill the caps', async () => {
    cfg.maxClosuresPerRun = 1;
    const a = mk({ priority: 'low', agentResponse: 'a1' });
    const b = mk({ priority: 'low', agentResponse: 'b1' });
    await review.apply('rc', [{ id: a.id, action: 'archive', kind: 'obsolete', reason: 'first obsolete row here' }]);
    review.reopen(a.id, 'reopened on purpose');
    const out = await review.apply('rc', [{ id: b.id, action: 'archive', kind: 'obsolete', reason: 'second obsolete row here' }]);
    expect(out.results[0].outcome).toBe('capped');
  });

  it('a priority raised to high during the evidence check blocks the close', async () => {
    const a = mk({ priority: 'normal' });
    const later = mk({ priority: 'normal' });
    t.deliver(later.id);
    const pending = review.apply('rg', [{ id: a.id, action: 'archive', kind: 'superseded', supersededBy: later.id, reason: 'replaced by the later one', evidenceRef: { kind: 'commitment', ref: later.id } }]);
    t.setPriority(a.id, 'high', 'a person is waiting after all', 'agent');
    const out = await pending;
    expect(out.results[0].refusal).toBe('changed-under-review');
    expect(t.get(a.id)!.status).toBe('pending');
  });

  it('closure shadow: would-apply stamps the review with the decision but closes nothing', async () => {
    cfg.closureDryRun = true;
    const a = mk({ priority: 'low' });
    const out = await review.apply('r1', [{ id: a.id, action: 'archive', kind: 'obsolete', reason: 'the window run ended' }]);
    expect(out.results[0].outcome).toBe('would-apply');
    expect(t.get(a.id)).toMatchObject({ status: 'pending', reviewCount: 1 });
    expect(t.get(a.id)!.shadowDecision).toMatch(/^would-archive:obsolete/);
    expect(review.queue().due).toBe(0);
  });

  it('a refused decision stamps the row so it does not spin; unknown and closed rows are refused', async () => {
    const a = mk({ priority: 'high' });
    const done = mk();
    t.deliver(done.id);
    const out = await review.apply('r1', [
      { id: a.id, action: 'archive', kind: 'obsolete', reason: 'nobody is waiting now' },
      { id: done.id, action: 'keep' },
      { id: 'CMT-999999', action: 'keep' },
    ]);
    expect(out.results.map((r) => r.refusal)).toEqual(['waiting-needs-evidence', 'not-own-pending', 'not-own-pending']);
    expect(t.get(a.id)!.shadowDecision).toBe('refused:waiting-needs-evidence');
  });

  it('a row closed by someone else while evidence was being checked is not overwritten', async () => {
    const a = mk({ priority: 'normal' });
    const later = mk({ priority: 'normal' });
    t.deliver(later.id);
    const pending = review.apply('r1', [{ id: a.id, action: 'archive', kind: 'superseded', supersededBy: later.id, reason: 'replaced by the later one', evidenceRef: { kind: 'commitment', ref: later.id } }]);
    t.deliver(a.id, undefined, 'the user closed it'); // lands during the async evidence check
    const out = await pending;
    expect(out.results[0].refusal).toBe('changed-under-review');
    expect(t.get(a.id)).toMatchObject({ status: 'delivered', resolution: 'the user closed it' });
    expect(t.get(a.id)!.closedBy).toBeUndefined();
  });

  it('never closes a row it could not reopen (minted conversation ids)', async () => {
    const a = t.record({ type: 'one-time-action', userRequest: 'u', agentResponse: 'minted row', priority: 'low' });
    settle(a.id);
    await t.mutate(a.id, (c) => ({ ...c, topicId: -5 }));
    const out = await review.apply('mt', [{ id: a.id, action: 'archive', kind: 'obsolete', reason: 'the conversation moved on' }]);
    expect(out.results[0].refusal).toBe('minted-topic-not-closable');
  });

  it('one apply at a time', async () => {
    const a = mk({ priority: 'normal' });
    const later = mk({ priority: 'normal' });
    t.deliver(later.id);
    const first = review.apply('r1', [{ id: a.id, action: 'deliver', evidence: 'done in the later row', evidenceRef: { kind: 'commitment', ref: later.id } }]);
    await expect(review.apply('r2', [{ id: mk().id, action: 'keep' }])).rejects.toMatchObject({ code: 'review-apply-busy' });
    await first;
  });

  it('audits every decision with source, before/after and the shadow flag', async () => {
    const a = mk({ priority: 'low', source: 'sentinel', agentResponse: 'sentinel row' });
    await review.apply('r1', [{ id: a.id, action: 'archive', kind: 'obsolete', reason: 'conversation moved on' }]);
    const [line] = auditLines();
    expect(line).toMatchObject({ runId: 'r1', id: a.id, action: 'archive', outcome: 'applied', source: 'sentinel', statusBefore: 'pending', statusAfter: 'withdrawn', kind: 'obsolete', closureDryRun: false });
  });
});

describe('reopen', () => {
  it('undoes a review closure inside the window, audited; refuses anything else', async () => {
    const a = mk({ priority: 'low' });
    await review.apply('r1', [{ id: a.id, action: 'archive', kind: 'obsolete', reason: 'conversation moved on' }]);
    expect(review.reopen(a.id, '')).toEqual({ ok: false, error: 'reason-required' });
    const out = review.reopen(a.id, 'still wanted by the user');
    expect(out.ok).toBe(true);
    expect(t.get(a.id)).toMatchObject({ status: 'pending', reopenReason: 'still wanted by the user', reopenCount: 1 });
    expect(t.get(a.id)!.closedBy).toBeUndefined();
    expect(auditLines().at(-1)).toMatchObject({ action: 'reopen', outcome: 'applied' });

    const b = mk();
    t.deliver(b.id);
    expect(review.reopen(b.id, 'not the review')).toEqual({ ok: false, error: 'not-review-closed' });

    const c = mk({ priority: 'low', agentResponse: 'c' });
    await review.apply('r2', [{ id: c.id, action: 'archive', kind: 'obsolete', reason: 'window program ended' }]);
    await t.mutate(c.id, (x) => ({ ...x, resolvedAt: '2020-01-01T00:00:00.000Z' }));
    expect(review.reopen(c.id, 'too late now')).toEqual({ ok: false, error: 'reopen-window-passed' });
  });

  it('a reopened duplicate archive is not silently re-closed by the graveyard reconciler', async () => {
    const keep = mk({ priority: 'low', agentResponse: 'kept copy' });
    const dup = mk({ priority: 'low', agentResponse: 'dup copy' });
    t.deliver(keep.id);
    await review.apply('rg1', [{ id: dup.id, action: 'archive', kind: 'duplicate', duplicateOf: keep.id, reason: 'same promise recorded twice' }]);
    review.reopen(dup.id, 'it is actually separate work');
    t.reconcileGraveyard({});
    expect(t.get(dup.id)).toMatchObject({ status: 'pending' });
    expect(t.get(dup.id)!.supersededBy).toBeUndefined();
  });

  it('shadow closures count against the same caps', async () => {
    cfg.closureDryRun = true;
    cfg.maxClosuresPerRun = 1;
    const rows = [mk({ priority: 'low', agentResponse: 's1' }), mk({ priority: 'low', agentResponse: 's2' })];
    const out = await review.apply('rs', rows.map((r, i) => ({ id: r.id, action: 'archive' as const, kind: 'obsolete' as const, reason: `obsolete shadow row ${i}` })));
    expect(out.results.map((r) => r.outcome)).toEqual(['would-apply', 'capped']);
  });

  it('a later close by someone else clears closedBy, so reopen cannot undo their decision', async () => {
    const a = mk({ priority: 'normal' });
    const later = mk({ priority: 'normal' });
    t.deliver(later.id);
    await review.apply('r1', [{ id: a.id, action: 'deliver', evidence: 'covered by later row', evidenceRef: { kind: 'commitment', ref: later.id } }]);
    t.withdraw(a.id, 'operator dropped it');
    expect(review.reopen(a.id, 'try again please')).toEqual({ ok: false, error: 'not-review-closed' });
  });
});
