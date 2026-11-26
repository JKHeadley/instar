/**
 * Queue pace v1 adapters (docs/specs/queue-pace.md §1 table). Each adapter is a pure READ over
 * one existing owner's live store instance; none writes to its owner. Events come from the
 * owner's own timestamps; a transition the owner does not timestamp is declared
 * snapshot-derived (counted from the id-set diff, row marked turnover 'incomplete').
 */
import type { Database as BetterSqliteDatabase } from 'better-sqlite3';
import { HOUR_MS, type ExecutorFacts, type PaceEvent, type ReviewSnapshot } from './QueuePace.js';
import type { AdapterRead, QueueAdapter } from './QueuePaceLedger.js';
import { readUnderBoundary } from './QueuePaceLedger.js';

interface TimeCursor { at: number }
interface SeqCursor { at: number; seq: number }

function cursorAt(cursor: unknown, now: number): number {
  const at = (cursor as TimeCursor | null)?.at;
  // No cursor (first read): only events in the last hour are offered; the row is a baseline anyway.
  return typeof at === 'number' && Number.isFinite(at) ? at : now - HOUR_MS;
}

function iso(s: string | undefined | null): number | null {
  if (!s) return null;
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
}

function hasTable(db: BetterSqliteDatabase, name: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
}

// ── feedback.triage + feedback.fix (one SQLite database: drain.sharedDatabase()) ──

export interface FeedbackDbSource {
  /** The drain's live shared connection (never a fresh open). Null while the drain is absent. */
  db: () => BetterSqliteDatabase | null;
  /** operated host AND holding the serving lease AND not restore-pending. */
  ownerServing: () => boolean;
}

/**
 * feedback.triage — open: work items awaiting a triage decision (state untriaged|queued).
 * Entered: the triage row's created_at; completed: triage_decisions rows (event-sourced);
 * re-entered: last_requeued_at when stamped; other hold→queued returns are snapshot-derived.
 */
export function feedbackTriageAdapter(src: FeedbackDbSource): QueueAdapter {
  return {
    queue: 'feedback.triage',
    ownerServing: src.ownerServing,
    read(cursor, now): AdapterRead {
      const db = src.db();
      if (!db) return { ok: false, reason: 'owner-unavailable' };
      if (!hasTable(db, 'triage')) return { ok: false, reason: 'owner-unavailable' };
      const since = cursorAt(cursor, now);
      const sinceSeq = Number((cursor as SeqCursor | null)?.seq ?? -1);
      // One read transaction: events and the open set share one read boundary.
      return db.transaction((): AdapterRead => {
        const maxSeq = Number((db.prepare('SELECT COALESCE(MAX(sequence), 0) s FROM triage_decisions').get() as { s: number }).s);
        const seqFloor = sinceSeq >= 0 ? sinceSeq : maxSeq; // first read: decisions before now are history, not this hour
        const events: PaceEvent[] = [];
        for (const r of db.prepare('SELECT initiative_id id, created_at at FROM triage WHERE created_at > ? AND created_at <= ?').all(since, now) as Array<{ id: string; at: number }>) {
          events.push({ itemId: r.id, kind: 'entered', at: r.at });
        }
        for (const r of db.prepare('SELECT initiative_id id, last_requeued_at at FROM triage WHERE last_requeued_at > ? AND last_requeued_at <= ? AND created_at <= ?').all(since, now, since) as Array<{ id: string; at: number }>) {
          events.push({ itemId: r.id, kind: 'reentered', at: r.at });
        }
        for (const r of db.prepare('SELECT initiative_id id, created_at at FROM triage_decisions WHERE sequence > ? AND sequence <= ? ORDER BY sequence').all(seqFloor, maxSeq) as Array<{ id: string; at: number }>) {
          events.push({ itemId: r.id, kind: 'completed', at: r.at });
        }
        const openIds = (db.prepare("SELECT initiative_id id FROM triage WHERE state IN ('untriaged','queued')").all() as Array<{ id: string }>).map((r) => r.id);
        return { ok: true, mode: 'hourly', events, openIds, cursorAfter: { at: now, seq: maxSeq } satisfies SeqCursor, snapshotDerivedArrivals: true, snapshotDerivedExits: false };
      }).deferred();
    },
  };
}

const LATEST_ATTEMPT = `SELECT e.* FROM execution e WHERE e.attempt = (SELECT MAX(attempt) FROM execution x WHERE x.initiative_id = e.initiative_id)`;
const REOPENED = "('reopened-new-report','live-proof-failed')";

/**
 * feedback.fix — open: items decided `work` whose fix has not merged (spec-path items leave when
 * their spec PR opens and show only as a context count). Entered: `work` decisions; completed: the
 * fix PR merged (merged_at, not `verified`); exits (re-triaged away, held, parked, spec PR opened)
 * have no exit timestamp of their own and are snapshot-derived.
 */
export function feedbackFixAdapter(src: FeedbackDbSource): QueueAdapter {
  return {
    queue: 'feedback.fix',
    ownerServing: src.ownerServing,
    read(cursor, now): AdapterRead {
      const db = src.db();
      if (!db || !hasTable(db, 'triage')) return { ok: false, reason: 'owner-unavailable' };
      const since = cursorAt(cursor, now);
      const sinceSeq = Number((cursor as SeqCursor | null)?.seq ?? -1);
      const exec = hasTable(db, 'execution');
      return db.transaction((): AdapterRead => {
        const maxSeq = Number((db.prepare('SELECT COALESCE(MAX(sequence), 0) s FROM triage_decisions').get() as { s: number }).s);
        const seqFloor = sinceSeq >= 0 ? sinceSeq : maxSeq;
        const events: PaceEvent[] = [];
        for (const r of db.prepare("SELECT initiative_id id, created_at at FROM triage_decisions WHERE disposition='work' AND sequence > ? AND sequence <= ?").all(seqFloor, maxSeq) as Array<{ id: string; at: number }>) {
          events.push({ itemId: r.id, kind: 'entered', at: r.at });
        }
        let context: Record<string, number> = {};
        let openIds: string[];
        if (exec) {
          for (const r of db.prepare("SELECT initiative_id id, merged_at m FROM execution WHERE state='merged' AND needs_spec=0 AND merged_at IS NOT NULL").all() as Array<{ id: string; m: string }>) {
            const at = iso(r.m);
            if (at !== null && at > since && at <= now) events.push({ itemId: r.id, kind: 'completed', at });
          }
          openIds = (db.prepare(`SELECT t.initiative_id id FROM triage t LEFT JOIN (${LATEST_ATTEMPT}) l ON l.initiative_id = t.initiative_id
            WHERE t.state='work' AND NOT (l.state IS NOT NULL AND l.state IN ('merged','spec-pr-open') AND COALESCE(l.reason,'') NOT IN ${REOPENED})`).all() as Array<{ id: string }>).map((r) => r.id);
          const drafted = db.prepare(`SELECT COUNT(*) n FROM (${LATEST_ATTEMPT}) l WHERE l.needs_spec=1 AND l.state IN ('spec-pr-open','merged')`).get() as { n: number };
          context = { designsDraftedNotBuilt: Number(drafted.n) };
        } else {
          openIds = (db.prepare("SELECT initiative_id id FROM triage WHERE state='work'").all() as Array<{ id: string }>).map((r) => r.id);
        }
        return { ok: true, mode: 'hourly', events, openIds, cursorAfter: { at: now, seq: maxSeq } satisfies SeqCursor, snapshotDerivedArrivals: true, snapshotDerivedExits: true, context };
      }).deferred();
    },
  };
}

/** Executor facts for the person/cap bottleneck, read live (one read transaction). */
export function readExecutorFacts(db: BetterSqliteDatabase | null, approverLatched: () => boolean, repo: () => string | null = () => null): ExecutorFacts {
  const empty: ExecutorFacts = { ok: false, awaitingOwnerPrs: [], approverLatched: false, openPrs: 0, failedReviewPrs: 0 };
  if (!db || !hasTable(db, 'execution')) return empty;
  try {
    return db.transaction((): ExecutorFacts => {
      const open = db.prepare("SELECT pr_number pr, codeowners_json co, review_reason rr, review_verdict rv FROM execution WHERE state IN ('pr-open','spec-pr-open','merge-armed')").all() as Array<{ pr: number | null; co: string | null; rr: string | null; rv: string | null }>;
      const awaiting: number[] = [];
      let failed = 0;
      for (const r of open) {
        let outside: unknown[] = [];
        try { outside = r.co ? JSON.parse(r.co) as unknown[] : []; } catch { outside = []; } // @silent-fallback-ok: an unreadable list counts as none
        const waitsOnOwner = (Array.isArray(outside) && outside.length > 0) || r.rr === 'codeowners-owned';
        if (waitsOnOwner && Number.isSafeInteger(r.pr) && (r.pr as number) > 0) awaiting.push(r.pr as number);
        if (r.rv === 'fail') failed++;
      }
      return { ok: true, awaitingOwnerPrs: awaiting.sort((a, b) => a - b), approverLatched: approverLatched(), openPrs: open.length, failedReviewPrs: failed, repo: repo() };
    }).deferred();
  } catch { return empty; } // @silent-fallback-ok: a failed read → person is `unknown`, never assumed
}

// ── commitments (this machine's own CommitmentTracker) ───────────────────────

export interface CommitmentLike {
  id: string; status: string; createdAt: string; resolvedAt?: string; expiresAt?: string; originMachineId?: string;
}

const ACTIVE_COMMITMENT = new Set(['pending', 'verified', 'violated']);

/**
 * commitments — open: this machine's active commitments (the getActive() predicate). Completed:
 * delivered; exitedOther: every other terminal state and silent expiry past expiresAt. A
 * terminal state without a resolvedAt is snapshot-derived. Replicated copies are never read.
 */
export function commitmentsAdapter(tracker: { getAll(): CommitmentLike[] }, selfMachineId: string | null): QueueAdapter {
  const mine = () => tracker.getAll().filter((c) => !selfMachineId || !c.originMachineId || c.originMachineId === selfMachineId);
  return {
    queue: 'commitments',
    async read(cursor, now) {
      const since = cursorAt(cursor, now);
      const r = await readUnderBoundary(() => tracker.getAll().length, () => {
        const events: PaceEvent[] = [];
        const nowIso = new Date(now).toISOString();
        const openIds: string[] = [];
        for (const c of mine()) {
          const created = iso(c.createdAt);
          if (created !== null && created > since && created <= now) events.push({ itemId: c.id, kind: 'entered', at: created });
          const expires = iso(c.expiresAt);
          const resolved = iso(c.resolvedAt);
          const terminal = !ACTIVE_COMMITMENT.has(c.status);
          // The first of expiry and resolution is when it left the active set.
          if (expires !== null && expires > since && expires <= now && (!terminal || resolved === null || expires < resolved)) {
            events.push({ itemId: c.id, kind: 'exitedOther', at: expires, exitKind: 'expired' });
          } else if (terminal && resolved !== null && resolved > since && resolved <= now) {
            events.push({ itemId: c.id, kind: c.status === 'delivered' ? 'completed' : 'exitedOther', at: resolved, exitKind: c.status });
          }
          if (ACTIVE_COMMITMENT.has(c.status) && !(c.expiresAt && c.expiresAt < nowIso)) openIds.push(c.id);
        }
        return { events, openIds };
      });
      if (!r.ok) return { ok: false, reason: r.reason };
      return { ok: true, mode: 'hourly', events: r.value.events, openIds: r.value.openIds, cursorAfter: { at: now }, snapshotDerivedArrivals: false, snapshotDerivedExits: true };
    },
  };
}

// ── evolution (this machine's EvolutionManager) ──────────────────────────────

export interface ActionLike { id: string; status: string; createdAt: string; completedAt?: string }
export interface ArchiveLike { action: { id: string }; archivedAt: string; restoredAt?: string }

/**
 * evolution — open: pending + in_progress actions. Completed: completedAt; exitedOther:
 * auto-expired (archive archivedAt); cancelled and pruned-beyond-maxActions carry no time and
 * are snapshot-derived. Re-entered: an archived action restored (restoredAt).
 */
export function evolutionAdapter(evo: { listActions(): ActionLike[]; listArchivedActions(): ArchiveLike[] }): QueueAdapter {
  return {
    queue: 'evolution',
    async read(cursor, now) {
      const since = cursorAt(cursor, now);
      const r = await readUnderBoundary(() => evo.listActions().length, () => {
        const events: PaceEvent[] = [];
        const actions = evo.listActions();
        for (const a of actions) {
          const created = iso(a.createdAt);
          if (created !== null && created > since && created <= now) events.push({ itemId: a.id, kind: 'entered', at: created });
          const done = iso(a.completedAt);
          if (a.status === 'completed' && done !== null && done > since && done <= now) events.push({ itemId: a.id, kind: 'completed', at: done });
        }
        let archive: ArchiveLike[] = [];
        try { archive = evo.listArchivedActions(); } catch { archive = []; } // @silent-fallback-ok: an unreadable archive leaves those exits snapshot-derived
        for (const e of archive) {
          const at = iso(e.archivedAt);
          if (at !== null && at > since && at <= now) events.push({ itemId: e.action.id, kind: 'exitedOther', at, exitKind: 'auto-expired' });
          const back = iso(e.restoredAt);
          if (back !== null && back > since && back <= now) events.push({ itemId: e.action.id, kind: 'reentered', at: back });
        }
        const openIds = actions.filter((a) => a.status === 'pending' || a.status === 'in_progress').map((a) => a.id);
        return { events, openIds };
      });
      if (!r.ok) return { ok: false, reason: r.reason };
      return { ok: true, mode: 'hourly', events: r.value.events, openIds: r.value.openIds, cursorAfter: { at: now }, snapshotDerivedArrivals: false, snapshotDerivedExits: true };
    },
  };
}

// ── maturation.fix (review files, stepped per review) ────────────────────────

/**
 * maturation.fix — membership per review = features the board counts in stalledRegressedBlind.
 * Stepped per review, not hourly. `readReviews` returns null when this machine holds no reviews
 * (a confirmed absence: no rows, no queue on this machine).
 */
export function maturationAdapter(readReviews: () => Promise<ReviewSnapshot[] | null | { error: string }>): QueueAdapter {
  return {
    queue: 'maturation.fix',
    stepped: true,
    async read() {
      const r = await readReviews();
      if (r === null) return { ok: false, reason: 'no-reviews-dir', absent: true };
      if (!Array.isArray(r)) return { ok: false, reason: r.error };
      return { ok: true, mode: 'stepped', reviews: r };
    },
  };
}
