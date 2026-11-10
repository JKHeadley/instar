/**
 * ChiefOfStaffLoop — the check-in loop of docs/specs/chief-of-staff-topic.md (§2.1–§2.9, §3, §4).
 *
 * Runs on the lease holder only. Each tick: derive the operator lease; for every DUE bound project
 * gather deterministic evidence, detect PROGRESS vs ACTIVITY (§2.3), skip the judge when nothing
 * changed, call the judge (a SIGNAL), apply the authority floors in code, act through the §2.4
 * action protocol within the brakes (§2.7) and the per-tick cap (§2.8), record a `check-event`,
 * mirror the initiative status, settle open intents, write `last-tick`. Separately: compose the
 * note (§3) on its cadence, and send at most `immediateMessagesPerDay` immediate messages.
 *
 * Everything that talks to the world is an injected seam so the decision logic is unit-testable
 * with fakes; the pure pieces (`applyVerdictFloors`, `detectProgress`, `planDue`, `composeNote`)
 * are exported. Every seam failure resolves to `unknown` / no action / "can't see" — never to action.
 *
 * Signal vs. Authority: the judge's verdict is a signal; the floors below and the protocol's own
 * invariants hold the authority. The judge can never start a run or close a project on its own.
 */

import crypto from 'node:crypto';
import {
  foldBindingState, foldProjectCheckState, deriveLeaseExpiry, foldIntentState, latestPerKey,
  buildCheckEvent, buildLastTick, buildLifecycleEvent, buildRenewal,
  type BindingState, type ProjectCheckState, type CosVerdict, type UnionEntry, type IntentState, foldLastTicks } from './ChiefOfStaffStore.js';
import type { HlcTimestamp } from './HybridLogicalClock.js';
import type { ChiefOfStaffActionProtocol, CosProtocolOutcome } from './ChiefOfStaffActionProtocol.js';

// ── config ───────────────────────────────────────────────────────────────────

export interface ChiefOfStaffLoopConfig {
  tickMinutes: number;
  defaultCadenceHours: number;
  minCadenceHours: number;
  maxRunHours: number;
  operatorLeaseHours: number;
  noteCadenceHours: number;
  /** "HH:MM" in the agent's timezone (the caller resolves the timezone; the loop compares local hours). */
  noteTime: string;
  maxRestartsWithoutProgress: number;
  breakerRestartsPerWeek: number;
  immediateMessagesPerDay: number;
  restartsPerTick: number;
  dirtyGapMinutes: number;
  progressLinesThreshold: number;
  unknownStreakForNote: number;
  noteSectionCap: number;
}

export const CHIEF_OF_STAFF_LOOP_DEFAULTS: ChiefOfStaffLoopConfig = {
  tickMinutes: 15, defaultCadenceHours: 24, minCadenceHours: 1, maxRunHours: 4, operatorLeaseHours: 72,
  noteCadenceHours: 24, noteTime: '08:00', maxRestartsWithoutProgress: 3, breakerRestartsPerWeek: 5,
  immediateMessagesPerDay: 3, restartsPerTick: 2, dirtyGapMinutes: 30, progressLinesThreshold: 20,
  unknownStreakForNote: 3, noteSectionCap: 5,
};

/** Clamp any operator-supplied value to its floor (§Fixed limits). The floors are the invariants. */
export function clampLoopConfig(c: Partial<ChiefOfStaffLoopConfig>): ChiefOfStaffLoopConfig {
  const d = CHIEF_OF_STAFF_LOOP_DEFAULTS;
  const num = (v: unknown, def: number, min: number, max?: number) => {
    const n = typeof v === 'number' && Number.isFinite(v) ? v : def;
    return Math.min(max ?? Number.POSITIVE_INFINITY, Math.max(min, n));
  };
  const tickMinutes = num(c.tickMinutes, d.tickMinutes, 5);
  return {
    tickMinutes,
    defaultCadenceHours: num(c.defaultCadenceHours, d.defaultCadenceHours, 1),
    minCadenceHours: num(c.minCadenceHours, d.minCadenceHours, 1),
    maxRunHours: num(c.maxRunHours, d.maxRunHours, 0.25),
    operatorLeaseHours: num(c.operatorLeaseHours, d.operatorLeaseHours, 1),
    noteCadenceHours: num(c.noteCadenceHours, d.noteCadenceHours, 1),
    noteTime: typeof c.noteTime === 'string' && /^\d{2}:\d{2}$/.test(c.noteTime) ? c.noteTime : d.noteTime,
    maxRestartsWithoutProgress: num(c.maxRestartsWithoutProgress, d.maxRestartsWithoutProgress, 1),
    // Upper bound: a tenth of the ticks in a week (§Fixed limits) so a very high value cannot disable the breaker.
    breakerRestartsPerWeek: num(c.breakerRestartsPerWeek, d.breakerRestartsPerWeek, 1, Math.floor((7 * 24 * 60) / tickMinutes / 10)),
    immediateMessagesPerDay: num(c.immediateMessagesPerDay, d.immediateMessagesPerDay, 0),
    restartsPerTick: num(c.restartsPerTick, d.restartsPerTick, 1),
    dirtyGapMinutes: num(c.dirtyGapMinutes, d.dirtyGapMinutes, 2 * tickMinutes),
    progressLinesThreshold: num(c.progressLinesThreshold, d.progressLinesThreshold, 1),
    unknownStreakForNote: num(c.unknownStreakForNote, d.unknownStreakForNote, 1),
    noteSectionCap: num(c.noteSectionCap, d.noteSectionCap, 1),
  };
}

// ── evidence ─────────────────────────────────────────────────────────────────

export type EvidenceSource = 'prs' | 'diff' | 'done-item' | 'run' | 'session' | 'commitments' | 'owner-message' | 'agent-message' | 'digest';

export interface EvidenceItem {
  id: string;
  source: EvidenceSource;
  /** Age of the observation in ms (how stale the read is), or null when unknown. */
  ageMs: number | null;
  /** The observation; `unknown` when the source could not be read. */
  value: unknown;
  unknown: boolean;
  /** Conversation text (untrusted) — never counts as non-conversation evidence. */
  conversation?: boolean;
}

export interface EvidenceBundle {
  conversationKey: string;
  items: EvidenceItem[];
  /** Net diff (non-whitespace, non-generated lines) of the linked branches against the default branch, or null. */
  netDiffLines: number | null;
  /** Merged PRs into the default branch since the last check. */
  mergedPrsSinceLastCheck: number | null;
  /** Deterministic done items: id → pass | fail | unknown. */
  doneItems: Record<string, 'pass' | 'fail' | 'unknown'>;
  liveSession: boolean | null;
  /** Bounded, newest-first conversation tails (untrusted). */
  conversationTail: string[];
  lastOwnerMessageAt: string | null;
  lastAgentMessageAt: string | null;
  overdueCommitments: number | null;
}

export function evidenceHash(b: EvidenceBundle): string {
  const stable = { netDiffLines: b.netDiffLines, merged: b.mergedPrsSinceLastCheck, done: b.doneItems, live: b.liveSession, owner: b.lastOwnerMessageAt, agent: b.lastAgentMessageAt, overdue: b.overdueCommitments, tail: b.conversationTail.slice(0, 5) };
  return crypto.createHash('sha256').update(JSON.stringify(stable)).digest('hex');
}

/** §2.3: progress = a deterministic done item flipped to pass, a merged PR, or the net diff exceeding
 *  its previous high-water mark by the threshold. Everything else is activity. */
export function detectProgress(b: EvidenceBundle, prev: ProjectCheckState | null, threshold: number, prevDoneItems: Record<string, 'pass' | 'fail' | 'unknown'> | null): { progress: boolean; highWater: number } {
  const highWaterBefore = prev?.netDiffHighWater ?? 0;
  const merged = (b.mergedPrsSinceLastCheck ?? 0) > 0;
  // No durable baseline (first check, or the previous check predates doneItems) ⇒ no flip credit (P20: absence is not evidence).
  const flipped = prevDoneItems !== null && Object.entries(b.doneItems).some(([id, v]) => v === 'pass' && prevDoneItems[id] !== 'pass');
  const net = b.netDiffLines ?? 0;
  const grew = net - highWaterBefore >= threshold;
  return { progress: merged || flipped || grew, highWater: Math.max(highWaterBefore, net) };
}

// ── judge (signal) + floors (authority) ──────────────────────────────────────

export interface JudgeInput {
  conversationKey: string;
  goal: string;
  doneDefinition: unknown;
  bundle: EvidenceBundle;
  /** The disclosed bound the tails were cut to (P24). */
  tailBoundBytes: number;
}

export interface JudgeOutput {
  verdict: CosVerdict;
  citedIds: string[];
  reason: string;
  /** The decision-quality correlation id when the router minted one. */
  decisionRef?: string;
}

export type FlooredVerdict = { verdict: CosVerdict; reason: string; floored?: string };

/** §2.5: authority floors applied AFTER the judge, in code. */
export function applyVerdictFloors(out: JudgeOutput | null, bundle: EvidenceBundle, laggingMs: number): FlooredVerdict {
  if (!out) return { verdict: 'unknown', reason: 'judge-unavailable', floored: 'no-judge' };
  const byId = new Map(bundle.items.map((i) => [i.id, i]));
  const cited = out.citedIds.map((id) => byId.get(id));
  if (cited.some((i) => !i)) return { verdict: 'unknown', reason: out.reason, floored: 'unresolvable-citation' };
  const freshNonConversation = (cited as EvidenceItem[]).some((i) => !i.conversation && !i.unknown && i.ageMs !== null && i.ageMs <= laggingMs);
  if ((out.verdict === 'stalled' || out.verdict === 'drifting') && !freshNonConversation) return { verdict: 'unknown', reason: out.reason, floored: 'conversation-only-evidence' };
  if (out.verdict === 'done-verified') return { verdict: 'claims-done', reason: out.reason, floored: 'judge-cannot-verify-done' };
  return { verdict: out.verdict, reason: out.reason };
}

// ── planning (pure) ──────────────────────────────────────────────────────────

export interface BoundProject {
  conversationKey: string;
  binding: BindingState;
  goal: string;
  doneDefinition: Array<{ id: string; kind: 'deterministic' | 'judgment'; text: string; certify?: string }>;
  checkCadenceHours: number;
  linked: { repos: string[]; branches: string[]; domains: string[] };
  initiativeId?: string;
}

export function boundProjects(union: UnionEntry[]): BoundProject[] {
  const out: BoundProject[] = [];
  for (const bs of foldBindingState(union).values()) {
    if (!bs.confirmed || bs.closed || !bs.binding) continue;
    const b = bs.binding;
    out.push({
      conversationKey: bs.conversationKey, binding: bs, goal: String(b.goal ?? ''), doneDefinition: (b.doneDefinition as BoundProject['doneDefinition']) ?? [],
      checkCadenceHours: Number(b.checkCadenceHours ?? 24), linked: (b.linked as BoundProject['linked']) ?? { repos: [], branches: [], domains: [] },
      ...(typeof b.initiativeId === 'string' ? { initiativeId: b.initiativeId } : {}),
    });
  }
  return out;
}

/** §2.1: which projects are due this tick (cadence elapsed, or dirty and past the gap). */
export function planDue(projects: BoundProject[], states: Map<string, ProjectCheckState>, dirty: Set<string>, now: number, gapMinutes: number): BoundProject[] {
  const due: BoundProject[] = [];
  for (const p of projects) {
    const st = states.get(p.conversationKey);
    const last = st?.lastCheckAt ? Date.parse(st.lastCheckAt) : null;
    const nextAt = st?.nextCheckAt ? Date.parse(st.nextCheckAt) : null;
    const cadenceDue = last === null || (nextAt !== null && now >= nextAt);
    const dirtyDue = dirty.has(p.conversationKey) && (last === null || now - last >= gapMinutes * 60_000);
    if (cadenceDue || dirtyDue) due.push(p);
  }
  return due;
}

// ── note (§3) ────────────────────────────────────────────────────────────────

export interface NoteItem { kind: 'needs-you' | 'result' | 'cant-see'; text: string; action?: { label: string; id: string } }

export function composeNote(items: NoteItem[], cap: number, statusUrl: string, leaseExpiresInMs: number | null): string | null {
  const section = (kind: NoteItem['kind'], title: string) => {
    const list = items.filter((i) => i.kind === kind);
    if (list.length === 0) return '';
    const shown = list.slice(0, cap).map((i) => `• ${i.text}`);
    const more = list.length > cap ? `\n• +${list.length - cap} more: ${statusUrl}` : '';
    return `${title}\n${shown.join('\n')}${more}\n\n`;
  };
  const body = section('needs-you', 'Needs you') + section('result', 'Results') + section('cant-see', "Can't see");
  if (body.trim().length === 0) {
    // Nothing changed and nothing needs the operator ⇒ no note, except the one actionable line before a pause.
    if (leaseExpiresInMs !== null && leaseExpiresInMs > 0 && leaseExpiresInMs <= 24 * 3_600_000) {
      return `Nothing needs you. I pause in about ${Math.max(1, Math.round(leaseExpiresInMs / 3_600_000))}h unless you check in here.`;
    }
    return null;
  }
  return body.trim();
}

// ── deps ─────────────────────────────────────────────────────────────────────

export interface ChiefOfStaffLoopDeps {
  now: () => number;
  machineId: string;
  enabled: () => boolean;
  holdsLease: () => boolean;
  config: () => ChiefOfStaffLoopConfig;
  journal: {
    emit(recordKey: string, build: (hlc: HlcTimestamp, origin: string, observed?: HlcTimestamp) => Record<string, unknown> | null): { outcome: string; seq?: number };
    loadUnion(): UnionEntry[];
    /** Resolve once `seq` is fsynced (CoherenceJournal.awaitDurableSeq). The loop awaits the check-event before it claims, so the owner's action gate reads a fresh fold (§2.4 step 2c). */
    awaitDurable?(seq: number): Promise<void>;
  };
  /** Verify a renewal record's machine signature (the receiving machine signed it). */
  verifyRenewal: (renewal: Record<string, unknown>) => boolean;
  gather: (project: BoundProject, prev: ProjectCheckState | null) => Promise<EvidenceBundle>;
  /** The LLM judge (signal). Null when the budget refused or the call failed. */
  judge: (input: JudgeInput) => Promise<JudgeOutput | null>;
  protocol: Pick<ChiefOfStaffActionProtocol, 'claim' | 'standDown' | 'settleOpenIntent' | 'operatorLeaseLive'>;
  /** Mirror the initiative status (binding is the authority). */
  mirrorInitiativeStatus: (initiativeId: string, status: 'completed' | 'active') => void;
  sendNote: (text: string) => Promise<void>;
  sendImmediate: (text: string) => Promise<void>;
  statusUrl: () => string;
  /** Hours in the agent's timezone (0–23) for the note time. */
  localHour: (nowMs: number) => number;
  /** Grade a judge decision later (decision-quality meter); best-effort. */
  gradeDecision?: (decisionRef: string, grade: 'right' | 'wrong', note: string) => void;
  log?: (line: string) => void;
}

// ── the loop ─────────────────────────────────────────────────────────────────

/** The machine that wrote the newest last-tick record, or null when no tick has ever been recorded. */
export function newestTickMachine(union: UnionEntry[]): string | null {
  let best: { machine: string; at: string } | null = null;
  for (const [machine, at] of foldLastTicks(union)) if (!best || at > best.at) best = { machine, at };
  return best?.machine ?? null;
}

/** A claim counts as a restart only when a run actually STARTED — locally, or on the owner machine behind a routed command. */
export function outcomeStarted(r: CosProtocolOutcome): boolean {
  if (r.outcome === 'started') return true;
  if (r.outcome === 'routed') { const inner = (r as { result?: { outcome?: string } }).result; return inner?.outcome === 'started'; }
  return false;
}
/** The rejection reason of a claim, local or behind a routed command; null when it was not rejected. */
export function rejectionReason(r: CosProtocolOutcome): string | null {
  if (r.outcome === 'rejected') return (r as { reason?: string }).reason ?? 'rejected';
  if (r.outcome === 'routed') { const inner = (r as { result?: { outcome?: string; reason?: string } }).result; if (inner?.outcome === 'rejected') return inner.reason ?? 'rejected'; if (inner?.outcome && inner.outcome !== 'started') return inner.outcome; }
  return null;
}

export interface LoopHealth {
  lastTickAt: string | null;
  lastTickMachine: string | null;
  ticks: number;
  lastError: string | null;
  lease: { live: boolean; expiresAt: string | null; renewedAt: string | null };
  projects: number;
  lastNoteAt: string | null;
  immediateSentToday: number;
}

export class ChiefOfStaffLoop {
  private dirty = new Set<string>();
  private pendingNote: NoteItem[] = [];
  private lastNoteAt: number | null = null;
  private immediateLog: number[] = [];
  private unknownStreak = new Map<string, number>();
  private refuted = new Map<string, number>();
  private health: LoopHealth = { lastTickAt: null, lastTickMachine: null, ticks: 0, lastError: null, lease: { live: false, expiresAt: null, renewedAt: null }, projects: 0, lastNoteAt: null, immediateSentToday: 0 };
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking = false;

  constructor(private readonly d: ChiefOfStaffLoopDeps) {}

  start(): void {
    if (this.timer) return;
    const ms = Math.max(5, this.d.config().tickMinutes) * 60_000;
    this.timer = setInterval(() => { void this.tick(); }, ms);
    (this.timer as unknown as { unref?: () => void }).unref?.();
  }
  stop(): void { if (this.timer) { clearInterval(this.timer); this.timer = null; } }

  /** An external event (run ended, PR changed, commitment overdue) makes a project due on the next tick. */
  markDirty(conversationKey: string): void { this.dirty.add(conversationKey); }

  status(): LoopHealth { return { ...this.health, lease: { ...this.health.lease } }; }

  /** §2.4 step 2(c) input for the protocol: the derived action gate for one conversation. */
  actionGate(conversationKey: string): { nextActionAllowedAt: string | null; newestCheckAgeMs: number | null } {
    let union: UnionEntry[] = [];
    try { union = this.d.journal.loadUnion(); } catch { /* @silent-fallback-ok: an unreadable union reads as a lagging fold ⇒ the protocol rejects (safe side) */ return { nextActionAllowedAt: null, newestCheckAgeMs: Number.POSITIVE_INFINITY }; }
    const cfg = this.d.config();
    const p = boundProjects(union).find((x) => x.conversationKey === conversationKey);
    const st = foldProjectCheckState(union, conversationKey, { checkCadenceHours: Math.max(cfg.minCadenceHours, p?.checkCadenceHours || cfg.defaultCadenceHours), maxRestartsWithoutProgress: cfg.maxRestartsWithoutProgress, breakerRestartsPerWeek: cfg.breakerRestartsPerWeek }, new Date(this.d.now()), p?.binding);
    return { nextActionAllowedAt: st.nextActionAllowedAt, newestCheckAgeMs: st.lastCheckAt ? this.d.now() - Date.parse(st.lastCheckAt) : null };
  }

  /** §5: one row per bound project (no evidence text; titles are the owner's). */
  projectsSummary(): Array<{ conversationKey: string; goal: string; lastVerdict: CosVerdict | null; lastCheckAt: string | null; nextCheckAt: string | null; restartsWithoutProgress: number; parked: boolean; breakerTripped: boolean; nextActionAllowedAt: string | null }> {
    let union: UnionEntry[] = [];
    try { union = this.d.journal.loadUnion(); } catch { /* @silent-fallback-ok: an unreadable union lists no projects; the loop health shows lastError */ return []; }
    const cfg = this.d.config(); const now = new Date(this.d.now());
    return boundProjects(union).map((p) => {
      const st = foldProjectCheckState(union, p.conversationKey, { checkCadenceHours: Math.max(cfg.minCadenceHours, p.checkCadenceHours || cfg.defaultCadenceHours), maxRestartsWithoutProgress: cfg.maxRestartsWithoutProgress, breakerRestartsPerWeek: cfg.breakerRestartsPerWeek }, now, p.binding);
      return { conversationKey: p.conversationKey, goal: p.goal, lastVerdict: st.lastVerdict, lastCheckAt: st.lastCheckAt, nextCheckAt: st.nextCheckAt, restartsWithoutProgress: st.restartsWithoutProgress, parked: st.parked, breakerTripped: st.breakerTripped, nextActionAllowedAt: st.nextActionAllowedAt };
    });
  }

  /** §5: one project with its cited evidence ids and intent history (owner-only route). */
  projectDetail(conversationKey: string): Record<string, unknown> | null {
    let union: UnionEntry[] = [];
    try { union = this.d.journal.loadUnion(); } catch { /* @silent-fallback-ok: unreadable ⇒ not found; health shows lastError */ return null; }
    const p = boundProjects(union).find((x) => x.conversationKey === conversationKey);
    if (!p) return null;
    const cfg = this.d.config();
    const st = foldProjectCheckState(union, conversationKey, { checkCadenceHours: Math.max(cfg.minCadenceHours, p.checkCadenceHours || cfg.defaultCadenceHours), maxRestartsWithoutProgress: cfg.maxRestartsWithoutProgress, breakerRestartsPerWeek: cfg.breakerRestartsPerWeek }, new Date(this.d.now()), p.binding);
    const checks = union.filter((e) => e.data.recordType === 'check-event' && e.data.conversationKey === conversationKey).map((e) => ({ at: e.data.at, verdict: e.data.verdict, evidenceIds: e.data.evidenceIds, progressSeen: e.data.progressSeen, note: e.data.note })).sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, 50);
    const intents = [...foldIntentState(union).values()].filter((s) => s.conversationKey === conversationKey).map((s) => ({ intentKey: s.intentKey, action: s.action, state: s.state, runId: s.runId, open: s.open }));
    return { conversationKey, goal: p.goal, doneDefinition: p.doneDefinition, linked: p.linked, checkCadenceHours: p.checkCadenceHours, state: st, checks, intents };
  }

  /** §4: the derived operator lease (shared with the protocol's `operatorLeaseLive`). */
  lease(now = this.d.now()) {
    let union: UnionEntry[] = [];
    try { union = this.d.journal.loadUnion(); } catch { /* @silent-fallback-ok: an unreadable union derives an EXPIRED lease (paused), the safe side */ return { renewedAt: null, expiresAt: null, live: false, ignored: 0 }; }
    return deriveLeaseExpiry(union, this.d.verifyRenewal, this.d.config().operatorLeaseHours, new Date(now));
  }

  /** §4: record an owner check-in. The CALLER has already verified the principal on the inbound event. */
  recordRenewal(input: { renewedVia: 'telegram' | 'app' | 'console'; principal: string; eventRef?: string; sign: (canonical: string) => string }): boolean {
    const renewedAt = new Date(this.d.now()).toISOString();
    const canonical = `cos-renewal:${renewedAt}:${input.renewedVia}:${input.principal}:${this.d.machineId}`;
    const r = this.d.journal.emit(`renewal:${renewedAt}:${this.d.machineId}`, buildRenewal({ renewedAt, renewedVia: input.renewedVia, principal: input.principal, ...(input.eventRef ? { eventRef: input.eventRef } : {}), machine: this.d.machineId, machineSignature: input.sign(canonical) }));
    return r.outcome === 'emitted' || r.outcome === 'accepted';
  }

  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    const now = this.d.now();
    try {
      if (!this.safe(() => this.d.enabled(), false)) return;
      if (!this.safe(() => this.d.holdsLease(), false)) return;
      const cfg = this.d.config();
      const lease = this.lease(now);
      this.health.lease = { live: lease.live, expiresAt: lease.expiresAt, renewedAt: lease.renewedAt };
      let union: UnionEntry[];
      try { union = this.d.journal.loadUnion(); } catch (e) { /* @silent-fallback-ok: recorded in loop health (lastError) and the tick is skipped; nothing is inferred from an unreadable union */ this.health.lastError = `union-unreadable: ${(e as Error)?.message}`; return; }
      const projects = boundProjects(union);
      this.health.projects = projects.length;
      // §2.1 grace tick, derived from the DURABLE last-tick records (not process memory): when the newest
      // tick was taken by another machine, this is the first tick after a holder change — check, but take no action.
      const graceTick = newestTickMachine(union) !== null && newestTickMachine(union) !== this.d.machineId;
      const states = new Map<string, ProjectCheckState>();
      for (const p of projects) states.set(p.conversationKey, foldProjectCheckState(union, p.conversationKey, { checkCadenceHours: Math.max(cfg.minCadenceHours, p.checkCadenceHours || cfg.defaultCadenceHours), maxRestartsWithoutProgress: cfg.maxRestartsWithoutProgress, breakerRestartsPerWeek: cfg.breakerRestartsPerWeek, jitter: jitterFor(p.conversationKey) }, new Date(now), p.binding));
      // Settle open intents first (step 4) — a stuck intent blocks everything for its conversation.
      await this.settleOpen(union);
      const due = planDue(projects, states, this.dirty, now, cfg.dirtyGapMinutes);
      let restartsThisTick = 0;
      for (const p of due) {
        this.dirty.delete(p.conversationKey);
        const prev = states.get(p.conversationKey) ?? null;
        const r = await this.checkProject(p, prev, lease.live && !graceTick, cfg, restartsThisTick, now);
        if (r.restarted) restartsThisTick++;
      }
      // Note on cadence.
      await this.maybeSendNote(now, cfg, lease);
      this.d.journal.emit(`last-tick:${this.d.machineId}`, buildLastTick(this.d.machineId, new Date(now).toISOString()));
      this.health.lastTickAt = new Date(now).toISOString(); this.health.lastTickMachine = this.d.machineId; this.health.ticks++; this.health.lastError = null;
    } catch (e) { /* @silent-fallback-ok: the failure is recorded in loop health + log and the project is re-checked next tick */
      this.health.lastError = (e as Error)?.message ?? String(e);
      this.d.log?.(`[chief-of-staff] tick failed: ${this.health.lastError}`);
    } finally {
      this.ticking = false;
    }
  }

  private async checkProject(p: BoundProject, prev: ProjectCheckState | null, leaseLive: boolean, cfg: ChiefOfStaffLoopConfig, restartsThisTick: number, now: number): Promise<{ restarted: boolean }> {
    let bundle: EvidenceBundle;
    try { bundle = await this.d.gather(p, prev); } catch (e) { /* @silent-fallback-ok: a failed gather yields an all-unknown check-event (P20), recorded with the error */
      this.recordCheck(p, 'unknown', 'gather-failed', 'x'.repeat(64), [], false, prev?.netDiffHighWater ?? 0, now);
      this.bumpUnknown(p, cfg, `evidence could not be gathered (${(e as Error)?.message ?? 'error'})`);
      return { restarted: false };
    }
    const hash = evidenceHash(bundle);
    const { progress, highWater } = detectProgress(bundle, prev, cfg.progressLinesThreshold, prev?.lastDoneItems ?? null);
    const deterministic = p.doneDefinition.filter((i) => i.kind === 'deterministic');
    const allDeterministicPass = deterministic.length > 0 && deterministic.every((i) => bundle.doneItems[i.id] === 'pass');
    const judgmentItems = p.doneDefinition.filter((i) => i.kind === 'judgment');
    // §2.5: skip the judge when nothing changed, or when the checklist is fully passing.
    let floored: FlooredVerdict; let decisionRef: string | undefined;
    if (prev && prev.lastEvidenceHash === hash && prev.lastVerdict) {
      floored = { verdict: prev.lastVerdict, reason: 'no new evidence', floored: 'carry-forward' };
    } else if (allDeterministicPass) {
      // Every deterministic item passes: no judge needed. With no judgment items this IS done-verified;
      // with judgment items it is a claim the owner (or a delegated judge, PR 3b) must confirm.
      floored = judgmentItems.length === 0 ? { verdict: 'done-verified', reason: 'every deterministic done item passes' } : { verdict: 'claims-done', reason: 'every deterministic done item passes; judgment items pending' };
    } else {
      let out: JudgeOutput | null = null;
      try { out = await this.d.judge({ conversationKey: p.conversationKey, goal: p.goal, doneDefinition: p.doneDefinition, bundle, tailBoundBytes: JUDGE_BUNDLE_BYTES }); } catch { /* @silent-fallback-ok: a failed judge call is `unknown` — the floors forbid acting without a verdict */ out = null; }
      decisionRef = out?.decisionRef;
      floored = applyVerdictFloors(out, bundle, cfg.dirtyGapMinutes * 60_000 * 2);
      if (allDeterministicPass && floored.verdict === 'claims-done') floored = { verdict: 'claims-done', reason: floored.reason };
    }
    const cited = bundle.items.filter((i) => !i.unknown).map((i) => i.id).slice(0, 64);
    let verdict = floored.verdict;
    let restarted = false;
    // The verdict the check-event records is final BEFORE any action: the done-candidate adjustments are pure.
    const doneCandidate = verdict === 'done-verified' || (verdict === 'claims-done' && allDeterministicPass);
    // Every judgment item pends on the owner until a delegated judge exists (spec: declare-done defaults to NOT done);
    // `certify: agent-may-certify` is accepted by the schema but is not yet honoured here.
    const pendingJudgment = doneCandidate ? judgmentItems : [];
    if (doneCandidate) { if (pendingJudgment.length === 0) { if (leaseLive) verdict = 'done-verified'; } else verdict = 'waiting-on-user'; }
    if (verdict === 'unknown') this.bumpUnknown(p, cfg, floored.reason); else this.unknownStreak.set(p.conversationKey, 0);
    // §2.4 step 2(c): the check that justifies an action is on disk BEFORE the claim, so the owner's
    // action gate (newest check age, next-action-allowed) reads a fresh fold instead of the previous cadence's.
    const checkSeq = this.recordCheck(p, verdict, floored.reason, hash, cited, progress, highWater, now, bundle.doneItems);
    if (checkSeq === undefined) { this.d.log?.(`[chief-of-staff] check-event for ${p.conversationKey} was not accepted; no action this tick`); return { restarted: false }; }
    if (this.d.journal.awaitDurable) {
      try { await this.d.journal.awaitDurable(checkSeq); } catch (e) { /* @silent-fallback-ok: an un-fsynced check is logged and NO action is taken this tick; the project is retried next cadence */ this.d.log?.(`[chief-of-staff] check-event not durable before action: ${(e as Error)?.message}`); return { restarted: false }; }
    }
    // §2.6 act.
    if (doneCandidate) {
      if (pendingJudgment.length === 0) {
        if (leaseLive) {
          this.d.journal.emit(`lifecycle:${p.conversationKey}:${now}`, buildLifecycleEvent(p.conversationKey, 'closed', p.binding.bindingHlc!, 'chief-of-staff', new Date(now).toISOString()));
          if (p.initiativeId) this.safe(() => { this.d.mirrorInitiativeStatus(p.initiativeId!, 'completed'); return true; }, false);
          this.pendingNote.push({ kind: 'result', text: `Finished and verified: ${label(p)}.` });
        } else {
          this.pendingNote.push({ kind: 'needs-you', text: `${label(p)} looks finished (every check passes) but I'm paused; check in here and I'll close it.` });
        }
      } else {
        this.pendingNote.push({ kind: 'needs-you', text: `${label(p)}: every automatic check passes. Confirm it's done?`, action: { label: 'Confirm done', id: `cos:confirm-done:${p.conversationKey}` } });
      }
    } else if (verdict === 'claims-done') {
      const n = (this.refuted.get(p.conversationKey) ?? 0) + 1; this.refuted.set(p.conversationKey, n);
      const missing = deterministic.filter((i) => bundle.doneItems[i.id] !== 'pass').map((i) => i.text).join('; ');
      if (n >= 2) this.pendingNote.push({ kind: 'needs-you', text: `${label(p)} says it is done but these checks still fail: ${missing}.` });
      else if (leaseLive && restartsThisTick < cfg.restartsPerTick && !prev?.parked) { const r = await this.d.protocol.claim({ conversationKey: p.conversationKey, action: 'redirect', payload: { text: `Your done claim was checked: still missing — ${missing}. Goal: ${p.goal}` } }); restarted = outcomeStarted(r); }
    } else if (verdict === 'stalled' || verdict === 'drifting') {
      if (prev?.parked || prev?.breakerTripped) {
        this.pendingNote.push({ kind: 'needs-you', text: `${label(p)} is parked after ${prev.restartsWithoutProgress} restarts without progress${prev.breakerTripped ? ' (breaker)' : ''}. Unpark?`, action: { label: 'Unpark', id: `cos:unpark:${p.conversationKey}` } });
      } else if (!leaseLive) {
        this.pendingNote.push({ kind: 'needs-you', text: `${label(p)} is ${verdict} but I'm paused; check in here and I'll restart it.` });
      } else if (restartsThisTick >= cfg.restartsPerTick) {
        this.dirty.add(p.conversationKey); // try next tick
      } else {
        const text = verdict === 'stalled'
          ? `Goal: ${p.goal}\nRemaining: ${deterministic.filter((i) => bundle.doneItems[i.id] !== 'pass').map((i) => i.text).join('; ') || 'see checklist'}\nContinue toward the goal and report what moved.`
          : `Goal: ${p.goal}\nRemaining: ${deterministic.filter((i) => bundle.doneItems[i.id] !== 'pass').map((i) => i.text).join('; ') || 'see checklist'}\nEvidence cited: ${cited.join(', ') || 'none'}\nThe work appears to be moving away from the goal. Correct course toward it, or explain why the goal should change.`;
        const action = verdict === 'stalled' ? (bundle.liveSession ? 'restart-inject' : 'restart-run') : 'redirect';
        let r: CosProtocolOutcome;
        try { r = await this.d.protocol.claim({ conversationKey: p.conversationKey, action, payload: { text, durationHours: cfg.maxRunHours } }); } catch (e) { /* @silent-fallback-ok: a throwing claim is recorded as a rejected intent with its reason and logged */ r = { outcome: 'rejected', reason: 'executor-failed' }; this.d.log?.(`[chief-of-staff] claim threw: ${(e as Error)?.message}`); }
        restarted = outcomeStarted(r);
        const rejection = rejectionReason(r);
        if (rejection === 'executor-failed') this.pendingNote.push({ kind: 'result', text: `Restart of ${label(p)} failed; I'll retry on the next cadence.` });
        else if (rejection) this.pendingNote.push({ kind: 'cant-see', text: `${label(p)}: could not act (${rejection}); I'll retry on the next cadence.` });
      }
    } else if (verdict === 'waiting-on-user') {
      this.pendingNote.push({ kind: 'needs-you', text: `${label(p)}: ${floored.reason}` });
    }
    if (decisionRef && this.d.gradeDecision && restarted) { /* graded on the next check when progress is observed; see settle */ }
    return { restarted };
  }

  private recordCheck(p: BoundProject, verdict: CosVerdict, note: string, hash: string, ids: string[], progress: boolean, highWater: number, now: number, doneItems?: Record<string, 'pass' | 'fail' | 'unknown'>): number | undefined {
    return this.d.journal.emit(`check:${p.conversationKey}:${now}`, buildCheckEvent({ conversationKey: p.conversationKey, verdict, evidenceHash: hash, evidenceIds: ids, progressSeen: progress, netDiffHighWater: highWater, machine: this.d.machineId, at: new Date(now).toISOString(), note: note.slice(0, 500), ...(doneItems ? { doneItems } : {}) })).seq;
  }

  private bumpUnknown(p: BoundProject, cfg: ChiefOfStaffLoopConfig, why: string): void {
    const n = (this.unknownStreak.get(p.conversationKey) ?? 0) + 1; this.unknownStreak.set(p.conversationKey, n);
    if (n === cfg.unknownStreakForNote) this.pendingNote.push({ kind: 'cant-see', text: `${label(p)}: ${why}` });
  }

  private async settleOpen(union: UnionEntry[]): Promise<void> {
    const tickMs = this.d.config().tickMinutes * 60_000;
    const now = this.d.now();
    const claims = latestPerKey(union);
    for (const st of foldIntentState(union).values()) {
      if (!st.open) continue;
      const claim = claims.get(st.intentKey);
      const claimedAt = claim && typeof claim.data.claimedAt === 'string' ? Date.parse(claim.data.claimedAt) : NaN;
      if (!Number.isFinite(claimedAt) || now - claimedAt < tickMs) continue;
      let r: 'started' | 'lost' | 'blocked' = 'blocked';
      try { r = await this.d.protocol.settleOpenIntent(st); } catch { /* @silent-fallback-ok: an unsettled intent keeps blocking by design; the note says "can't settle" */ r = 'blocked'; }
      if (r === 'blocked') this.pendingNote.push({ kind: 'cant-see', text: `An action for ${st.conversationKey} can't be settled (its machine is unreachable); nothing new starts there until it is.` });
    }
  }

  private async maybeSendNote(now: number, cfg: ChiefOfStaffLoopConfig, lease: ReturnType<ChiefOfStaffLoop['lease']>): Promise<void> {
    const [hh, mm] = cfg.noteTime.split(':').map(Number);
    const hour = this.d.localHour(now);
    // Due once the note hour has been reached (not only inside it — a missed tick must not slip a day) and no note went out this cadence.
    const dueByClock = hour >= hh && (this.lastNoteAt === null || now - this.lastNoteAt >= cfg.noteCadenceHours * 3_600_000 - cfg.tickMinutes * 60_000);
    void mm;
    if (!dueByClock) return;
    const items = this.pendingNote.splice(0, this.pendingNote.length);
    const expiresIn = lease.expiresAt ? Date.parse(lease.expiresAt) - now : null;
    const text = composeNote(items, cfg.noteSectionCap, this.d.statusUrl(), expiresIn);
    this.lastNoteAt = now; this.health.lastNoteAt = new Date(now).toISOString();
    if (!text) return;
    try { await this.d.sendNote(text); } catch (e) { /* @silent-fallback-ok: the note items are re-queued for the next cadence and the failure is logged */ this.pendingNote.unshift(...items); this.d.log?.(`[chief-of-staff] note send failed: ${(e as Error)?.message}`); }
  }

  /** §3: at most N immediate messages per day; overflow waits for the note. */
  async immediate(text: string): Promise<boolean> {
    const now = this.d.now();
    this.immediateLog = this.immediateLog.filter((t) => now - t < 24 * 3_600_000);
    this.health.immediateSentToday = this.immediateLog.length;
    if (this.immediateLog.length >= this.d.config().immediateMessagesPerDay) { this.pendingNote.push({ kind: 'needs-you', text }); return false; }
    this.immediateLog.push(now); this.health.immediateSentToday = this.immediateLog.length;
    try { await this.d.sendImmediate(text); return true; } catch { /* @silent-fallback-ok: a failed immediate send falls back to the note, never dropped */ this.pendingNote.push({ kind: 'needs-you', text }); return false; }
  }

  /** Owner taps (verified by the caller): unpark / confirm-done. */
  async ownerTap(actionId: string, by: 'owner-tap'): Promise<'ok' | 'ignored'> {
    const m = /^cos:(unpark|confirm-done):(.+)$/.exec(actionId);
    if (!m || by !== 'owner-tap') return 'ignored';
    const [, kind, conversationKey] = m;
    const union = this.d.journal.loadUnion();
    const bs = foldBindingState(union).get(conversationKey);
    if (!bs?.bindingHlc) return 'ignored';
    const at = new Date(this.d.now()).toISOString();
    if (kind === 'unpark') { this.d.journal.emit(`lifecycle:${conversationKey}:${this.d.now()}`, buildLifecycleEvent(conversationKey, 'unpark', bs.bindingHlc, 'owner-tap', at)); return 'ok'; }
    this.d.journal.emit(`lifecycle:${conversationKey}:${this.d.now()}`, buildLifecycleEvent(conversationKey, 'closed', bs.bindingHlc, 'owner-tap', at));
    const initiativeId = bs.binding && typeof bs.binding.initiativeId === 'string' ? bs.binding.initiativeId : null;
    if (initiativeId) this.safe(() => { this.d.mirrorInitiativeStatus(initiativeId, 'completed'); return true; }, false);
    return 'ok';
  }

  private safe<T>(fn: () => T, fallback: T): T { try { return fn(); } catch { /* @silent-fallback-ok: loop deps resolve to the safe side (disabled / not holder / no mirror) */ return fallback; } }
}

/** §2.5 bundle bound: cost-driven (see the spec's derivation). */
export const JUDGE_BUNDLE_BYTES = 48 * 1024;

function label(p: BoundProject): string {
  return p.goal.length > 60 ? `${p.goal.slice(0, 57)}…` : p.goal;
}

/** Deterministic ±10% jitter seed per conversation (so due times spread without state). */
function jitterFor(conversationKey: string): number {
  const h = crypto.createHash('sha256').update(conversationKey).digest();
  return h[0] / 255;
}
