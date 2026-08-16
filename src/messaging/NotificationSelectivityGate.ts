/**
 * NotificationSelectivityGate.ts — the last-hop selectivity gate (Quiet by Default,
 * docs/specs/notification-selectivity.md §2, §3, §5, §6, §7).
 *
 * A deterministic, synchronous, LLM-free classifier invoked inside the delivery
 * chokepoints (`TelegramAdapter.sendToTopic` / `createAttentionItem`). It routes each
 * send — `deliver` (verified replies + corroborated conversation-serving floors),
 * `deliver-push` (significant per the §5 code table, or category opted-in, WITHIN the
 * §5.2 budgets), or `record` (the quiet store; never delivered).
 *
 * Signal-vs-Authority: this gate holds blocking-equivalent ROUTING authority while
 * being deterministic — legitimate because its key is structural provenance (who/
 * where a message came from; the P17 origin-typed-ceiling precedent), never content
 * interpretation. It reads NO message text. Content authority stays with the tone
 * gate (§8).
 *
 * Fail directions (§2.4): verified-reply + malfunction → deliver; automated +
 * malfunction → record; recording failure → the §6 ladder (owned by the store);
 * dryRun → always deliver, ledger counterfactuals only, NO quiet-store writes.
 */

import fs from 'node:fs';
import path from 'node:path';
import { JsonlStore } from '../core/storage/JsonlStore.js';
import {
  resolveCategory,
  isSignificantAllowed,
  UNCATEGORIZED,
  SIGNIFICANT_CLASSES,
  type NotificationCategory,
  type SignificantClass,
} from './notificationCategories.js';
import { PreDecidedEnvelope, mintPreDecided, type OutboundEnvelope } from './notificationEnvelope.js';

export type GateDecision = 'deliver' | 'deliver-push' | 'record';

export interface GateVerdict {
  deliver: boolean;
  decision: GateDecision;
  reason: string;
  category: string;
  dryRun: boolean;
  quietId?: string;
}

export interface GateProcessInput {
  topicId: number;
  text: string;
  envelope?: OutboundEnvelope | PreDecidedEnvelope;
  kindMetadata?: Record<string, unknown>;
}

interface CategoryCounters {
  delivered: number;
  pushed: number;
  recorded: number;
  coalesced: number;
}

export interface GateStatus {
  enabled: boolean;
  dryRun: boolean;
  counters: Record<string, CategoryCounters>;
  canaries: {
    eatenReplyCounterfactual: number;
    demotedConversationServing: number;
    replyWithoutRecentInbound: number;
  };
  budgets: {
    perCategoryPer10Min: number;
    significantPerLanePer10Min: number;
    globalRoutinePer10Min: number;
  };
  ledgerDegraded: boolean;
  decisions: number;
}

/** FD-15 — shipped budget defaults (tunable DOWN via config, never off). */
const ROUTINE_PER_CATEGORY_DEFAULT = 3;
const SIGNIFICANT_PER_LANE_DEFAULT = 3;
const GLOBAL_ROUTINE_DEFAULT = 10;
const BUDGET_WINDOW_MS = 10 * 60 * 1000;
const CORROBORATION_WINDOW_MS = 15 * 60 * 1000;
const EPISODE_REARM_MS = 6 * 60 * 60 * 1000;
const MAX_LANE_KEYS = 500;

export interface NotificationSelectivityGateOptions {
  /** Agent state dir (`.instar`); the ledger lives at `<stateDir>/../logs/` next to server.log. */
  stateDir: string;
  /** RESOLVED enabled state — the caller wires resolveDevAgentGate (the one funnel). */
  isEnabled: () => boolean;
  getDryRun: () => boolean;
  getPushCategories: () => Record<string, unknown> | undefined;
  /** Resolve a category's legacyGate dotted key against live config (§3.5). */
  getLegacyGateValue: (dottedKey: string) => boolean;
  /** Budget tunables (clamped: tunable down, never off/up past defaults — FD-15). */
  getBudgetOverrides?: () => { perCategoryPer10Min?: number; globalPer10Min?: number } | undefined;
  quietStore?: import('./QuietNotificationStore.js').QuietNotificationStore | null;
  recencyMap: import('./InboundRecencyMap.js').InboundRecencyMap;
  machineId?: () => string | undefined;
  /** §2.4 relay-fallback closure condition: are any REGISTERED peers present? */
  hasRegisteredPeers?: () => boolean;
  /** Emit a §5.2 overflow summary (wired to the adapter's hub send, pre-decided). */
  sendSummary?: (text: string, envelope: PreDecidedEnvelope) => void;
  now?: () => number;
}

export class NotificationSelectivityGate {
  private readonly opts: NotificationSelectivityGateOptions;
  private readonly now: () => number;
  private ledger: JsonlStore | null = null;
  private ledgerDegraded = false;
  private counters = new Map<string, CategoryCounters>();
  private canaries = { eatenReplyCounterfactual: 0, demotedConversationServing: 0, replyWithoutRecentInbound: 0 };
  private decisions = 0;

  /** Rolling budget timelines per lane key (`routine:<cat>` / `sig:<cat>:<class>` / `global`). */
  private budgetTimelines = new Map<string, number[]>();
  /** Overflow summaries already emitted this window, per lane key. */
  private summaryEmittedAt = new Map<string, number>();
  /** Overflow counts accumulated per lane key within the current window. */
  private overflowCounts = new Map<string, number>();
  /** §5 episode dedup: (category|class|sourceContext) → last raise. */
  private episodes = new Map<string, number>();
  /** §3.2 single-use command-response inbound ids: `${topic}:${id}` → consumedAt. */
  private consumedCommandIds = new Map<string, number>();
  /** §2.4 — per-peer last-advertised relay protocol version. */
  private peerProtocols = new Map<string, number>();

  constructor(opts: NotificationSelectivityGateOptions) {
    this.opts = opts;
    this.now = opts.now ?? Date.now;
    try {
      const logDir = path.join(opts.stateDir, '..', 'logs');
      fs.mkdirSync(logDir, { recursive: true });
      /* state-registry: notification-selectivity-ledger */
      this.ledger = new JsonlStore(path.join(logDir, 'notification-selectivity.jsonl'), {
        maxBytes: 2 * 1024 * 1024,
        keepSegments: 1,
      });
    } catch {
      this.ledgerDegraded = true;
    }
  }

  isEnabled(): boolean {
    try {
      return this.opts.isEnabled();
    } catch {
      return false;
    }
  }

  isDryRun(): boolean {
    try {
      return this.opts.getDryRun();
    } catch {
      return true;
    }
  }

  /**
   * The funnel call (§2.3). Deterministic + synchronous; zero disk I/O on the
   * deliver path (the ledger append is a bounded local write, itself fail-safe).
   */
  process(input: GateProcessInput): GateVerdict {
    if (!this.isEnabled()) {
      return { deliver: true, decision: 'deliver', reason: 'gate-dark', category: UNCATEGORIZED, dryRun: false };
    }
    try {
      return this.classify(input);
    } catch (err) {
      // §2.4 fail directions: a gate exception fails toward the class's safe side.
      const origin = this.originOf(input.envelope);
      if (origin === 'verified-reply') {
        return this.finish(input, 'deliver', 'gate-exception-reply-fails-open', UNCATEGORIZED, undefined, {
          error: err instanceof Error ? err.message : String(err),
        });
      }
      return this.finish(input, 'record', 'gate-exception-automated-fails-closed', UNCATEGORIZED, undefined, {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * The attention chokepoint (§2 single-evaluation): render the verdict ONCE at
   * `createAttentionItem`; a push rides a PRE-DECIDED envelope through the funnel.
   */
  evaluateAttention(input: {
    category: 'attention-item' | 'agent-health';
    sourceContext: string;
    significantClass?: SignificantClass;
    priority?: string;
  }): { push: boolean; dryRun: boolean; mintPush?: () => PreDecidedEnvelope; reason: string } {
    if (!this.isEnabled()) {
      return { push: true, dryRun: false, reason: 'gate-dark' };
    }
    const dryRun = this.isDryRun();
    const sourceContext = input.sourceContext || input.category;
    let decision: GateDecision;
    let reason: string;

    if (input.significantClass && isSignificantAllowed(input.category, input.significantClass)) {
      const episodeKey = `${input.category}|${input.significantClass}|${sourceContext}`;
      if (!this.episodeAdmits(episodeKey)) {
        decision = 'record';
        reason = 'significant-episode-dedup';
      } else if (this.budgetAdmits(`sig:${input.category}:${input.significantClass}`, this.significantLaneBudget(), dryRun)) {
        decision = 'deliver-push';
        reason = `significant:${input.significantClass}`;
      } else {
        decision = 'record';
        reason = 'significant-budget-coalesced';
        this.noteOverflow(`sig:${input.category}:${input.significantClass}`, input.category, input.significantClass, dryRun);
      }
    } else {
      if (input.significantClass) {
        this.ledgerRow({
          ts: new Date(this.now()).toISOString(),
          kind: 'audit',
          audit: 'significant-mislabel',
          category: input.category,
          significantClass: input.significantClass,
          sourceContext,
        });
      }
      if (this.isPushEntitled(resolveCategory(input.category))) {
        if (this.routineBudgetAdmits(input.category, dryRun)) {
          decision = 'deliver-push';
          reason = 'category-opted-in';
        } else {
          decision = 'record';
          reason = 'push-budget-coalesced';
          this.noteOverflow(`routine:${input.category}`, input.category, undefined, dryRun);
        }
      } else {
        decision = 'record';
        reason = 'quiet-default';
      }
    }

    this.decisions++;
    this.ledgerRow({
      ts: new Date(this.now()).toISOString(),
      origin: 'automated',
      category: input.category,
      ...(input.significantClass ? { significantClass: input.significantClass } : {}),
      decision,
      reason,
      dryRun,
      ...(dryRun && decision === 'record' ? { wouldRecord: true } : {}),
      sourceContext,
      machineId: this.machineId(),
    });
    this.bumpCounter(input.category, dryRun ? 'delivered' : decision === 'record' ? 'recorded' : 'pushed');

    if (decision === 'deliver-push' || dryRun) {
      // The verdict (incl. its budget consumption) was rendered ONCE here; the
      // mint closure lets the caller stamp each delivery ATTEMPT of that one
      // verdict (the hub route retries on a self-healed topic) while each
      // PreDecidedEnvelope instance stays strictly single-use.
      const fields = {
        category: input.category,
        significantClass: input.significantClass,
        sourceContext,
        reason: dryRun && decision === 'record' ? `dryRun:${reason}` : reason,
      };
      return { push: true, dryRun, reason, mintPush: () => mintPreDecided(fields) };
    }
    return { push: false, dryRun, reason };
  }

  /**
   * §6 step 2 — the store-failure significant notice. Hardcoded to the §5 table
   * (category `attention-item`, class `data-loss`); by construction it can never
   * classify `record` on first raise and never writes the quiet store.
   */
  raiseStoreFailureNotice(summary: string, raiseAttention: (item: {
    id: string;
    title: string;
    body: string;
    significantClass: SignificantClass;
    sourceContext: string;
  }) => void): void {
    try {
      raiseAttention({
        id: 'selectivity:store-failure',
        title: 'Quiet notification store failing',
        body: summary,
        significantClass: 'data-loss',
        sourceContext: 'selectivity-store-failure',
      });
    } catch {
      this.ledgerRow({
        ts: new Date(this.now()).toISOString(),
        kind: 'audit',
        audit: 'store-failure-notice-raise-failed',
        category: 'attention-item',
        sourceContext: 'selectivity-store-failure',
      });
    }
  }

  /** §2.4 — record a peer's advertised relay protocol version (relay marker). */
  notePeerProtocol(machineId: string, protocolVersion: number): void {
    if (machineId) this.peerProtocols.set(machineId, protocolVersion);
  }

  /**
   * §2.4 closure condition: the envelope-less-relay kindMetadata fallback is alive
   * ONLY while a registered peer has not been seen advertising the envelope
   * protocol; DEAD the moment no such peer exists (single-machine → dead).
   */
  legacyRelayFallbackActive(): boolean {
    let hasPeers = false;
    try {
      hasPeers = this.opts.hasRegisteredPeers?.() ?? false;
    } catch {
      hasPeers = false;
    }
    if (!hasPeers) return false;
    // Peers exist: the fallback stays alive until every SEEN peer advertises >=1.
    // An unseen peer (registered but never relayed here) keeps the fallback alive —
    // the safe direction (an eaten relayed reply is the worst failure, §2.4).
    if (this.peerProtocols.size === 0) return true;
    for (const v of this.peerProtocols.values()) {
      if (v < 1) return true;
    }
    return false;
  }

  status(peerCount?: number): GateStatus & { poolWideTheoreticalMaxPushesPer10Min?: number } {
    const budgets = {
      perCategoryPer10Min: this.routineBudget(),
      significantPerLanePer10Min: this.significantLaneBudget(),
      globalRoutinePer10Min: this.globalBudget(),
    };
    const counters: Record<string, CategoryCounters> = {};
    for (const [k, v] of this.counters) counters[k] = { ...v };
    return {
      enabled: this.isEnabled(),
      dryRun: this.isDryRun(),
      counters,
      canaries: { ...this.canaries },
      budgets,
      ledgerDegraded: this.ledgerDegraded,
      decisions: this.decisions,
      ...(peerCount !== undefined
        ? { poolWideTheoreticalMaxPushesPer10Min: budgets.globalRoutinePer10Min * Math.max(1, peerCount + 1) }
        : {}),
    };
  }

  /* ── classification core ─────────────────────────────────────────────── */

  private classify(input: GateProcessInput): GateVerdict {
    const dryRun = this.isDryRun();

    // Pre-decided pass-through (§2): single evaluation, single use.
    if (input.envelope instanceof PreDecidedEnvelope) {
      if (input.envelope.consume()) {
        return this.finish(input, 'deliver-push', `pre-decided:${input.envelope.reason}`, input.envelope.category, input.envelope.significantClass);
      }
      // Replay: a captured instance never skips re-evaluation — classify fresh as automated.
      return this.classifyPlain(
        {
          origin: 'automated',
          category: input.envelope.category,
          sourceContext: input.envelope.sourceContext,
        },
        input,
        dryRun,
        true,
      );
    }

    const envelope = input.envelope;
    if (!envelope) {
      // §2.4 version-skew fallback: an envelope-less send still carrying relay-era
      // kindMetadata falls back to messageKind ONLY under the pinned closure condition.
      const kind = typeof input.kindMetadata?.messageKind === 'string' ? input.kindMetadata.messageKind : undefined;
      if (kind === 'reply' && this.legacyRelayFallbackActive()) {
        return this.finish(input, 'deliver', 'legacy-relay-kindmetadata-fallback', UNCATEGORIZED, undefined, {
          relayedOrigin: true,
        });
      }
      return this.classifyPlain(
        { origin: 'automated', category: UNCATEGORIZED, sourceContext: 'unstamped' },
        input,
        dryRun,
        false,
      );
    }
    return this.classifyPlain(envelope, input, dryRun, false);
  }

  private classifyPlain(
    envelope: OutboundEnvelope,
    input: GateProcessInput,
    dryRun: boolean,
    replayed: boolean,
  ): GateVerdict {
    const category = resolveCategory(envelope.category);
    const extras: Record<string, unknown> = {
      ...(envelope.relayedOrigin ? { relayedOrigin: true } : {}),
      ...(replayed ? { preDecidedReplay: true } : {}),
      ...(this.kindDivergence(envelope, input.kindMetadata) ? { kindDivergence: true } : {}),
    };

    // Verified reply: the conversational surface always delivers (§2.2, D-8).
    if (envelope.origin === 'verified-reply') {
      if (!this.opts.recencyMap.hasRecentInbound(input.topicId, CORROBORATION_WINDOW_MS)) {
        // §2.2.4 — ADVISORY in v1 (FD-9): logged, never a demotion.
        this.canaries.replyWithoutRecentInbound++;
        extras.replyWithoutRecentInbound = true;
      }
      return this.finish(input, 'deliver', 'verified-reply', category.id, undefined, extras);
    }

    // Runtime callsite→category fit (§9): a module outside emitterModules records.
    if (
      envelope.emitterModule &&
      category.id !== UNCATEGORIZED &&
      category.emitterModules.length > 0 &&
      !category.emitterModules.includes(envelope.emitterModule)
    ) {
      this.ledgerRow({
        ts: new Date(this.now()).toISOString(),
        kind: 'audit',
        audit: 'emitter-module-mismatch',
        category: category.id,
        emitterModule: envelope.emitterModule,
        sourceContext: envelope.sourceContext,
      });
      return this.finish(input, 'record', 'emitter-module-mismatch', category.id, undefined, extras, envelope);
    }

    if (category.disposition === 'conversation-serving') {
      return this.classifyConversationServing(category, envelope, input, dryRun, extras);
    }

    // Quiet disposition (§3.1): significant lane, then opt-in, then record.
    if (envelope.significantClass) {
      if (isSignificantAllowed(category.id, envelope.significantClass)) {
        return this.classifySignificant(category, envelope, input, dryRun, extras);
      }
      this.ledgerRow({
        ts: new Date(this.now()).toISOString(),
        kind: 'audit',
        audit: 'significant-mislabel',
        category: category.id,
        significantClass: envelope.significantClass,
        emitterModule: envelope.emitterModule,
        sourceContext: envelope.sourceContext,
      });
      extras.significantMislabel = true;
    }

    if (this.isPushEntitled(category)) {
      if (this.routineBudgetAdmits(category.id, dryRun)) {
        return this.finish(input, 'deliver-push', category.emitterGated ? 'emitter-gated' : 'category-opted-in', category.id, undefined, extras, envelope);
      }
      this.noteOverflow(`routine:${category.id}`, category.id, undefined, dryRun);
      return this.finish(input, 'record', 'push-budget-coalesced', category.id, undefined, extras, envelope);
    }
    return this.finish(input, 'record', 'quiet-default', category.id, undefined, extras, envelope);
  }

  private classifySignificant(
    category: NotificationCategory,
    envelope: OutboundEnvelope,
    input: GateProcessInput,
    dryRun: boolean,
    extras: Record<string, unknown>,
  ): GateVerdict {
    const cls = envelope.significantClass as SignificantClass;
    const episodeKey = `${category.id}|${cls}|${envelope.sourceContext}`;
    if (!this.episodeAdmits(episodeKey)) {
      return this.finish(input, 'record', 'significant-episode-dedup', category.id, cls, extras, envelope);
    }
    const laneKey = `sig:${category.id}:${cls}`;
    if (this.budgetAdmits(laneKey, this.significantLaneBudget(), dryRun)) {
      return this.finish(input, 'deliver-push', `significant:${cls}`, category.id, cls, extras, envelope);
    }
    this.noteOverflow(laneKey, category.id, cls, dryRun);
    return this.finish(input, 'record', 'significant-budget-coalesced', category.id, cls, extras, envelope);
  }

  private classifyConversationServing(
    category: NotificationCategory,
    envelope: OutboundEnvelope,
    input: GateProcessInput,
    dryRun: boolean,
    extras: Record<string, unknown>,
  ): GateVerdict {
    const cold = this.opts.recencyMap.isCold();
    const floor = category.id === 'cold-start-fallback' || category.id === 'message-loss-notice';

    if (cold) {
      extras.mapCold = true;
      if (floor) {
        // Always-Reachable floors fail OPEN under a cold map (their trigger IS an inbound).
        return this.finish(input, 'deliver', 'conversation-serving-floor-cold-map', category.id, undefined, extras);
      }
      this.noteDemotedConversationServing(dryRun);
      return this.finish(input, 'record', 'conversation-serving-cold-map', category.id, undefined, extras, envelope);
    }

    const inboundId = envelope.inboundMessageId;
    let corroborated = false;
    if (category.id === 'presence-standby') {
      corroborated = !!inboundId && this.opts.recencyMap.currentUnanswered(input.topicId) === inboundId;
    } else if (category.id === 'command-response') {
      if (inboundId && this.opts.recencyMap.hasInbound(input.topicId, inboundId, CORROBORATION_WINDOW_MS)) {
        const useKey = `${input.topicId}:${inboundId}`;
        if (!this.consumedCommandIds.has(useKey)) {
          this.consumedCommandIds.set(useKey, this.now());
          this.gcConsumedIds();
          corroborated = true;
        }
      }
    } else {
      corroborated = !!inboundId && this.opts.recencyMap.hasInbound(input.topicId, inboundId, CORROBORATION_WINDOW_MS);
    }

    if (corroborated) {
      return this.finish(input, 'deliver', 'conversation-serving', category.id, undefined, extras);
    }
    // An active topic is NOT a standing license (§3.2): uncorroborated claims record.
    this.noteDemotedConversationServing(dryRun);
    return this.finish(input, 'record', 'conversation-serving-uncorroborated', category.id, undefined, extras, envelope);
  }

  /* ── verdict finish: ledger + counters + dryRun + store ───────────────── */

  private finish(
    input: GateProcessInput,
    decision: GateDecision,
    reason: string,
    categoryId: string,
    significantClass?: SignificantClass,
    extras?: Record<string, unknown>,
    envelope?: OutboundEnvelope,
  ): GateVerdict {
    const dryRun = this.isDryRun();
    this.decisions++;
    const row: Record<string, unknown> = {
      ts: new Date(this.now()).toISOString(),
      origin: envelope?.origin ?? (decision === 'deliver' && reason.startsWith('verified') ? 'verified-reply' : reason === 'gate-dark' ? 'unknown' : 'automated'),
      category: categoryId,
      ...(significantClass ? { significantClass } : {}),
      decision,
      reason,
      dryRun,
      topicId: input.topicId,
      sourceContext: envelope?.sourceContext ?? (input.envelope instanceof PreDecidedEnvelope ? input.envelope.sourceContext : 'unstamped'),
      machineId: this.machineId(),
      ...(extras ?? {}),
    };

    if (decision === 'record') {
      if (dryRun) {
        // Counterfactual only: deliver, ledger `wouldRecord`, NO quiet-store write.
        row.wouldRecord = true;
        this.ledgerRow(row);
        this.bumpCounter(categoryId, 'delivered');
        return { deliver: true, decision: 'record', reason, category: categoryId, dryRun: true };
      }
      row.callerHint = this.callerHint();
      let quietId: string | undefined;
      try {
        quietId = this.opts.quietStore?.record({
          category: categoryId,
          sourceContext: String(row.sourceContext),
          origin: (envelope?.origin ?? 'automated') as 'automated' | 'verified-reply',
          text: input.text,
          topicId: input.topicId,
          ...(significantClass ? { significantClass } : {}),
          reason,
        });
      } catch {
        // The store's own §6 ladder owns write failures; a record() throw must
        // never turn into a delivery (quiet-routing stays quiet).
        quietId = undefined;
      }
      if (quietId) row.quietId = quietId;
      this.ledgerRow(row);
      this.bumpCounter(categoryId, 'recorded');
      return { deliver: false, decision, reason, category: categoryId, dryRun, quietId: quietId ?? 'unrecorded' };
    }

    this.ledgerRow(row);
    this.bumpCounter(categoryId, decision === 'deliver-push' ? 'pushed' : 'delivered');
    return { deliver: true, decision, reason, category: categoryId, dryRun };
  }

  /* ── budgets (§5.2 / FD-15) ────────────────────────────────────────────── */

  private routineBudget(): number {
    const o = this.safeBudgetOverrides()?.perCategoryPer10Min;
    return this.clampBudget(o, ROUTINE_PER_CATEGORY_DEFAULT);
  }

  private significantLaneBudget(): number {
    return SIGNIFICANT_PER_LANE_DEFAULT;
  }

  private globalBudget(): number {
    const o = this.safeBudgetOverrides()?.globalPer10Min;
    return this.clampBudget(o, GLOBAL_ROUTINE_DEFAULT);
  }

  private safeBudgetOverrides(): { perCategoryPer10Min?: number; globalPer10Min?: number } | undefined {
    try {
      return this.opts.getBudgetOverrides?.();
    } catch {
      return undefined;
    }
  }

  /** Tunable DOWN, never off (min 1), never above the shipped default. */
  private clampBudget(value: number | undefined, dflt: number): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) return dflt;
    return Math.max(1, Math.min(Math.floor(value), dflt));
  }

  /** Routine lane: per-category budget AND the global routine ceiling (§5.2). */
  private routineBudgetAdmits(categoryId: string, dryRun: boolean): boolean {
    const catOk = this.budgetAdmits(`routine:${categoryId}`, this.routineBudget(), dryRun, true);
    if (!catOk) return false;
    const globalOk = this.budgetAdmits('global', this.globalBudget(), dryRun);
    if (!globalOk) {
      // Roll back the per-category consumption so the window stays honest.
      const tl = this.budgetTimelines.get(`routine:${categoryId}`);
      tl?.pop();
      return false;
    }
    return true;
  }

  private budgetAdmits(laneKey: string, budget: number, _dryRun: boolean, deferGlobal = false): boolean {
    void deferGlobal;
    const nowMs = this.now();
    let tl = this.budgetTimelines.get(laneKey);
    if (!tl) {
      if (this.budgetTimelines.size >= MAX_LANE_KEYS) this.gcTimelines(nowMs);
      tl = [];
      this.budgetTimelines.set(laneKey, tl);
    }
    while (tl.length > 0 && nowMs - tl[0] > BUDGET_WINDOW_MS) tl.shift();
    if (tl.length >= budget) return false;
    tl.push(nowMs);
    return true;
  }

  /** §5.2 overflow: coalesce into ONE pinned summary per lane key per window. */
  private noteOverflow(laneKey: string, categoryId: string, cls: SignificantClass | undefined, dryRun: boolean): void {
    this.overflowCounts.set(laneKey, (this.overflowCounts.get(laneKey) ?? 0) + 1);
    this.bumpCounter(categoryId, 'coalesced');
    if (dryRun) return; // a summary is a push; dryRun pushes nothing extra
    const nowMs = this.now();
    const last = this.summaryEmittedAt.get(laneKey);
    if (last !== undefined && nowMs - last < BUDGET_WINDOW_MS) return;
    this.summaryEmittedAt.set(laneKey, nowMs);
    const n = this.overflowCounts.get(laneKey) ?? 1;
    this.overflowCounts.set(laneKey, 0);
    // Pinned content (§5.2): count + category/class name + the dashboard pointer —
    // never sourceContext, titles, or item text.
    const text = cls
      ? `${cls}: ${n} more episode${n === 1 ? '' : 's'} in 10m (category ${categoryId}) — details in the dashboard Notifications tab.`
      : laneKey === 'global'
        ? `${n} more opted-in notification push${n === 1 ? '' : 'es'} across categories coalesced in this 10m window — details in the dashboard Notifications tab.`
        : `${n} more ${categoryId} push${n === 1 ? '' : 'es'} coalesced in this 10m window — details in the dashboard Notifications tab.`;
    const envelope = mintPreDecided({
      category: cls ? categoryId : 'selectivity-digest',
      significantClass: cls,
      sourceContext: `overflow-summary:${laneKey}`,
      reason: 'budget-overflow-summary',
    });
    try {
      this.opts.sendSummary?.(text, envelope);
    } catch {
      /* @silent-fallback-ok — summary emission is best-effort; items are all recorded */
    }
  }

  /* ── small helpers ─────────────────────────────────────────────────────── */

  private isPushEntitled(category: NotificationCategory): boolean {
    if (category.emitterGated) return true; // §3.4 — the emitter's own lever already gated it
    let optedIn = false;
    try {
      const cats = this.opts.getPushCategories();
      optedIn = cats?.[category.id] === true;
    } catch {
      optedIn = false;
    }
    if (optedIn) return true;
    if (category.legacyGate) {
      try {
        return this.opts.getLegacyGateValue(category.legacyGate) === true;
      } catch {
        return false;
      }
    }
    return false;
  }

  private episodeAdmits(episodeKey: string): boolean {
    const nowMs = this.now();
    const last = this.episodes.get(episodeKey);
    if (last !== undefined && nowMs - last < EPISODE_REARM_MS) return false;
    if (this.episodes.size >= MAX_LANE_KEYS) {
      for (const [k, t] of this.episodes) {
        if (nowMs - t >= EPISODE_REARM_MS) this.episodes.delete(k);
      }
    }
    this.episodes.set(episodeKey, nowMs);
    return true;
  }

  private originOf(envelope: GateProcessInput['envelope']): 'verified-reply' | 'automated' {
    if (envelope && !(envelope instanceof PreDecidedEnvelope) && envelope.origin === 'verified-reply') {
      return 'verified-reply';
    }
    return 'automated';
  }

  private kindDivergence(envelope: OutboundEnvelope, kindMetadata?: Record<string, unknown>): boolean {
    const kind = typeof kindMetadata?.messageKind === 'string' ? kindMetadata.messageKind : undefined;
    if (!kind) return false;
    if (kind === 'reply' && envelope.origin !== 'verified-reply') return true;
    if (kind === 'automated' && envelope.origin === 'verified-reply') return true;
    return false;
  }

  private noteDemotedConversationServing(_dryRun: boolean): void {
    this.canaries.demotedConversationServing++;
  }

  private bumpCounter(categoryId: string, key: keyof CategoryCounters): void {
    let c = this.counters.get(categoryId);
    if (!c) {
      c = { delivered: 0, pushed: 0, recorded: 0, coalesced: 0 };
      this.counters.set(categoryId, c);
    }
    c[key]++;
  }

  private ledgerRow(row: Record<string, unknown>): void {
    try {
      this.ledger?.appendObject(row);
      this.ledgerDegraded = false;
    } catch (err) {
      // §6 rung 5: the ledger failing never blocks delivery or recording.
      this.ledgerDegraded = true;
      console.warn(
        `[selectivity] decision ledger degraded: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /** Transitional record-contract shim (§2.3): name the caller consuming a recorded result. */
  private callerHint(): string {
    try {
      const stack = new Error().stack?.split('\n') ?? [];
      for (const frame of stack.slice(1)) {
        if (
          !frame.includes('NotificationSelectivityGate') &&
          !frame.includes('TelegramAdapter') &&
          frame.trim().startsWith('at ')
        ) {
          return frame.trim().slice(3, 160);
        }
      }
    } catch {
      /* @silent-fallback-ok */
    }
    return 'unknown';
  }

  private gcConsumedIds(): void {
    if (this.consumedCommandIds.size < MAX_LANE_KEYS) return;
    const nowMs = this.now();
    for (const [k, t] of this.consumedCommandIds) {
      if (nowMs - t > CORROBORATION_WINDOW_MS) this.consumedCommandIds.delete(k);
    }
  }

  private gcTimelines(nowMs: number): void {
    for (const [k, tl] of this.budgetTimelines) {
      if (tl.length === 0 || nowMs - tl[tl.length - 1] > BUDGET_WINDOW_MS) {
        this.budgetTimelines.delete(k);
      }
    }
  }

  private machineId(): string | undefined {
    try {
      return this.opts.machineId?.();
    } catch {
      return undefined;
    }
  }
}

/** The §5 class list re-exported for route validation convenience. */
export { SIGNIFICANT_CLASSES };
