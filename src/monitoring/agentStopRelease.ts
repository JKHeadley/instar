/**
 * Agent-class green-PR stops (docs/specs/green-pr-agent-stop-release.md).
 *
 * A rollback stop is operator-class unless it carries a valid claim made when
 * it was minted. An agent-class stop is released by a session (never by this
 * code) once a server-verified condition holds: a pull request citing the
 * stop's marker merged after the stop, and is contained in the release tag of
 * the version this server is running.
 *
 * This module holds the pure claim/condition logic and AgentStopSurfacer, the
 * pass that keeps an unreleased stop from being orphaned. The surfacer only
 * posts and wakes: it decides nothing and blocks nothing.
 */

import fs from 'node:fs';
import path from 'node:path';

import { boundedHead } from '../core/boundedInput.js';

// ---- origin + claim -------------------------------------------------------

export interface AgentStopOrigin {
  class: 'agent';
  topicId: number;
  sessionId?: string;
  cause: string;
  release: { kind: 'fix-pr-released' };
  stoppedAt: string;
}

/** A release, recorded on the clearing transition. */
export interface AgentStopReleaseRecord {
  topicId: number;
  sessionId?: string;
  note: string;
  evidence: Record<string, unknown>;
  at: string;
}

const MAX_CAUSE_CHARS = 4000;
const MIN_CAUSE_CHARS = 10;
const MAX_SESSION_ID_CHARS = 128;
export const MAX_RELEASE_NOTE_CHARS = 1000;

export function isPositiveTopicId(v: unknown): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v > 0;
}

function sessionIdProblem(v: unknown): boolean {
  return v !== undefined && (typeof v !== 'string' || !v || v.length > MAX_SESSION_ID_CHARS);
}

/**
 * Validate a stop's claim. Pure and synchronous: it runs before the latch is
 * minted and must never make stopping slower. A rejected claim still stops,
 * as operator-class; the route reports the reasons.
 */
export function parseAgentStopClaim(
  raw: unknown,
  nowIso: string,
): { ok: true; origin: AgentStopOrigin } | { ok: false; reasons: string[] } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, reasons: ['agentStop must be an object'] };
  const c = raw as Record<string, unknown>;
  const reasons: string[] = [];
  if (!isPositiveTopicId(c.topicId)) reasons.push('topicId must be a positive integer');
  if (sessionIdProblem(c.sessionId)) reasons.push('sessionId must be a short string');
  const cause = typeof c.cause === 'string' ? c.cause.trim() : '';
  if (cause.length < MIN_CAUSE_CHARS || cause.length > MAX_CAUSE_CHARS) reasons.push(`cause must be ${MIN_CAUSE_CHARS}-${MAX_CAUSE_CHARS} characters`);
  const release = c.release as Record<string, unknown> | undefined;
  if (!release || typeof release !== 'object' || release.kind !== 'fix-pr-released') reasons.push('release.kind must be fix-pr-released');
  if (reasons.length > 0) return { ok: false, reasons };
  return {
    ok: true,
    origin: {
      class: 'agent',
      topicId: c.topicId as number,
      ...(c.sessionId ? { sessionId: c.sessionId as string } : {}),
      cause,
      release: { kind: 'fix-pr-released' },
      stoppedAt: nowIso,
    },
  };
}

/**
 * Read a stored origin back. Anything that is not exactly the valid shape reads
 * as no origin, which makes the stop operator-class: the strict side.
 */
export function readStoredOrigin(raw: unknown): AgentStopOrigin | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  if (o.class !== 'agent' || !isPositiveTopicId(o.topicId)) return null;
  if (sessionIdProblem(o.sessionId)) return null;
  if (typeof o.cause !== 'string' || !o.cause || o.cause.length > MAX_CAUSE_CHARS) return null;
  if (typeof o.stoppedAt !== 'string' || !Number.isFinite(Date.parse(o.stoppedAt))) return null;
  const release = o.release as Record<string, unknown> | undefined;
  if (!release || release.kind !== 'fix-pr-released') return null;
  return {
    class: 'agent',
    topicId: o.topicId,
    ...(o.sessionId ? { sessionId: o.sessionId as string } : {}),
    cause: o.cause,
    release: { kind: 'fix-pr-released' },
    stoppedAt: o.stoppedAt,
  };
}

/** The token a fix PR cites in its body. A latch id's colon does not search reliably. */
export function markerFor(latchId: string): string {
  return `agent-stop-${latchId.replace(/:/g, '-')}`;
}

/** Exact token match: `…-21` never matches `…-212`. */
export function bodyCitesMarker(body: unknown, marker: string): boolean {
  if (typeof body !== 'string') return false;
  const escaped = marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![\\w-])${escaped}(?![\\w-])`).test(body);
}

// ---- condition ------------------------------------------------------------

export interface CitingPr {
  number: number;
  body: string;
  state: string;
  mergedAt: string | null;
  baseRefName: string;
  mergeCommitOid: string | null;
}

export type TagContainment = 'contained' | 'not-contained' | 'unreadable';

export interface AgentStopFacts {
  /** Merged PRs nominated by search. null = the read failed. The search only nominates. */
  mergedPrsCiting(marker: string): Promise<CitingPr[] | null>;
  /** Is this commit contained in the release tag `v<version>`? */
  commitInReleaseTag(commit: string, version: string): Promise<TagContainment>;
}

export type ReleaseConditionVerdict =
  | { met: true; evidence: Record<string, unknown> }
  | { met: false; unverifiable: boolean; evidence: Record<string, unknown> };

const RELEASE_BRANCH = 'main';
const SEMVER_RE = /^\d+\.\d+\.\d+$/;

/** Decide from real GitHub and running-version state. Anything unreadable is never met. */
export async function evaluateReleaseCondition(args: {
  latchId: string;
  origin: AgentStopOrigin;
  runningVersion: string | null | undefined;
  facts: AgentStopFacts;
}): Promise<ReleaseConditionVerdict> {
  const { latchId, origin, runningVersion, facts } = args;
  if (!runningVersion || !SEMVER_RE.test(runningVersion)) {
    return { met: false, unverifiable: true, evidence: { problem: 'running-version-unreadable' } };
  }
  const stoppedAtMs = Date.parse(origin.stoppedAt);
  const marker = markerFor(latchId);
  const nominated = await facts.mergedPrsCiting(marker);
  if (nominated === null) return { met: false, unverifiable: true, evidence: { problem: 'search-unreadable', marker } };
  const qualifying = nominated.filter((pr) =>
    bodyCitesMarker(pr.body, marker)
    && pr.state === 'MERGED'
    && pr.baseRefName === RELEASE_BRANCH
    && !!pr.mergeCommitOid
    && Number.isFinite(Date.parse(pr.mergedAt ?? ''))
    && Date.parse(pr.mergedAt as string) > stoppedAtMs);
  if (qualifying.length === 0) {
    return { met: false, unverifiable: false, evidence: { marker, nominated: nominated.length, qualifying: 0 } };
  }
  let unreadable = false;
  for (const pr of qualifying) {
    const contained = await facts.commitInReleaseTag(pr.mergeCommitOid as string, runningVersion);
    if (contained === 'contained') return { met: true, evidence: { marker, pr: pr.number, running: runningVersion } };
    if (contained === 'unreadable') unreadable = true;
  }
  return {
    met: false,
    unverifiable: unreadable,
    evidence: { marker, prs: qualifying.map((p) => p.number), running: runningVersion, inRunningRelease: false },
  };
}

// ---- surfacer -------------------------------------------------------------

/** The dashboard's own stop reason: the operator just pressed it, so it needs no notice. */
export const CONSOLE_STOP_REASON = 'stopped from the console';

export const AGENT_STOP_COMMITMENT_PREFIX = 'green-pr-agent-stop:';
export const AGENT_STOP_ATTENTION_PREFIX = 'green-pr-agent-stop:';

const PASS_INTERVAL_MS = 10 * 60_000;
const PASS_BOUND_MS = 20_000;
const COMMITMENT_CADENCE_MS = 6 * 3_600_000;
const WAKE_UNMET_AFTER_MS = 6 * 3_600_000;
const WAKE_EVERY_MS = 24 * 3_600_000;
const WAKE_RETRY_MS = 3_600_000;
const ATTENTION_EVERY_MS = 24 * 3_600_000;
const ATTENTION_RAISE_AFTER_MET_MS = 3_600_000;
/** One readable line of the cause in a notice: its head says what went wrong, and status has the rest. */
const CAUSE_LINE_CHARS = 400;

export interface StopView {
  latchId: string;
  class: 'operator' | 'agent';
  reason?: string;
  since?: string;
  origin?: AgentStopOrigin;
}

/** The commitment tracker, narrowed to what a stop's loop uses. */
export interface AgentStopCommitments {
  record(input: Record<string, unknown>): { id: string };
  getActive(): Array<{ id: string; externalKey?: string }>;
  deliver(id: string): unknown;
  withdraw(id: string, reason: string): unknown;
}

export interface AgentStopSurfacerDeps {
  stateDir: string;
  listRollbackStops(): StopView[];
  facts: AgentStopFacts;
  runningVersion(): string | null | undefined;
  commitments?: AgentStopCommitments | null;
  raiseAttention?(item: { id: string; title: string; summary: string; category: string; priority: 'NORMAL' | 'HIGH'; sourceContext: string }): Promise<unknown>;
  closeAttention?(id: string, resolution: string): void;
  /** Inject into the topic's live session, or start one. */
  wakeTopic?(topicId: number, brief: string): Promise<void>;
  now?: () => number;
  logger?: (msg: string) => void;
}

interface SurfaceEntry {
  attentionAt?: number;
  raised?: boolean;
  wakeAt?: number;
  wakeRetryAt?: number;
  wokeForMet?: boolean;
  met?: boolean;
  metSince?: number;
  checkedAt?: number;
  evidence?: Record<string, unknown>;
}

interface SurfaceFile { stops: Record<string, SurfaceEntry> }

export interface AgentStopCondition {
  conditionMet: boolean | null;
  conditionCheckedAt: string | null;
  conditionEvidence: Record<string, unknown> | null;
}

export class AgentStopSurfacer {
  private readonly deps: AgentStopSurfacerDeps;
  private readonly now: () => number;
  private state: SurfaceFile;
  private passInFlight: Promise<void> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(deps: AgentStopSurfacerDeps) {
    this.deps = deps;
    this.now = deps.now ?? (() => Date.now());
    this.state = this.load();
  }

  start(intervalMs: number = PASS_INTERVAL_MS): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.pass(); }, intervalMs);
    this.timer.unref?.();
    void this.pass();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Check a stop's condition now, for the release route. */
  evaluate(latchId: string, origin: AgentStopOrigin): Promise<ReleaseConditionVerdict> {
    return evaluateReleaseCondition({ latchId, origin, runningVersion: this.safeVersion(), facts: this.deps.facts });
  }

  /** The last condition the pass read, for the status route. No network. */
  conditionOf(latchId: string): AgentStopCondition {
    const e = this.state.stops[latchId];
    return {
      conditionMet: e?.met ?? null,
      conditionCheckedAt: e?.checkedAt ? new Date(e.checkedAt).toISOString() : null,
      conditionEvidence: e?.evidence ?? null,
    };
  }

  /** Idempotent: the external key dedupes a retry. Never throws; returns null on failure. */
  ensureCommitment(latchId: string, origin: AgentStopOrigin): string | null {
    if (!this.deps.commitments) return null;
    const marker = markerFor(latchId);
    try {
      const created = this.deps.commitments.record({
        type: 'one-time-action',
        source: 'sentinel',
        owner: 'agent',
        blockedOn: 'none',
        verificationMethod: 'manual',
        topicId: origin.topicId,
        beaconEnabled: true,
        cadenceMs: COMMITMENT_CADENCE_MS,
        nextUpdateDueAt: new Date(this.now() + COMMITMENT_CADENCE_MS).toISOString(),
        externalKey: `${AGENT_STOP_COMMITMENT_PREFIX}${latchId}`,
        userRequest: `Auto-merge stop ${latchId} was pulled by this agent.`,
        agentResponse: `I will land a fix PR citing ${marker}, then release the stop once that PR is in the running release.`,
      });
      return created?.id ?? null;
    } catch (e) { /* @silent-fallback-ok: a commitment failure must never undo a stop; the next pass repairs it from the durable latch */
      this.log(`commitment record failed for ${latchId}: ${(e as Error)?.message}`);
      return null;
    }
  }

  /** A session released the stop: its loop is finished. */
  onReleased(latchId: string): void {
    this.closeLoop(latchId, 'deliver', 'released by the agent');
  }

  /** The PIN cleared these stops: the loop is no longer the agent's. */
  onEnabled(latchIds: string[]): void {
    for (const id of latchIds) this.closeLoop(id, 'withdraw', 'cleared by the operator');
  }

  /**
   * One surfacing pass. Never rejects, never stacks, and its caller's wait is
   * bounded: a read that never returns only makes later passes skip.
   */
  pass(): Promise<void> {
    if (this.passInFlight) return Promise.resolve();
    const running = this.runPass()
      .catch((e) => { this.log(`pass failed: ${(e as Error)?.message}`); })
      .finally(() => { this.passInFlight = null; });
    this.passInFlight = running;
    return Promise.race([running, new Promise<void>((resolve) => {
      const t = setTimeout(resolve, PASS_BOUND_MS);
      t.unref?.();
    })]);
  }

  private async runPass(): Promise<void> {
    const stops = this.deps.listRollbackStops();
    const activeIds = new Set(stops.map((s) => s.latchId));
    for (const stop of stops) {
      // One stop's fault must not strand the others.
      try {
        if (stop.class === 'agent' && stop.origin) await this.surfaceAgentStop(stop.latchId, stop.origin);
        else await this.surfaceOperatorStop(stop);
      } catch (e) { /* @silent-fallback-ok: retried on the next pass */
        this.log(`surfacing failed for ${stop.latchId}: ${(e as Error)?.message}`);
      }
    }
    for (const id of Object.keys(this.state.stops)) {
      if (!activeIds.has(id)) this.closeLoop(id, 'withdraw', 'the stop is no longer active');
    }
    this.withdrawStrayCommitments(activeIds);
    this.persist();
  }

  private async surfaceAgentStop(latchId: string, origin: AgentStopOrigin): Promise<void> {
    this.ensureCommitment(latchId, origin);
    const entry = this.state.stops[latchId] ?? (this.state.stops[latchId] = {});
    const now = this.now();
    const verdict = await this.evaluate(latchId, origin).catch((e): ReleaseConditionVerdict => ({
      // @silent-fallback-ok: a failed read answers unverifiable, never met; the evidence is kept and the next pass retries
      met: false, unverifiable: true, evidence: { problem: String((e as Error)?.message).slice(0, 120) },
    }));
    // A release or /enable may have landed while that read was out.
    if (this.state.stops[latchId] !== entry) return;
    entry.checkedAt = now;
    entry.evidence = verdict.evidence;
    // A failed read says nothing about the condition: keep what was last known,
    // so a GitHub blip neither wakes a session again nor restarts the raise clock.
    if (verdict.met) {
      entry.met = true;
      entry.metSince = entry.metSince ?? now;
    } else if (!verdict.unverifiable) {
      entry.met = false;
      entry.metSince = undefined;
      entry.wokeForMet = false;
    }
    const met = entry.met === true;

    await this.maybeWake(latchId, origin, entry, met, now);
    if (this.state.stops[latchId] !== entry) return;
    await this.maybeRaiseAttention(latchId, origin, entry, met, now);
  }

  private async maybeWake(latchId: string, origin: AgentStopOrigin, entry: SurfaceEntry, met: boolean, now: number): Promise<void> {
    if (!this.deps.wakeTopic) return;
    if (entry.wakeRetryAt !== undefined && now < entry.wakeRetryAt) return;
    const sinceLast = entry.wakeAt === undefined ? Infinity : now - entry.wakeAt;
    const age = now - Date.parse(origin.stoppedAt);
    const due = met
      ? (!entry.wokeForMet || sinceLast >= WAKE_EVERY_MS)
      : (age >= WAKE_UNMET_AFTER_MS && sinceLast >= WAKE_EVERY_MS);
    if (!due) return;
    const marker = markerFor(latchId);
    const brief = met
      ? `System notice, not from the user. This agent's own auto-merge stop ${latchId} now reads as resolved: its fix is in the running release. Read gate.rollbackStops from GET /green-pr-automerge, confirm the cause really is fixed, then release it with POST /green-pr-automerge/release naming that latch id. The server re-checks the condition. If the stop should hold, leave it and say why.`
      : `System notice, not from the user. This agent's own auto-merge stop ${latchId} is still on and its condition is not met. Read gate.rollbackStops from GET /green-pr-automerge for the cause. If the fix is not landed, land a PR whose body cites ${marker}. It may be merged through scripts/safe-merge.mjs only if every active stop is the agent's own and the PR cites each of their markers. The stop can then be released once that PR is in the running release.`;
    try {
      await this.deps.wakeTopic(origin.topicId, brief);
      entry.wakeAt = now;
      entry.wakeRetryAt = undefined;
      if (met) entry.wokeForMet = true;
    } catch (e) { /* @silent-fallback-ok: the Attention item is the floor; retry in an hour rather than every pass */
      entry.wakeRetryAt = now + WAKE_RETRY_MS;
      this.log(`wake failed for ${latchId}: ${(e as Error)?.message}`);
    }
  }

  private async maybeRaiseAttention(latchId: string, origin: AgentStopOrigin, entry: SurfaceEntry, met: boolean, now: number): Promise<void> {
    if (!this.deps.raiseAttention) return;
    const raiseNow = met && !entry.raised && entry.metSince !== undefined && now - entry.metSince >= ATTENTION_RAISE_AFTER_MET_MS;
    const cadenceDue = entry.attentionAt === undefined || now - entry.attentionAt >= ATTENTION_EVERY_MS;
    if (!raiseNow && !cadenceDue) return;
    const days = Math.floor((now - Date.parse(origin.stoppedAt)) / 86_400_000);
    const cause = boundedHead(origin.cause.replace(/\s+/g, ' '), CAUSE_LINE_CHARS);
    const standing = days >= 1 ? ` It has stood for ${days} day${days === 1 ? '' : 's'}.` : '';
    const stateLine = met
      ? 'Its fix is in the running release, so I can release it. One word in any chat will get that done; no PIN is needed.'
      : 'I am handling it: I release it myself once its fix PR is in the running release. Nothing is needed from you.';
    try {
      await this.deps.raiseAttention({
        id: `${AGENT_STOP_ATTENTION_PREFIX}${latchId}`,
        title: 'Auto-merge is stopped by the agent',
        summary: `I stopped auto-merging for my own reason: ${cause}.${standing} ${stateLine} If you want it to stay off regardless, stop it from the dashboard; that stop is yours and only your PIN clears it.`,
        category: 'degradation',
        priority: met && (raiseNow || entry.raised) ? 'HIGH' : 'NORMAL',
        sourceContext: 'agent',
      });
      entry.attentionAt = now;
      if (raiseNow) entry.raised = true;
    } catch (e) { /* @silent-fallback-ok: the next pass retries; the commitment and status route still carry the stop */
      this.log(`attention failed for ${latchId}: ${(e as Error)?.message}`);
    }
  }

  private async surfaceOperatorStop(stop: StopView): Promise<void> {
    if (this.state.stops[stop.latchId]) return; // once, on first sight
    const entry: SurfaceEntry = {};
    this.state.stops[stop.latchId] = entry;
    if (stop.reason === CONSOLE_STOP_REASON || !this.deps.raiseAttention) return;
    try {
      await this.deps.raiseAttention({
        id: `${AGENT_STOP_ATTENTION_PREFIX}${stop.latchId}`,
        title: 'Auto-merge is stopped',
        summary: `Auto-merging is stopped${stop.reason ? ` (${stop.reason.replace(/\s+/g, ' ')})` : ''}. Turning it back on needs your PIN, on the dashboard's Development page.`,
        category: 'degradation',
        priority: 'NORMAL',
        sourceContext: 'agent',
      });
      entry.attentionAt = this.now();
    } catch (e) { /* @silent-fallback-ok: forget first sight so the next pass retries */
      delete this.state.stops[stop.latchId];
      this.log(`attention failed for ${stop.latchId}: ${(e as Error)?.message}`);
    }
  }

  private closeLoop(latchId: string, how: 'deliver' | 'withdraw', resolution: string): void {
    const key = `${AGENT_STOP_COMMITMENT_PREFIX}${latchId}`;
    try {
      const open = this.deps.commitments?.getActive().find((c) => c.externalKey === key);
      if (open) {
        if (how === 'deliver') this.deps.commitments?.deliver(open.id);
        else this.deps.commitments?.withdraw(open.id, resolution);
      }
    } catch (e) { /* @silent-fallback-ok: the stop is already gone; the next pass closes a stray commitment */
      this.log(`commitment close failed for ${latchId}: ${(e as Error)?.message}`);
    }
    try {
      this.deps.closeAttention?.(`${AGENT_STOP_ATTENTION_PREFIX}${latchId}`, resolution);
    } catch (e) { /* @silent-fallback-ok: a stale notice is not worth failing a release over */
      this.log(`attention close failed for ${latchId}: ${(e as Error)?.message}`);
    }
    delete this.state.stops[latchId];
    this.persist();
  }

  private withdrawStrayCommitments(activeIds: Set<string>): void {
    if (!this.deps.commitments) return;
    for (const c of this.deps.commitments.getActive()) {
      if (!c.externalKey?.startsWith(AGENT_STOP_COMMITMENT_PREFIX)) continue;
      if (activeIds.has(c.externalKey.slice(AGENT_STOP_COMMITMENT_PREFIX.length))) continue;
      try { this.deps.commitments.withdraw(c.id, 'the stop is no longer active'); }
      catch (e) { /* @silent-fallback-ok: retried on the next pass */ this.log(`stray commitment close failed: ${(e as Error)?.message}`); }
    }
  }

  private safeVersion(): string | null {
    try { return this.deps.runningVersion() ?? null; }
    catch { /* @silent-fallback-ok: an unreadable version means the condition is not met */ return null; }
  }

  // ---- machine-local state (own file: never the watcher's) ----------------

  private filePath(): string {
    return path.join(this.deps.stateDir, 'state', 'green-pr-agent-stops.json');
  }

  private load(): SurfaceFile {
    try {
      const obj = JSON.parse(fs.readFileSync(this.filePath(), 'utf-8')) as Partial<SurfaceFile>;
      if (obj && obj.stops && typeof obj.stops === 'object') return { stops: obj.stops };
    } catch (e) { /* @silent-fallback-ok: losing cadence memory only repeats one notice */
      if ((e as NodeJS.ErrnoException)?.code !== 'ENOENT') this.log(`state unreadable, starting fresh: ${(e as Error)?.message}`);
    }
    return { stops: {} };
  }

  private persist(): void {
    try {
      const p = this.filePath();
      fs.mkdirSync(path.dirname(p), { recursive: true });
      const tmp = `${p}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2), { mode: 0o600 });
      fs.renameSync(tmp, p);
    } catch (e) { /* @silent-fallback-ok: losing cadence memory only repeats one notice */
      this.log(`state write failed: ${(e as Error)?.message}`);
    }
  }

  private log(msg: string): void {
    this.deps.logger?.(`[agent-stop] ${msg}`);
  }
}
