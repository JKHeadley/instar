/**
 * MachineCoherenceEpisodeManager — the §4 episode STATE MACHINE
 * (machine-coherence-guard §4.1–§4.4, §4.6). Consumes the durable state layer
 * (`machineCoherenceEpisode.ts`) and the confirmed skew rows from the sentinel's
 * §3.3 confirmation engine, and drives the ONE-item, honest-lifecycle,
 * bounded-recurrence episode contract.
 *
 * SLICE STATUS (C₁b-iii-b lands in sub-units — see the side-effects artifact):
 *   - THIS FILE (b1): open / join / suspend / resume / close taxonomy (§4.3:
 *     restored / suspended-peer-offline|unverifiable / expired-peer-gone /
 *     manifest-changed) + §4.4 single escalation + the operator "leave it" ack +
 *     the §4.2 VERBATIM attention-item body render. Durable file owned here
 *     (§4.6 corrupt → re-baseline). Emits EFFECTS the sentinel executes; the
 *     raise/append/resolve effects are gated on selfIsRaiser && live posture
 *     (dry-run + non-raiser run the machine + jsonl, never speak).
 *   - NOT YET (b2): §4.5 recurrence damper + per-day cap + the R3-M5 SHARED
 *     per-episode append budget (this slice's appends are unbudgeted).
 *   - NOT YET (b3): the §4.2.1 pendingFix reply-recognition flow.
 *
 * Supervision tier (N6): Tier 0 — deterministic; no LLM anywhere in this path
 * (reply recognition, when it lands in b3, lives in the CONVERSATIONAL agent,
 * never here — D17 intact).
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { maybeRotateJsonl } from '../utils/jsonl-rotation.js';
import { COHERENCE_CRITICAL_FLAGS, type CoherenceCriticalFlag } from '../core/machineCoherenceManifest.js';
import type { SkewRow } from './machineCoherenceEvaluate.js';

/** Local manifest lookup (avoids widening the increment-A module + its ratchet). */
function getFlagByKey(key: string): CoherenceCriticalFlag | undefined {
  return COHERENCE_CRITICAL_FLAGS.find((f) => f.key === key);
}
import type { MachineCoherenceResolvedConfig } from './MachineCoherenceSentinel.js';
import {
  emptyRecurrence,
  episodeStatePath,
  mintEpisodeId,
  readEpisodeFile,
  writeEpisodeFile,
  type EpisodeCloseReason,
  type EpisodeFile,
  type EpisodeState,
  type PendingFix,
  type PendingFixState,
} from './machineCoherenceEpisode.js';

/** One effect the sentinel/server executes (the manager never does I/O beyond
 *  its own durable file + jsonl — telegram effects are the caller's). */
export type EpisodeEffect =
  | { kind: 'raise'; itemId: string; title: string; summary: string; description: string }
  | { kind: 'append'; itemId: string; text: string }
  | { kind: 'resolve'; itemId: string; note: string }
  // §4.2.1-iv (divergent == raiser, mechanized): the LOCAL config write + self-
  // restart the raiser's own server performs on approval. The caller executes it
  // through the atomic config funnel (write-ahead outcome, then restart).
  | { kind: 'execute-fix'; itemId: string; key: string; configPath: string; targetValue: string };

/**
 * The two row classes §4.2.1-iii NEVER auto-proposes: `developmentAgent` (the F4
 * root switch — flipping it flips every omitted dev-gated resolution) and the
 * guard's OWN posture row (flipping the guard live is a §7 graduation action).
 */
const NEVER_AUTO_PROPOSE_KEYS = new Set(['developmentAgent', 'monitoring.machineCoherence']);

/** The result of an operator approval attempt (§4.2.1-i). */
export interface FixApprovalResult {
  ok: boolean;
  /** Why an approval was refused (lapsed / not-verified / in-flight / no-fix). */
  reason?: string;
  /** The pendingFix state AFTER a successful transition. */
  state?: PendingFixState;
}

/** Per-reconcile inputs the sentinel assembles from its classification pass. */
export interface EpisodeReconcileInput {
  /** The currently-CONFIRMED skew rows (§3.3 confirmation engine output). */
  confirmedRows: SkewRow[];
  /** Machine ids currently in the `compared` (fresh + clamp-passed) set. */
  comparedMachineIds: Set<string>;
  /** Machine ids currently registered ONLINE (compared ∪ unknown ∪ stale ∪ rejected). */
  onlineMachineIds: Set<string>;
  /** This machine's id. */
  selfMachineId: string;
  /** The §3.4 elected raiser (may be self, a peer, or null). */
  raiserMachineId: string | null;
  /** The serving-lease holder (direction tiebreak; restart-honesty clause). */
  leaseHolderMachineId: string | null;
  /** machineId → operator-facing nickname (registry display label; escaped at render). */
  nicknameOf: (machineId: string) => string;
  now: number;
}

/** Observability counters (surfaced on the sentinel status snapshot / route). */
export interface EpisodeManagerCounters {
  episodesOpened: number;
  wouldRaise: number; // dry-run / non-raiser would-have-raised transitions
  itemsRaised: number;
  suspends: number;
  resumes: number;
  closes: Record<EpisodeCloseReason, number> | Record<string, number>;
  escalations: number;
}

const EMPTY_CLOSES = (): Record<string, number> => ({});

export class MachineCoherenceEpisodeManager {
  private file: EpisodeFile;
  /** In-memory tick counters (R2-N3 — never persisted; warm-up-absorbed on restart). */
  private resolveCleanTicks = 0;
  /** The last self machine id seen on reconcile (for approveFix's raiser==divergent check). */
  private lastSelfMachineId: string | null = null;
  /** The last nickname resolver seen on reconcile (for out-of-tick approveFix notes). */
  private lastNicknameOf?: (m: string) => string;
  /** In-memory verify-tick counter for an executing-verifying fix (§4.2.1-v). */
  private fixVerifyTicks = 0;
  private counters: EpisodeManagerCounters = {
    episodesOpened: 0, wouldRaise: 0, itemsRaised: 0, suspends: 0, resumes: 0, closes: EMPTY_CLOSES(), escalations: 0,
  };
  private readonly logPath: string;

  constructor(
    private readonly stateDir: string,
    private readonly cfg: MachineCoherenceResolvedConfig,
  ) {
    // Agent-root logs dir (stateDir is `<agent>/.instar`; logs live at `<agent>/logs`).
    this.logPath = path.join(stateDir, '..', 'logs', 'machine-coherence.jsonl');
    const read = readEpisodeFile(stateDir);
    if (read.status === 'ok') {
      this.file = read.file;
    } else {
      // Absent → fresh; corrupt → re-baseline WITHOUT crashing (§4.6, the
      // GuardPostureProbe pattern). A corrupt re-baseline drops any in-flight
      // pendingFix (R3-L3). The adopt-or-resolve of a locally-held open item is
      // driven on the next reconcile by the normal open/resolve path (the item
      // id is derived from the fresh episodeId; a stale item with a different
      // id is left for the operator ack — a duplicate inside §0(b)'s envelope).
      this.file = { version: 1, episode: null, recurrence: emptyRecurrence() };
      if (read.status === 'corrupt') {
        this.log({ t: 'rebaseline', reason: read.reason });
      }
    }
  }

  /** The item id for an episode (§4.2 — idempotent on the createAttentionItem chokepoint). */
  private itemId(episodeId: string): string {
    return `machine-coherence:${episodeId}`;
  }

  /** Only the elected raiser on a LIVE (enabled && !dryRun) guard actually speaks. */
  private speaks(input: EpisodeReconcileInput): boolean {
    return this.cfg.enabled && !this.cfg.dryRun && input.raiserMachineId === input.selfMachineId;
  }

  /**
   * One reconcile pass (rides the sentinel tick, AFTER confirmation). Returns
   * the effects the caller executes; the durable file + jsonl are written here.
   */
  reconcile(input: EpisodeReconcileInput): EpisodeEffect[] {
    const effects: EpisodeEffect[] = [];
    const { now } = input;
    this.lastSelfMachineId = input.selfMachineId;
    this.lastNicknameOf = input.nicknameOf;
    const rowById = new Map(input.confirmedRows.map((r) => [r.identity, r]));
    const confirmedIds = new Set(rowById.keys());

    // ── No open episode: REOPEN a recently-closed one whose row set intersects
    //    (§4.5 recurrence damper), else OPEN a fresh episode. ──
    if (!this.file.episode) {
      if (confirmedIds.size === 0) return effects; // nothing to do
      this.pruneRecurrence(now);
      const reopen = this.findReopenTarget([...confirmedIds], now);
      if (reopen) this.reopenEpisode(input, [...confirmedIds], reopen, effects);
      else this.openEpisode(input, [...confirmedIds], effects);
      return effects;
    }

    const ep = this.file.episode;

    // ── Manifest-membership removal (§4.3 manifest-changed): an episode row's
    //    key is no longer a compared manifest key → the row vanishes for a
    //    NON-skew reason. If EVERY episode row is gone AND at least one vanished
    //    because its manifest key retired, close manifest-changed. ──
    const survivingIds = ep.skewRowIdentities.filter((id) => confirmedIds.has(id));

    // ── Suspension: a skew participant left the VERIFIABLE (compared) set ──
    const participants = this.episodeParticipants(ep);
    const offline = [...participants].filter((m) => !input.onlineMachineIds.has(m));
    const unverifiable = [...participants].filter((m) => input.onlineMachineIds.has(m) && !input.comparedMachineIds.has(m));
    const shouldSuspend = offline.length > 0 || unverifiable.length > 0;

    if (shouldSuspend) {
      this.applySuspend(input, ep, offline, unverifiable, effects);
      return effects;
    }
    // A previously-suspended episode whose participants are all verifiable again → resume.
    if (ep.suspended) {
      this.applyResume(input, ep, effects);
      // fall through to resolve/join evaluation this same tick
    }

    // ── All rows cleared (skew gone) → resolve-ticks toward `restored` ──
    if (survivingIds.length === 0) {
      // Distinguish manifest-changed (a key retired) from restored (skew healed).
      const anyKeyRetired = ep.skewRowIdentities.some((id) => this.rowKeyRetired(id, input));
      if (anyKeyRetired && !this.anyEpisodeKeyStillCompared(ep, input)) {
        this.closeEpisode(input, ep, 'manifest-changed', effects);
        return effects;
      }
      this.resolveCleanTicks += 1;
      if (this.resolveCleanTicks >= this.cfg.resolveTicks) {
        this.closeEpisode(input, ep, 'restored', effects);
      }
      return effects;
    }

    // Skew still present → reset the resolve clock; JOIN any newly-confirmed rows.
    this.resolveCleanTicks = 0;
    const newRows = [...confirmedIds].filter((id) => !ep.skewRowIdentities.includes(id));
    if (newRows.length > 0) {
      // §4.2.1-i: a skew-set change INVALIDATES a not-yet-executed pendingFix.
      this.invalidatePendingFix(input, ep, 'skew-set-changed', effects);
      this.joinRows(input, ep, newRows, effects);
    }

    // §4.2.1-v verify: an executing-verifying fix whose row hasn't cleared within
    // fixVerifyTicks fires ONE honest failure append and clears (retry needs
    // fresh approval); the episode stays open (closure belongs to §4.3 alone).
    this.verifyPendingFix(input, ep, confirmedIds, effects);

    // ── §4.4 escalation: open past escalateAfterMs (unsuspended clock), once,
    //    suppressed by the operator "leave it" ack. ──
    this.maybeEscalate(input, ep, effects);
    return effects;
  }

  private episodeParticipants(ep: EpisodeState): Set<string> {
    const s = new Set<string>();
    for (const id of ep.skewRowIdentities) for (const m of participantsOf(id)) s.add(m);
    return s;
  }

  /** A row's manifest key retired from the intersection (only meaningful for flag rows). */
  private rowKeyRetired(rowIdentity: string, input: EpisodeReconcileInput): boolean {
    const key = keyOf(rowIdentity);
    if (dimensionOf(rowIdentity) !== 'flag') return false;
    // Retired ⇔ the key is no longer a manifest flag AND is not present as a live
    // divergence — i.e. the intersection dropped it. We approximate with the
    // manifest catalog: a key absent from the manifest is retired.
    return !getFlagByKey(key);
  }

  private anyEpisodeKeyStillCompared(ep: EpisodeState, input: EpisodeReconcileInput): boolean {
    return ep.skewRowIdentities.some((id) => {
      if (dimensionOf(id) !== 'flag') return true; // version/manifest/protocol always compared
      return !!getFlagByKey(keyOf(id));
    });
  }

  private openEpisode(input: EpisodeReconcileInput, rowIds: string[], effects: EpisodeEffect[]): void {
    const openedAtMs = input.now;
    const episodeId = mintEpisodeId(openedAtMs);
    const ep: EpisodeState = {
      episodeId,
      openedAtMs,
      skewRowIdentities: rowIds,
      recurrence: emptyRecurrence(),
    };
    this.counters.episodesOpened += 1;
    // §4.5 per-day cap: at most maxEpisodeItemsPerDay NEW items per rolling 24 h.
    this.pruneRecurrence(input.now);
    const itemsToday = this.file.recurrence.newItemTimestamps.length;
    const overCap = itemsToday >= this.cfg.maxEpisodeItemsPerDay;
    if (this.speaks(input) && !overCap) {
      // Record the §4.2.1 proposal BEFORE rendering so the body can name it.
      this.maybeProposeFix(input, ep);
      const body = this.renderBody(input, ep);
      ep.itemRaisedAt = input.now;
      ep.attentionItemId = this.itemId(episodeId);
      this.counters.itemsRaised += 1;
      this.file.recurrence.newItemTimestamps.push(input.now);
      effects.push({ kind: 'raise', itemId: ep.attentionItemId, title: body.title, summary: body.summary, description: body.description });
    } else if (this.speaks(input) && overCap) {
      // Give up LOUDLY, once per window (P19): jsonl-only item, one final note.
      this.maybeCapGiveup(input, effects);
      this.counters.wouldRaise += 1;
    } else {
      this.counters.wouldRaise += 1;
    }
    this.file.episode = ep;
    this.persist();
    this.log({ t: 'open', episodeId, rows: rowIds, spoke: this.speaks(input), overCap });
  }

  /** §4.5 reopen: a newly-confirmed skew intersecting a recently-closed episode
   *  re-opens it — SAME item un-resolved + one short append, no new item (reopens
   *  don't count toward the per-day cap). Latched-flapping bounds the appends. */
  private reopenEpisode(input: EpisodeReconcileInput, rowIds: string[], target: { itemId?: string }, effects: EpisodeEffect[]): void {
    const openedAtMs = input.now;
    const episodeId = mintEpisodeId(openedAtMs);
    const latch = (this.file.recurrence.reopenLatch ??= { latched: false, reopenCount: 0, windowStartMs: input.now });
    if (input.now - latch.windowStartMs > this.cfg.reopenWindowMs) { latch.reopenCount = 0; latch.windowStartMs = input.now; latch.latched = false; }
    latch.reopenCount += 1;
    const ep: EpisodeState = {
      episodeId,
      openedAtMs,
      skewRowIdentities: rowIds,
      attentionItemId: target.itemId,
      itemRaisedAt: target.itemId ? input.now : undefined,
      reopenCount: latch.reopenCount,
      recurrence: emptyRecurrence(),
    };
    this.file.episode = ep;
    this.counters.episodesOpened += 1;
    // Enter latched-flapping after flappingLatchReopens re-opens in the window.
    if (!latch.latched && latch.reopenCount > this.cfg.flappingLatchReopens) {
      latch.latched = true;
      if (this.speaks(input) && ep.attentionItemId) effects.push({ kind: 'append', itemId: ep.attentionItemId, text: 'this divergence is flapping — recording silently until it stabilizes' });
    } else if (!latch.latched && this.speaks(input) && ep.attentionItemId) {
      // A reopened item is un-resolved (re-raised OPEN) with one short append.
      effects.push({ kind: 'raise', itemId: ep.attentionItemId, title: 'Machine coherence: divergence is back', summary: 'this divergence is back — re-opening', description: 'this divergence is back — re-opening' });
    }
    // else: latched → jsonl-only (no append).
    this.persist();
    this.log({ t: 'reopen', episodeId, reusedItem: target.itemId, reopenCount: latch.reopenCount, latched: latch.latched });
  }

  private maybeCapGiveup(input: EpisodeReconcileInput, effects: EpisodeEffect[]): void {
    const rec = this.file.recurrence;
    if (rec.capGiveupAtMs && input.now - rec.capGiveupAtMs < 86_400_000) return; // once per 24 h
    rec.capGiveupAtMs = input.now;
    const mostRecent = [...rec.recentlyClosed].reverse().find((c) => c.itemId)?.itemId ?? this.file.episode?.attentionItemId;
    if (mostRecent) effects.push({ kind: 'append', itemId: mostRecent, text: 'coherence is flapping faster than I\'ll alarm — further episodes today are recorded silently; see /pool/machine-coherence' });
    this.log({ t: 'cap-giveup' });
  }

  private joinRows(input: EpisodeReconcileInput, ep: EpisodeState, newRowIds: string[], effects: EpisodeEffect[]): void {
    ep.skewRowIdentities = [...ep.skewRowIdentities, ...newRowIds];
    this.pushFlapAppend(input, ep, `Another divergence joined this episode: ${newRowIds.map((id) => keyOf(id)).join(', ')}.`, false, effects);
    this.persist();
    this.log({ t: 'row-join', episodeId: ep.episodeId, rows: newRowIds });
  }

  private applySuspend(input: EpisodeReconcileInput, ep: EpisodeState, offline: string[], unverifiable: string[], effects: EpisodeEffect[]): void {
    if (ep.suspended) return; // already suspended — idempotent (append only on transition)
    ep.suspended = true;
    ep.suspendReason = offline.length > 0 ? 'peer-offline' : 'peer-unverifiable';
    this.resolveCleanTicks = 0;
    this.counters.suspends += 1;
    // §4.2.1-i/iv: suspension INVALIDATES a proposed/approved-holding pendingFix
    // (an executing-verifying fix is exempt — its write already happened; R5-N2).
    this.invalidatePendingFix(input, ep, 'suspended', effects);
    const who = input.nicknameOf(offline[0] ?? unverifiable[0]);
    const text = offline.length > 0
      ? `the divergent machine (${who}) went offline — holding this open; I'll re-check when it returns`
      : `${who} is online but I can't read its coherence card — holding`;
    this.pushFlapAppend(input, ep, text, true, effects);
    this.persist();
    this.log({ t: 'suspend', episodeId: ep.episodeId, reason: ep.suspendReason });
  }

  // ── §4.2.1 pendingFix state machine (proposal → approved-holding →
  //    executing-verifying; operator-uid-gated; single-flight; loud failure) ──

  /** Record the FIRST auto-proposable row as a `proposed` pendingFix (§4.2.1). A
   *  version/manifest/protocol row (no config override to write) and the two
   *  excluded flag classes (§4.2.1-iii) are NEVER auto-proposed. */
  private maybeProposeFix(input: EpisodeReconcileInput, ep: EpisodeState): void {
    if (ep.pendingFix) return; // cardinality: one at a time (R3-N8)
    const row = ep.skewRowIdentities.find((id) => this.isAutoProposable(id));
    if (!row) return;
    const key = keyOf(row);
    const targetMachineId = divergentMachineFor(row, input);
    const targetValue = plainValue(targetValueClassFor(row, input));
    ep.pendingFix = {
      state: 'proposed',
      rowIdentity: row,
      key,
      dimension: 'flag',
      targetMachineId,
      targetValue,
      proposalHash: proposalHash(ep.episodeId, key, targetMachineId, targetValue),
    };
  }

  /** Only FLAG rows carry a config override to equalize; the two §4.2.1-iii root
   *  classes are excluded (manual decision block instead). */
  private isAutoProposable(rowIdentity: string): boolean {
    return dimensionOf(rowIdentity) === 'flag' && !NEVER_AUTO_PROPOSE_KEYS.has(keyOf(rowIdentity));
  }

  /**
   * Operator approval of the recorded proposal (§4.2.1-i). The caller (the
   * conversational reply path) has ALREADY verified the sender is the topic's
   * verified operator (Know Your Principal) and passes `verifiedOperator`; the
   * `proposalHash` is the display-integrity authority (a reply confirms ONLY the
   * exact recorded proposal). Returns the transition + (for divergent==raiser)
   * an `execute-fix` effect the caller runs through the atomic config funnel.
   */
  approveFix(args: { proposalHash: string; verifiedOperator: boolean; now: number }): { result: FixApprovalResult; effects: EpisodeEffect[] } {
    const effects: EpisodeEffect[] = [];
    const ep = this.file.episode;
    if (!ep || !ep.pendingFix) return { result: { ok: false, reason: 'no-open-proposal' }, effects };
    const pf = ep.pendingFix;
    if (!args.verifiedOperator) return { result: { ok: false, reason: 'not-verified-operator' }, effects }; // Know Your Principal
    if (pf.proposalHash !== args.proposalHash) return { result: { ok: false, reason: 'proposal-lapsed' }, effects };
    if (pf.state !== 'proposed') return { result: { ok: false, reason: 'already-in-flight' }, effects }; // single-flight (R4-N4)
    pf.approvedAtMs = args.now;
    if (pf.targetMachineId === this.lastSelfMachineId) {
      // Divergent == raiser (mechanized): the raiser's own server writes + restarts.
      pf.state = 'executing-verifying';
      this.fixVerifyTicks = 0;
      const cfgPath = getFlagByKey(pf.key)?.configPath ?? pf.key;
      if (ep.attentionItemId) effects.push({ kind: 'execute-fix', itemId: ep.attentionItemId, key: pf.key, configPath: cfgPath, targetValue: pf.targetValue });
    } else {
      // Divergent == any other machine (held): the write is the agent's own hand
      // on that machine; v1 has no cross-machine execution trigger (§4.2.1-iv).
      pf.state = 'approved-holding';
      if (ep.attentionItemId) effects.push({ kind: 'append', itemId: ep.attentionItemId, text: `approved — I'll apply this from my own hands on ${this.nick(pf.targetMachineId)}; I'll confirm here when it lands` });
    }
    this.persist();
    this.log({ t: 'fix-approved', episodeId: ep.episodeId, state: pf.state, target: pf.targetMachineId });
    return { result: { ok: true, state: pf.state }, effects };
  }

  /** Invalidate a NOT-YET-EXECUTED pendingFix (§4.2.1-i). An executing-verifying
   *  fix is exempt (its durable write already happened — R5-N2). */
  private invalidatePendingFix(input: EpisodeReconcileInput, ep: EpisodeState, reason: string, effects: EpisodeEffect[]): void {
    const pf = ep.pendingFix;
    if (!pf || pf.state === 'executing-verifying') return;
    ep.pendingFix = undefined;
    this.fixVerifyTicks = 0;
    if (reason === 'suspended' && pf.state === 'approved-holding' && this.speaks(input) && ep.attentionItemId) {
      effects.push({ kind: 'append', itemId: ep.attentionItemId, text: `the fix you approved is paused — ${this.nick(pf.targetMachineId)} is unverifiable/offline; I'll re-propose when it returns` });
    }
    this.log({ t: 'fix-invalidated', episodeId: ep.episodeId, reason, wasState: pf.state });
  }

  /** §4.2.1-v verify: an executing-verifying fix whose row hasn't cleared within
   *  fixVerifyTicks fires ONE loud failure append + clears (episode stays open). */
  private verifyPendingFix(input: EpisodeReconcileInput, ep: EpisodeState, confirmedIds: Set<string>, effects: EpisodeEffect[]): void {
    const pf = ep.pendingFix;
    if (!pf || pf.state !== 'executing-verifying') return;
    if (!confirmedIds.has(pf.rowIdentity)) { ep.pendingFix = undefined; this.fixVerifyTicks = 0; this.log({ t: 'fix-cleared-row-gone', episodeId: ep.episodeId }); return; }
    this.fixVerifyTicks += 1;
    if (this.fixVerifyTicks >= this.cfg.fixVerifyTicks) {
      ep.pendingFix = undefined;
      this.fixVerifyTicks = 0;
      if (this.speaks(input) && ep.attentionItemId) effects.push({ kind: 'append', itemId: ep.attentionItemId, text: `the fix didn't take — ${pf.key} is still divergent; a retry needs your fresh approval` });
      this.persist();
      this.log({ t: 'fix-failed', episodeId: ep.episodeId, key: pf.key });
    }
  }

  private nick(machineId: string): string {
    return this.lastNicknameOf ? this.lastNicknameOf(machineId) : machineId;
  }

  /**
   * §4.5 SHARED per-episode append budget (R3-M5): all intra-episode FLAP-class
   * appends (row-join, suspend/resume, takeover re-arm) share one rolling budget
   * (`episodeAppendBudget` per `episodeAppendWindowMs`). ONE slot is RESERVED per
   * window for the first suspend/resume transition (R4-L6 — the clock-changing
   * note is never crowded out). Past the budget the episode enters latched
   * flapping: ONE "flapping — recording silently" note, then jsonl-only until the
   * rolling count falls back below budget (R4-N3/L7). Structural appends
   * (escalation, cap give-up) do NOT ride this budget.
   */
  private pushFlapAppend(input: EpisodeReconcileInput, ep: EpisodeState, text: string, isSuspendResume: boolean, effects: EpisodeEffect[]): void {
    if (!this.speaks(input) || !ep.attentionItemId) return;
    this.pruneRecurrence(input.now);
    const b = (this.file.recurrence.appendBudget ??= { appendTimestamps: [], latched: false });
    // Reserved slot: the first suspend/resume per window always speaks.
    if (isSuspendResume && (b.reservedSuspendResumeAtMs === undefined || input.now - b.reservedSuspendResumeAtMs > this.cfg.episodeAppendWindowMs)) {
      b.reservedSuspendResumeAtMs = input.now;
      b.appendTimestamps.push(input.now);
      effects.push({ kind: 'append', itemId: ep.attentionItemId, text });
      return;
    }
    if (b.latched) {
      if (b.appendTimestamps.length < this.cfg.episodeAppendBudget) b.latched = false; // exit
      else return; // jsonl-only while latched
    }
    if (b.appendTimestamps.length >= this.cfg.episodeAppendBudget) {
      b.latched = true;
      b.appendTimestamps.push(input.now);
      effects.push({ kind: 'append', itemId: ep.attentionItemId, text: 'this divergence is flapping — recording silently until it stabilizes' });
      return;
    }
    b.appendTimestamps.push(input.now);
    effects.push({ kind: 'append', itemId: ep.attentionItemId, text });
  }

  /** Lazy rolling-window eviction (R3-L2 — never triggers a write on its own). */
  private pruneRecurrence(now: number): void {
    const rec = this.file.recurrence;
    rec.newItemTimestamps = rec.newItemTimestamps.filter((t) => now - t < 86_400_000);
    rec.recentlyClosed = rec.recentlyClosed.filter((c) => now - c.closedAtMs < this.cfg.reopenWindowMs);
    if (rec.appendBudget) rec.appendBudget.appendTimestamps = rec.appendBudget.appendTimestamps.filter((t) => now - t < this.cfg.episodeAppendWindowMs);
  }

  private findReopenTarget(rowIds: string[], now: number): { itemId?: string } | null {
    const want = new Set(rowIds);
    for (const c of this.file.recurrence.recentlyClosed) {
      if (now - c.closedAtMs >= this.cfg.reopenWindowMs) continue;
      if (c.rowIdentities.some((id) => want.has(id))) return c;
    }
    return null;
  }

  private applyResume(input: EpisodeReconcileInput, ep: EpisodeState, effects: EpisodeEffect[]): void {
    ep.suspended = false;
    ep.suspendReason = undefined;
    this.counters.resumes += 1;
    // Resume is silent per §4.3 (same item, no new topic); jsonl records it.
    this.persist();
    this.log({ t: 'resume', episodeId: ep.episodeId });
  }

  private maybeEscalate(input: EpisodeReconcileInput, ep: EpisodeState, effects: EpisodeEffect[]): void {
    if (ep.escalationAppended || ep.operatorAck || ep.suspended) return;
    if (input.now - ep.openedAtMs < this.cfg.escalateAfterMs) return;
    ep.escalationAppended = true;
    this.counters.escalations += 1;
    if (this.speaks(input) && ep.attentionItemId) {
      effects.push({ kind: 'append', itemId: ep.attentionItemId, text: 'still divergent after 24h' });
    }
    this.persist();
    this.log({ t: 'escalate', episodeId: ep.episodeId });
  }

  private closeEpisode(input: EpisodeReconcileInput, ep: EpisodeState, reason: EpisodeCloseReason, effects: EpisodeEffect[]): void {
    // Record the close in the recurrence memory (R2-N2 — outlives close; the
    // item id rides along so a §4.5 reopen reuses the SAME item/topic).
    this.file.recurrence.recentlyClosed.push({ rowIdentities: [...ep.skewRowIdentities], closedAtMs: input.now, itemId: ep.attentionItemId });
    if (this.speaks(input) && ep.attentionItemId && reason === 'restored') {
      const keys = ep.skewRowIdentities.map((id) => keyOf(id)).join(', ');
      const nicks = [...this.episodeParticipants(ep)].map((m) => input.nicknameOf(m)).join(', ');
      effects.push({ kind: 'resolve', itemId: ep.attentionItemId, note: `machine-coherence restored — ${keys} now agree across ${nicks}, held for ${this.cfg.resolveTicks} ticks` });
    } else if (this.speaks(input) && ep.attentionItemId) {
      effects.push({ kind: 'resolve', itemId: ep.attentionItemId, note: this.closeNote(reason, ep, input) });
    }
    this.counters.closes[reason] = (this.counters.closes[reason] ?? 0) + 1;
    this.resolveCleanTicks = 0;
    this.file.episode = null;
    this.persist();
    this.log({ t: 'close', episodeId: ep.episodeId, reason });
  }

  private closeNote(reason: EpisodeCloseReason, ep: EpisodeState, input: EpisodeReconcileInput): string {
    switch (reason) {
      case 'expired-peer-gone':
        return 'the divergent machine never came back — closing; a fresh divergence will open a new episode';
      case 'manifest-changed': {
        const keys = ep.skewRowIdentities.map((id) => keyOf(id)).join(', ');
        return `${keys} are no longer compared under the new manifest — closing; not a restoration claim`;
      }
      default:
        return `episode closed — ${reason}`;
    }
  }

  /**
   * Set (or clear) the durable operator "leave it" ack (§4.2 / R4-N2). Called by
   * the conversational reply path. Suppresses the §4.4 escalation for this
   * episode; cleared on a genuine §4.5 recurrence re-open (b2).
   */
  setOperatorAck(ack: boolean): void {
    if (!this.file.episode) return;
    this.file.episode.operatorAck = ack;
    this.persist();
    this.log({ t: ack ? 'operator-ack' : 'operator-ack-clear', episodeId: this.file.episode.episodeId });
  }

  /** A suspended episode past the expiry closes `expired-peer-gone` (§4.3). Called each tick by the sentinel. */
  expireIfStale(now: number, nicknameOf: (m: string) => string): EpisodeEffect[] {
    const effects: EpisodeEffect[] = [];
    const ep = this.file.episode;
    if (!ep || !ep.suspended) return effects;
    // Suspended-since is approximated by openedAt when no explicit suspend-start
    // is tracked in this slice; the b2 recurrence work adds the precise anchor.
    if (now - ep.openedAtMs < this.cfg.suspendedEpisodeExpiryMs) return effects;
    this.closeEpisode(
      { now, nicknameOf } as EpisodeReconcileInput,
      ep,
      'expired-peer-gone',
      effects,
    );
    return effects;
  }

  status(): {
    openEpisode: { episodeId: string; rows: number; suspended: boolean; itemRaisedAt: string | null; pendingFix: { state: PendingFixState; key: string; targetMachineId: string; targetValue: string; proposalHash: string } | null } | null;
    counters: EpisodeManagerCounters;
  } {
    const ep = this.file.episode;
    const pf = ep?.pendingFix;
    return {
      openEpisode: ep ? {
        episodeId: ep.episodeId,
        rows: ep.skewRowIdentities.length,
        suspended: !!ep.suspended,
        itemRaisedAt: ep.itemRaisedAt ? new Date(ep.itemRaisedAt).toISOString() : null,
        pendingFix: pf ? { state: pf.state, key: pf.key, targetMachineId: pf.targetMachineId, targetValue: pf.targetValue, proposalHash: pf.proposalHash } : null,
      } : null,
      counters: this.counters,
    };
  }

  /** The current proposal's hash (the reply-recognition authority), or null. */
  currentProposalHash(): string | null {
    return this.file.episode?.pendingFix?.proposalHash ?? null;
  }

  private persist(): void {
    writeEpisodeFile(this.stateDir, this.file);
  }

  private log(row: Record<string, unknown>): void {
    try {
      fs.mkdirSync(path.dirname(this.logPath), { recursive: true });
      // Byte-cap safety rotation on append (O(1) size check). The precise 30-day
      // time-based prune (SessionWatchdog `rotateLog` shape) rides the wiring
      // slice as a periodic call on the sentinel cadence — noted in the artifact.
      maybeRotateJsonl(this.logPath);
      fs.appendFileSync(this.logPath, JSON.stringify({ ts: new Date().toISOString(), ...row }) + '\n');
    } catch {
      /* jsonl is observability — never fail a transition on a log write */
    }
  }

  /**
   * Render the §4.2 attention-item body VERBATIM (M9 — impact first, plain
   * language; a fix the agent performs on approval; technical detail last). The
   * peer-influenced strings (nicknames, effective values) are clamp-bounded
   * upstream (§4.2 exposure invariant) — rendered as data, never instructions.
   */
  renderBody(input: EpisodeReconcileInput, ep: EpisodeState): { title: string; summary: string; description: string } {
    const rows = ep.skewRowIdentities;
    const nicks = [...this.episodeParticipants(ep)].map((m) => input.nicknameOf(m));
    const nickList = joinNicknames(nicks);
    // 1. Impact first (the manifest guarantee, per row, by nickname).
    const guarantees = uniq(rows.map((id) => guaranteeFor(id))).join('; ');
    const summary = `My machines have drifted apart — ${nickList} aren't running as the same me: ${guarantees}.`;

    // 2. A complete proposed fix (direction is canonical + always named, §4.2.1-ii),
    //    OR a MANUAL decision block for the two excluded row classes (§4.2.1-iii:
    //    developmentAgent + the guard's own posture — flipping either is a
    //    graduation/blast-radius action the agent never auto-proposes).
    const first = rows[0];
    let fixLine: string;
    if (!this.isAutoProposable(first)) {
      const divergentNick = input.nicknameOf(divergentMachineFor(first, input));
      fixLine = `This one I won't touch on my own — ${keyOf(first)} is a root switch (flipping it changes far more than this setting). It differs on ${divergentNick} vs ${restOfPoolExcluding(this.episodeParticipants(ep), divergentMachineFor(first, input), input.nicknameOf)}. Tell me which way you want it and I'll set it — I'll do nothing until you say.`;
    } else {
      const divergent = divergentMachineFor(first, input); // the machine to change
      const targetValue = plainValue(targetValueClassFor(first, input));
      const feature = plainFeatureName(first);
      const divergentNick = input.nicknameOf(divergent);
      const restOfPool = joinNicknames([...this.episodeParticipants(ep)].filter((m) => m !== divergent).map((m) => input.nicknameOf(m)));
      if (divergent === input.selfMachineId) {
        const holdsLease = input.leaseHolderMachineId === input.selfMachineId;
        const peerNick = input.nicknameOf([...this.episodeParticipants(ep)].find((m) => m !== divergent) ?? divergent);
        const leaseClause = holdsLease
          ? `; I currently hold the serving lease, so the restart hands serving to ${peerNick} for that blip (a failover, named, not a surprise)`
          : '';
        fixLine = `Reply **fix it** and I'll switch ${feature} to ${targetValue} here on ${divergentNick} to match ${restOfPool}, then restart my own server — a ~30-second blip${leaseClause}.`;
      } else {
        fixLine = `Reply **fix it** and I'll switch ${feature} to ${targetValue} on ${divergentNick} from my own hands there — no remote config-write exists, so I'll confirm here when it lands (and tell you loudly if it doesn't within a few minutes).`;
      }
    }
    const leaveLine = `Or reply **leave it** and I'll keep this episode open without further nagging.`;

    // 3. Technical detail last (secondary block).
    const tech = rows.map((id) => `${dimensionOf(id)} · ${keyOf(id)} · ${renderValueClasses(id, input.nicknameOf)}`).join('\n');

    const title = 'Machine coherence: my machines have drifted apart';
    const description = `${summary}\n\n${fixLine}\n\n${leaveLine}\n\nTechnical detail:\n${tech}`;
    return { title, summary, description };
  }
}

/** The §4.2.1-i display-integrity authority: a hash over the exact proposal tuple
 *  (episodeId|key|targetMachine|targetValue). A reply confirms ONLY this tuple. */
function proposalHash(episodeId: string, key: string, targetMachineId: string, targetValue: string): string {
  return crypto.createHash('sha256').update(`${episodeId}|${key}|${targetMachineId}|${targetValue}`).digest('hex').slice(0, 16);
}

function restOfPoolExcluding(participants: Set<string>, exclude: string, nicknameOf: (m: string) => string): string {
  return joinNicknames([...participants].filter((m) => m !== exclude).map((m) => nicknameOf(m)));
}

// ── Pure row-identity helpers (the N1 identity is `dimension|key|sorted(id=vc)`) ──
function dimensionOf(rowIdentity: string): string {
  return rowIdentity.split('|', 1)[0] ?? '';
}
function keyOf(rowIdentity: string): string {
  return rowIdentity.split('|')[1] ?? '';
}
function participantsOf(rowIdentity: string): string[] {
  const tail = rowIdentity.split('|').slice(2).join('|');
  if (!tail) return [];
  return tail.split(',').map((p) => p.split('=')[0]).filter(Boolean);
}
function valueClassesOf(rowIdentity: string): Record<string, string> {
  const tail = rowIdentity.split('|').slice(2).join('|');
  const out: Record<string, string> = {};
  if (!tail) return out;
  for (const p of tail.split(',')) {
    const [m, v] = p.split('=');
    if (m) out[m] = v ?? '';
  }
  return out;
}
function renderValueClasses(rowIdentity: string, nicknameOf: (m: string) => string): string {
  const vc = valueClassesOf(rowIdentity);
  return Object.entries(vc).map(([m, v]) => `${nicknameOf(m)}=${v}`).join(', ');
}
function guaranteeFor(rowIdentity: string): string {
  const dim = dimensionOf(rowIdentity);
  if (dim === 'flag') {
    const f = getFlagByKey(keyOf(rowIdentity));
    if (f) return f.guarantee;
  }
  if (dim === 'version') return 'the two machines are running different versions of me';
  if (dim === 'manifest') return 'the two machines built the same version differently (a dirty or locally-built dist)';
  if (dim === 'protocol') return 'the two machines speak different mesh protocol versions';
  return 'a cross-machine guarantee is halved';
}
function plainFeatureName(rowIdentity: string): string {
  const dim = dimensionOf(rowIdentity);
  if (dim === 'flag') {
    const f = getFlagByKey(keyOf(rowIdentity));
    if (f) return f.guarantee; // the plain-language framing (§4.2 point 2)
  }
  return keyOf(rowIdentity);
}
/** §4.2.1-ii direction: equalize toward the pool-majority value class; with no
 *  majority (the 2-machine case) toward the serving-lease-holder's value. */
function targetValueClassFor(rowIdentity: string, input: EpisodeReconcileInput): string {
  const vc = valueClassesOf(rowIdentity);
  const counts = new Map<string, number>();
  for (const v of Object.values(vc)) counts.set(v, (counts.get(v) ?? 0) + 1);
  let best: string | null = null; let bestN = 0; let tie = false;
  for (const [v, n] of counts) { if (n > bestN) { best = v; bestN = n; tie = false; } else if (n === bestN) tie = true; }
  if (best !== null && !tie) return best;
  // No majority → the lease holder's value (if it is a participant).
  if (input.leaseHolderMachineId && vc[input.leaseHolderMachineId] !== undefined) return vc[input.leaseHolderMachineId];
  return best ?? 'the pool value';
}
/** The machine to change = a participant whose value class ≠ the target. */
function divergentMachineFor(rowIdentity: string, input: EpisodeReconcileInput): string {
  const vc = valueClassesOf(rowIdentity);
  const target = targetValueClassFor(rowIdentity, input);
  const off = Object.entries(vc).find(([, v]) => v !== target);
  return off ? off[0] : (Object.keys(vc)[0] ?? input.selfMachineId);
}
function plainValue(valueClass: string): string {
  const map: Record<string, string> = { live: 'on', dark: 'off', 'dry-run': 'dry-run', true: 'on', false: 'off' };
  return map[valueClass] ?? valueClass;
}
function joinNicknames(nicks: string[]): string {
  const u = uniq(nicks);
  if (u.length <= 1) return u[0] ?? '';
  if (u.length === 2) return `${u[0]} and ${u[1]}`;
  return `${u.slice(0, -1).join(', ')}, and ${u[u.length - 1]}`;
}
function uniq(a: string[]): string[] {
  return [...new Set(a)];
}
