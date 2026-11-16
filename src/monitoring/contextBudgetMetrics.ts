/**
 * Context budget measurement backend (context-budget-layered-summaries §11,
 * Phase 1 S13). Read-only and signal-only: it computes the numbers the
 * dashboard card and the rung review read; it never gates anything.
 *
 * Sources, all already on this machine:
 *  - the TokenLedger (per-request usage, tool inputs, operator prompts,
 *    compaction boundaries) — scanned from EVERY Claude config home;
 *  - the layer store, transcript archive and layer budget (`ContextLayers`);
 *  - the per-day, per-trigger LayerUpdate rollup (`ContextLayers.spend`);
 *  - the TopicIntentStore capture counters (cumulative, per topic);
 *  - TopicMemory (the operator corpus, U).
 *
 * Honesty rules: a number this build cannot measure is reported as
 * `unavailable: <reason>`, never as zero (a topic whose Anchor was never
 * evaluated on this machine reads `not-yet-evaluated`, never `no-anchor`); a
 * rework rate the poller has not caught up on reads `pending`; a share with no
 * denominator is `null`.
 *
 * Cost weighting (Phase 0 baseline, scripts/context-budget/token-baseline.mjs):
 * relative to one uncached input token, cache read 0.1, cache write 1 h 2.0,
 * cache write 5 min 1.25, output 5.0. "inputWeighted" = uncached + writes +
 * reads; "allInWeighted" adds output. A turn is one API request.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { TokenLedger, SessionRequestTotalsRow, ReworkRow } from './TokenLedger.js';
import type { ContextLayers } from './contextLayers/contextLayersBoot.js';
import type { LayerSpendDay } from './contextLayers/layerSpendLog.js';
import { contextLayersRoot } from './contextLayers/LayerStore.js';
import { anchorView, backfillView, ledgerCounts, measureAnchorLedger, LEDGER_STATUSES } from './contextLayers/anchorLedger.js';
import { H3_KEY } from './contextLayers/h3Builder.js';
import { layerFreshness } from './contextLayers/layerProjection.js';
import type { LayerStore } from './contextLayers/LayerStore.js';

/** H3 on this topic (§6 row H3, §6.5): its freshness and how much of the history it read through C2. Never zero for "not built". */
export function measureH3(store: LayerStore, topicKey: string, countAfter: (lastMessageId: number) => { total: number; fromUser: number } | null) {
  const rec = store.read(topicKey, 'h3', H3_KEY);
  if (!rec) return { status: 'not-built-yet' as const };
  const d = rec.data as Record<string, unknown>;
  const len = (v: unknown) => (Array.isArray(v) ? v.length : 0);
  const f = layerFreshness(rec, countAfter);
  return {
    status: (rec.status ?? 'live') as string,
    writtenAt: rec.writtenAt,
    freshness: f.line,
    messagesBehind: f.messagesBehind,
    inputTokens: typeof d.inputTokens === 'number' ? d.inputTokens : null,
    floorOverBudget: d.floorOverBudget === true,
    chunksRead: len(d.chunkKeys),
    rangesDirect: len(d.rangesDirect),
    rangesThroughC2: len(d.rangesThroughC2),
    rangesOmitted: len(d.rangesOmitted),
    summaryChars: typeof d.summary === 'string' ? d.summary.length : 0,
  };
}

export const COST_WEIGHTS = { uncached: 1, cacheRead: 0.1, cacheWrite1h: 2.0, cacheWrite5m: 1.25, output: 5.0 } as const;
export type CostWeights = { [K in keyof typeof COST_WEIGHTS]: number };

/** The §11 rework window: repeats within this many turns. */
export const REWORK_WINDOW_TURNS = 30;
/** A transcript the ledger last read longer ago than this, with unread bytes, is lagging (≥ the poller's idle cadence). */
export const POLLER_LAG_TOLERANCE_MS = 6 * 60_000;
export const MAX_SINCE_HOURS = 720;
export const DEFAULT_SINCE_HOURS = 24;
export const MAX_SESSIONS = 50;
export const MAX_TOPICS = 50;
export const SERIES_POINTS = 48;

export interface CostBreakdown {
  requests: number;
  uncached: number;
  cacheRead: number;
  cacheWrite1h: number;
  cacheWrite5m: number;
  /** Cache-write tokens whose 1 h / 5 min split was not recorded (priced as 1 h, the Phase 0 observation). */
  cacheWriteSplitUnknown: number;
  output: number;
  inputWeighted: number;
  allInWeighted: number;
  perRequest: { inputWeighted: number | null; allInWeighted: number | null; cacheRead: number | null; output: number | null };
}

/** Cost-weight one or more per-session totals (summed). */
export function costWeigh(rows: readonly Pick<SessionRequestTotalsRow, 'requests' | 'uncached' | 'cacheRead' | 'cacheWrite' | 'cacheWrite1hKnown' | 'cacheWriteSplitUnknown' | 'output'>[], w: CostWeights = COST_WEIGHTS): CostBreakdown {
  const t = { requests: 0, uncached: 0, cacheRead: 0, cacheWrite1h: 0, cacheWrite5m: 0, cacheWriteSplitUnknown: 0, output: 0 };
  for (const r of rows) {
    t.requests += r.requests;
    t.uncached += r.uncached;
    t.cacheRead += r.cacheRead;
    t.cacheWrite1h += r.cacheWrite1hKnown;
    t.cacheWriteSplitUnknown += r.cacheWriteSplitUnknown;
    t.cacheWrite5m += Math.max(0, r.cacheWrite - r.cacheWrite1hKnown - r.cacheWriteSplitUnknown);
    t.output += r.output;
  }
  const inputWeighted = w.uncached * t.uncached + w.cacheRead * t.cacheRead + w.cacheWrite1h * (t.cacheWrite1h + t.cacheWriteSplitUnknown) + w.cacheWrite5m * t.cacheWrite5m;
  const allInWeighted = inputWeighted + w.output * t.output;
  const per = (n: number) => (t.requests > 0 ? Math.round(n / t.requests) : null);
  return { ...t, inputWeighted: Math.round(inputWeighted), allInWeighted: Math.round(allInWeighted), perRequest: { inputWeighted: per(inputWeighted), allInWeighted: per(allInWeighted), cacheRead: per(t.cacheRead), output: per(t.output) } };
}

export interface ScanLag { files: number; unreadBytes: number; laggingFiles: number; oldestReadAt: number | null; partialSideRecords: boolean }

/**
 * How current the ledger is on one session, shared by every ledger-derived
 * field of that session (cost, live context, rework, verbatim share):
 *  - `pending`: at least one of its transcript copies has unread bytes the
 *    poller has not read within the tolerance (judged per file);
 *  - `partial-before-upgrade`: a copy was part-read before this build, so its
 *    earlier tool inputs, prompts and compactions were never recorded;
 *  - `current` otherwise.
 */
export function ledgerFreshness(lag: ScanLag): { status: 'current' | 'pending' | 'partial-before-upgrade'; unreadBytes: number; laggingFiles: number; files: number; lastReadAt: number | null } {
  const status = lag.laggingFiles > 0 ? 'pending' : lag.partialSideRecords ? 'partial-before-upgrade' : 'current';
  return { status, unreadBytes: lag.unreadBytes, laggingFiles: lag.laggingFiles, files: lag.files, lastReadAt: lag.oldestReadAt };
}

export type ReworkResult = { status: 'ok' | 'pending' | 'partial-before-upgrade'; rate: number | null } & ReworkRow;

/** Rework with its freshness: `pending` while the poller lags on the session, `partial-before-upgrade` when its early history was never recorded. */
export function reworkWithFreshness(rework: ReworkRow, lag: ScanLag): ReworkResult {
  const rate = rework.toolInputs > 0 ? +(rework.repeats / rework.toolInputs).toFixed(4) : null;
  const f = ledgerFreshness(lag).status;
  return { status: f === 'current' ? 'ok' : f, rate, ...rework };
}

export interface MetricsTopicIntentSource {
  read(topicId: number): { telemetry?: { capture?: object } };
}
export interface MetricsTopicMemorySource {
  operatorCorpusSize(topicId: number): { messages: number; chars: number; forwarded: number } | null;
  /** For H3's freshness (optional: absent ⇒ `stale: unknown`). */
  countMessagesAfter?(topicId: number, messageId: number): { total: number; fromUser: number } | null;
}

export interface ContextBudgetMetricsDeps {
  layers: ContextLayers;
  stateDir: string;
  ledger: TokenLedger | null;
  topicIntentStore?: MetricsTopicIntentSource | null;
  topicMemory?: MetricsTopicMemorySource | null;
  now?: () => number;
  weights?: CostWeights;
}

export interface ContextBudgetMetricsQuery {
  topicId?: number;
  sinceHours?: number;
}

/** Parse `?topic=` / `?sinceHours=`: a bad value is an error, never silently widened. */
export function parseMetricsQuery(q: { topic?: unknown; sinceHours?: unknown }): { ok: true; query: ContextBudgetMetricsQuery } | { ok: false; error: string } {
  const out: ContextBudgetMetricsQuery = {};
  if (q.topic !== undefined) {
    const n = Number(q.topic);
    if (typeof q.topic !== 'string' || !/^\d{1,15}$/.test(q.topic) || !Number.isSafeInteger(n) || n <= 0) return { ok: false, error: 'topic must be a positive integer topic id' };
    out.topicId = n;
  }
  if (q.sinceHours !== undefined) {
    const n = Number(q.sinceHours);
    if (typeof q.sinceHours !== 'string' || !Number.isFinite(n) || n <= 0) return { ok: false, error: 'sinceHours must be a positive number' };
    out.sinceHours = Math.min(MAX_SINCE_HOURS, n);
  }
  return { ok: true, query: out };
}

const CAPTURE_KEYS = ['turns_seen', 'extractions_attempted', 'layer_ticks', 'budget_deferred', 'awareness_updates', 'degraded_shed', 'degraded_cap_or_error', 'prefilter_skipped', 'rate_limited'] as const;

/** Layer-store records of one type for a topic: entries, bytes, and entries last written per UTC day. */
export const MAX_GROWTH_FILES = 2000;
function recordGrowth(root: string, topicKey: string, recordType: string, sinceMs: number): { entries: number; bytes: number; writtenPerDay: Record<string, number>; truncated: boolean } {
  const out = { entries: 0, bytes: 0, writtenPerDay: {} as Record<string, number>, truncated: false };
  const dir = path.join(root, topicKey, recordType);
  let names: string[];
  try { names = fs.readdirSync(dir).filter((f) => f.endsWith('.json')); } catch { return out; /* @silent-fallback-ok — no records of this type yet */ }
  out.truncated = names.length > MAX_GROWTH_FILES;
  for (const n of names.slice(0, MAX_GROWTH_FILES)) {
    let st: fs.Stats;
    try { st = fs.statSync(path.join(dir, n)); } catch { continue; /* @silent-fallback-ok — a record removed mid-walk */ }
    out.entries++;
    out.bytes += st.size;
    if (st.mtimeMs >= sinceMs) {
      const day = new Date(st.mtimeMs).toISOString().slice(0, 10);
      out.writtenPerDay[day] = (out.writtenPerDay[day] ?? 0) + 1;
    }
  }
  return out;
}

function layerTopicKeys(root: string): string[] {
  try {
    return fs.readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory() && /^[0-9]{1,15}$/.test(e.name)).map((e) => e.name);
  } catch { return []; /* @silent-fallback-ok — no layer root yet */ }
}

/** Compute the §11 metrics. Bounded: ≤ 50 sessions, ≤ 50 topics, ≤ 48 series points per session. */
export function computeContextBudgetMetrics(deps: ContextBudgetMetricsDeps, q: ContextBudgetMetricsQuery = {}) {
  const now = (deps.now ?? Date.now)();
  const weights = deps.weights ?? COST_WEIGHTS;
  const sinceHours = Math.min(MAX_SINCE_HOURS, q.sinceHours ?? DEFAULT_SINCE_HOURS);
  const sinceMs = now - sinceHours * 3_600_000;
  const ledger = deps.ledger;

  // ── Sessions (from the ledger) ──
  // A session belongs to the topic most of its operator prompts came from, over
  // ALL its prompts (an autonomous session whose last prompt is older than the
  // window keeps its topic).
  const sessionTopic = new Map<string, number>();
  const topicSessions = new Map<number, string[]>();
  const topicLastTs = new Map<number, number>();
  if (ledger) {
    const best = new Map<string, { topicId: number; prompts: number; lastTs: number }>();
    for (const r of ledger.sessionTopics({ sinceMs: 0, limit: 5000 })) {
      const b = best.get(r.sessionId);
      if (!b || r.prompts > b.prompts) best.set(r.sessionId, { topicId: r.topicId, prompts: r.prompts, lastTs: r.lastTs });
    }
    for (const [sid, b] of best) {
      sessionTopic.set(sid, b.topicId);
      topicSessions.set(b.topicId, [...(topicSessions.get(b.topicId) ?? []), sid]);
      topicLastTs.set(b.topicId, Math.max(topicLastTs.get(b.topicId) ?? 0, b.lastTs));
    }
  }
  const scopedIds = q.topicId !== undefined ? (topicSessions.get(q.topicId) ?? []) : undefined;
  const totals = !ledger || (scopedIds && scopedIds.length === 0) ? [] : ledger.sessionRequestTotals({ sinceMs, limit: MAX_SESSIONS, ...(scopedIds ? { sessionIds: scopedIds } : {}) });
  // Uncapped: the overall numbers never depend on the per-session list's bound.
  const overallTotals = ledger ? ledger.windowTotals({ sinceMs, ...(scopedIds ? { sessionIds: scopedIds } : {}) }) : null;

  const sessions = totals.map((t) => {
    const lag = ledger!.sessionScanLag(t.sessionId, { now, toleranceMs: POLLER_LAG_TOLERANCE_MS });
    const rework = reworkWithFreshness(ledger!.reworkForSession(t.sessionId, { sinceMs, windowTurns: REWORK_WINDOW_TURNS }), lag);
    const ctxSeries = ledger!.contextSizeSeries(t.sessionId, { sinceMs, maxPoints: SERIES_POINTS });
    const prompts = ledger!.promptsInContext(t.sessionId);
    return {
      sessionId: t.sessionId,
      topicId: sessionTopic.get(t.sessionId) ?? null,
      firstTs: t.firstTs,
      lastTs: t.lastTs,
      ledgerFreshness: ledgerFreshness(lag),
      cost: costWeigh([t], weights),
      writeSplitUnknownRequests: t.writeSplitUnknownRequests,
      liveContext: { latest: ctxSeries.latest, max: ctxSeries.max, series: ctxSeries.points },
      rework,
      operatorMessages: {
        channel: 'telegram' as const,
        delivered: prompts.prompts,
        verbatimInContext: prompts.inContext,
        share: prompts.prompts > 0 ? +(prompts.inContext / prompts.prompts).toFixed(4) : null,
        compactions: prompts.compactions,
        lastCompactionAt: prompts.lastCompactionAt,
      },
    };
  });

  // ── Topics ──
  const root = contextLayersRoot(deps.stateDir);
  const budget = deps.layers.budget.status();
  const topicIds = new Set<number>();
  if (q.topicId !== undefined) topicIds.add(q.topicId);
  else {
    for (const s of sessions) if (s.topicId !== null) topicIds.add(s.topicId);
    for (const k of layerTopicKeys(root)) topicIds.add(Number(k));
    for (const t of budget.topics) if (/^\d{1,15}$/.test(t.topicKey)) topicIds.add(Number(t.topicKey));
  }
  const budgetByTopic = new Map(budget.topics.map((t) => [t.topicKey, t]));
  // Most recently active first (operator prompts), then by id; the cut is flagged.
  const orderedTopics = [...topicIds].sort((a, b) => (topicLastTs.get(b) ?? 0) - (topicLastTs.get(a) ?? 0) || a - b);
  const topicsTruncated = orderedTopics.length > MAX_TOPICS;
  const topics = orderedTopics.slice(0, MAX_TOPICS).map((topicId) => {
    const key = String(topicId);
    const mine = sessions.filter((s) => s.topicId === topicId);
    const allIds = topicSessions.get(topicId) ?? [];
    const topicTotals = ledger && allIds.length ? ledger.windowTotals({ sinceMs, sessionIds: allIds }) : null;
    const inWindow = topicTotals?.sessions ?? 0;
    const reworkInputs = mine.reduce((n, s) => n + s.rework.toolInputs, 0);
    const reworkRepeats = mine.reduce((n, s) => n + s.rework.repeats, 0);
    const reworkStatus = mine.some((s) => s.rework.status === 'pending') ? 'pending' as const
      : mine.some((s) => s.rework.status === 'partial-before-upgrade') ? 'partial-before-upgrade' as const : 'ok' as const;
    const latest = [...mine].sort((a, b) => b.lastTs - a.lastTs)[0];
    const capture = (deps.topicIntentStore?.read(topicId).telemetry?.capture ?? null) as Record<string, unknown> | null;
    const corpus = deps.topicMemory?.operatorCorpusSize(topicId) ?? null;
    const g = recordGrowth(root, key, 'ledger-entry', sinceMs);
    const c = recordGrowth(root, key, 'chunk', sinceMs);
    const growth = (r: typeof g) => (r.entries === 0
      ? { status: 'no-records-yet' as const, entries: 0, bytes: 0, writtenPerDay: r.writtenPerDay, truncated: r.truncated }
      : { status: 'measured' as const, ...r, entriesPerDay: +(Object.values(r.writtenPerDay).reduce((a, b) => a + b, 0) / Math.max(1 / 24, sinceHours / 24)).toFixed(3) });
    const noLedger = { unavailable: 'token-ledger-unavailable' as const };
    const noSession = { unavailable: 'no-session-in-window' as const };
    return {
      topicId,
      sessions: mine.map((s) => s.sessionId),
      sessionsInWindow: inWindow,
      cost: !ledger ? noLedger : inWindow === 0 || !topicTotals ? noSession : { ...costWeigh([topicTotals], weights), sessions: inWindow },
      rework: !ledger ? noLedger : mine.length === 0
        ? (inWindow === 0 ? noSession : { unavailable: 'no-session-in-top-sessions' as const, sessionsInWindow: inWindow })
        : { status: reworkStatus, toolInputs: reworkInputs, repeats: reworkRepeats, rate: reworkInputs > 0 ? +(reworkRepeats / reworkInputs).toFixed(4) : null, windowTurns: REWORK_WINDOW_TURNS, sessionsCounted: mine.length, partial: mine.length < inWindow },
      extractor: !deps.topicIntentStore
        ? { unavailable: 'topic-intent-store-not-wired' }
        : capture
          ? { source: 'topic-intent-store (cumulative)', ...Object.fromEntries(CAPTURE_KEYS.map((k) => [k, Number(capture[k]) || 0])), lastCaptureAt: capture.last_capture_at ?? null }
          : { unavailable: 'no-capture-telemetry' },
      layerUpdate: { inputTokens24h: budgetByTopic.get(key)?.inputTokens24h ?? 0, deferred: budgetByTopic.get(key)?.deferred ?? 0, perTopicCeiling: budget.limits.perTopicDailyInputTokens, inMemorySinceBoot: true },
      u: corpus
        ? { messages: corpus.messages, forwarded: corpus.forwarded, chars: corpus.chars, estimatedTokens: Math.ceil(corpus.chars / 4) }
        : { unavailable: deps.topicMemory ? 'topic-memory-not-open' : 'topic-memory-not-wired' },
      operatorVerbatimShare: latest
        ? { sessionId: latest.sessionId, ledgerFreshness: latest.ledgerFreshness.status, ...latest.operatorMessages }
        : { unavailable: 'no-session-with-operator-prompts-in-window' },
      archiveBytes: deps.layers.archive.topicBytes(key),
      layerBytes: deps.layers.store.topicBytes(key),
      liveSetBudgetInputs: { g: growth(g), c: growth(c) },
      anchorLedger: measureAnchorLedger(deps.layers.store, key),
      h3: measureH3(deps.layers.store, key, (id) => deps.topicMemory?.countMessagesAfter?.(topicId, id) ?? null),
    };
  });

  // ── Anchors and the ledger (§6.1, §6.2): every topic with layer records on this machine ──
  const allKeys = layerTopicKeys(root);
  const anchorStates = { anchored: 0, 'no-anchor': 0, 'not-yet-evaluated': 0 };
  // S7: backfill state over every topic here; `pendingConfirmations` is what the dashboard card and Home's count read.
  // `pendingConfirmations` = waiting to be asked + asked and still unanswered (the operator's word is awaited).
  // Read from this machine's store: replicated Anchor records mean each machine counts the same topic, so a
  // pool-wide count must take one machine's figure (the owner's), never the sum.
  const backfill = { topicsBackfilled: 0, backfilledUnconfirmed: 0, pendingConfirmations: 0, awaitingAsk: 0, asked: 0, expiredConfirmations: 0, pendingTopics: [] as string[] };
  for (const k of allKeys) {
    anchorStates[anchorView(deps.layers.store, k).status]++;
    const b = backfillView(deps.layers.store, k);
    if (b.state === 'backfilled') backfill.topicsBackfilled++;
    backfill.backfilledUnconfirmed += b.backfilledUnconfirmed;
    if (b.confirmation === 'pending' || b.confirmation === 'asked') {
      backfill.pendingConfirmations++;
      if (b.confirmation === 'pending') backfill.awaitingAsk++; else backfill.asked++;
      if (backfill.pendingTopics.length < 50) backfill.pendingTopics.push(k);
    }
    if (b.confirmation === 'expired') backfill.expiredConfirmations++;
  }
  const ledgerTotals = ledgerCounts([]);
  for (const t of topics) {
    ledgerTotals.total += t.anchorLedger.ledger.total;
    for (const ty of ['evolution', 'decision'] as const) ledgerTotals.byType[ty] += t.anchorLedger.ledger.byType[ty];
    for (const st of LEDGER_STATUSES) ledgerTotals.byStatus[st] += t.anchorLedger.ledger.byStatus[st] ?? 0;
  }
  const al = deps.layers.anchorLedger?.() ?? null;

  const spendDays: LayerSpendDay[] = deps.layers.spend.byDay(Math.max(1, Math.ceil(sinceHours / 24)));
  return {
    generatedAt: now,
    window: { sinceHours, sinceMs },
    weights,
    turnUnit: 'one API request',
    ledger: ledger
      ? { available: true, roots: ledger.projectRoots(), sessionsInWindow: overallTotals?.sessions ?? 0, sessionsListed: sessions.length, sessionsTruncated: (overallTotals?.sessions ?? 0) > sessions.length, sessionsWithTopic: sessions.filter((s) => s.topicId !== null).length }
      : { available: false, reason: 'token-ledger-unavailable' },
    overall: overallTotals ? { ...costWeigh([overallTotals], weights), sessions: overallTotals.sessions } : { unavailable: 'token-ledger-unavailable' },
    sessions,
    topics,
    topicsTruncated,
    extractorByDay: spendDays,
    layerUpdate: {
      reserve: budget.limits,
      componentInputTokens24h: budget.componentInputTokens24h,
      componentShare: budget.limits.componentDailyInputTokens > 0 ? +(budget.componentInputTokens24h / budget.limits.componentDailyInputTokens).toFixed(4) : null,
      deferred: budget.deferred,
      inMemorySinceBoot: true,
      processStartedAt: Math.round(Date.now() - process.uptime() * 1000),
      basis: 'estimated input tokens reserved by the layer brakes (§6.4), held in memory: a rolling 24 h since this process started; provider-reported tokens, persisted, are in extractorByDay',
    },
    anchors: {
      source: 'layer store on this machine',
      topics: allKeys.length,
      ...anchorStates,
      ledger: { ...ledgerTotals, scope: 'listed-topics' as const, topicsCounted: topics.length },
      builder: al ? { wired: true as const, ...al.status().counters } : { wired: false as const },
      backfill: {
        ...backfill,
        scope: 'all-topics-with-layer-records' as const,
        lane: deps.layers.backfillLane?.()?.status() ?? { wired: false as const },
      },
    },
  };
}

export type ContextBudgetMetrics = ReturnType<typeof computeContextBudgetMetrics>;
