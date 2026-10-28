/**
 * JobCostReport — per-job cost measurement (docs/specs/job-cost-reduction.md §9).
 *
 * Read-only over three existing records, joined per job slug:
 *   - JobRunHistory   → runs (script runs record `tokens: 0`, a measured zero);
 *   - TokenLedger     → session tokens, via the job_sessions ⋈ token_events join
 *                       (and codex_token_sessions for Codex-framework job sessions);
 *   - FeatureMetrics  → calls a component made FOR a job (attribution.jobSlug):
 *                       narrator, outage backup check, supervision pass, Jev.
 *
 * It also owns the frozen per-machine baseline at `.instar/state/job-cost-baseline.json`:
 *   - the collection start is recorded the first time this module runs on a machine;
 *   - the baseline freezes AUTOMATICALLY on the first report computed ≥ 7 days after
 *     that start, over the PROSPECTIVE week [start, start + 7d) (method `prospective`),
 *     or on demand via POST /jobs/cost/baseline/freeze (method `prospective-manual`,
 *     window = the last 7 days, clipped to the collection start);
 *   - a best-effort transcript backfill (the §1 scan) is computed at freeze time and
 *     stored under `backfill`, for comparison only — it never becomes the baseline.
 *
 * Weighting (echoed in every output and written into the baseline file):
 *   input 1, output 5, cache-read 0.1, cache-write 1.25. No weighted-token helper
 *   existed in src/monitoring, so these are defined here; they are the relative
 *   Anthropic list-price ratios (cache read ≈ 0.1× input, 5-minute cache write ≈
 *   1.25× input, output ≈ 5× input). Codex/feature-metrics `tokensIn` includes its
 *   cached subset, so for those sources fresh input = tokensIn − tokensCached and the
 *   cached part is weighted as a cache read.
 *
 * Observability only: it never gates, throttles, or mutates a job.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { JobRun } from './JobRunHistory.js';
import type {
  JobTokenTotalsRow,
  JobSessionCountRow,
  SessionUsageRow,
} from '../monitoring/TokenLedger.js';
import type { FeatureJobRollup } from '../monitoring/FeatureMetricsLedger.js';

export const JOB_COST_WEIGHTS = Object.freeze({ input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 });
export const JOB_COST_WEIGHTS_NOTE =
  'weighted = input*1 + output*5 + cacheRead*0.1 + cacheWrite*1.25 (relative list-price ratios). ' +
  'For codex and feature-metrics rows, input excludes its cached subset, which is weighted as a cache read.';

/** The prospective collection week (§9.2). */
export const BASELINE_COLLECTION_MS = 7 * 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
/** Feature components counted as "narrations" (Builder D's narrator). */
export const DEFAULT_NARRATOR_COMPONENTS: readonly string[] = ['JobAnomalyNarrator'];

export interface TokenCounts { in: number; out: number; cacheRead: number; cacheWrite: number }

export interface JobCostSlugRow {
  slug: string;
  /** Run-history rows started in the window (this machine). */
  runs: number;
  /** Of those, script runs (recorded `tokens: 0`). */
  scriptRuns: number;
  failures: number;
  /** Model calls: session API requests + feature calls made for the job. */
  modelCalls: number;
  tokens: TokenCounts;
  weightedTokens: number;
  /** calls per framework / per model, across sessions and feature calls. */
  frameworks: Record<string, number>;
  models: Record<string, number>;
  /** Session usage split by origin ('job' | 'triage' | 'rollback'). */
  sessions: Record<string, { recorded: number; unbound: number; transcripts: number; modelCalls: number; weightedTokens: number }>;
  /** Feature calls made for this job, per component. */
  featureCalls: Record<string, number>;
  narrations: number;
  /** Triage sessions (origin 'triage') recorded in the window. */
  triageSessions: number;
  baseline: BaselineSlugEntry | null;
}

export interface BaselineSlugEntry {
  runs: number;
  failures: number;
  modelCalls: number;
  tokens: TokenCounts;
  weightedTokens: number;
  /** Per-day failures over the baseline window, oldest first (for §9.4's 2× std-dev flag). */
  failuresPerDay: number[];
}

export interface BackfillResult {
  method: 'transcript-first-prompt';
  dateRange: { from: string; to: string };
  perSlug: Record<string, { sessions: number; modelCalls: number; tokens: TokenCounts; weightedTokens: number }>;
  /** Sessions that look like scheduled-job sessions (carry the job VIEW METADATA block) but could not be mapped to a slug. */
  unmapped: number;
  /** Sessions with no job signature at all (interactive / non-job). Not job sessions; counted for honesty. */
  nonJobSessions: number;
  /** Sessions with usage but no readable transcript path. */
  unreadable: number;
}

export interface JobCostBaselineFile {
  schemaVersion: 1;
  machineId: string | null;
  collectionStartedAt: string;
  method: 'prospective' | 'prospective-manual' | null;
  weights: typeof JOB_COST_WEIGHTS;
  dateRange: { from: string; to: string } | null;
  perSlug: Record<string, BaselineSlugEntry> | null;
  /** Job sessions in the baseline window that never bound to a transcript. */
  unmapped: number | null;
  frozenAt: string | null;
  backfill: BackfillResult | null;
}

export interface JobCostReportOutput {
  schemaVersion: 1;
  machineId: string | null;
  sinceDays: number;
  window: { from: string; to: string };
  weights: typeof JOB_COST_WEIGHTS;
  weightsNote: string;
  slugs: JobCostSlugRow[];
  totals: { runs: number; scriptRuns: number; modelCalls: number; tokens: TokenCounts; weightedTokens: number; narrations: number; triageSessions: number };
  /** Job sessions recorded in the window that never bound to a transcript (their tokens are not in the totals). */
  unboundJobSessions: number;
  /** Which sources answered. A null source is stated, never read as zero. */
  sources: { runHistory: boolean; tokenLedger: boolean; featureMetrics: boolean };
  baseline: {
    method: JobCostBaselineFile['method'];
    dateRange: JobCostBaselineFile['dateRange'];
    frozenAt: string;
    unmapped: number | null;
    backfill: BackfillResult | null;
  } | null;
  baselineReason: string | null;
  collectionStartedAt: string | null;
  generatedAt: string;
}

export interface JobCostReportDeps {
  /** The agent state dir (`.instar`); the baseline lives at `<stateDir>/state/job-cost-baseline.json`. */
  stateDir: string;
  machineId: () => string | null;
  runHistory: { query(opts: { sinceHours?: number; limit?: number }): { runs: JobRun[] } } | null;
  tokenLedger: {
    jobTokenTotals(opts: { sinceMs: number; untilMs?: number; machineId?: string | null }): JobTokenTotalsRow[];
    jobSessionCounts(opts: { sinceMs: number; untilMs?: number; machineId?: string | null }): JobSessionCountRow[];
    sessionUsageInWindow?(opts: { sinceMs: number; untilMs?: number; limit?: number }): SessionUsageRow[];
  } | null;
  featureMetrics: { byJobSlug(opts: { sinceMs: number; untilMs?: number; machineId?: string | null }): FeatureJobRollup[] } | null;
  /** Known job slugs → body text (for the backfill's body-prefix fallback match). */
  jobBodies?: () => Map<string, string>;
  narratorComponents?: readonly string[];
  now?: () => number;
  /** Test seam: backfill per-file head read. */
  readHead?: (filePath: string, maxBytes: number) => Promise<string | null>;
}

function zeroTokens(): TokenCounts { return { in: 0, out: 0, cacheRead: 0, cacheWrite: 0 }; }
function addTokens(a: TokenCounts, b: TokenCounts): void {
  a.in += b.in; a.out += b.out; a.cacheRead += b.cacheRead; a.cacheWrite += b.cacheWrite;
}
export function weighTokens(t: TokenCounts): number {
  const w = JOB_COST_WEIGHTS;
  return Math.round(t.in * w.input + t.out * w.output + t.cacheRead * w.cacheRead + t.cacheWrite * w.cacheWrite);
}
function bump(map: Record<string, number>, key: string, n: number): void {
  if (n <= 0) return;
  map[key] = (map[key] ?? 0) + n;
}
function isScriptRun(r: JobRun): boolean {
  // Builder A's script runner records `runner: 'script'` and `tokens: 0`; either marks
  // a script run (a measured zero, not a missing one).
  const x = r as JobRun & { runner?: string; tokens?: number };
  return x.runner === 'script' || x.tokens === 0;
}
function isFailure(r: JobRun): boolean {
  return r.result === 'failure' || r.result === 'timeout' || r.result === 'spawn-error';
}

/** Aggregated per-slug core numbers over one window (shared by report + freeze). */
interface WindowAgg {
  runs: number; scriptRuns: number; failures: number;
  modelCalls: number; tokens: TokenCounts;
  frameworks: Record<string, number>; models: Record<string, number>;
  sessions: JobCostSlugRow['sessions'];
  featureCalls: Record<string, number>; narrations: number; triageSessions: number;
  failuresPerDay: number[];
}

export class JobCostReport {
  private readonly deps: JobCostReportDeps;
  private readonly now: () => number;
  private readonly narrators: Set<string>;
  private freezeInFlight: Promise<unknown> | null = null;

  constructor(deps: JobCostReportDeps) {
    this.deps = deps;
    this.now = deps.now ?? (() => Date.now());
    this.narrators = new Set(deps.narratorComponents ?? DEFAULT_NARRATOR_COMPONENTS);
  }

  get baselinePath(): string {
    return path.join(this.deps.stateDir, 'state', 'job-cost-baseline.json');
  }

  /**
   * Record the collection start on first boot with the feature (idempotent). Called by
   * the integrator at server start; also called lazily by compute().
   */
  ensureCollectionStarted(): JobCostBaselineFile {
    const existing = this.readBaseline();
    if (existing) return existing;
    const file: JobCostBaselineFile = {
      schemaVersion: 1,
      machineId: this.deps.machineId(),
      collectionStartedAt: new Date(this.now()).toISOString(),
      method: null,
      weights: { ...JOB_COST_WEIGHTS },
      dateRange: null,
      perSlug: null,
      unmapped: null,
      frozenAt: null,
      backfill: null,
    };
    this.writeBaseline(file);
    return file;
  }

  readBaseline(): JobCostBaselineFile | null {
    try {
      const raw = JSON.parse(fs.readFileSync(this.baselinePath, 'utf-8')) as JobCostBaselineFile;
      if (!raw || raw.schemaVersion !== 1 || typeof raw.collectionStartedAt !== 'string') return null;
      return raw;
    } catch {
      // @silent-fallback-ok: absent/corrupt file → no baseline yet (reported as baseline: null + reason).
      return null;
    }
  }

  private writeBaseline(file: JobCostBaselineFile): void {
    const p = this.baselinePath;
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const tmp = `${p}.${process.pid}.${Date.now().toString(36)}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(file, null, 2));
    fs.renameSync(tmp, p);
  }

  /** Per-slug aggregation over [fromMs, toMs). */
  private aggregate(fromMs: number, toMs: number): { bySlug: Map<string, WindowAgg>; unbound: number } {
    const machineId = this.deps.machineId();
    const bySlug = new Map<string, WindowAgg>();
    const days = Math.max(1, Math.ceil((toMs - fromMs) / DAY_MS));
    const get = (slug: string): WindowAgg => {
      let a = bySlug.get(slug);
      if (!a) {
        a = {
          runs: 0, scriptRuns: 0, failures: 0, modelCalls: 0, tokens: zeroTokens(),
          frameworks: {}, models: {}, sessions: {}, featureCalls: {}, narrations: 0, triageSessions: 0,
          failuresPerDay: new Array<number>(days).fill(0),
        };
        bySlug.set(slug, a);
      }
      return a;
    };

    if (this.deps.runHistory) {
      const sinceHours = Math.ceil((this.now() - fromMs) / 3_600_000) + 1;
      const { runs } = this.deps.runHistory.query({ sinceHours, limit: 1_000_000 });
      for (const r of runs) {
        const t = Date.parse(r.startedAt);
        if (!Number.isFinite(t) || t < fromMs || t >= toMs) continue;
        if (machineId && r.machineId && r.machineId !== machineId) continue;
        const a = get(r.slug);
        a.runs++;
        if (isScriptRun(r)) a.scriptRuns++;
        if (isFailure(r)) {
          a.failures++;
          const d = Math.min(days - 1, Math.floor((t - fromMs) / DAY_MS));
          a.failuresPerDay[d]++;
        }
      }
    }

    let unbound = 0;
    if (this.deps.tokenLedger) {
      const q = { sinceMs: fromMs, untilMs: toMs, machineId };
      for (const row of this.deps.tokenLedger.jobTokenTotals(q)) {
        const a = get(row.jobSlug);
        const t: TokenCounts = { in: row.tokensIn, out: row.tokensOut, cacheRead: row.cacheRead, cacheWrite: row.cacheWrite };
        addTokens(a.tokens, t);
        a.modelCalls += row.modelCalls;
        bump(a.frameworks, row.framework, row.modelCalls);
        bump(a.models, row.model, row.modelCalls);
        const s = (a.sessions[row.origin] ??= { recorded: 0, unbound: 0, transcripts: 0, modelCalls: 0, weightedTokens: 0 });
        s.transcripts += row.sessions;
        s.modelCalls += row.modelCalls;
        s.weightedTokens += weighTokens(t);
      }
      for (const c of this.deps.tokenLedger.jobSessionCounts(q)) {
        const a = get(c.jobSlug);
        const s = (a.sessions[c.origin] ??= { recorded: 0, unbound: 0, transcripts: 0, modelCalls: 0, weightedTokens: 0 });
        s.recorded += c.recorded;
        s.unbound += c.unbound;
        unbound += c.unbound;
        if (c.origin === 'triage') a.triageSessions += c.recorded;
      }
    }

    if (this.deps.featureMetrics) {
      for (const f of this.deps.featureMetrics.byJobSlug({ sinceMs: fromMs, untilMs: toMs, machineId })) {
        const a = get(f.jobSlug);
        const cached = Math.min(f.tokensCached, f.tokensIn);
        addTokens(a.tokens, { in: f.tokensIn - cached, out: f.tokensOut, cacheRead: cached, cacheWrite: 0 });
        a.modelCalls += f.calls;
        bump(a.frameworks, f.framework ?? 'unknown', f.calls);
        bump(a.models, f.model ?? 'unknown', f.calls);
        bump(a.featureCalls, f.feature, f.calls);
        if (this.narrators.has(f.feature)) a.narrations += f.calls;
      }
    }
    return { bySlug, unbound };
  }

  /**
   * Compute the report over the last `sinceDays`. Freezes the baseline automatically
   * when it is unfrozen and ≥ 7 days have passed since the collection start.
   */
  async compute(sinceDays = 7): Promise<JobCostReportOutput> {
    const nowMs = this.now();
    let baseline = this.ensureCollectionStarted();
    const startMs = Date.parse(baseline.collectionStartedAt);
    if (!baseline.frozenAt && Number.isFinite(startMs) && nowMs - startMs >= BASELINE_COLLECTION_MS) {
      try {
        baseline = await this.freeze({ method: 'prospective', fromMs: startMs, toMs: startMs + BASELINE_COLLECTION_MS });
      } catch (err) {
        // @silent-fallback-ok: an auto-freeze failure leaves the baseline unfrozen and is
        // retried on the next report; the reason is surfaced in baselineReason below.
        console.warn(`[JobCostReport] baseline auto-freeze failed: ${(err as Error).message}`);
      }
    }

    const fromMs = nowMs - sinceDays * DAY_MS;
    const { bySlug, unbound } = this.aggregate(fromMs, nowMs + 1);
    const frozen = baseline.frozenAt ? baseline : null;
    const slugs: JobCostSlugRow[] = [];
    const totals = { runs: 0, scriptRuns: 0, modelCalls: 0, tokens: zeroTokens(), weightedTokens: 0, narrations: 0, triageSessions: 0 };
    const allSlugs = new Set<string>([...bySlug.keys(), ...Object.keys(frozen?.perSlug ?? {})]);
    for (const slug of [...allSlugs].sort()) {
      const a = bySlug.get(slug);
      const tokens = a ? { ...a.tokens } : zeroTokens();
      const row: JobCostSlugRow = {
        slug,
        runs: a?.runs ?? 0,
        scriptRuns: a?.scriptRuns ?? 0,
        failures: a?.failures ?? 0,
        modelCalls: a?.modelCalls ?? 0,
        tokens,
        weightedTokens: weighTokens(tokens),
        frameworks: a?.frameworks ?? {},
        models: a?.models ?? {},
        sessions: a?.sessions ?? {},
        featureCalls: a?.featureCalls ?? {},
        narrations: a?.narrations ?? 0,
        triageSessions: a?.triageSessions ?? 0,
        baseline: frozen?.perSlug?.[slug] ?? null,
      };
      slugs.push(row);
      totals.runs += row.runs;
      totals.scriptRuns += row.scriptRuns;
      totals.modelCalls += row.modelCalls;
      addTokens(totals.tokens, row.tokens);
      totals.narrations += row.narrations;
      totals.triageSessions += row.triageSessions;
    }
    totals.weightedTokens = weighTokens(totals.tokens);

    let baselineReason: string | null = null;
    if (!frozen) {
      const elapsed = Number.isFinite(startMs) ? nowMs - startMs : 0;
      const remainingH = Math.max(0, Math.ceil((BASELINE_COLLECTION_MS - elapsed) / 3_600_000));
      baselineReason = remainingH > 0
        ? `collecting: the prospective baseline week started ${baseline.collectionStartedAt} and freezes in about ${remainingH}h (or POST /jobs/cost/baseline/freeze)`
        : 'the baseline is due to freeze but the freeze did not complete; it is retried on the next report';
    }

    return {
      schemaVersion: 1,
      machineId: this.deps.machineId(),
      sinceDays,
      window: { from: new Date(fromMs).toISOString(), to: new Date(nowMs).toISOString() },
      weights: { ...JOB_COST_WEIGHTS },
      weightsNote: JOB_COST_WEIGHTS_NOTE,
      slugs,
      totals,
      unboundJobSessions: unbound,
      sources: {
        runHistory: this.deps.runHistory !== null,
        tokenLedger: this.deps.tokenLedger !== null,
        featureMetrics: this.deps.featureMetrics !== null,
      },
      baseline: frozen && frozen.frozenAt
        ? { method: frozen.method, dateRange: frozen.dateRange, frozenAt: frozen.frozenAt, unmapped: frozen.unmapped, backfill: frozen.backfill }
        : null,
      baselineReason,
      collectionStartedAt: baseline.collectionStartedAt,
      generatedAt: new Date(nowMs).toISOString(),
    };
  }

  /**
   * Freeze the baseline. Default (manual) window: the last 7 days, clipped to the
   * collection start. Refuses to overwrite a frozen baseline unless `force`.
   * Single-flight: a concurrent call waits for the in-flight freeze.
   */
  async freeze(opts: { method?: 'prospective' | 'prospective-manual'; fromMs?: number; toMs?: number; force?: boolean } = {}): Promise<JobCostBaselineFile> {
    if (this.freezeInFlight) await this.freezeInFlight.catch(() => undefined);
    const current = this.ensureCollectionStarted();
    if (current.frozenAt && !opts.force) {
      throw new JobCostBaselineFrozenError(current.frozenAt);
    }
    const run = (async () => {
      const nowMs = this.now();
      const startMs = Date.parse(current.collectionStartedAt);
      const toMs = opts.toMs ?? nowMs;
      const fromMs = opts.fromMs ?? Math.max(Number.isFinite(startMs) ? startMs : toMs - BASELINE_COLLECTION_MS, toMs - BASELINE_COLLECTION_MS);
      const { bySlug, unbound } = this.aggregate(fromMs, toMs);
      const perSlug: Record<string, BaselineSlugEntry> = {};
      for (const [slug, a] of bySlug) {
        perSlug[slug] = {
          runs: a.runs, failures: a.failures, modelCalls: a.modelCalls,
          tokens: { ...a.tokens }, weightedTokens: weighTokens(a.tokens),
          failuresPerDay: a.failuresPerDay,
        };
      }
      let backfill: BackfillResult | null = null;
      try {
        backfill = await this.backfill(fromMs, toMs);
      } catch (err) {
        // @silent-fallback-ok: the backfill is comparison-only; its absence is stated as backfill: null.
        console.warn(`[JobCostReport] backfill failed: ${(err as Error).message}`);
      }
      const file: JobCostBaselineFile = {
        ...current,
        machineId: this.deps.machineId(),
        method: opts.method ?? 'prospective-manual',
        weights: { ...JOB_COST_WEIGHTS },
        dateRange: { from: new Date(fromMs).toISOString(), to: new Date(toMs).toISOString() },
        perSlug,
        unmapped: unbound,
        frozenAt: new Date(nowMs).toISOString(),
        backfill,
      };
      this.writeBaseline(file);
      return file;
    })();
    this.freezeInFlight = run;
    try {
      return await run;
    } finally {
      this.freezeInFlight = null;
    }
  }

  /**
   * Best-effort backfill (§9.2, the §1 scan): for every transcript session with usage in
   * the window, read the head of its transcript, take the first user prompt, and map it
   * to a slug — first by the scheduler's job signature (the VIEW METADATA block every
   * scheduled-job prompt carries: `"source": { "type": "job", "id": "<slug>" }`), then
   * by the job body's opening text. A session carrying the job signature that maps to
   * no slug is `unmapped`, never dropped. Returns null without a ledger.
   */
  async backfill(fromMs: number, toMs: number): Promise<BackfillResult | null> {
    const ledger = this.deps.tokenLedger;
    if (!ledger?.sessionUsageInWindow) return null;
    const sessions = ledger.sessionUsageInWindow({ sinceMs: fromMs, untilMs: toMs });
    const bodies = this.deps.jobBodies?.() ?? new Map<string, string>();
    const bodyKeys: Array<{ slug: string; key: string }> = [];
    for (const [slug, body] of bodies) {
      const key = normalize(body).slice(0, 160);
      if (key.length >= 40) bodyKeys.push({ slug, key });
    }
    const readHead = this.deps.readHead ?? defaultReadHead;
    const result: BackfillResult = {
      method: 'transcript-first-prompt',
      dateRange: { from: new Date(fromMs).toISOString(), to: new Date(toMs).toISOString() },
      perSlug: {}, unmapped: 0, nonJobSessions: 0, unreadable: 0,
    };
    let i = 0;
    for (const s of sessions) {
      if (++i % 25 === 0) await new Promise<void>((r) => setImmediate(r));
      if (!s.filePath) { result.unreadable++; continue; }
      const head = await readHead(s.filePath, 256 * 1024);
      const prompt = head === null ? null : firstUserPrompt(head);
      if (prompt === null) { result.unreadable++; continue; }
      const marker = JOB_MARKER_RE.exec(prompt);
      let slug: string | null = marker ? marker[1] : null;
      if (!slug && bodyKeys.length > 0) {
        const norm = normalize(prompt);
        slug = bodyKeys.find((b) => norm.includes(b.key))?.slug ?? null;
      }
      if (!slug) {
        if (prompt.includes('[VIEW METADATA]')) result.unmapped++;
        else result.nonJobSessions++;
        continue;
      }
      const tokens: TokenCounts = { in: s.tokensIn, out: s.tokensOut, cacheRead: s.cacheRead, cacheWrite: s.cacheWrite };
      const e = (result.perSlug[slug] ??= { sessions: 0, modelCalls: 0, tokens: zeroTokens(), weightedTokens: 0 });
      e.sessions++;
      e.modelCalls += s.modelCalls;
      addTokens(e.tokens, tokens);
      e.weightedTokens = weighTokens(e.tokens);
    }
    return result;
  }
}

export class JobCostBaselineFrozenError extends Error {
  constructor(readonly frozenAt: string) {
    super(`baseline already frozen at ${frozenAt}`);
    this.name = 'JobCostBaselineFrozenError';
  }
}

/** The scheduler's per-job VIEW METADATA signature (JobScheduler.buildPrompt). */
const JOB_MARKER_RE = /"source"\s*:\s*\{\s*"type"\s*:\s*"job"\s*,\s*"id"\s*:\s*"([A-Za-z0-9_.:-]{1,128})"/;

function normalize(s: string): string {
  return s.replace(/\s+/g, ' ').trim().toLowerCase();
}

/** The first `type: user` line's text in a transcript head; null if none parsed. */
export function firstUserPrompt(head: string): string | null {
  for (const line of head.split('\n')) {
    if (!line.includes('"user"')) continue;
    let obj: { type?: string; message?: { role?: string; content?: unknown } };
    try { obj = JSON.parse(line); } catch { continue; /* @silent-fallback-ok: a truncated last line in the head */ }
    if (obj.type !== 'user') continue;
    const c = obj.message?.content;
    if (typeof c === 'string') return c;
    if (Array.isArray(c)) {
      const text = c
        .map((p) => (p && typeof p === 'object' && (p as { type?: string }).type === 'text' ? String((p as { text?: unknown }).text ?? '') : ''))
        .join('\n');
      if (text) return text;
    }
  }
  return null;
}

async function defaultReadHead(filePath: string, maxBytes: number): Promise<string | null> {
  let fh: fs.promises.FileHandle | null = null;
  try {
    fh = await fs.promises.open(filePath, 'r');
    const buf = Buffer.alloc(maxBytes);
    const { bytesRead } = await fh.read(buf, 0, maxBytes, 0);
    return buf.subarray(0, bytesRead).toString('utf-8');
  } catch {
    // @silent-fallback-ok: a pruned/unreadable transcript counts as `unreadable` in the backfill.
    return null;
  } finally {
    await fh?.close().catch(() => undefined);
  }
}
