/**
 * JobAnomalyPusher — status line, then push (docs/specs/job-cost-reduction.md
 * §5.3–§5.4). A ScriptRunObserver for script jobs that declare `anomalies`.
 *
 * Per completed run:
 *   - A `skipped` or `failed` run is NEUTRAL for episodes: it neither breaks
 *     nor advances one (coverage is rolling). Failures alert only through the
 *     existing `alertOnConsecutiveFailures` path, never here.
 *   - A successful run's reason set (its declared `JOB_ANOMALY` kinds) opens or
 *     refreshes one episode per `<machineId>:<slug>:<reason id>`; an open
 *     episode absent from 3 successful runs in a row closes and its calm item
 *     is cleared.
 *   - CRITICAL reasons push on the same run (notify-and-heal). RECOVERABLE
 *     reasons raise one calm attention item on first sight (low, the job slug as
 *     source, conditionKey `job-anomaly:<machineId>:<reason id>`); at 6 h of
 *     persistence a heal attempt (one triage session) is requested, and the
 *     persistence push goes out once it settles, or at the hard deadline
 *     (6 h + 30 min + one cron interval) saying "investigation outcome unknown".
 *     3 episodes of one reason inside 6 h push once as "keeps recurring" and
 *     mute that reason's recurrence/persistence pushes for 24 h. Critical
 *     reasons are never muted. No owner item ever suppresses a push.
 *   - All pushes due on one run go out as ONE message: one narrator summary,
 *     one deterministic status line per reason, one verbatim evidence block.
 *   - "Pushed" means a CONFIRMED delivery (a Telegram message id). A failed or
 *     unknown send leaves the episode unpushed; it is retried with growing
 *     spacing (1, 2, 4, 8 runs, then hourly), and the 6th failed attempt raises
 *     one high `job-anomaly-undelivered:<machineId>` item.
 *   - A critical push goes out BEFORE the episode store and audit are written;
 *     a failed store write never blocks it, and an in-memory record keeps the
 *     one-push-per-episode limit for this process.
 *
 * Delivery goes through the automation reply chokepoint (producer
 * `job-anomaly`), never `sendToTopic` directly: a tone-gate ADVISORY is
 * answered once with an honest ack; a BLOCK drops the evidence block and sends
 * the fixed sentence plus a private-view link through the deterministic
 * topic-send path (no link with no tunnel, or for a credential-wall block).
 *
 * Audit: reason ids, classes, transitions and outcomes only — never raw output.
 */

import { Cron } from 'croner';
import type { JobDefinition } from '../core/types.js';
import type { AnomalyDecl, ParsedScriptRun } from './jobScriptProtocol.js';
import type { ScriptRunContext, ScriptRunObserver } from './scriptRunObservers.js';
import {
  type AnomalyEpisode,
  type JobAnomalyEpisodeStore,
  type PushKind,
  EPISODE_CLOSE_CLEAN_RUNS,
} from './JobAnomalyEpisodeStore.js';
import {
  type JobAnomalyNarrator,
  type Narration,
  fallbackSentence,
  renderEvidenceBlock,
} from './JobAnomalyNarrator.js';
import type { OriginAutomationAuthor } from '../messaging/telegram-origin/OriginAutomationAuthor.js';

export const PERSISTENCE_MS = 6 * 60 * 60 * 1000;
export const TRIAGE_SESSION_CAP_MS = 30 * 60 * 1000;
export const RETRY_SPACING_RUNS = [1, 2, 4, 8] as const;
export const RETRY_HOURLY_MS = 60 * 60 * 1000;
export const UNDELIVERED_AFTER_ATTEMPTS = 6;
export const PRODUCER_ID = 'job-anomaly';
export const ADVISORY_ACK_REASON = 'deterministic evidence block the operator must see verbatim';
/** How long a run waits in-line for a heal request to settle before moving on. */
export const HEAL_INLINE_GRACE_MS = 2_000;
const REASON_ID_RE = /^[A-Za-z0-9_.:/-]{1,96}$/;

/** §5.3 owners of each reason's heal (named in the calm item; never a heal state). */
export function ownerFor(reasonId: string): string {
  if (reasonId === 'sessions-exhausted') return 'the session reaper and the resume queue';
  if (reasonId === 'llm-unreliable') return 'the provider circuit breakers and the failure swap';
  if (reasonId.startsWith('degradation:')) return `the subsystem that reported it (${reasonId.slice('degradation:'.length)})`;
  if (reasonId === 'undelivered-reminders') return 'the reminder service (its retries are already exhausted)';
  return 'no owner';
}

/** Shape of the HTTP response `sendAutomationReply` returns (a fetch Response). */
export interface ReplyResponseLike { ok: boolean; status: number; json(): Promise<unknown> }

export type HealAttemptResult = 'ran' | 'disabled' | `refused:${string}`;

export interface AttentionRaise {
  id: string;
  title: string;
  summary: string;
  description?: string;
  category: string;
  priority: 'LOW' | 'HIGH';
  /** The attention `source` (POST /attention maps `source` → sourceContext). */
  sourceContext: string;
  conditionKey: string;
}

export interface AuditSink { append(row: Record<string, unknown>): void }

export interface JobAnomalyPusherDeps {
  store: JobAnomalyEpisodeStore;
  narrator: JobAnomalyNarrator;
  /** This machine's id (used when a run context carries none). */
  machineId: string;
  /** Machine nickname for the operator-facing text. Default: the id. */
  machineName?: (machineId: string) => string;
  now?: () => number;
  /** Raise one attention item (TelegramAdapter.createAttentionItem). */
  raiseAttention: (item: AttentionRaise) => Promise<unknown> | unknown;
  /** Close by conditionKey (TelegramAdapter.clearAttentionCondition / POST /attention/clear). */
  clearAttention: (conditionKey: string, resolution: string) => Promise<unknown> | unknown;
  /** The server.ts `sendAutomationReply` closure (postOriginAutomationReply). */
  sendAutomationReply: (producerId: string, topicId: number, body: Record<string, unknown>,
    author?: OriginAutomationAuthor, logicalSendId?: string) => Promise<ReplyResponseLike>;
  /** The deterministic topic-send path the cold-start lifeline notice uses. Resolves with the message id. */
  sendDeterministicTopic: (topicId: number, text: string) => Promise<{ messageId?: number } | null | undefined>;
  /** PrivateViewer.create → the new view's id. Absent ⇒ no link. */
  createPrivateView?: (title: string, markdown: string) => { id: string } | null;
  /** Shared viewTunnelUrl() — null with no tunnel. */
  viewTunnelUrl?: (viewId: string) => string | null;
  /** The job's existing topic, lazily created when missing (as notifyJobComplete does). Null ⇒ none. */
  ensureJobTopic: (job: JobDefinition) => Promise<number | null>;
  /** Request one triage session for the episode; resolves when the attempt SETTLES
   *  ('ran' = the session ran and ended; refusals resolve at once). Absent ⇒ refused:triage-disabled. */
  requestHealAttempt?: (episode: AnomalyEpisode) => Promise<HealAttemptResult>;
  /** Persisted triage outcome reader; reconnects a requested heal after restart. */
  readHealOutcome?: (episodeId: string) => HealAttemptResult | null;
  /** `jobs.scriptTriage.enabled`, read live. Default: true when requestHealAttempt is given. */
  triageEnabled?: () => boolean;
  /** Cron interval of a job in ms (default: from its schedule via croner). */
  intervalFor?: (job: JobDefinition) => number | null;
  /** Job lookup for the tick's stale expiry. */
  jobBySlug?: (slug: string) => JobDefinition | undefined;
  /** logs/job-anomaly.jsonl (BoundedJsonlAudit). */
  audit?: AuditSink;
  /** Canary (§5.6.4): bound to a runId, writes the push to the audit, never sends. */
  auditOnlyRunId?: string;
  /** In-run wait for a heal request to settle. Default 2 s. */
  healInlineGraceMs?: number;
  log?: (msg: string) => void;
}

export interface PushRecord {
  kinds: Array<{ episodeId: string; reasonId: string; kind: PushKind }>;
  text: string;
  outcome: 'delivered' | 'not-delivered' | 'audit-only' | 'suppressed' | 'no-topic';
  path?: 'reply' | 'advisory-ack' | 'view-link' | 'jobs-tab';
  narration: Narration['source'];
}

export interface RunReport {
  slug: string;
  neutral: boolean;
  transitions: Array<{ reasonId: string; transition: string }>;
  calmRaised: string[];
  calmCleared: string[];
  push: PushRecord | null;
  undeliveredRaised: boolean;
}

export interface PreparedAnomalyRun {
  input: { job: JobDefinition; machineId: string | null; runId: string; parsed: ParsedScriptRun };
  report: RunReport;
  machineId: string;
  at: number;
  runN: number;
  calmRaises: AnomalyEpisode[];
  calmClears: Array<{ ep: AnomalyEpisode; resolution: string }>;
  /** Capture critical episodes before a later run can close them. */
  criticalDue: AnomalyEpisode[];
  candidateEpisodeIds: Set<string>;
  transitionEpisodeIds: Map<string, string>;
}

/** Cron interval from two consecutive fire times. Null when unparseable. */
export function cronIntervalMs(schedule: string | undefined, from: Date = new Date()): number | null {
  if (!schedule) return null;
  try {
    const c = new Cron(schedule);
    const runs = c.nextRuns(2, from);
    c.stop();
    if (runs.length < 2) return null;
    return runs[1].getTime() - runs[0].getTime();
  } catch {
    // @silent-fallback-ok: an unparseable schedule never expires episodes (fail toward keeping them).
    return null;
  }
}

function declaredKinds(job: JobDefinition): AnomalyDecl[] {
  const decls = (job as JobDefinition & { anomalies?: AnomalyDecl[] }).anomalies;
  return Array.isArray(decls) ? decls : [];
}

function declares(decls: AnomalyDecl[], kind: string): AnomalyDecl | undefined {
  return decls.find(d => d.kind === kind || (d.kind.endsWith(':*') && kind.startsWith(d.kind.slice(0, -1))));
}

export class JobAnomalyPusher implements ScriptRunObserver {
  private readonly d: JobAnomalyPusherDeps;
  private readonly now: () => number;
  private chain: Promise<unknown> = Promise.resolve();
  /** In-memory record of pushed `<episode id>:<kind>` — holds the one-push limit when writes fail. */
  private readonly pushedInMemory = new Set<string>();
  /** Narration reuse across retries: re-narrate only when severity/evidence changed. */
  private readonly narrationCache = new Map<string, { fingerprint: string; narration: Narration }>();

  constructor(deps: JobAnomalyPusherDeps) {
    this.d = deps;
    this.now = deps.now ?? Date.now;
  }

  /** ScriptRunObserver: ignores canary runs and jobs without declared anomalies. */
  onScriptRunCompleted(ctx: ScriptRunContext): Promise<void> {
    if (ctx.canary) return Promise.resolve();
    if (declaredKinds(ctx.job).length === 0) return Promise.resolve();
    return this.processRun({ job: ctx.job, machineId: ctx.machineId, runId: ctx.runId, parsed: ctx.parsed })
      .then(() => undefined, (err) => { this.log(`[JobAnomalyPusher] run failed: ${(err as Error).message}`); });
  }

  /** Observe immediately, then serialize external effects. Exposed for canaries and tests. */
  processRun(input: { job: JobDefinition; machineId: string | null; runId: string; parsed: ParsedScriptRun }): Promise<RunReport> {
    return this.dispatchPrepared(this.prepareRun(input));
  }

  /** Record the run and open episodes synchronously, before any network send or narration. */
  prepareRun(input: { job: JobDefinition; machineId: string | null; runId: string; parsed: ParsedScriptRun }): PreparedAnomalyRun {
    const { job, parsed } = input;
    const store = this.d.store;
    const machineId = input.machineId ?? this.d.machineId;
    const at = this.now();
    const runN = store.recordRun(job.slug, at);
    const neutral = parsed.result !== 'success';
    const report: RunReport = { slug: job.slug, neutral, transitions: [], calmRaised: [], calmCleared: [], push: null, undeliveredRaised: false };
    const calmRaises: AnomalyEpisode[] = [];
    const calmClears: Array<{ ep: AnomalyEpisode; resolution: string }> = [];
    const transitionEpisodeIds = new Map<string, string>();

    if (!neutral) {
      const decls = declaredKinds(job);
      const seen = new Map<string, { kind: string; severity: 1 | 2 | 3; evidence: string; class: 'critical' | 'recoverable' }>();
      for (const a of parsed.anomalies) {
        if (!REASON_ID_RE.test(a.kind)) continue;
        const decl = declares(decls, a.kind);
        if (!decl) continue;
        const prev = seen.get(a.kind);
        if (!prev || a.severity > prev.severity) seen.set(a.kind, { kind: a.kind, severity: a.severity, evidence: a.evidence, class: decl.class });
      }
      const present = new Set<string>();
      for (const r of seen.values()) {
        const key = store.key(machineId, job.slug, r.kind);
        present.add(key);
        const existing = store.get(key);
        if (existing) {
          existing.lastSeen = new Date(at).toISOString();
          existing.cleanStreak = 0;
          existing.severity = r.severity;
          existing.evidence = r.evidence.slice(0, 300);
          if (existing.class === 'recoverable' && !existing.statusLineSent) calmRaises.push(existing);
          report.transitions.push({ reasonId: r.kind, transition: 'refreshed' });
          transitionEpisodeIds.set(r.kind, existing.id);
          continue;
        }
        const ep = store.open({ machineId, slug: job.slug, reasonId: r.kind, class: r.class, severity: r.severity, evidence: r.evidence, at });
        report.transitions.push({ reasonId: r.kind, transition: 'opened' });
        transitionEpisodeIds.set(r.kind, ep.id);
        if (r.class === 'critical') {
          ep.pushDue = 'critical';
          ep.pushDueSince = ep.firstSeen;
        } else {
          calmRaises.push(ep);
          if (store.openingsInWindow(key, at) >= 3 && !store.isMuted(key, at)) {
            ep.pushDue = 'recurrence';
            ep.pushDueSince = ep.firstSeen;
            store.mute(key, at);
            report.transitions.push({ reasonId: r.kind, transition: 'recurrence' });
          }
        }
      }
      for (const ep of store.listOpen(job.slug)) {
        if (ep.machineId !== machineId || present.has(ep.key)) continue;
        ep.cleanStreak += 1;
        if (ep.cleanStreak >= EPISODE_CLOSE_CLEAN_RUNS) {
          store.close(ep.key, `${EPISODE_CLOSE_CLEAN_RUNS} clean runs`, 'closed', at);
          report.transitions.push({ reasonId: ep.reasonId, transition: 'closed' });
          transitionEpisodeIds.set(ep.reasonId, ep.id);
          if (ep.statusLineSent) calmClears.push({ ep, resolution: `cleared: ${EPISODE_CLOSE_CLEAN_RUNS} clean runs in a row` });
        }
      }
    }
    const candidates = store.listOpen(job.slug).filter(ep => ep.machineId === machineId);
    const criticalDue = candidates.filter(ep => ep.pushDue === 'critical' && !ep.pushed);
    return { input, report, machineId, at, runN, calmRaises, calmClears, criticalDue,
      candidateEpisodeIds: new Set(candidates.map(ep => ep.id)), transitionEpisodeIds };
  }

  /** Serialize only external side effects; state observation above never waits behind a send. */
  dispatchPrepared(prepared: PreparedAnomalyRun): Promise<RunReport> {
    const next = this.chain.then(() => this.processPrepared(prepared));
    this.chain = next.catch(() => undefined);
    return next;
  }

  /** Scheduler tick: close episodes of jobs this machine no longer runs (§5.4 Expiry). */
  tick(): Promise<string[]> {
    const next = this.chain.then(async () => {
      const at = this.now();
      const expired = this.d.store.expireStale(at, (slug) => {
        const job = this.d.jobBySlug?.(slug);
        return job ? this.intervalOf(job) : null;
      });
      if (expired.length === 0) return [];
      this.d.store.save();
      for (const ep of expired) {
        if (ep.statusLineSent) await this.safeClear(this.calmKey(ep), 'stale: job no longer runs here');
        this.auditRow({ kind: 'transition', transition: 'stale', slug: ep.slug, machineId: ep.machineId, reasonId: ep.reasonId, class: ep.class, episodeId: ep.id });
      }
      return expired.map(e => e.key);
    });
    this.chain = next.catch(() => undefined);
    return next;
  }

  // ── core ──────────────────────────────────────────────────────────

  private async processPrepared(prepared: PreparedAnomalyRun): Promise<RunReport> {
    const { input, report, machineId, at, runN, calmRaises, calmClears, criticalDue, candidateEpisodeIds, transitionEpisodeIds } = prepared;
    const { job, parsed } = input;
    const store = this.d.store;

    // Persistence (recoverable, ≥ 6 h): heal attempt, then one push.
    await this.evaluatePersistence(job, machineId, at, report);

    // Deliver every push due (and eligible under the retry brakes) as ONE message.
    const due = [...new Map([...criticalDue, ...store.listOpen(job.slug)]
      .filter(ep => ep.machineId === machineId && candidateEpisodeIds.has(ep.id) && ep.pushDue && !ep.pushed
        && !this.pushedInMemory.has(`${ep.id}:${ep.pushDue}`) && this.retryEligible(ep, runN, at))
      .map(ep => [ep.id, ep])).values()];
    if (due.length > 0) {
      report.push = await this.deliver(job, machineId, due, runN, at, report);
    }

    // Writes AFTER the push (critical: the push never waits on a disk that may be full).
    store.save();
    for (const ep of calmRaises) {
      if (store.get(ep.key)?.id !== ep.id || ep.statusLineSent) continue;
      const raised = await this.safeRaise({
        id: `job-anomaly:${machineId}:${ep.reasonId}:${Date.parse(ep.firstSeen)}`,
        title: `${ep.reasonId} on ${this.machineName(machineId)}`,
        summary: `${ep.reasonId} on ${this.machineName(machineId)}: seen since ${ep.firstSeen}; owned by ${ownerFor(ep.reasonId)}`,
        category: 'job-anomaly',
        priority: 'LOW',
        sourceContext: job.slug,
        conditionKey: this.calmKey(ep),
      });
      if (raised) {
        ep.statusLineSent = true;
        store.save();
        report.calmRaised.push(ep.reasonId);
      }
    }
    for (const { ep, resolution } of calmClears) {
      if (store.get(ep.key)) continue; // a later run reopened the same condition
      await this.safeClear(this.calmKey(ep), resolution);
      report.calmCleared.push(ep.reasonId);
    }
    for (const t of report.transitions) {
      const ep = store.get(store.key(machineId, job.slug, t.reasonId));
      this.auditRow({ kind: 'transition', transition: t.transition, slug: job.slug, machineId, reasonId: t.reasonId,
        class: ep?.class, episodeId: transitionEpisodeIds.get(t.reasonId), runId: input.runId });
    }
    if (report.neutral) this.auditRow({ kind: 'neutral-run', slug: job.slug, machineId, runId: input.runId, result: parsed.result });
    return report;
  }

  private async evaluatePersistence(job: JobDefinition, machineId: string, at: number, report: RunReport): Promise<void> {
    const store = this.d.store;
    for (const ep of store.listOpen(job.slug)) {
      if (ep.machineId !== machineId || ep.class !== 'recoverable') continue;
      if (ep.pushed || ep.pushDue || ep.pushSuppressed) continue;
      const opened = Date.parse(ep.firstSeen);
      if (at - opened < PERSISTENCE_MS) continue;
      if (store.isMuted(ep.key, at)) continue; // recurrence mute (24 h); calm item + audit continue
      if (ep.heal.state === 'requested' && this.d.readHealOutcome) {
        try {
          const settled = this.d.readHealOutcome(ep.id);
          if (settled) this.recordHealSettled(ep.key, ep.id, settled);
        } catch (err) { this.log(`[JobAnomalyPusher] heal outcome read failed: ${(err as Error).message}`); }
      }
      if (ep.heal.state === 'none') {
        const enabled = this.d.requestHealAttempt ? (this.d.triageEnabled?.() ?? true) : false;
        if (!enabled) {
          ep.heal = { state: 'refused', requestedAt: new Date(at).toISOString(), settledAt: new Date(at).toISOString(), reason: 'triage-disabled' };
          report.transitions.push({ reasonId: ep.reasonId, transition: 'heal-refused' });
        } else {
          ep.heal = { state: 'requested', requestedAt: new Date(at).toISOString(), settledAt: null, reason: null };
          report.transitions.push({ reasonId: ep.reasonId, transition: 'heal-requested' });
          const settled = this.requestHeal(ep);
          const grace = this.d.healInlineGraceMs ?? HEAL_INLINE_GRACE_MS;
          let timer: ReturnType<typeof setTimeout> | undefined;
          await Promise.race([settled, new Promise<void>(r => { timer = setTimeout(r, grace); })]);
          if (timer) clearTimeout(timer);
        }
      }
      const deadline = opened + PERSISTENCE_MS + TRIAGE_SESSION_CAP_MS + (this.intervalOf(job) ?? 0);
      if (ep.heal.state === 'refused'
        || (ep.heal.state === 'ran' && ep.heal.settledAt !== null && Date.parse(ep.heal.settledAt) < at)
        || (ep.heal.state === 'requested' && at >= deadline)) {
        ep.pushDue = 'persistence';
        ep.pushDueSince = new Date(at).toISOString();
      }
    }
  }

  /** Fire the heal request; its settlement is recorded on the episode whenever it lands. */
  private requestHeal(ep: AnomalyEpisode): Promise<void> {
    const dep = this.d.requestHealAttempt!;
    const id = ep.id;
    let p: Promise<HealAttemptResult>;
    try { p = dep(structuredClone(ep)); } catch (err) { p = Promise.resolve(`refused:${(err as Error).message || 'request-error'}` as HealAttemptResult); }
    return p.then(
      (res) => this.recordHealSettled(ep.key, id, res),
      (err) => this.recordHealSettled(ep.key, id, `refused:${(err as Error)?.message || 'request-error'}` as HealAttemptResult),
    );
  }

  private recordHealSettled(key: string, episodeId: string, res: HealAttemptResult): void {
    const ep = this.d.store.get(key);
    if (!ep || ep.id !== episodeId || ep.heal.state !== 'requested') return;
    const at = new Date(this.now()).toISOString();
    if (res === 'ran') ep.heal = { ...ep.heal, state: 'ran', settledAt: at };
    else ep.heal = { ...ep.heal, state: 'refused', settledAt: at, reason: res === 'disabled' ? 'triage-disabled' : res.slice('refused:'.length) || 'refused' };
    this.d.store.save();
    this.auditRow({ kind: 'transition', transition: `heal-${ep.heal.state}`, slug: ep.slug, machineId: ep.machineId, reasonId: ep.reasonId, class: ep.class, episodeId: ep.id, healReason: ep.heal.reason });
  }

  private retryEligible(ep: AnomalyEpisode, runN: number, at: number): boolean {
    if (ep.pushAttempts === 0) return true;
    const lastAt = ep.lastPushAttemptAt ? Date.parse(ep.lastPushAttemptAt) : 0;
    const hourly = at - lastAt >= RETRY_HOURLY_MS;
    if (ep.pushAttempts > RETRY_SPACING_RUNS.length) return hourly;
    const spacing = RETRY_SPACING_RUNS[ep.pushAttempts - 1];
    return hourly || (runN - (ep.lastPushAttemptRun ?? 0)) >= spacing;
  }

  private statusLine(ep: AnomalyEpisode, machine: string, at: number): string {
    switch (ep.pushDue) {
      case 'critical':
        return `${ep.reasonId} on ${machine} (critical), seen ${ep.firstSeen}.`;
      case 'recurrence':
        return `${ep.reasonId} on ${machine} keeps recurring: ${this.d.store.openingsInWindow(ep.key, at)} episodes in 6 hours. Further notices about it are muted for 24 hours.`;
      case 'persistence':
      default: {
        let clause: string;
        if (ep.heal.state === 'ran') clause = 'ran and it is still present';
        else if (ep.heal.state === 'refused') {
          const m = /^cooldown@(.+)$/.exec(ep.heal.reason ?? '');
          clause = m ? `ran at ${m[1]} (cooldown)` : `could not start: ${ep.heal.reason ?? 'unknown'}`;
        } else clause = 'was requested; investigation outcome unknown';
        return `${ep.reasonId} on ${machine} has persisted for 6 hours; an investigation ${clause}.`;
      }
    }
  }

  private async narrate(job: JobDefinition, machineId: string, eps: AnomalyEpisode[]): Promise<Narration> {
    const ids = eps.map(e => e.reasonId).sort();
    const cacheKey = `${machineId}:${job.slug}:${ids.join('|')}`;
    const fingerprint = eps.map(e => `${e.reasonId}=${e.severity}:${e.evidence}`).sort().join('\n');
    const cached = this.narrationCache.get(cacheKey);
    if (cached && cached.fingerprint === fingerprint) return cached.narration;
    const narration = await this.d.narrator.narrate({
      jobName: job.name, jobSlug: job.slug, machineId, machineName: this.machineName(machineId),
      episodeId: eps.map(e => e.id).join('|'),
      reasons: eps.map(e => ({ id: e.reasonId, class: e.class })),
      jobBody: job.body,
    }, this.d.auditOnlyRunId ? { auditOnlyRunId: this.d.auditOnlyRunId } : {});
    this.narrationCache.set(cacheKey, { fingerprint, narration });
    for (const e of eps) e.narratedSeverity = e.severity;
    return narration;
  }

  private async deliver(job: JobDefinition, machineId: string, eps: AnomalyEpisode[], runN: number, at: number, report: RunReport): Promise<PushRecord> {
    const machine = this.machineName(machineId);
    const kinds = eps.map(e => ({ episodeId: e.id, reasonId: e.reasonId, kind: e.pushDue as PushKind }));
    const markPushed = (outcomeAt: number) => {
      for (const e of eps) {
        this.pushedInMemory.add(`${e.id}:${e.pushDue}`);
        e.pushed = true; e.pushKind = e.pushDue; e.pushedAt = new Date(outcomeAt).toISOString(); e.pushDue = null;
      }
    };

    // telegramNotify: false — the destination says "never"; record, never retry.
    if (job.telegramNotify === false) {
      for (const e of eps) { e.pushSuppressed = 'telegramNotify-false'; e.pushKind = e.pushDue; e.pushDue = null; e.pushed = true; }
      this.auditRow({ kind: 'push', outcome: 'suppressed', slug: job.slug, machineId, reasons: kinds });
      return { kinds, text: '', outcome: 'suppressed', narration: 'fallback' };
    }

    const narration = await this.narrate(job, machineId, eps);
    const evidence = renderEvidenceBlock(eps.map(e => `${e.reasonId}: ${e.evidence}`));
    const text = [narration.text, '', ...eps.map(e => this.statusLine(e, machine, at)), '', 'Evidence:', evidence].join('\n');
    const logicalSendId = eps.map(e => `${e.id}:${e.pushDue}`).sort().join('|');

    if (this.d.auditOnlyRunId) {
      markPushed(at);
      this.auditRow({ kind: 'push-audit-only', runId: this.d.auditOnlyRunId, slug: job.slug, machineId, reasons: kinds, narration: narration.source, textLength: text.length });
      return { kinds, text, outcome: 'audit-only', narration: narration.source };
    }

    const topicId = await this.d.ensureJobTopic(job).catch(() => null);
    let outcome: PushRecord['outcome'] = 'not-delivered';
    let path: PushRecord['path'];
    if (topicId === null || topicId === undefined) {
      outcome = 'no-topic';
    } else {
      const res = await this.sendWithGate(job, machineId, topicId, text, narration, eps, logicalSendId);
      if (res.delivered) outcome = 'delivered';
      path = res.path;
    }

    if (outcome === 'delivered') {
      const hadUndelivered = eps.some(e => e.undeliveredRaised);
      markPushed(this.now());
      if (hadUndelivered && !this.d.store.listOpen().some(e => e.machineId === machineId && e.undeliveredRaised && !e.pushed)) {
        await this.safeClear(`job-anomaly-undelivered:${machineId}`, 'the pending job-anomaly push was delivered');
      }
    } else {
      for (const e of eps) {
        e.pushAttempts += 1;
        e.lastPushAttemptAt = new Date(at).toISOString();
        e.lastPushAttemptRun = runN;
      }
      const crossed = eps.filter(e => e.pushAttempts >= UNDELIVERED_AFTER_ATTEMPTS && !e.undeliveredRaised);
      if (crossed.length > 0) {
        for (const e of crossed) e.undeliveredRaised = true;
        await this.safeRaise({
          id: `job-anomaly-undelivered:${machineId}`,
          title: `A job alarm on ${machine} could not be delivered`,
          summary: `A push from ${job.name} on ${machine} (${crossed.map(e => e.reasonId).join(', ')}) failed ${UNDELIVERED_AFTER_ATTEMPTS} delivery attempts. It keeps retrying hourly while the condition lasts; details on the Jobs tab.`,
          category: 'job-anomaly',
          priority: 'HIGH',
          sourceContext: 'agent',
          conditionKey: `job-anomaly-undelivered:${machineId}`,
        });
        report.undeliveredRaised = true;
      }
    }
    this.auditRow({ kind: 'push', outcome, path, slug: job.slug, machineId, reasons: kinds, narration: narration.source,
      attempts: eps.map(e => e.pushAttempts) });
    return { kinds, text, outcome, path, narration: narration.source };
  }

  /** Send through the chokepoint; answer an advisory once; on a block, fall to the fixed sentence + view link. */
  private async sendWithGate(job: JobDefinition, machineId: string, topicId: number, text: string, narration: Narration,
    eps: AnomalyEpisode[], logicalSendId: string): Promise<{ delivered: boolean; path: PushRecord['path'] }> {
    const metadata: Record<string, unknown> = { provenance: 'automation', source: PRODUCER_ID, jobSlug: job.slug, machineId };
    let first: { delivered: boolean; body: Record<string, unknown> | null; status: number };
    try {
      first = await this.post(topicId, { text, metadata }, narration.author, logicalSendId);
    } catch {
      return { delivered: false, path: 'reply' }; // outcome unknown ⇒ unpushed, retried with the same key
    }
    if (first.delivered) return { delivered: true, path: 'reply' };
    let verdict = first;
    let path: PushRecord['path'] = 'reply';
    if (first.status === 422 && first.body?.error === 'tone-gate-advisory' && typeof first.body.rule === 'string') {
      path = 'advisory-ack';
      try {
        verdict = await this.post(topicId, { text, metadata: {
          ...metadata,
          toneAdvisoryAck: first.body.rule,
          toneAdvisoryAckReason: ADVISORY_ACK_REASON,
          ...(typeof first.body.decisionRef === 'string' ? { toneAdvisoryDecisionRef: first.body.decisionRef } : {}),
        } }, narration.author, logicalSendId);
      } catch {
        return { delivered: false, path };
      }
      if (verdict.delivered) return { delivered: true, path };
    }
    const body = verdict.body;
    const blocked = verdict.status === 422 && (body?.error === 'tone-gate-blocked' || body?.blockedBy === 'credential-exposure-guard'
      || body?.error === 'tone-gate-advisory' || body?.error === 'tone-gate-advisory-reason-required'
      || body?.reason === 'credential-exposure-guard');
    if (!blocked) return { delivered: false, path };
    return this.sendBlockedFallback(job, machineId, topicId, eps, body);
  }

  private async sendBlockedFallback(job: JobDefinition, machineId: string, topicId: number, eps: AnomalyEpisode[],
    body: Record<string, unknown> | null): Promise<{ delivered: boolean; path: PushRecord['path'] }> {
    const machine = this.machineName(machineId);
    const ids = eps.map(e => e.reasonId);
    const credentialWall = body?.blockedBy === 'credential-exposure-guard' || body?.reason === 'credential-exposure-guard';
    let link: string | null = null;
    if (!credentialWall && this.d.createPrivateView && this.d.viewTunnelUrl) {
      try {
        const md = [`# ${job.name} on ${machine}`, '', ...eps.map(e => `- **${e.reasonId}** (${e.class}), seen since ${e.firstSeen}`), '',
          '## Evidence', '', renderEvidenceBlock(eps.map(e => `${e.reasonId}: ${e.evidence}`))].join('\n');
        const view = this.d.createPrivateView(`${job.name} on ${machine}`, md);
        link = view ? this.d.viewTunnelUrl(view.id) : null;
      } catch {
        link = null; // @silent-fallback-ok: no link ⇒ the sentence points at the Jobs tab
      }
    }
    const sentence = fallbackSentence(job.name, machine, ids);
    const text = link ? `${sentence} Details: ${link}` : `${sentence.slice(0, -1)}; details on the Jobs tab.`;
    const path: PushRecord['path'] = link ? 'view-link' : 'jobs-tab';
    try {
      const res = await this.d.sendDeterministicTopic(topicId, text);
      return { delivered: Number.isSafeInteger(res?.messageId), path };
    } catch {
      return { delivered: false, path };
    }
  }

  private async post(topicId: number, body: Record<string, unknown>, author: OriginAutomationAuthor, logicalSendId: string) {
    const resp = await this.d.sendAutomationReply(PRODUCER_ID, topicId, body, author, logicalSendId);
    const json = await resp.json().catch(() => null) as Record<string, unknown> | null;
    return { delivered: resp.ok && Number.isSafeInteger(json?.messageId), body: json, status: resp.status };
  }

  // ── helpers ───────────────────────────────────────────────────────

  private intervalOf(job: JobDefinition): number | null {
    return this.d.intervalFor ? this.d.intervalFor(job) : cronIntervalMs(job.schedule, new Date(this.now()));
  }

  private calmKey(ep: AnomalyEpisode): string {
    return `${this.d.store.namespace}job-anomaly:${ep.machineId}:${ep.reasonId}`;
  }

  private machineName(machineId: string): string {
    return this.d.machineName?.(machineId) ?? machineId;
  }

  private async safeRaise(item: AttentionRaise): Promise<boolean> {
    try { await this.d.raiseAttention(item); return true; }
    catch (err) { this.log(`[JobAnomalyPusher] attention raise failed: ${(err as Error).message}`); return false; }
  }

  private async safeClear(conditionKey: string, resolution: string): Promise<void> {
    try { await this.d.clearAttention(conditionKey, resolution); } catch (err) { this.log(`[JobAnomalyPusher] attention clear failed: ${(err as Error).message}`); }
  }

  private auditRow(row: Record<string, unknown>): void {
    try {
      this.d.audit?.append({ ts: new Date(this.now()).toISOString(), ...(this.d.auditOnlyRunId ? { canaryRunId: this.d.auditOnlyRunId } : {}), ...row });
    } catch {
      // @silent-fallback-ok: an audit trail never affects the decision it audits
    }
  }

  private log(msg: string): void {
    (this.d.log ?? ((m) => console.warn(m)))(msg);
  }
}
