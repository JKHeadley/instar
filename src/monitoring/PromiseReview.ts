/**
 * PromiseReview — the deterministic floor under the agent's own promise review
 * (docs/specs/promise-review-and-priority.md).
 *
 * The JUDGMENT (keep / prioritize / deliver / archive, and which priority) is
 * made by the `promise-review` job session. This module holds the FLOOR the
 * judgment cannot cross:
 *   - only this machine's own pending rows;
 *   - every closure carries an assessed priority and a written reason;
 *   - a delivery carries evidence AND an evidence reference the server tries to
 *     resolve (exists + post-dates the promise); a checkable reference that does
 *     not resolve is refused;
 *   - a row a person is (or was) recorded as waiting on cannot be archived or
 *     downgraded without evidence;
 *   - behavioral rows (standing rules) are never delivered and are archived only
 *     as superseded/duplicate of another live behavioral row;
 *   - duplicate/supersede targets must survive the batch (no cycles);
 *   - per-run and rolling-24h closure caps, persisted in state (not a log scan);
 *   - closure shadow mode (would-apply) by default;
 *   - one apply at a time (single-flight);
 *   - every decision audited to logs/promise-review.jsonl.
 *
 * Signal vs. authority: the floor can only say "not like this" — a refusal
 * leaves the promise open, which is the safe direction. It never closes
 * anything on its own.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import type { CommitmentTracker, Commitment, CommitmentPriority, PromiseEvidenceKind } from './CommitmentTracker.js';
import { COMMITMENT_PRIORITIES, PROMISE_EVIDENCE_KINDS, priorityRank } from './CommitmentTracker.js';
import { redactForLiveTail } from '../core/liveTailRedaction.js';

const execFile = promisify(execFileCb);

export interface PromiseReviewConfig {
  enabled?: boolean;
  closureDryRun?: boolean;
  batchSize?: number;
  maxClosuresPerRun?: number;
  maxClosuresPerDay?: number;
  rereviewAfterDays?: number;
  highRereviewAfterDays?: number;
  reopenWindowDays?: number;
}

export interface ResolvedPromiseReviewConfig {
  enabled: boolean;
  closureDryRun: boolean;
  batchSize: number;
  maxClosuresPerRun: number;
  maxClosuresPerDay: number;
  rereviewAfterDays: number;
  highRereviewAfterDays: number;
  reopenWindowDays: number;
}

export const PROMISE_REVIEW_DEFAULTS: Omit<ResolvedPromiseReviewConfig, 'enabled'> = {
  closureDryRun: true,
  batchSize: 30,
  maxClosuresPerRun: 15,
  maxClosuresPerDay: 60,
  rereviewAfterDays: 7,
  highRereviewAfterDays: 1,
  reopenWindowDays: 30,
};

export const MAX_DECISIONS_PER_APPLY = 50;
export const MAX_QUEUE_LIMIT = 50;
const MIN_REASON = 12;
const RUN_ID_RE = /^[A-Za-z0-9._:-]{1,64}$/;
const SHA_RE = /^[0-9a-f]{7,40}$/;
const EVIDENCE_CHECK_BUDGET_MS = 10_000;
const DAY_MS = 86_400_000;
/** Commit/file/close times vs the promise's createdAt: allow for clock skew between machines. */
const CLOCK_SLACK_MS = 10 * 60_000;
/** The follow-up window after a first assessment (~4.8 h: due at the next 6-hourly run). */
const FOLLOW_UP_DAYS = 0.2;
/** A stored priority must be this old before the review may close on it. */
const PRIORITY_SETTLE_MS = 60 * 60_000;
/** The per-run closure cap counts closures in this rolling window. */
const RUN_WINDOW_MS = 60 * 60_000;

function posNum(v: unknown, d: number): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : d;
}

/** Resolve config: `enabled` comes from the caller (dev-agent gate), the rest from config or defaults. */
export function resolvePromiseReviewConfig(raw: PromiseReviewConfig | undefined, enabled: boolean): ResolvedPromiseReviewConfig {
  const r = raw ?? {};
  return {
    enabled,
    closureDryRun: typeof r.closureDryRun === 'boolean' ? r.closureDryRun : PROMISE_REVIEW_DEFAULTS.closureDryRun,
    batchSize: Math.min(posNum(r.batchSize, PROMISE_REVIEW_DEFAULTS.batchSize), MAX_QUEUE_LIMIT),
    maxClosuresPerRun: posNum(r.maxClosuresPerRun, PROMISE_REVIEW_DEFAULTS.maxClosuresPerRun),
    maxClosuresPerDay: posNum(r.maxClosuresPerDay, PROMISE_REVIEW_DEFAULTS.maxClosuresPerDay),
    rereviewAfterDays: posNum(r.rereviewAfterDays, PROMISE_REVIEW_DEFAULTS.rereviewAfterDays),
    highRereviewAfterDays: posNum(r.highRereviewAfterDays, PROMISE_REVIEW_DEFAULTS.highRereviewAfterDays),
    reopenWindowDays: posNum(r.reopenWindowDays, PROMISE_REVIEW_DEFAULTS.reopenWindowDays),
  };
}

export type ReviewAction = 'keep' | 'prioritize' | 'deliver' | 'archive';
export type ArchiveKind = 'superseded' | 'duplicate' | 'obsolete';

export interface ReviewDecision {
  id: string;
  action: ReviewAction;
  priority?: CommitmentPriority;
  reason?: string;
  evidence?: string;
  evidenceRef?: { kind: PromiseEvidenceKind; ref: string };
  kind?: ArchiveKind;
  duplicateOf?: string;
  supersededBy?: string;
}

export type DecisionOutcome = 'applied' | 'refused' | 'capped' | 'would-apply';

export interface DecisionResult {
  id: string;
  action: string;
  outcome: DecisionOutcome;
  refusal?: string;
  evidenceRefResolved?: boolean;
}

export interface ApplyResult {
  runId: string;
  closureDryRun: boolean;
  results: DecisionResult[];
  counts: Record<DecisionOutcome, number>;
}

export class PromiseReviewError extends Error {
  constructor(readonly code: 'promise-review-disabled' | 'review-apply-busy' | 'bad-request', message: string) {
    super(message);
  }
}

export interface PromiseReviewDeps {
  tracker: CommitmentTracker;
  /** The agent's state dir (`.instar`). Audit goes to `<stateDir>/logs/`, caps to `<stateDir>/state/`. */
  stateDir: string;
  /** The project dir, used to resolve `file` and `commit` evidence references. */
  projectDir: string;
  config: () => ResolvedPromiseReviewConfig;
  now?: () => number;
  /**
   * Look up a message in this agent's own conversation log: was message
   * `messageId` sent in `topicId`, when, and by the agent (not the user)?
   * null = not found / no log. Makes a `message` reference resolvable — the
   * usual proof for "I'll send you X".
   */
  findMessage?: (topicId: number, messageId: number) => { at: number; fromAgent: boolean } | null;
}

const SLIM_FIELDS = [
  'id', 'type', 'createdAt', 'topicId', 'source', 'owner', 'blockedOn', 'externalKey',
  'hardDeadlineAt', 'nextUpdateDueAt', 'checkInAt', 'priority', 'priorityReason', 'everHigh',
  'lastReviewedAt', 'reviewCount', 'supersededBy', 'duplicateCandidateOf', 'prioritySetAt', 'prioritySetBy', 'reopenedAt', 'reopenReason', 'reopenCount',
] as const;
const SLIM_TEXT = ['userRequest', 'agentResponse', 'behavioralRule', 'priorityReason', 'reopenReason'] as const;

function redact(text: unknown, max: number): string | undefined {
  if (typeof text !== 'string' || !text) return undefined;
  return redactForLiveTail(text).text.slice(0, max);
}

export class PromiseReview {
  private busy = false;
  private readonly now: () => number;

  constructor(private readonly deps: PromiseReviewDeps) {
    this.now = deps.now ?? (() => Date.now());
  }

  get auditPath(): string { return path.join(this.deps.stateDir, 'logs', 'promise-review.jsonl'); }

  /** Rows due for review: own pending one-time-action/behavioral rows not reviewed within their window. */
  private dueRows(): Commitment[] {
    const now = this.now();
    return this.deps.tracker.getAll().filter((c) => {
      if (c.status !== 'pending') return false;
      if (c.type !== 'one-time-action' && c.type !== 'behavioral') return false;
      if (!c.lastReviewedAt) return true;
      const last = Date.parse(c.lastReviewedAt);
      if (!Number.isFinite(last)) return true;
      return now - last > this.rereviewWindowDays(c) * DAY_MS;
    });
  }

  /** When a row became due: its last review + its window, or its creation if never reviewed. */
  private dueSince(c: Commitment): number {
    return c.lastReviewedAt
      ? Date.parse(c.lastReviewedAt) + this.rereviewWindowDays(c) * DAY_MS
      : Date.parse(c.createdAt);
  }

  /** The review just assessed this row for the first time (or nearly); it comes back next run. */
  private isFirstAssessmentFollowUp(c: Commitment): boolean {
    return c.prioritySetBy === 'promise-review' && !!c.prioritySetAt && c.prioritySetAt === c.lastReviewedAt;
  }

  /** How long a reviewed row rests before it is due again. */
  private rereviewWindowDays(c: Commitment): number {
    const cfg = this.deps.config();
    // A person is or was recorded as waiting: daily, whatever the current priority or type.
    if (c.priority === 'high' || c.everHigh || c.checkInAt) return cfg.highRereviewAfterDays;
    // First assessment just made: come back next run (6 h) so a row judged
    // obsolete on first sight closes one cycle later, not a week later.
    // ~5 h, under the 6-hourly cadence minus a run's length, so it is due at the NEXT run.
    if (this.isFirstAssessmentFollowUp(c)) return FOLLOW_UP_DAYS;
    // Standing rules change rarely; re-reading them weekly is pure spend.
    if (c.type === 'behavioral') return cfg.rereviewAfterDays * 4;
    if (c.priority === 'low') return cfg.rereviewAfterDays * 2;
    return cfg.rereviewAfterDays;
  }



  /**
   * The next rows to review. Tiers: (0) rows a person is or was recorded as
   * waiting on; (1) never-reviewed rows, NEWEST first (a fresh promise is not
   * stuck behind a months-old backlog); (2) the rest, oldest review first.
   */
  queue(limit?: number): { enabled: boolean; closureDryRun: boolean; due: number; items: Record<string, unknown>[]; caps: { maxClosuresPerRun: number; maxClosuresPerDay: number } } {
    const cfg = this.deps.config();
    if (!cfg.enabled) return { enabled: false, closureDryRun: cfg.closureDryRun, due: 0, items: [], caps: { maxClosuresPerRun: cfg.maxClosuresPerRun, maxClosuresPerDay: cfg.maxClosuresPerDay } };
    const due = this.dueRows();
    const tier = (c: Commitment) => (c.priority === 'high' || c.everHigh || c.checkInAt) ? 0 : !c.lastReviewedAt ? 1 : 2;
    due.sort((a, b) => {
      const t = tier(a) - tier(b);
      if (t) return t;
      if (tier(a) === 1) return Date.parse(b.createdAt) - Date.parse(a.createdAt);
      if (tier(a) === 0) return priorityRank(a.priority) - priorityRank(b.priority) || Date.parse(a.createdAt) - Date.parse(b.createdAt);
      return Date.parse(a.lastReviewedAt ?? '') - Date.parse(b.lastReviewedAt ?? '');
    });
    const n = Math.max(1, Math.min(limit ?? cfg.batchSize, MAX_QUEUE_LIMIT));
    // Progress guarantee: at least a third of every batch is reserved.
    // The reserve goes to the rows that have been due the LONGEST (never-reviewed
    // or reviewed, by when they became due), so neither old unreviewed rows nor
    // old reviewed rows can be starved by a stream of new ones.
    const rest = due.filter((c) => tier(c) !== 0);
    const oldestFirst = [...rest].sort((a, b) => this.dueSince(a) - this.dueSince(b));
    const reserved = oldestFirst.slice(0, Math.min(Math.ceil(n / 3), rest.length));
    const head = due.filter((c) => !reserved.includes(c)).slice(0, n - reserved.length);
    // Everything fits: keep the tier order; the reserve only matters when rows compete.
    const picked = due.length <= n ? due : [...head, ...reserved];
    const items = picked.map((c) => {
      const row: Record<string, unknown> = {};
      for (const f of SLIM_FIELDS) if ((c as unknown as Record<string, unknown>)[f] !== undefined) row[f] = (c as unknown as Record<string, unknown>)[f];
      for (const f of SLIM_TEXT) {
        const v = redact((c as unknown as Record<string, unknown>)[f], f === 'priorityReason' ? 200 : 1500);
        if (v) row[f] = v;
      }
      return row;
    });
    return { enabled: true, closureDryRun: cfg.closureDryRun, due: due.length, items, caps: { maxClosuresPerRun: cfg.maxClosuresPerRun, maxClosuresPerDay: cfg.maxClosuresPerDay } };
  }

  /** Cheap count for the job gate. */
  peek(): { enabled: boolean; due: number; runnable: boolean } {
    const cfg = this.deps.config();
    if (!cfg.enabled) return { enabled: false, due: 0, runnable: false };
    const due = this.dueRows();
    // Run when there is a batch's worth, when anything high/waiting is due, or
    // when the oldest due row has waited a day — never a session for one row.
    const now = this.now();
    const urgent = due.some((c) => c.priority === 'high' || c.everHigh || !!c.checkInAt || this.isFirstAssessmentFollowUp(c));
    // Wait is measured from when a row BECAME due (not from its last review), so
    // one routine row coming due never starts a session on its own.
    const oldestWait = due.reduce((m, c) => Math.max(m, now - this.dueSince(c)), 0);
    return { enabled: true, due: due.length, runnable: due.length >= 5 || urgent || (due.length > 0 && oldestWait > DAY_MS) };
  }

  /**
   * Closures the review made, counted FROM THE STORE (each row's
   * reviewClosures history, which reopen does not clear), so the cap survives
   * restarts and log rotation, cannot be refilled by reopening, and needs no
   * second file. Bounded: one pass over the own store.
   */
  private closureCounts(runId: string, shadow = false): { run: number; day: number } {
    const since = this.now() - DAY_MS;
    let run = 0;
    let day = 0;
    for (const c of this.deps.tracker.getAll()) {
      for (const k of (shadow ? c.shadowClosures : c.reviewClosures) ?? []) {
        const at = Date.parse(k.at);
        // "Per run" is a rolling hour (a run lasts ~20 min), so rotating runIds
        // cannot refill it; the same runId always counts too.
        if (k.runId === runId || (Number.isFinite(at) && at >= this.now() - RUN_WINDOW_MS)) run++;
        if (Number.isFinite(at) && at >= since) day++;
      }
    }
    return { run, day };
  }

  private audit(line: Record<string, unknown>): void {
    try {
      fs.mkdirSync(path.dirname(this.auditPath), { recursive: true });
      fs.appendFileSync(this.auditPath, JSON.stringify(line) + '\n');
    } catch (err) {
      // @silent-fallback-ok — the row itself carries closedBy/resolution/reviewRunId; a lost audit line is reported, not fatal
      console.warn(`[PromiseReview] audit append failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Resolve an evidence reference: does it exist and post-date the promise? null = uncheckable here. */
  private async resolveRef(row: Commitment, ref: { kind: PromiseEvidenceKind; ref: string }, deadline: number): Promise<boolean | null> {
    const createdMs = Date.parse(row.createdAt);
    switch (ref.kind) {
      case 'commitment': {
        if (ref.ref === row.id) return false;
        const other = this.deps.tracker.get(ref.ref);
        if (!other || !['delivered', 'verified'].includes(other.status)) return false;
        const at = Date.parse(other.resolvedAt ?? other.lastVerifiedAt ?? '');
        if (!(Number.isFinite(at) && (!Number.isFinite(createdMs) || at > createdMs))) return false;
        // Proof is only as good as the cited promise's own proof: a row closed on
        // unverifiable evidence (or with none) makes this reference unverifiable.
        return other.status === 'verified' || other.evidenceRefResolved === true ? true : null;
      }
      case 'file': {
        if (path.isAbsolute(ref.ref) || ref.ref.split(/[\\/]/).includes('..')) return false;
        let root: string;
        let target: string;
        try {
          root = fs.realpathSync(this.deps.projectDir);
          target = fs.realpathSync(path.join(root, ref.ref));
        } catch { return false; }
        if (!target.startsWith(root + path.sep)) return false;
        const rel = path.relative(root, target).split(path.sep);
        if (rel[0] === '.git' || rel[0] === '.instar') return false;
        try {
          const st = fs.statSync(target);
          return !Number.isFinite(createdMs) || st.mtimeMs > createdMs;
        } catch { return false; }
      }
      case 'commit': {
        if (!SHA_RE.test(ref.ref)) return false;
        if (!fs.existsSync(path.join(this.deps.projectDir, '.git'))) return null;
        const left = deadline - this.now();
        if (left <= 0) return null;
        try {
          const { stdout } = await execFile('git', ['-C', this.deps.projectDir, 'show', '-s', '--format=%ct', '--end-of-options', `${ref.ref}^{commit}`],
            { timeout: Math.min(2000, left), maxBuffer: 64 * 1024 });
          const ct = Number(String(stdout).trim().split('\n').pop()) * 1000;
          if (!Number.isFinite(ct)) return false;
          return !Number.isFinite(createdMs) || ct >= createdMs - CLOCK_SLACK_MS;
        } catch {
          // Not in THIS repo (the work may live in another repository), a
          // timeout, or no git: uncheckable here, stored as unresolved. Only a
          // commit that exists and PRE-DATES the promise is refused.
          return null;
        }
      }
      case 'message': {
        // ref = the message id; it must be the agent's own message in this
        // promise's conversation, sent after the promise was made.
        if (!this.deps.findMessage || typeof row.topicId !== 'number' || !/^\d{1,12}$/.test(ref.ref)) return null;
        const m = this.deps.findMessage(row.topicId, Number(ref.ref));
        if (!m) return null;
        return m.fromAgent && (!Number.isFinite(createdMs) || m.at > createdMs);
      }
      default:
        return null; // pr / other: not checkable offline
    }
  }

  async apply(runId: unknown, decisions: unknown): Promise<ApplyResult> {
    const cfg = this.deps.config();
    if (!cfg.enabled) throw new PromiseReviewError('promise-review-disabled', 'promise review is not enabled on this agent');
    if (typeof runId !== 'string' || !RUN_ID_RE.test(runId)) throw new PromiseReviewError('bad-request', 'runId must match [A-Za-z0-9._:-]{1,64}');
    if (!Array.isArray(decisions) || decisions.length === 0 || decisions.length > MAX_DECISIONS_PER_APPLY) {
      throw new PromiseReviewError('bad-request', `decisions must be a non-empty array of at most ${MAX_DECISIONS_PER_APPLY}`);
    }
    if (this.busy) throw new PromiseReviewError('review-apply-busy', 'another review apply is in progress');
    this.busy = true;
    try {
      return await this.applyInner(runId, decisions as ReviewDecision[], cfg);
    } finally {
      this.busy = false;
    }
  }

  private async applyInner(runId: string, decisions: ReviewDecision[], cfg: ResolvedPromiseReviewConfig): Promise<ApplyResult> {
    const tracker = this.deps.tracker;
    const atMs = this.now();
    const at = new Date(atMs).toISOString();
    const deadline = atMs + EVIDENCE_CHECK_BUDGET_MS;
    const results: DecisionResult[] = [];
    const isClosure = (d: ReviewDecision) => d && (d.action === 'deliver' || d.action === 'archive');
    const closingIds = new Set(decisions.filter(isClosure).map((d) => String(d.id)));
    const seenIds = new Set<string>();
    const evidenceUse = new Map<string, number>();


    type Plan = { d: ReviewDecision; row: Commitment; refResolved?: boolean | null };
    const planned: Array<{ plan?: Plan; result: DecisionResult; before?: Commitment; storePriority?: { priority: CommitmentPriority; reason?: string } }> = [];

    // ── Pass 1: validate (async evidence checks happen here, BEFORE any mutation) ──
    for (const raw of decisions) {
      const d = (raw ?? {}) as ReviewDecision;
      const id = typeof d.id === 'string' ? d.id : '';
      const action = String(d.action ?? '');
      const refuse = (refusal: string, row?: Commitment) => { planned.push({ result: { id, action, outcome: 'refused', refusal }, before: row }); };
      if (!id || seenIds.has(id)) { refuse(!id ? 'bad-id' : 'duplicate-decision'); continue; }
      seenIds.add(id);
      const row = tracker.get(id);
      if (!row || row.status !== 'pending') { refuse('not-own-pending'); continue; }
      if (!['keep', 'prioritize', 'deliver', 'archive'].includes(action)) { refuse('bad-action', row); continue; }
      if (d.priority !== undefined && !COMMITMENT_PRIORITIES.includes(d.priority)) { refuse('bad-priority', row); continue; }
      const reason = typeof d.reason === 'string' ? d.reason.trim() : '';
      const evidence = typeof d.evidence === 'string' ? d.evidence.trim() : '';
      const ref = d.evidenceRef && typeof d.evidenceRef === 'object'
        && PROMISE_EVIDENCE_KINDS.includes(d.evidenceRef.kind) && typeof d.evidenceRef.ref === 'string'
        && d.evidenceRef.ref.trim() && d.evidenceRef.ref.length <= 300
        ? { kind: d.evidenceRef.kind, ref: d.evidenceRef.ref.trim() } : undefined;
      if (d.evidenceRef !== undefined && !ref) { refuse('bad-evidence-ref', row); continue; }
      if (action === 'prioritize' && (!d.priority || reason.length < 8)) { refuse('prioritize-needs-priority-and-reason', row); continue; }
      // Wherever the review stores a priority, it states why.
      if (action === 'keep' && d.priority !== undefined && reason.length < 8) { refuse('prioritize-needs-priority-and-reason', row); continue; }
      // A row recorded high cannot be lowered without evidence.
      const downgrading = row.priority === 'high' && d.priority !== undefined && d.priority !== 'high';
      if (downgrading) {
        if (evidence.length < MIN_REASON || !ref) { refuse('high-downgrade-needs-evidence', row); continue; }
        const resolved = await this.resolveRef(row, ref, deadline);
        if (resolved !== true) { refuse('high-downgrade-needs-evidence', row); continue; }
      }

      if (action === 'keep' || action === 'prioritize') {
        planned.push({ plan: { d: { ...d, reason, evidence, evidenceRef: ref }, row }, result: { id, action, outcome: 'applied' }, before: row });
        continue;
      }

      // ── closures ──
      // A row on a minted (negative) conversation id cannot be reopened (its
      // binding is released on close), so the review never closes it: every
      // review closure must stay reversible.
      if (typeof row.topicId === 'number' && row.topicId < 0) { refuse('minted-topic-not-closable', row); continue; }
      // The priority must have been assessed by an EARLIER decision (stored), so
      // the model cannot label a first-seen row "low" and close it in one step.
      // A priority stored by THIS run (a second apply call with the same runId)
      // does not count either.
      // Gated on TIME, not on a runId the caller picks: the stored priority must
      // be at least an hour old, whoever set it (review, PATCH or POST).
      const prioritySetMs = Date.parse(row.prioritySetAt ?? '');
      const freshlySet = row.prioritySetAt !== undefined && (!Number.isFinite(prioritySetMs) || atMs - prioritySetMs < PRIORITY_SETTLE_MS);
      if (!row.priority || freshlySet) {
        // Keep the assessment the model offered, so the row can close next run.
        planned.push({ result: { id, action, outcome: 'refused', refusal: 'closure-needs-assessed-priority' }, before: row, ...(d.priority && COMMITMENT_PRIORITIES.includes(d.priority) && !row.priority && reason.length >= 8 ? { storePriority: { priority: d.priority, reason } } : {}) });
        continue;
      }
      if (row.type === 'behavioral' && action === 'deliver') { refuse('behavioral-never-delivered', row); continue; }
      if (row.type === 'behavioral' && action === 'archive' && d.kind !== 'superseded' && d.kind !== 'duplicate') { refuse('behavioral-needs-supersession', row); continue; }
      const waiting = row.priority === 'high' || d.priority === 'high' || row.everHigh === true || !!row.checkInAt;
      if (action === 'deliver' && (evidence.length < MIN_REASON || !ref)) { refuse('deliver-needs-evidence', row); continue; }
      if (action === 'archive') {
        if (!d.kind || !['superseded', 'duplicate', 'obsolete'].includes(d.kind)) { refuse('archive-needs-kind', row); continue; }
        if (reason.length < MIN_REASON) { refuse('archive-needs-reason', row); continue; }
        if (waiting && (evidence.length < MIN_REASON || !ref)) { refuse('waiting-needs-evidence', row); continue; }
        if (d.kind === 'duplicate' || d.kind === 'superseded') {
          const targetId = d.kind === 'duplicate' ? d.duplicateOf : d.supersededBy;
          const target = typeof targetId === 'string' ? tracker.get(targetId) : null;
          const targetOk = !!target && target.id !== row.id
            && ['pending', 'delivered', 'verified'].includes(target.status)
            && !closingIds.has(target.id)
            && (row.type !== 'behavioral' || (target.type === 'behavioral' && target.status === 'pending'));
          if (!targetOk) { refuse(d.kind === 'duplicate' ? 'duplicate-target-invalid' : 'supersede-target-invalid', row); continue; }
        }
      }
      // Repeated wording is a SIGNAL for the reader (audited), not a refusal:
      // several promises can legitimately share one completion.
      const evKey = (evidence || reason).toLowerCase().replace(/\s+/g, ' ');
      evidenceUse.set(evKey, (evidenceUse.get(evKey) ?? 0) + 1);
      // Outcome matrix: a reference is resolved (true), disproven (false) or
      // unverifiable here (null). Disproven is always refused. A waiting row
      // closes only on a RESOLVED reference; unverifiable proof keeps it open.
      let refResolved: boolean | null | undefined;
      if (ref) {
        refResolved = await this.resolveRef(row, ref, deadline);
        if (refResolved === false) { refuse('evidence-ref-unresolved', row); continue; }
      }
      if (waiting && refResolved !== true) { refuse('waiting-needs-resolved-evidence', row); continue; }
      planned.push({ plan: { d: { ...d, reason, evidence, evidenceRef: ref }, row, refResolved }, result: { id, action, outcome: 'applied', ...(ref ? { evidenceRefResolved: refResolved === true } : {}) }, before: row });
    }

    // ── Pass 2: apply (synchronous; each close re-checks pending inside the mutation) ──
    const counted = this.closureCounts(runId, cfg.closureDryRun);
    let runClosures = counted.run;
    let dayClosures = counted.day;

    tracker.withSaveBatch(() => {
      for (const p of planned) {
        const r = p.result;
        if (!p.plan) {
          // Refused: stamp so the same row does not spin back next run (not for missing / non-pending rows).
          if (r.refusal !== 'not-own-pending' && r.refusal !== 'bad-id' && r.refusal !== 'duplicate-decision' && p.before) {
            tracker.stampReview(r.id, { runId, at, shadowDecision: `refused:${r.refusal}`,
              ...(p.storePriority ? { priority: p.storePriority.priority, priorityReason: p.storePriority.reason, guard: (now) => !now.priority } : {}) });
          }
          continue;
        }
        const { d, row, refResolved } = p.plan;
        if (d.action === 'keep' || d.action === 'prioritize') {
          const s = tracker.stampReview(row.id, { runId, at, priority: d.priority, priorityReason: d.reason || undefined,
            guard: (now) => now.priority === row.priority && !!now.everHigh === !!row.everHigh });
          if (!s) { r.outcome = 'refused'; r.refusal = 'changed-under-review'; }
          continue;
        }
        // closure
        if (runClosures >= cfg.maxClosuresPerRun || dayClosures >= cfg.maxClosuresPerDay) {
          r.outcome = 'capped'; // NOT stamped: the row stays due for the next run
          continue;
        }
        const kindWord = d.action === 'deliver' ? 'delivered' : d.kind;
        const summary = d.action === 'deliver' ? d.evidence! : `${d.reason}${d.evidence ? ` (evidence: ${d.evidence})` : ''}`;
        if (cfg.closureDryRun) {
          // Shadow counts against the same caps, so shadow numbers predict a live run.
          const s = tracker.stampReview(row.id, { runId, at, shadowDecision: redact(`would-${d.action}:${kindWord}: ${summary}`, 300), shadowClosure: true });
          r.outcome = s ? 'would-apply' : 'refused';
          if (!s) r.refusal = 'changed-under-review';
          else { runClosures++; dayClosures++; }
          continue;
        }
        const target = d.kind === 'superseded' ? d.supersededBy : d.kind === 'duplicate' ? d.duplicateOf : undefined;
        const closed = tracker.closeByReview(row.id, {
          guard: (now) => now.priority === row.priority && !!now.everHigh === !!row.everHigh && now.checkInAt === row.checkInAt
            && (!target || ['pending', 'delivered', 'verified'].includes(tracker.get(target)?.status ?? '')),
          status: d.action === 'deliver' ? 'delivered' : 'withdrawn',
          resolution: d.action === 'deliver' ? `promise-review: ${d.evidence}` : `promise-review (${d.kind}): ${summary}`,
          runId,
          at,
          priority: d.priority,
          priorityReason: d.action === 'archive' ? undefined : d.reason || undefined,
          evidenceRef: d.evidenceRef,
          evidenceRefResolved: refResolved === true,
          supersededBy: d.kind === 'superseded' ? d.supersededBy : d.kind === 'duplicate' ? d.duplicateOf : undefined,
        });
        if (!closed) { r.outcome = 'refused'; r.refusal = 'changed-under-review'; continue; }
        runClosures++;
        dayClosures++;
      }
    });

    for (const p of planned) {
      const r = p.result;
      const d = p.plan?.d ?? ((decisions.find((x) => x && x.id === r.id) ?? {}) as ReviewDecision);
      const after = tracker.get(r.id);
      this.audit({
        feature: 'promiseReview', at, runId, id: r.id, action: r.action, outcome: r.outcome,
        ...(r.refusal ? { refusal: r.refusal } : {}),
        source: p.before?.source ?? null,
        type: p.before?.type ?? null,
        statusBefore: p.before?.status ?? null,
        statusAfter: after?.status ?? null,
        priorityBefore: p.before?.priority ?? null,
        priorityAfter: after?.priority ?? null,
        ...(r.action === 'deliver' || r.action === 'archive' ? { closure: true } : {}),
        ...((evidenceUse.get(((d.evidence || d.reason) ?? '').toLowerCase().replace(/\s+/g, ' ')) ?? 0) >= 3 ? { evidenceReused: true } : {}),
        ...(d.kind ? { kind: d.kind } : {}),
        ...(d.reason ? { reason: redact(d.reason, 500) } : {}),
        ...(d.evidence ? { evidence: redact(d.evidence, 500) } : {}),
        ...(d.evidenceRef ? { evidenceRef: { kind: d.evidenceRef.kind, ref: redact(d.evidenceRef.ref, 300) } } : {}),
        ...(r.evidenceRefResolved !== undefined ? { evidenceRefResolved: r.evidenceRefResolved } : {}),
        ...(d.duplicateOf ? { duplicateOf: d.duplicateOf } : {}),
        ...(d.supersededBy ? { supersededBy: d.supersededBy } : {}),
        closureDryRun: cfg.closureDryRun,
      });
      results.push(r);
    }
    const counts: Record<DecisionOutcome, number> = { applied: 0, refused: 0, capped: 0, 'would-apply': 0 };
    for (const r of results) counts[r.outcome]++;
    return { runId, closureDryRun: cfg.closureDryRun, results, counts };
  }

  reopen(id: string, reason: unknown): ReturnType<CommitmentTracker['reopenFromReview']> | { ok: false; error: 'reason-required' } {
    if (typeof reason !== 'string' || reason.trim().length < 4) return { ok: false, error: 'reason-required' };
    const cfg = this.deps.config();
    const before = this.deps.tracker.get(id);
    const out = this.deps.tracker.reopenFromReview(id, reason, cfg.reopenWindowDays, new Date(this.now()));
    this.audit({
      feature: 'promiseReview', at: new Date(this.now()).toISOString(), runId: null, id, action: 'reopen',
      outcome: out.ok ? 'applied' : 'refused', ...(out.ok ? {} : { refusal: out.error }),
      statusBefore: before?.status ?? null, statusAfter: out.ok ? 'pending' : before?.status ?? null,
      reason: redact(reason, 500),
    });
    return out;
  }
}
