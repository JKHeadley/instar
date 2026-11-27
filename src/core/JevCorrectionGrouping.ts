/**
 * JevCorrectionGrouping — "do these two correction records state the same
 * standing preference?" (spec: docs/specs/correction-meaning-grouping.md).
 *
 * The CorrectionAnalyzer groups open records before its recurrence gate. Its
 * word-overlap (Jaccard 0.65) rule never matched reworded copies of the same
 * preference: on the 131-record corpus of 2026-10-29 it formed zero groups.
 * This module supplies a second edge source for the analyzer's complete-link
 * clustering:
 *
 *   1. Candidate pairs: same kind AND word overlap >= `candidateFloor` (0.05).
 *      Pairs below the floor are never judged and never get a meaning edge.
 *   2. Jev (TypeSafe) is asked one choice question per pair, in both option
 *      orders. min(P(same) forward, P(same) reversed) above band.hi → same;
 *      below band.lo → not same; inside the band → unsure.
 *   3. Unsure pairs go to the cascade referee (GPT-6 Luna via the Codex fast
 *      tier, the shared JevCascade helper) when one is available. A referee
 *      `true` is a same edge; anything else (false, timeout, error) is none.
 *
 * Verdicts are cached on disk per pair of dedupeKeys (a dedupeKey is a hash of
 * the normalized learning, so a cached verdict can never describe different
 * text), so each pair is asked at most once. The cache is pruned to the
 * current candidate set every run, which bounds it.
 *
 * Holds no authority: it only answers "same?" for pairs; the analyzer's
 * complete-link rule (every member pair must have an edge) and its unchanged
 * recurrence gate decide everything. Fails toward the old behavior: no key,
 * Jev down, budget spent, or any error leaves only the word-overlap edges.
 */
import fs from 'node:fs';
import path from 'node:path';
import { scrubForStore } from './durableSecretScrub.js';
import { boundedHead } from './boundedInput.js';
import { resolveDevAgentGate } from './devAgentGate.js';
import { askReferee, DEFAULT_CASCADE_BAND, type CascadeBand } from './JevCascade.js';
import type { IntelligenceProvider } from './types.js';

export const JEV_GROUPING_FEATURE = 'correction-meaning-grouping';
const ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
export const GROUPING_MODEL = 'jev-1.13.0';
/** Bumped whenever the question wording changes, so old verdicts are re-asked. */
export const GROUPING_QUESTION_VERSION = 1;
export const DEFAULT_CANDIDATE_FLOOR = 0.05;
export const DEFAULT_MAX_JEV_CALLS_PER_RUN = 800;
export const DEFAULT_MAX_REFEREE_CALLS_PER_RUN = 24;
export const DEFAULT_RUN_BUDGET_MS = 240_000;
const DEFAULT_TIMEOUT_MS = 3000;
const JEV_CONCURRENCY = 4;
const REFEREE_CONCURRENCY = 3;
const NOTE_CHARS = 600;
const SCRUB_SPAN = 4096;
const KEY_REREAD_MS = 10 * 60_000;

/**
 * Measured 2026-10-29 on the live corpus (docs/measurements/2026-10-29-
 * correction-meaning-grouping.md): asking "the same core rule, extra detail
 * allowed" moved true repeats to 0.75–1.00 and kept distinct rules at or below
 * ~0.4; the stricter "following one means following the other" wording called
 * most true repeats `related`.
 */
export const GROUPING_CRITERIA: Readonly<Record<string, string>> = {
  same: 'Both notes state the same core rule or preference: the same thing the agent should do or avoid. Wording differs, and one note may add extra detail, but the main rule is the same.',
  related: 'The notes share a topic or theme, but the main rule each one asks for is different.',
  different: 'The notes are about different things.',
  cannot_tell: 'Too vague or unclear to tell.',
};
const INSTRUCTIONS = 'Each NOTE below was distilled from something a person told their AI agent about how it should work. Which best describes NOTE A and NOTE B together?';
const REFEREE_RULE = 'same';
const REFEREE_INSTRUCTIONS = 'NOTE A and NOTE B state the same core rule or preference: the same thing the agent should do or avoid. Wording differs, and one note may add extra detail, but the main rule is the same.';

export function groupingQuestions(): Record<string, { type: 'choice'; instructions: string; criteria: Record<string, string> }> {
  return {
    same: { type: 'choice', instructions: INSTRUCTIONS, criteria: { ...GROUPING_CRITERIA } },
    same_rev: { type: 'choice', instructions: INSTRUCTIONS, criteria: Object.fromEntries(Object.entries(GROUPING_CRITERIA).reverse()) },
  };
}

export interface MeaningGroupingConfig {
  /** Resolved through the dev-agent gate: omitted ⇒ live on a development agent, dark on the fleet. */
  enabled?: boolean;
  candidateFloor?: number;
  maxJevCallsPerRun?: number;
  maxRefereeCallsPerRun?: number;
  runBudgetMs?: number;
  timeoutMs?: number;
  model?: string;
  band?: CascadeBand;
  referee?: { enabled?: boolean };
}

/** The record fields the grouper reads. Matches CorrectionRecord. */
export interface GroupableRecord {
  dedupeKey: string;
  kind: string;
  learning: string;
}

export type PairVerdict = 'same' | 'not-same' | 'unsure';
export interface CachedVerdict {
  v: PairVerdict;
  by: 'jev' | 'referee';
  pSame: number;
  model: string;
  qv: number;
  at: string;
}

export interface GroupingReport {
  mode: 'meaning' | 'words';
  /** Why meaning grouping did not run (mode 'words'). */
  reason?: 'disabled' | 'no-key' | 'error';
  candidates: number;
  cached: number;
  jevCalls: number;
  jevFailures: number;
  refereeCalls: number;
  refereeFailures: number;
  sameEdges: number;
  unsurePairs: number;
  /** Candidate pairs left unjudged this run (budget or time spent). */
  deferred: number;
  ms: number;
}

export type SameMeaning = (a: GroupableRecord, b: GroupableRecord) => boolean;

export interface PreparedGrouping { sameMeaning: SameMeaning | null; report: GroupingReport }

export interface JevCorrectionGrouperDeps {
  getConfig: () => MeaningGroupingConfig | undefined;
  readKey: () => string | null;
  cachePath: string;
  logPath: string;
  referee?: IntelligenceProvider | null;
  metrics?: { record(r: Record<string, unknown>): void } | null;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

/** Normalized word set, the same tokens the analyzer's Jaccard uses. */
export type TokenSet = (learning: string) => Set<string>;

export function pairKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

function jaccard(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 || right.size === 0) return 0;
  let inter = 0;
  for (const t of left) if (right.has(t)) inter++;
  return inter / (left.size + right.size - inter);
}

/**
 * The note text sent out: scrubbed whole, then bounded with a disclosure.
 * Null (the pair is skipped, never judged on a fragment) when the learning is
 * longer than the scrub span, carries a private-key marker, or fails the scrub.
 * A distilled learning is one or two sentences (longest on the live corpus:
 * ~290 characters), so NOTE_CHARS keeps it whole in practice.
 */
export function renderNote(learning: string): string | null {
  const text = String(learning);
  if (text.length > SCRUB_SPAN || /PRIVATE KEY-----/.test(text)) return null;
  const s = scrubForStore(text);
  if (s.error || s.truncated) return null;
  return boundedHead(s.text, NOTE_CHARS);
}

export function renderPairState(a: string, b: string): string | null {
  const na = renderNote(a);
  const nb = renderNote(b);
  if (na === null || nb === null) return null;
  return `NOTE A: ${na}\nNOTE B: ${nb}`;
}

/**
 * Candidate pairs: same kind and word overlap at or above the floor.
 * Deterministic order (input order, then partner order).
 */
export function candidatePairs<T extends GroupableRecord>(records: readonly T[], tokens: TokenSet, floor: number): Array<[T, T]> {
  const sets = records.map((r) => tokens(r.learning));
  const out: Array<[T, T]> = [];
  for (let i = 0; i < records.length; i++) {
    for (let j = i + 1; j < records.length; j++) {
      if (records[i].kind !== records[j].kind) continue;
      if (records[i].dedupeKey === records[j].dedupeKey) continue;
      if (jaccard(sets[i], sets[j]) >= floor) out.push([records[i], records[j]]);
    }
  }
  return out;
}

function readSame(a: { choice?: unknown; probabilities?: Record<string, unknown> } | undefined): number | null {
  if (!a || !a.probabilities || typeof a.probabilities !== 'object') return null;
  const p = (a.probabilities as Record<string, unknown>).same;
  return typeof p === 'number' && Number.isFinite(p) ? p : null;
}

function validBand(b: CascadeBand | undefined): CascadeBand {
  if (b && Number.isFinite(b.lo) && Number.isFinite(b.hi) && b.lo >= 0 && b.lo <= b.hi && b.hi <= 1) return b;
  return DEFAULT_CASCADE_BAND;
}

export class JevCorrectionGrouper {
  private readonly deps: JevCorrectionGrouperDeps;
  private cachedKey: string | null = null;
  private keyReadAt = -Infinity;

  constructor(deps: JevCorrectionGrouperDeps) {
    this.deps = deps;
  }

  private now(): number { return (this.deps.now ?? Date.now)(); }

  private key(): string | null {
    if (!this.cachedKey && this.now() - this.keyReadAt >= KEY_REREAD_MS) {
      this.keyReadAt = this.now();
      try { this.cachedKey = this.deps.readKey() || null; } catch { /* @silent-fallback-ok — no key = words mode, reported as reason 'no-key' */ this.cachedKey = null; }
    }
    return this.cachedKey;
  }

  /** Cached verdicts only, no calls. For read surfaces. Null when grouping is off or nothing is cached. */
  cachedLookup(): SameMeaning | null {
    const cfg = this.deps.getConfig() ?? {};
    if (cfg.enabled !== true) return null;
    const model = cfg.model || GROUPING_MODEL;
    const cache = this.readCache();
    if (cache.size === 0) return null;
    return (a, b) => {
      const hit = cache.get(pairKey(a.dedupeKey, b.dedupeKey));
      return hit?.v === 'same' && hit.qv === GROUPING_QUESTION_VERSION && hit.model === model;
    };
  }

  /**
   * Judge every uncached candidate pair (within the run's call and time
   * budgets) and return the lookup the analyzer clusters with. Never throws.
   */
  async prepare(records: readonly GroupableRecord[], tokens: TokenSet): Promise<PreparedGrouping> {
    const t0 = this.now();
    const report: GroupingReport = {
      mode: 'words', candidates: 0, cached: 0, jevCalls: 0, jevFailures: 0,
      refereeCalls: 0, refereeFailures: 0, sameEdges: 0, unsurePairs: 0, deferred: 0, ms: 0,
    };
    const finish = (sameMeaning: SameMeaning | null): PreparedGrouping => {
      report.ms = this.now() - t0;
      return { sameMeaning, report };
    };
    try {
      const cfg = this.deps.getConfig() ?? {};
      if (cfg.enabled !== true) { report.reason = 'disabled'; return finish(null); }
      const key = this.key();
      if (!key) { report.reason = 'no-key'; return finish(null); }
      report.mode = 'meaning';

      const floor = typeof cfg.candidateFloor === 'number' && cfg.candidateFloor > 0 && cfg.candidateFloor <= 1 ? cfg.candidateFloor : DEFAULT_CANDIDATE_FLOOR;
      const maxJev = typeof cfg.maxJevCallsPerRun === 'number' && cfg.maxJevCallsPerRun >= 0 ? cfg.maxJevCallsPerRun : DEFAULT_MAX_JEV_CALLS_PER_RUN;
      const maxRef = typeof cfg.maxRefereeCallsPerRun === 'number' && cfg.maxRefereeCallsPerRun >= 0 ? cfg.maxRefereeCallsPerRun : DEFAULT_MAX_REFEREE_CALLS_PER_RUN;
      const budgetMs = typeof cfg.runBudgetMs === 'number' && cfg.runBudgetMs > 0 ? cfg.runBudgetMs : DEFAULT_RUN_BUDGET_MS;
      const band = validBand(cfg.band);
      const model = cfg.model || GROUPING_MODEL;
      const deadline = t0 + budgetMs;

      const pairs = candidatePairs(records, tokens, floor);
      report.candidates = pairs.length;
      const old = this.readCache();
      const cache = new Map<string, CachedVerdict>();
      for (const [a, b] of pairs) {
        const k = pairKey(a.dedupeKey, b.dedupeKey);
        const hit = old.get(k);
        if (hit && hit.qv === GROUPING_QUESTION_VERSION && hit.model === model) cache.set(k, hit);
      }
      report.cached = cache.size;

      // Phase 1 — Jev on uncached pairs.
      const todo = pairs.filter(([a, b]) => !cache.has(pairKey(a.dedupeKey, b.dedupeKey)));
      let cursor = 0;
      const jevWorker = async (): Promise<void> => {
        while (cursor < todo.length && report.jevCalls < maxJev && this.now() < deadline) {
          const [a, b] = todo[cursor++];
          report.jevCalls++;
          const v = await this.askJev(key, model, cfg.timeoutMs, a, b, band);
          if (v) cache.set(pairKey(a.dedupeKey, b.dedupeKey), v);
          else report.jevFailures++;
        }
      };
      await Promise.all(Array.from({ length: JEV_CONCURRENCY }, jevWorker));

      // Phase 2 — the referee on unsure pairs (cascade default), bounded.
      const referee = cfg.referee?.enabled === false ? null : this.deps.referee ?? null;
      if (referee) {
        const unsure = pairs.filter(([a, b]) => cache.get(pairKey(a.dedupeKey, b.dedupeKey))?.v === 'unsure');
        let rc = 0;
        const refWorker = async (): Promise<void> => {
          while (rc < unsure.length && report.refereeCalls < maxRef && this.now() < deadline) {
            const [a, b] = unsure[rc++];
            report.refereeCalls++;
            const k = pairKey(a.dedupeKey, b.dedupeKey);
            const decided = await this.askReferee(referee, a, b, Math.max(1000, deadline - this.now()));
            const prior = cache.get(k)!;
            if (decided === null) { report.refereeFailures++; continue; }
            const next: CachedVerdict = { ...prior, v: decided ? 'same' : 'not-same', by: 'referee', at: new Date(this.now()).toISOString() };
            cache.set(k, next);
            this.log({ kind: 'referee', pair: k, same: decided });
          }
        };
        await Promise.all(Array.from({ length: REFEREE_CONCURRENCY }, refWorker));
      }

      for (const [a, b] of pairs) {
        const v = cache.get(pairKey(a.dedupeKey, b.dedupeKey))?.v;
        if (v === 'same') report.sameEdges++;
        else if (v === 'unsure') report.unsurePairs++;
        else if (v === undefined) report.deferred++;
      }
      this.writeCache(cache);
      this.log({ kind: 'run', ...report, ms: this.now() - t0 });
      return finish((a, b) => cache.get(pairKey(a.dedupeKey, b.dedupeKey))?.v === 'same');
    } catch {
      // @silent-fallback-ok — reported: mode 'words' + reason 'error'; the analyzer keeps its word-overlap edges.
      report.mode = 'words';
      report.reason = 'error';
      return finish(null);
    }
  }

  private async askJev(key: string, model: string, timeoutMsCfg: number | undefined, a: GroupableRecord, b: GroupableRecord, band: CascadeBand): Promise<CachedVerdict | null> {
    const state = renderPairState(a.learning, b.learning);
    if (state === null) return null;
    const timeoutMs = typeof timeoutMsCfg === 'number' && timeoutMsCfg > 0 ? Math.min(timeoutMsCfg, 10_000) : DEFAULT_TIMEOUT_MS;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    (timer as { unref?: () => void }).unref?.();
    const t0 = this.now();
    let outcome: 'fired' | 'noop' | 'error' = 'error';
    let tokensIn: number | undefined;
    let served: string | undefined;
    const k = pairKey(a.dedupeKey, b.dedupeKey);
    try {
      const res = await (this.deps.fetchImpl ?? fetch)(ENDPOINT, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ state, model, questions: groupingQuestions() }),
        signal: ctrl.signal,
      });
      if (!res.ok) {
        if (res.status === 401 || res.status === 403) { this.cachedKey = null; this.keyReadAt = this.now(); }
        this.log({ kind: 'jev-failed', pair: k, reason: `http-${res.status}` });
        return null;
      }
      const json = (await res.json()) as { model?: string; usage?: { input_tokens?: number }; answers?: Record<string, { choice?: unknown; probabilities?: Record<string, unknown> }> };
      served = typeof json.model === 'string' ? json.model : undefined;
      tokensIn = json.usage?.input_tokens;
      if (served !== model) { this.log({ kind: 'jev-failed', pair: k, reason: 'model-mismatch' }); return null; }
      const fwd = readSame(json.answers?.same);
      const rev = readSame(json.answers?.same_rev);
      if (fwd === null || rev === null) { this.log({ kind: 'jev-failed', pair: k, reason: 'no-answers' }); return null; }
      const pSame = Math.min(fwd, rev);
      const v: PairVerdict = pSame > band.hi ? 'same' : pSame < band.lo ? 'not-same' : 'unsure';
      outcome = v === 'same' ? 'fired' : 'noop';
      this.log({ kind: 'jev', pair: k, pSame, pFwd: fwd, pRev: rev, v, ms: this.now() - t0 });
      return { v, by: 'jev', pSame, model, qv: GROUPING_QUESTION_VERSION, at: new Date(this.now()).toISOString() };
    } catch (err) {
      this.log({ kind: 'jev-failed', pair: k, reason: (err as Error)?.name === 'AbortError' ? 'timeout' : 'error' });
      return null;
    } finally {
      clearTimeout(timer);
      try {
        this.deps.metrics?.record({
          feature: JEV_GROUPING_FEATURE, kind: 'llm', outcome, tokensIn, tokensOut: 0,
          latencyMs: this.now() - t0, model: served ?? model, framework: 'typesafe-api',
        });
      } catch { /* @silent-fallback-ok — metering never breaks grouping */ }
    }
  }

  private async askReferee(referee: IntelligenceProvider, a: GroupableRecord, b: GroupableRecord, timeoutMs: number): Promise<boolean | null> {
    const state = renderPairState(a.learning, b.learning);
    if (state === null) return null;
    const out = await askReferee(referee, state, [{ rule: REFEREE_RULE, instructions: REFEREE_INSTRUCTIONS }], {
      component: 'CorrectionMeaningGrouping',
      category: 'job',
      timeoutMs: Math.min(60_000, timeoutMs),
      now: this.deps.now,
    });
    return out.ok ? out.answers[REFEREE_RULE] === true : null;
  }

  private readCache(): Map<string, CachedVerdict> {
    const m = new Map<string, CachedVerdict>();
    try {
      const raw = JSON.parse(fs.readFileSync(this.deps.cachePath, 'utf8')) as { pairs?: Record<string, CachedVerdict> };
      for (const [k, v] of Object.entries(raw.pairs ?? {})) {
        if (v && (v.v === 'same' || v.v === 'not-same' || v.v === 'unsure') && typeof v.qv === 'number' && typeof v.model === 'string') m.set(k, v);
      }
    } catch { /* @silent-fallback-ok — a missing or unreadable cache means every pair is asked again */ }
    return m;
  }

  private writeCache(cache: Map<string, CachedVerdict>): void {
    try {
      fs.mkdirSync(path.dirname(this.deps.cachePath), { recursive: true });
      // Per-writer temp name: two overlapping runs never rename each other's half-written file.
      const tmp = `${this.deps.cachePath}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ version: 1, pairs: Object.fromEntries(cache) }), { mode: 0o600 });
      fs.renameSync(tmp, this.deps.cachePath);
    } catch { /* @silent-fallback-ok — an unwritable cache only costs re-asking next run */ }
  }

  private log(row: Record<string, unknown>): void {
    try {
      fs.mkdirSync(path.dirname(this.deps.logPath), { recursive: true });
      fs.appendFileSync(this.deps.logPath, JSON.stringify({ ts: new Date(this.now()).toISOString(), ...row }) + '\n');
    } catch { /* @silent-fallback-ok — an unwritable audit log loses rows, never changes grouping */ }
  }
}

/** The production factory, shared by server.ts and the E2E test. */
export function buildJevCorrectionGrouper(opts: {
  readLiveConfig: () => MeaningGroupingConfig | undefined;
  developmentAgent?: boolean;
  readSecret: (name: string) => unknown;
  stateDir: string;
  referee?: IntelligenceProvider | null;
  metrics?: JevCorrectionGrouperDeps['metrics'];
  fetchImpl?: typeof fetch;
}): JevCorrectionGrouper {
  return new JevCorrectionGrouper({
    getConfig: () => {
      const block = opts.readLiveConfig() ?? {};
      const enabled = resolveDevAgentGate(typeof block.enabled === 'boolean' ? block.enabled : undefined, { developmentAgent: opts.developmentAgent });
      return { ...block, enabled };
    },
    readKey: () => {
      const v = opts.readSecret('typesafe_api_key');
      return typeof v === 'string' && v ? v : null;
    },
    cachePath: path.join(opts.stateDir, 'state', 'correction-pair-verdicts.json'),
    logPath: path.join(opts.stateDir, '..', 'logs', 'correction-meaning-grouping.jsonl'),
    referee: opts.referee ?? null,
    metrics: opts.metrics,
    fetchImpl: opts.fetchImpl,
  });
}

let installed: JevCorrectionGrouper | null = null;
/** server.ts installs the one instance; POST /corrections/analyze and GET /corrections/groups find it here. */
export function installJevCorrectionGrouper(g: JevCorrectionGrouper | null): void { installed = g; }
export function getJevCorrectionGrouper(): JevCorrectionGrouper | null { return installed; }
