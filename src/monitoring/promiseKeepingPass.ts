/**
 * promiseKeepingPass — the stateful half of promise keeping
 * (docs/specs/promise-keeping-before-the-deadline.md §3).
 *
 * Runs inside the check-in reminder pass. For each open, timed (or review
 * pick-up) promise this machine writes and speaks for, it decides with the
 * pure core in promiseKeepingCore which stage is owed, hands the work to a
 * session (notify a running one, or start one), and only as the last resort
 * sends the person one fixed message. It never awaits a session start: a
 * start is launched, recorded as a pending attempt, and settled later.
 */
import type { Commitment, CommitmentTracker } from './CommitmentTracker.js';
import {
  preDeadlineCheck,
  overdueStep,
  ladderTimeOf,
  nextBackoffAt,
  buildPromiseBootstrap,
  buildLastResortText,
  promiseWorkMaxLive,
  PENDING_ATTEMPT_TIMEOUT_MS,
  PENDING_SLOT_HOLD_MS,
  PROMISE_WORK_STARTS_PER_PASS,
  PARK_REVIEW_AFTER_MS,
  PROMISE_WORK_IDLE_RELEASE_MS,
  NO_TIME_MAX_ASKS,
  NO_TIME_ASK_SPACING_MS,
  NO_TIME_TOPICS_PER_PASS,
  NO_TIME_ROWS_PER_NOTICE,
  type HeldReason,
  type LastResortVariant,
  type BootstrapStage,
} from './promiseKeepingCore.js';
import {
  DEFAULT_LATE_TOPIC_COOLDOWN_MS,
  DEFAULT_MAX_LATE_TOPICS_PER_PASS,
  DEFAULT_MAX_LATE_TOPICS_PER_HOUR,
  LATE_NOTICE_MAX_ATTEMPTS,
} from './lateNoticeCore.js';

/** What a pickup did (§3.1). `pending` = a start was launched and will settle later. */
export type PickupOutcome =
  | { kind: 'notified' }
  | { kind: 'pending' }
  | { kind: 'started'; session: string }
  | { kind: 'held'; reason: HeldReason }
  | { kind: 'failed'; error: string };

export interface PickupRequest {
  topicId: number;
  bootstrap: string;
  attemptId: string;
  /** `promise-work:<ids>:<attemptId>` — recorded on a started session. */
  triggeredBy: string;
  /** False once this pass has used its start budget: the pickup may notify, never start. */
  mayStart: boolean;
  /** Second pickup: a live session idle (at prompt, no child process) since this time did not take the first notice. */
  stuckIfIdleSince?: string;
  /** Called once when a launched start settles. */
  onSettled: (outcome: Exclude<PickupOutcome, { kind: 'pending' }>) => void;
}

export interface PromiseKeepingDeps {
  tracker: Pick<CommitmentTracker, 'getAll' | 'mutate'>;
  /** Hand the work to a session (§3.1). Absent → nothing can be picked up. */
  pickUp?: (req: PickupRequest) => Promise<PickupOutcome>;
  /** Reconcile a timed-out attempt against the session registry, exited sessions included. */
  findAttemptSession?: (attemptId: string) => { session: string } | null;
  /** Live promise-work sessions that are working (output in the window) — for the live limit. */
  workingPromiseSessions?: () => number;
  maxSessions?: number;
  /** §3.7 no-time lane: is a session live for this conversation right now? */
  hasLiveSession?: (topicId: number) => boolean;
  /** Promise-work sessions running on this machine, with the promise ids they were started for. */
  listPromiseWorkSessions?: () => Array<{ tmuxSession: string; commitmentIds: string[]; idleSince?: string }>;
  /** End one, if the release rule's own guards allow it (§3.6). Returns true when ended. */
  releaseIfAllowed?: (tmuxSession: string) => boolean;
  /** Resolve an open reschedule intent (§3.4): replays the send under the intent's key. */
  resolveRescheduleIntent?: (c: Commitment) => Promise<unknown>;
  /** Delivered-or-failed send of the last resort (throws on held/quiet). */
  sendLastResort: (topicId: number, text: string, identity: { kind: 'late'; topicId: number; rows: Array<{ origin: string | null; id: string; time: string }> }) => Promise<void>;
  timeZone?: string | null;
  log?: (line: string) => void;
}

export interface PromiseKeepingReport {
  checksTaken: number;
  pickedUp: number;
  started: number;
  notified: number;
  pending: number;
  held: Partial<Record<HeldReason, number>>;
  failed: number;
  lastResortTopics: number;
  lastResortRows: number;
  lastResortByVariant: Partial<Record<LastResortVariant, number>>;
  lastResortHeldByCap: number;
  parkedAttempts: number;
  parkedHandedToReview: number;
  released: number;
  timeAsked: number;
  reconciledPending: number;
  skipped: Record<string, number>;
  errors: Array<{ id: string; error: string }>;
}

export function emptyPromiseKeepingReport(): PromiseKeepingReport {
  return {
    checksTaken: 0, pickedUp: 0, started: 0, notified: 0, pending: 0, held: {}, failed: 0,
    lastResortTopics: 0, lastResortRows: 0, lastResortByVariant: {}, lastResortHeldByCap: 0,
    parkedAttempts: 0, parkedHandedToReview: 0, released: 0, timeAsked: 0, reconciledPending: 0, skipped: {}, errors: [],
  };
}

type Unit = { stage: BootstrapStage; topicId: number; rows: Array<{ c: Commitment; time: string; noTime: boolean; kind: 'check' | 'pickup' | 'parked'; checkStage?: 'midpoint' | 'due-soon' }> };

export class PromiseKeepingPass {
  private startsThisPass = 0;
  constructor(
    private readonly deps: PromiseKeepingDeps,
    private readonly cfg: {
      selfMachineId?: string | null;
      epochMs: number;
      maxLateTopicsPerPass?: number;
      maxLateTopicsPerHour?: number;
      lateTopicCooldownMs?: number;
    },
  ) {}

  private log(line: string): void { (this.deps.log ?? console.log)(line); }

  private find(c: Commitment): Commitment {
    return (this.deps.tracker.getAll() as Commitment[]).find((x) => x.id === c.id && x.originMachineId === c.originMachineId) ?? c;
  }

  async run(now: number, rep: PromiseKeepingReport): Promise<void> {
    this.startsThisPass = 0;
    const self = this.cfg.selfMachineId;
    let all = this.deps.tracker.getAll() as Commitment[];

    // 0. Reschedule intents left open (crash residue): resolve before any stage is evaluated.
    if (this.deps.resolveRescheduleIntent) {
      for (const c of all) {
        const it = c.rescheduleIntent;
        if (!it || c.status !== 'pending') continue;
        if (self && (c.originMachineId ?? self) !== self) continue;
        if (now - Date.parse(it.at) < 2 * 60_000) continue; // the route itself is still resolving it
        try { await this.deps.resolveRescheduleIntent(c); } catch (err) { rep.errors.push({ id: c.id, error: `reschedule-resolve: ${err}` }); }
      }
      all = this.deps.tracker.getAll() as Commitment[];
    }

    // 1. Reconcile timed-out pending attempts (§3.1 crash safety).
    for (const c of all) {
      const pa = c.pendingAttempt;
      if (!pa || pa.timedOutAt) continue;
      const age = now - Date.parse(pa.at);
      if (!(age >= PENDING_ATTEMPT_TIMEOUT_MS)) continue;
      const hit = this.deps.findAttemptSession?.(pa.id) ?? null;
      try {
        if (hit) {
          await this.applyOutcome(c, pa.id, pa.gen, pa.stage, { kind: 'started', session: hit.session }, now, rep);
        } else {
          // Failed for the ladder; the slot stays reserved until the registry or the settle says otherwise.
          await this.deps.tracker.mutate(c.id, (cur) => (cur.pendingAttempt?.id === pa.id
            ? { ...cur, pendingAttempt: { ...pa, timedOutAt: new Date(now).toISOString() }, ...(pa.stage === 'overdue' ? { ...this.countFailed(cur, pa.gen, now), ...this.backoffIfParked(cur, pa.gen, now) } : {}) }
            : cur));
          rep.failed++;
        }
        rep.reconciledPending++;
      } catch (err) {
        rep.errors.push({ id: c.id, error: `reconcile: ${err}` });
      }
    }
    all = this.deps.tracker.getAll() as Commitment[];

    // 2. Work units: pre-deadline checks and overdue pickups, grouped per conversation and stage.
    const units = new Map<string, Unit>();
    const lastResort = new Map<number, Array<{ c: Commitment; time: string; noTime: boolean; variant: LastResortVariant }>>();
    const add = (stage: BootstrapStage, topicId: number, row: Unit['rows'][number]) => {
      const key = `${topicId}:${stage}`;
      const u = units.get(key) ?? { stage, topicId, rows: [] };
      u.rows.push(row);
      units.set(key, u);
    };
    for (const c of all) {
      const chk = preDeadlineCheck(c, now, self);
      if (chk.due) { add(chk.stage, c.topicId as number, { c, time: chk.time, noTime: false, kind: 'check', checkStage: chk.stage }); continue; }
      const step = overdueStep({ c, nowMs: now, selfMachineId: self, epochMs: this.cfg.epochMs, movedSincePickup: false });
      if (step.act === 'pickup') add('overdue', c.topicId as number, { c, time: step.time, noTime: step.noTime, kind: 'pickup' });
      else if (step.act === 'parked-attempt') add('overdue', c.topicId as number, { c, time: step.time, noTime: step.noTime, kind: 'parked' });
      else if (step.act === 'last-resort') {
        const g = lastResort.get(c.topicId as number) ?? [];
        g.push({ c, time: step.time, noTime: step.noTime, variant: step.variant });
        lastResort.set(c.topicId as number, g);
      } else {
        const r = chk.due ? 'n/a' : (step.act === 'none' ? step.reason : 'n/a');
        rep.skipped[r] = (rep.skipped[r] ?? 0) + 1;
      }
    }

    // Order: timed rows before no-time and parked rows; earliest time first.
    const rank = (u: Unit) => {
      const r = u.rows[0];
      const parked = u.rows.every((x) => x.kind === 'parked') ? 2 : 0;
      const noTime = u.rows.every((x) => x.noTime) ? 1 : 0;
      return [parked + noTime, Math.min(...u.rows.map((x) => Date.parse(x.time)))] as const;
    };
    const ordered = [...units.values()].sort((a, b) => { const ra = rank(a), rb = rank(b); return ra[0] - rb[0] || ra[1] - rb[1]; });

    let parkedStartsToday = (this.deps.tracker.getAll() as Commitment[])
      .filter((c) => c.parkedAt && Number.isFinite(Date.parse(c.pickedUpAt ?? '')) && now - Date.parse(c.pickedUpAt as string) < 24 * 60 * 60_000).length;
    for (const u of ordered) {
      if (u.rows.every((x) => x.kind === 'parked')) {
        const cap = promiseWorkMaxLive(this.deps.maxSessions ?? 10);
        if (parkedStartsToday >= cap) { rep.held['promise-limit'] = (rep.held['promise-limit'] ?? 0) + 1; continue; }
        parkedStartsToday++;
      }
      await this.pickUpUnit(u, now, rep);
    }

    // 3. Parked rows past 7 days → handed to the promise review (once).
    for (const c of this.deps.tracker.getAll() as Commitment[]) {
      if (!c.parkedAt || c.parkReviewHandedAt || c.status !== 'pending') continue;
      if (now - Date.parse(c.parkedAt) < PARK_REVIEW_AFTER_MS) continue;
      try {
        await this.deps.tracker.mutate(c.id, (cur) => ({ ...cur, parkReviewHandedAt: new Date(now).toISOString() }));
        rep.parkedHandedToReview++;
      } catch (err) { rep.errors.push({ id: c.id, error: `park-review: ${err}` }); }
    }

    // 3a. No-time lane (§3.7): running sessions only, never a start, never the person.
    if (this.deps.pickUp && this.deps.hasLiveSession) {
      const byTopic = new Map<number, Commitment[]>();
      for (const c of this.deps.tracker.getAll() as Commitment[]) {
        if (c.status !== 'pending' || c.softDeadlineAt || c.firstPromisedAt || c.pickupRequestedAt) continue;
        if (c.type === 'behavioral' || typeof c.topicId !== 'number' || c.topicId <= 0) continue;
        if (c.owner === 'user' || c.blockedOn === 'user-input' || c.blockedOn === 'user-authorization') continue;
        if (self && ((c.ownerMachineId ?? c.originMachineId) !== self || (c.originMachineId && c.originMachineId !== self))) continue;
        if ((c.timeAskedCount ?? 0) >= NO_TIME_MAX_ASKS) continue;
        const last = Date.parse(c.timeAskedAt ?? '');
        if (Number.isFinite(last) && now - last < NO_TIME_ASK_SPACING_MS) continue;
        const g = byTopic.get(c.topicId) ?? [];
        g.push(c);
        byTopic.set(c.topicId, g);
      }
      let topics = 0;
      for (const [topicId, rows] of byTopic) {
        if (topics >= NO_TIME_TOPICS_PER_PASS) break;
        if (!this.deps.hasLiveSession(topicId)) continue;
        const picked = rows.slice(0, NO_TIME_ROWS_PER_NOTICE);
        const attemptId = `nt-${now.toString(36)}-${topicId}`;
        let o: PickupOutcome;
        try {
          o = await this.deps.pickUp({
            topicId,
            bootstrap: buildPromiseBootstrap({ stage: 'no-time', rows: picked.map((c) => ({ id: c.id, origin: c.originMachineId ?? null, noTime: true, agentResponse: c.agentResponse })), timeZone: this.deps.timeZone }),
            attemptId,
            triggeredBy: `promise-work:${picked.map((c) => c.id).join('+')}:${attemptId}`,
            mayStart: false,
            onSettled: () => { /* notify-only: never launches a start */ },
          });
        } catch (err) { o = { kind: 'failed', error: String(err) }; }
        topics++;
        if (o.kind !== 'notified') continue;
        const iso = new Date(now).toISOString();
        for (const c of picked) {
          await this.deps.tracker.mutate(c.id, (cur) => ({ ...cur, timeAskedCount: (cur.timeAskedCount ?? 0) + 1, timeAskedAt: iso }))
            .catch((err) => rep.errors.push({ id: c.id, error: `no-time-stamp: ${err}` }));
        }
        rep.timeAsked += picked.length;
      }
    }

    // 3b. Release finished promise work (§3.6): promise closed, rescheduled or parked; idle at its
    // prompt with no child process for 30 minutes; the rest of the guards are in releaseIfAllowed.
    if (this.deps.listPromiseWorkSessions && this.deps.releaseIfAllowed) {
      const rows = this.deps.tracker.getAll() as Commitment[];
      for (const sess of this.deps.listPromiseWorkSessions()) {
        const idle = Date.parse(sess.idleSince ?? '');
        if (!Number.isFinite(idle) || now - idle < PROMISE_WORK_IDLE_RELEASE_MS) continue;
        const finished = sess.commitmentIds.length > 0 && sess.commitmentIds.every((id) => {
          const c = rows.find((x) => x.id === id);
          if (!c) return false;
          if (c.status !== 'pending') return true;
          if (c.parkedAt) return true;
          const moved = Date.parse(c.lastTimeMoveAt ?? '');
          return Number.isFinite(moved) && moved >= idle - PROMISE_WORK_IDLE_RELEASE_MS;
        });
        if (!finished) continue;
        try { if (this.deps.releaseIfAllowed(sess.tmuxSession)) rep.released++; }
        catch (err) { rep.errors.push({ id: sess.tmuxSession, error: `release: ${err}` }); }
      }
    }

    // 4. Last resort, combined per conversation and capped (parent spec caps, per machine).
    await this.sendLastResorts(lastResort, now, rep);
  }

  private countFailed(cur: Commitment, gen: string, now: number): Partial<Commitment> {
    const same = cur.attemptsFor === gen;
    return {
      attemptsFor: gen,
      failedAttempts: (same ? (cur.failedAttempts ?? 0) : 0) + 1,
      ...(same ? {} : { heldCounts: {} }),
      // firstHeldAt = the first unsuccessful attempt for this time (held OR failed).
      firstHeldAt: (same && cur.firstHeldAt) || new Date(now).toISOString(),
    };
  }

  /** After the last resort, a timed-out attempt advances the backoff like any other attempt. */
  private backoffIfParked(cur: Commitment, gen: string, now: number): Partial<Commitment> {
    if (cur.lateNoticeFor !== gen) return {};
    const b = nextBackoffAt(cur, now);
    return { nextAttemptAt: new Date(b.at).toISOString(), backoffStep: b.step, ...(b.parked && !cur.parkedAt ? { parkedAt: new Date(now).toISOString() } : {}) };
  }

  private countHeld(cur: Commitment, gen: string, reason: HeldReason, now: number): Partial<Commitment> {
    const same = cur.attemptsFor === gen;
    const counts = { ...(same ? cur.heldCounts ?? {} : {}) };
    counts[reason] = (counts[reason] ?? 0) + 1;
    return { attemptsFor: gen, heldCounts: counts, ...(same ? {} : { failedAttempts: 0 }), firstHeldAt: (same && cur.firstHeldAt) || new Date(now).toISOString() };
  }

  /* @self-action-controller: promise-keeping-pickup */
  private async pickUpUnit(u: Unit, now: number, rep: PromiseKeepingReport): Promise<void> {
    const attemptId = `pk-${now.toString(36)}-${u.topicId}-${u.stage}`;
    const bootstrap = buildPromiseBootstrap({
      stage: u.stage,
      rows: u.rows.map((r) => ({ id: r.c.id, origin: r.c.originMachineId ?? null, time: r.noTime ? null : r.time, noTime: r.noTime, agentResponse: r.c.agentResponse })),
      timeZone: this.deps.timeZone,
    });
    if (!this.deps.pickUp) {
      for (const r of u.rows) await this.recordOutcome(r, attemptId, u.stage, { kind: 'held', reason: 'capacity' }, now, rep);
      return;
    }
    const maxLive = promiseWorkMaxLive(this.deps.maxSessions ?? 10);
    const working = this.deps.workingPromiseSessions?.() ?? 0;
    // A timed-out start keeps its slot for PENDING_SLOT_HOLD_MS more, in case it settles late (§3.1).
    const pending = (this.deps.tracker.getAll() as Commitment[]).filter((c) => {
      const pa = c.pendingAttempt;
      if (!pa) return false;
      if (!pa.timedOutAt) return true;
      return now - Date.parse(pa.timedOutAt) < PENDING_SLOT_HOLD_MS;
    }).length;
    const mayStart = this.startsThisPass < PROMISE_WORK_STARTS_PER_PASS && working + pending < maxLive;
    // Write the pending attempt before anything can start (crash safety).
    for (const r of u.rows) {
      try {
        await this.deps.tracker.mutate(r.c.id, (cur) => ({ ...cur, pendingAttempt: { id: attemptId, stage: r.kind === 'check' ? (r.checkStage as string) : 'overdue', gen: r.time, at: new Date(now).toISOString() } }));
      } catch (err) { rep.errors.push({ id: r.c.id, error: `pending-write: ${err}` }); }
    }
    let outcome: PickupOutcome;
    try {
      outcome = await this.deps.pickUp({
        topicId: u.topicId,
        bootstrap,
        attemptId,
        triggeredBy: `promise-work:${u.rows.map((r) => r.c.id).join('+')}:${attemptId}`,
        mayStart,
        ...(() => {
          const prior = u.rows.map((r) => (r.kind === 'pickup' && r.c.pickupFor === r.time ? r.c.pickedUpAt : undefined)).filter(Boolean) as string[];
          return prior.length ? { stuckIfIdleSince: prior.sort()[prior.length - 1] } : {};
        })(),
        onSettled: (o) => {
          void (async () => {
            for (const r of u.rows) {
              const cur = this.find(r.c);
              if (cur.pendingAttempt?.id !== attemptId) continue;
              await this.applyOutcome(cur, attemptId, r.time, cur.pendingAttempt.stage, o, Date.now(), rep).catch((err) => this.log(`[promise-keeping] settle ${r.c.id}: ${err}`));
            }
          })();
        },
      });
    } catch (err) {
      outcome = { kind: 'failed', error: String(err) };
    }
    if (outcome.kind === 'pending') {
      this.startsThisPass++;
      rep.pending++;
      return;
    }
    for (const r of u.rows) await this.recordOutcome(r, attemptId, u.stage, outcome, now, rep);
  }

  private async recordOutcome(r: Unit['rows'][number], attemptId: string, stage: BootstrapStage, o: Exclude<PickupOutcome, { kind: 'pending' }>, now: number, rep: PromiseKeepingReport): Promise<void> {
    const cur = this.find(r.c);
    await this.applyOutcome(cur, attemptId, r.time, r.kind === 'check' ? (r.checkStage as string) : stage, o, now, rep);
  }

  /** Apply a settled outcome to a row — only when the row's time still matches the attempt's generation. */
  private async applyOutcome(c: Commitment, attemptId: string, gen: string, stage: string, o: Exclude<PickupOutcome, { kind: 'pending' }>, now: number, rep: PromiseKeepingReport): Promise<void> {
    const iso = new Date(now).toISOString();
    await this.deps.tracker.mutate(c.id, (cur) => {
      const clear = cur.pendingAttempt?.id === attemptId ? { pendingAttempt: undefined } : {};
      const lt = ladderTimeOf(cur);
      if (!lt || lt.iso !== gen || cur.status !== 'pending') return { ...cur, ...clear }; // superseded: no-op
      // After the last resort every attempt, taken or not, advances the backoff (then daily).
      const afterLastResort = cur.lateNoticeFor === gen && stage === 'overdue';
      const b = afterLastResort ? nextBackoffAt(cur, now) : null;
      const backoff = b ? { nextAttemptAt: new Date(b.at).toISOString(), backoffStep: b.step, ...(b.parked && !cur.parkedAt ? { parkedAt: iso } : {}) } : {};
      if (o.kind === 'notified' || o.kind === 'started') {
        if (stage === 'midpoint') return { ...cur, ...clear, midpointCheckFor: gen };
        if (stage === 'due-soon') return { ...cur, ...clear, dueSoonNudgeFor: gen };
        const same = cur.pickupFor === gen;
        return { ...cur, ...clear, ...backoff, pickupFor: gen, pickedUpAt: iso, pickups: (same ? (cur.pickups ?? 0) : 0) + 1 };
      }
      if (o.kind === 'held') return { ...cur, ...clear, ...backoff, ...(stage === 'overdue' ? this.countHeld(cur, gen, o.reason, now) : {}) };
      return { ...cur, ...clear, ...backoff, ...(stage === 'overdue' ? this.countFailed(cur, gen, now) : {}) };
    });
    if (o.kind === 'notified') { rep.notified++; if (stage === 'overdue') rep.pickedUp++; else rep.checksTaken++; }
    else if (o.kind === 'started') { rep.started++; if (stage === 'overdue') rep.pickedUp++; else rep.checksTaken++; }
    else if (o.kind === 'held') rep.held[o.reason] = (rep.held[o.reason] ?? 0) + 1;
    else { rep.failed++; rep.errors.push({ id: c.id, error: `pickup-failed: ${o.error}` }); }
  }

  private async sendLastResorts(groups: Map<number, Array<{ c: Commitment; time: string; noTime: boolean; variant: LastResortVariant }>>, now: number, rep: PromiseKeepingReport): Promise<void> {
    if (groups.size === 0) return;
    const self = this.cfg.selfMachineId;
    const all = this.deps.tracker.getAll() as Commitment[];
    const cooldown = this.cfg.lateTopicCooldownMs ?? DEFAULT_LATE_TOPIC_COOLDOWN_MS;
    const perPass = this.cfg.maxLateTopicsPerPass ?? DEFAULT_MAX_LATE_TOPICS_PER_PASS;
    const perHour = this.cfg.maxLateTopicsPerHour ?? DEFAULT_MAX_LATE_TOPICS_PER_HOUR;
    const lastSent = new Map<number, number>();
    for (const c of all) {
      const t = Date.parse(c.lateNoticeSentAt ?? '');
      if (!Number.isFinite(t) || typeof c.topicId !== 'number') continue;
      if (self && (c.ownerMachineId ?? c.originMachineId) !== self) continue;
      if (t > (lastSent.get(c.topicId) ?? 0)) lastSent.set(c.topicId, t);
    }
    let thisHour = [...lastSent.values()].filter((t) => now - t < 60 * 60_000).length;
    let thisPass = 0;
    const ordered = [...groups.entries()].sort((a, b) => Math.min(...a[1].map((x) => Date.parse(x.time))) - Math.min(...b[1].map((x) => Date.parse(x.time))));
    for (const [topicId, rows] of ordered) {
      const last = lastSent.get(topicId);
      if ((last !== undefined && now - last < cooldown) || thisPass >= perPass || thisHour >= perHour) { rep.lastResortHeldByCap++; continue; }
      // Count an attempt first (bounded, never a silent give-up).
      const kept: typeof rows = [];
      for (const r of rows) {
        try {
          await this.deps.tracker.mutate(r.c.id, (cur) => {
            const same = cur.lateAttemptsFor === r.time;
            return { ...cur, lateAttemptsFor: r.time, lateAttempts: (same ? (cur.lateAttempts ?? 0) : 0) + 1 };
          });
          kept.push(r);
        } catch (err) { rep.errors.push({ id: r.c.id, error: `last-resort-attempt: ${err}` }); }
      }
      if (kept.length === 0) continue;
      const text = buildLastResortText(kept.map((r) => ({ time: r.time, noTime: r.noTime, agentResponse: r.c.agentResponse, userRequest: r.c.userRequest, variant: r.variant })), this.deps.timeZone);
      const identity = { kind: 'late' as const, topicId, rows: kept.map((r) => ({ origin: r.c.originMachineId ?? null, id: r.c.id, time: r.time })).sort((a, b) => (a.id + a.time).localeCompare(b.id + b.time)) };
      try {
        await this.deps.sendLastResort(topicId, text, identity);
      } catch (err) {
        rep.errors.push({ id: kept.map((k) => k.c.id).join(','), error: String(err) });
        for (const k of kept) {
          const cur = this.find(k.c);
          if (cur.lateAttemptsFor === k.time && (cur.lateAttempts ?? 0) >= LATE_NOTICE_MAX_ATTEMPTS) {
            await this.deps.tracker.mutate(k.c.id, (x) => ({ ...x, lateNoticeFailedAt: new Date(now).toISOString() })).catch(() => { /* @silent-fallback-ok — in the pass report already */ });
            this.log(`[promise-keeping] GIVING UP on the last-resort message for ${k.c.id} after ${cur.lateAttempts} attempts — UNDELIVERED`);
          }
        }
        continue;
      }
      const sentAt = new Date(now).toISOString();
      for (const k of kept) {
        try {
          await this.deps.tracker.mutate(k.c.id, (cur) => {
            // First post-last-resort attempt waits interval × 2 (backoff step 1).
            const b = nextBackoffAt({ ...cur, backoffStep: 0 }, now);
            return { ...cur, lateNoticeFor: k.time, lateNoticeSentAt: sentAt, lateNoticeCount: (cur.lateNoticeCount ?? 0) + 1, backoffStep: b.step, nextAttemptAt: new Date(b.at).toISOString() };
          });
          rep.lastResortRows++;
          rep.lastResortByVariant[k.variant] = (rep.lastResortByVariant[k.variant] ?? 0) + 1;
        } catch (err) { rep.errors.push({ id: k.c.id, error: `last-resort-sent-but-unstamped: ${err}` }); }
      }
      rep.lastResortTopics++;
      thisPass++;
      thisHour++;
    }
  }
}
