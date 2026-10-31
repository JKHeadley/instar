/**
 * Queue pace v1 adapters (docs/specs/queue-pace.md §1 table) over the REAL owner schemas:
 * the feedback adapters read the drain's shared SQLite database with the triage and execution
 * tables the real stores create (so a renamed column fails here), and the commitments and
 * evolution adapters read store-shaped objects. Every adapter is read-only.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { FeedbackDrainStore } from '../../src/feedback-factory/drain/FeedbackDrainStore.js';
import { FeedbackTriageStore } from '../../src/feedback-factory/triage/FeedbackTriageStore.js';
import { FeedbackExecuteStore } from '../../src/feedback-factory/execute/FeedbackExecuteStore.js';
import {
  commitmentsAdapter, evolutionAdapter, feedbackFixAdapter, feedbackTriageAdapter, maturationAdapter, readExecutorFacts,
} from '../../src/monitoring/QueuePaceAdapters.js';
import { reconcileInterval, HOUR_MS } from '../../src/monitoring/QueuePace.js';
import type { AdapterRead } from '../../src/monitoring/QueuePaceLedger.js';

const NOW = Date.parse('2026-10-30T12:00:00Z');
const drains: FeedbackDrainStore[] = [];
afterEach(() => { for (const d of drains.splice(0)) d.close(); });

function feedbackDb() {
  const drain = new FeedbackDrainStore({ dbPath: ':memory:', tokenHmacKey: 'k'.repeat(32) });
  drains.push(drain);
  const triage = new FeedbackTriageStore(drain, { hmacKey: 'h'.repeat(32) });
  new FeedbackExecuteStore(drain, triage);
  const db = drain.sharedDatabase();
  const addTriage = (id: string, state: string, createdAt: number, over: Record<string, unknown> = {}) => {
    db.prepare(`INSERT INTO triage(initiative_id,cluster_id,feedback_work_key,state,first_seen_at,created_at,updated_at,needs_spec,last_requeued_at)
      VALUES (?,?,?,?,?,?,?,?,?)`).run(id, `c-${id}`, `k-${id}`, state, createdAt, createdAt, createdAt, over.needsSpec ?? 0, over.requeuedAt ?? null);
  };
  const decide = (id: string, disposition: string, at: number) => {
    db.prepare(`INSERT INTO triage_decisions(initiative_id,cluster_id,model_disposition,disposition,reason,would_ignore,rule_default,shadow,floors_json,keyword_floor,created_at)
      VALUES (?,?,?,?,?,0,'work',0,'[]',0,?)`).run(id, `c-${id}`, disposition, disposition, 'r', at);
    db.prepare('UPDATE triage SET state=? WHERE initiative_id=?').run(disposition === 'ignore' ? 'ignored' : disposition, id);
  };
  const attempt = (id: string, state: string, over: Record<string, unknown> = {}) => {
    db.prepare(`INSERT INTO execution(attempt_id,initiative_id,cluster_id,attempt,state,reason,owner_epoch,needs_spec,branch,pr_number,merged_at,codeowners_json,review_reason,review_verdict,created_at,updated_at)
      VALUES (?,?,?,?,?,?,1,?,?,?,?,?,?,?,?,?)`).run(`${id}:${over.attempt ?? 1}`, id, `c-${id}`, over.attempt ?? 1, state, over.reason ?? '', over.needsSpec ?? 0, `b-${id}`,
      over.pr ?? null, over.mergedAt ?? null, over.codeowners ?? '[]', over.reviewReason ?? null, over.reviewVerdict ?? null, NOW - HOUR_MS, NOW - HOUR_MS);
  };
  return { drain, db, addTriage, decide, attempt };
}

const hourly = (r: AdapterRead) => { if (!r.ok || r.mode !== 'hourly') throw new Error(`not hourly: ${JSON.stringify(r)}`); return r; };

describe('feedback.triage adapter', () => {
  it('open = untriaged|queued; entered = new rows; completed = decision rows; reconciles cleanly', async () => {
    const f = feedbackDb();
    f.addTriage('a', 'untriaged', NOW - 2 * HOUR_MS);
    f.addTriage('b', 'queued', NOW - 2 * HOUR_MS);
    const adapter = feedbackTriageAdapter({ db: () => f.db, ownerServing: () => true });
    const first = hourly(await adapter.read(null, NOW - HOUR_MS));
    expect(new Set(first.openIds)).toEqual(new Set(['a', 'b']));
    f.addTriage('c', 'untriaged', NOW - 30 * 60_000);
    f.decide('a', 'work', NOW - 20 * 60_000);
    const second = hourly(await adapter.read(first.cursorAfter, NOW));
    expect(second.events.map((e) => `${e.kind}:${e.itemId}`).sort()).toEqual(['completed:a', 'entered:c']);
    const r = reconcileInterval({ prevIds: new Set(first.openIds), events: second.events, snapshot: new Set(second.openIds), snapshotDerivedArrivals: second.snapshotDerivedArrivals });
    expect(r).toMatchObject({ ok: true, entered: 1, completed: 1, open: 2, turnover: 'complete' });
  });

  it('a stamped re-queue is an event; an unstamped hold→queued return is snapshot-derived', async () => {
    const f = feedbackDb();
    f.addTriage('h', 'hold', NOW - 5 * HOUR_MS);
    f.addTriage('q', 'hold', NOW - 5 * HOUR_MS);
    const adapter = feedbackTriageAdapter({ db: () => f.db, ownerServing: () => true });
    const first = hourly(await adapter.read(null, NOW - HOUR_MS));
    f.db.prepare("UPDATE triage SET state='queued', last_requeued_at=? WHERE initiative_id='h'").run(NOW - 10 * 60_000);
    f.db.prepare("UPDATE triage SET state='queued' WHERE initiative_id='q'").run();
    const second = hourly(await adapter.read(first.cursorAfter, NOW));
    expect(second.events).toEqual([{ itemId: 'h', kind: 'reentered', at: NOW - 10 * 60_000 }]);
    const r = reconcileInterval({ prevIds: new Set(first.openIds), events: second.events, snapshot: new Set(second.openIds), snapshotDerivedArrivals: true });
    expect(r).toMatchObject({ ok: true, reentered: 2, turnover: 'incomplete' });
  });

  it('no database → owner-unavailable, never zeros', async () => {
    const r = await feedbackTriageAdapter({ db: () => null, ownerServing: () => true }).read(null, NOW);
    expect(r).toEqual({ ok: false, reason: 'owner-unavailable' });
  });
});

describe('feedback.fix adapter', () => {
  it('open = work items whose fix has not merged; merged = completed; spec PR open leaves as context', async () => {
    const f = feedbackDb();
    f.addTriage('w1', 'work', NOW - 5 * HOUR_MS);
    f.addTriage('w2', 'work', NOW - 5 * HOUR_MS);
    f.addTriage('s1', 'work', NOW - 5 * HOUR_MS, { needsSpec: 1 });
    f.attempt('s1', 'spec-pr-open', { needsSpec: 1, pr: 9 });
    const adapter = feedbackFixAdapter({ db: () => f.db, ownerServing: () => true });
    const first = hourly(await adapter.read(null, NOW - HOUR_MS));
    expect(new Set(first.openIds)).toEqual(new Set(['w1', 'w2']));
    expect(first.context).toEqual({ designsDraftedNotBuilt: 1 });
    f.attempt('w1', 'merged', { pr: 11, mergedAt: new Date(NOW - 15 * 60_000).toISOString() });
    f.addTriage('w3', 'untriaged', NOW - 40 * 60_000);
    f.decide('w3', 'work', NOW - 30 * 60_000);
    const second = hourly(await adapter.read(first.cursorAfter, NOW));
    const r = reconcileInterval({ prevIds: new Set(first.openIds), events: second.events, snapshot: new Set(second.openIds), snapshotDerivedArrivals: true, snapshotDerivedExits: true });
    expect(r).toMatchObject({ ok: true, entered: 1, completed: 1, open: 2 });
  });

  it('a reopened merged fix is open again', async () => {
    const f = feedbackDb();
    f.addTriage('r', 'work', NOW - 5 * HOUR_MS);
    f.attempt('r', 'merged', { reason: 'reopened-new-report', mergedAt: new Date(NOW - 3 * HOUR_MS).toISOString() });
    const r = hourly(await feedbackFixAdapter({ db: () => f.db, ownerServing: () => true }).read(null, NOW));
    expect(r.openIds).toEqual(['r']);
  });

  it('executor facts: PRs waiting on a CODEOWNERS owner, failed reviews, open slots', () => {
    const f = feedbackDb();
    f.attempt('p1', 'pr-open', { pr: 2439, codeowners: '["docs/x.md"]', reviewVerdict: 'fail' });
    f.attempt('p2', 'pr-open', { pr: 2442, reviewReason: 'codeowners-owned' });
    f.attempt('p3', 'merge-armed', { pr: 2453, reviewVerdict: 'fail' });
    f.attempt('p4', 'merged', { pr: 2454 });
    const facts = readExecutorFacts(f.db, () => false, () => 'JKHeadley/instar');
    expect(facts).toEqual({ ok: true, awaitingOwnerPrs: [2439, 2442], approverLatched: false, openPrs: 3, failedReviewPrs: 2, repo: 'JKHeadley/instar' });
    expect(readExecutorFacts(null, () => true).ok).toBe(false);
  });
});

describe('commitments adapter', () => {
  const iso = (t: number) => new Date(t).toISOString();
  it('open = getActive predicate; delivered completes; withdrawn and silent expiry exit; replicas are skipped', async () => {
    const list = [
      { id: 'c1', status: 'pending', createdAt: iso(NOW - 30 * 60_000) },
      { id: 'c2', status: 'delivered', createdAt: iso(NOW - 5 * HOUR_MS), resolvedAt: iso(NOW - 10 * 60_000) },
      { id: 'c3', status: 'withdrawn', createdAt: iso(NOW - 5 * HOUR_MS), resolvedAt: iso(NOW - 20 * 60_000) },
      { id: 'c4', status: 'pending', createdAt: iso(NOW - 5 * HOUR_MS), expiresAt: iso(NOW - 5 * 60_000) },
      { id: 'c5', status: 'pending', createdAt: iso(NOW - 5 * HOUR_MS) },
      { id: 'peer', status: 'pending', createdAt: iso(NOW - 30 * 60_000), originMachineId: 'other' },
    ];
    const r = hourly(await commitmentsAdapter({ getAll: () => list }, 'self').read({ at: NOW - HOUR_MS }, NOW));
    expect(r.openIds.sort()).toEqual(['c1', 'c5']);
    expect(r.events.map((e) => `${e.kind}:${e.itemId}`).sort()).toEqual(['completed:c2', 'entered:c1', 'exitedOther:c3', 'exitedOther:c4']);
    const rec = reconcileInterval({ prevIds: new Set(['c2', 'c3', 'c4', 'c5']), events: r.events, snapshot: new Set(r.openIds) });
    expect(rec).toMatchObject({ ok: true, entered: 1, completed: 1, exitedOther: 2 });
  });
});

describe('evolution adapter', () => {
  const iso = (t: number) => new Date(t).toISOString();
  it('open = pending+in_progress; completed by completedAt; auto-expiry archive exits; restore re-enters', async () => {
    const actions = [
      { id: 'A1', status: 'pending', createdAt: iso(NOW - 20 * 60_000) },
      { id: 'A2', status: 'completed', createdAt: iso(NOW - 5 * HOUR_MS), completedAt: iso(NOW - 10 * 60_000) },
      { id: 'A4', status: 'in_progress', createdAt: iso(NOW - 5 * HOUR_MS) },
    ];
    const archive = [
      { action: { id: 'A3' }, archivedAt: iso(NOW - 15 * 60_000) },
      { action: { id: 'A4' }, archivedAt: iso(NOW - 4 * HOUR_MS), restoredAt: iso(NOW - 5 * 60_000) },
    ];
    const r = hourly(await evolutionAdapter({ listActions: () => actions, listArchivedActions: () => archive }).read({ at: NOW - HOUR_MS }, NOW));
    expect(r.openIds.sort()).toEqual(['A1', 'A4']);
    const rec = reconcileInterval({ prevIds: new Set(['A2', 'A3']), events: r.events, snapshot: new Set(r.openIds), snapshotDerivedExits: true });
    expect(rec).toMatchObject({ ok: true, entered: 1, reentered: 1, completed: 1, exitedOther: 1 });
  });
});

describe('maturation.fix adapter', () => {
  it('no reviews on this machine is a confirmed absence; reviews read as stepped', async () => {
    expect(await maturationAdapter(async () => null).read(null, NOW)).toMatchObject({ ok: false, absent: true });
    expect(await maturationAdapter(async () => ({ error: 'reviews-dir-unreadable' })).read(null, NOW)).toEqual({ ok: false, reason: 'reviews-dir-unreadable' });
    const r = await maturationAdapter(async () => [{ date: '2026-10-01', at: 1, rows: [] }]).read(null, NOW);
    expect(r).toMatchObject({ ok: true, mode: 'stepped' });
  });
});
