/**
 * JevSignalShadow — a dark, measure-only comparison of Jev (TypeSafe AI's
 * System One model) against the deterministic B1–B7 artefact detectors.
 *
 * Spec: docs/specs/jev-signal-layer-shadow.md
 *
 * CONTRACT (the whole reason this is safe to ship):
 *   - It decides NOTHING. It writes one content-free audit row per candidate
 *     and nothing reads that row on any decision path.
 *   - It is never awaited on the message path. `observe()` returns
 *     synchronously; the network call runs detached. At most ONE call is in
 *     flight per process — a second candidate while one runs is recorded as
 *     `skipped-concurrent` rather than queued.
 *   - It is inert unless ALL of: enabled, a future `soakEndsAt`, a vault key.
 *     The soak bound is mechanical: past `soakEndsAt` it stops, across
 *     restarts, until a new window is set.
 *   - Rows never carry message text — a sha256, byte length, detector kinds,
 *     Jev probabilities, and a CLOSED-ENUM reason. A vendor error body is never
 *     recorded (it may echo input).
 *   - Every call is metered into the feature-metrics funnel so its spend and
 *     latency appear beside every other LLM feature.
 *   - The optional referee cascade (JevCascade) is equally measure-only: it
 *     puts Jev's unsure answers (and an audit share of confident ones) to a
 *     referee model and logs the verdicts. Referee rows carry verdicts, never
 *     text; the text sent to the referee is secret-scrubbed first.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { detectGateSignals, GATE_SIGNAL_KINDS, type GateSignal, type GateSignalKind } from './GateSignalDetectors.js';
import { scrubForStore } from './durableSecretScrub.js';
import { selectEscalations, askReferee, bandFor, type CascadeBand, type EscalationReason } from './JevCascade.js';
import { resolveDevAgentGate } from './devAgentGate.js';
import { decisionQualityRecordingLive } from './DecisionQualityRecorderImpl.js';
import type { IntelligenceProvider } from './types.js';

export const JEV_SHADOW_FEATURE = 'jev-signal-shadow';
/** Attribution label for the referee's LLM calls (feature metrics + routing). */
export const JEV_REFEREE_COMPONENT = 'JevLunaReferee';
/** Default volume bound on referee calls per UTC day. */
export const REFEREE_DAILY_CAP = 300;
const ENDPOINT = 'https://api.typesafe.ai/v1/systemone';

export interface JevSignalShadowConfig {
  enabled?: boolean;
  sampleRate?: number;
  model?: string;
  timeoutMs?: number;
  /** ISO instant; the shadow is inert at or after it, and when absent. */
  soakEndsAt?: string | null;
  /** Retain a scrubbed, span-anchored excerpt on DISAGREEING rows only, so a
   *  disagreement can be adjudicated instead of merely counted. Default OFF:
   *  absent or false keeps the byte-identical no-text behaviour. */
  retainDisagreementExcerpts?: boolean;
  /** Volume bound on retained excerpts per UTC day (default EXCERPT_DAILY_CAP). */
  maxExcerptsPerDay?: number;
  /**
   * The Jev→referee cascade, measured (JevCascade). When enabled, answers in
   * the unsure band — plus an audit share of confident ones — are put to the
   * referee model and its answers are logged beside Jev's, so each question's
   * threshold can be calibrated against a smarter model. Measure-only, like
   * the rest of the shadow. Absent or disabled ⇒ no referee call is ever made.
   */
  referee?: {
    enabled?: boolean;
    band?: CascadeBand;
    bands?: Record<string, CascadeBand>;
    auditRate?: number;
    timeoutMs?: number;
    maxPerDay?: number;
  };
}

/**
 * The live advisory switch (docs/specs/jev-signal-live.md). When on, the tone
 * gate awaits Jev (bounded) and uses its CONFIDENT answers for the B1–B7
 * artefact signals; unsure or missing answers fall back to the detectors.
 * `enabled` is resolved through the development-agent gate before it reaches
 * the shadow (live on a dev agent, dark on the fleet unless flipped).
 */
export interface JevSignalLiveConfig {
  enabled?: boolean;
  /** Fetch abort for the live call (default LIVE_DEFAULT_TIMEOUT_MS, clamped to LIVE_TIMEOUT_MIN_MS–LIVE_TIMEOUT_MAX_MS). */
  timeoutMs?: number;
  /** Confident-vs-unsure band (default: the cascade's 0.30–0.70). */
  band?: CascadeBand;
  bands?: Record<string, CascadeBand>;
}
/** Covers the measured p99 (834 ms) of Jev calls on real candidates. */
export const LIVE_DEFAULT_TIMEOUT_MS = 1000;
/** Operator `timeoutMs` is clamped to this range, so no config value can make the gate wait long. */
export const LIVE_TIMEOUT_MIN_MS = 100;
export const LIVE_TIMEOUT_MAX_MS = 3000;
/** Extra wait past the fetch abort before the caller stops waiting regardless. */
export const LIVE_RACE_SLACK_MS = 250;
/** An in-flight slot older than this is treated as abandoned and reclaimed. */
export const STALE_SLOT_MS = 30_000;
/** Consecutive live failures (missed deadline, timeout, HTTP error, model mismatch) that open the breaker. */
export const LIVE_BREAKER_FAILURES = 3;
/** How long an open breaker keeps live mode on the detector path. */
export const LIVE_BREAKER_OPEN_MS = 5 * 60_000;

/**
 * What a rule's line on a live candidate rests on: `jev` = a confident Jev
 * answer decided it; `disputed` = the detector matched and Jev confidently
 * disagrees — the detection stands, annotated with Jev's view; `detector-fallback`
 * = Jev was unsure or had no answer, the detector decided.
 */
export type LiveSource = 'jev' | 'disputed' | 'detector-fallback';

/** What the tone gate receives from a live call. Never rejects. */
export interface LiveSignalsResult {
  signals: GateSignal[];
  /** True when at least one signal line came from a confident Jev answer —
   *  i.e. the list the judge sees differs from the detector list. An agreed
   *  "nothing here" does not count, so the prompt stays today's. */
  jevUsed: boolean;
}

/** The closed set of reasons a candidate was not compared. */
export type NotComparedReason =
  | 'timeout'
  | 'http-error'
  | 'oversize'
  | 'skipped-concurrent'
  | 'skipped-sample'
  | 'model-mismatch'
  | 'disabled-no-key'
  | 'soak-expired'
  /** Live only: the text scrub failed, so nothing was sent. */
  | 'scrub-error'
  /** Live only: the vendor answered but gave no usable probability at all. */
  | 'no-answers'
  /** Live only: the vendor breaker opened (one row per opening). */
  | 'breaker-open';

export type ShadowRow =
  | {
      kind: 'compared';
      ts: string;
      sha256: string;
      bytes: number;
      detectorSignals: string[];
      jev: Record<string, number>;
      ms: number;
      modelServed: string;
      disagree: string[];
      /** Present on live candidates (the answers fed the tone gate). */
      live?: true;
      /** Live only: which source decided each rule's signal. */
      liveSources?: Record<string, LiveSource>;
      /** Live only: the answer arrived after the caller stopped waiting, so
       *  every rule for this message used the detector. */
      liveLate?: true;
      /** Scrubbed, span-anchored excerpt — present ONLY on disagreeing rows,
       *  and only when retention is enabled. */
      excerpt?: string;
      /** Count of secrets redacted inside the excerpt (never their values). */
      excerptRedactions?: number;
      /** Why no excerpt was retained on a disagreeing row. */
      excerptUnavailable?: 'no-detector-span' | 'daily-cap' | 'scrub-error';
    }
  | {
      kind: 'not-compared'; ts: string; sha256: string; bytes: number; reason: NotComparedReason;
      /** Live candidate: every rule for this message fell back to the detector. */
      live?: true;
    }
  | {
      kind: 'referee';
      ts: string;
      sha256: string;
      /** Why each rule went to the referee. */
      escalated: Record<string, EscalationReason>;
      /** Jev's probabilities for the escalated rules. */
      jev: Record<string, number>;
      /** The detector's verdict for the escalated rules. */
      detector: Record<string, boolean>;
      /** The referee's verdicts — present only when the call succeeded. */
      referee?: Record<string, boolean>;
      reason?: 'timeout' | 'error' | 'unparseable' | 'busy' | 'daily-cap' | 'scrub-error';
      model?: string;
      ms?: number;
    };

/**
 * The frozen comparison contract: one Noul question per rule, the detector
 * signal kind it is compared against, and the positive threshold. Changing a
 * question is a code change, visible in review — never config. Wordings are
 * the research register's measured ladder-1 rung-2 versions.
 */
export const SHADOW_QUESTIONS: ReadonlyArray<{ rule: string; signalKind: string; instructions: string }> = [
  { rule: 'raw_path', signalKind: 'file-path', instructions: 'The message shows the reader a raw filesystem path (for example a directory or file location on a machine).' },
  { rule: 'cli_command', signalKind: 'cli-command', instructions: 'The message asks the reader to run a command in a terminal.' },
  { rule: 'config_key', signalKind: 'config-key', instructions: 'The message names a configuration setting by its literal dotted key path, in the form section.subsection.name. Describing a setting in plain words does not count.' },
  { rule: 'api_endpoint', signalKind: 'api-endpoint', instructions: 'The message shows the reader an internal HTTP endpoint or URL path of our own system.' },
  { rule: 'copy_paste_code', signalKind: 'copy-paste-code', instructions: 'The message contains a block of code or a script the reader is meant to copy and run.' },
  { rule: 'env_var', signalKind: 'env-var', instructions: 'The message names an environment variable (for example an ALL_CAPS_NAME set in a shell) for the reader to set or use.' },
  { rule: 'cron_or_slug', signalKind: 'cron-or-slug', instructions: 'The message shows the reader a raw cron expression or an internal machine identifier/slug instead of plain words.' },
];
export const POSITIVE_THRESHOLD = 0.5;
/** Characters of context kept either side of a detector span. */
export const EXCERPT_CONTEXT_CHARS = 60;
/** Hard clamp on a retained excerpt, before scrubbing. */
export const EXCERPT_MAX_CHARS = 400;
/** Default volume bound per UTC day. */
export const EXCERPT_DAILY_CAP = 50;
/** Minimum spacing between key re-reads after a miss or a 401/403 (bounds any blocking lookup). */
export const KEY_REREAD_MS = 10 * 60_000;

export interface JevSignalShadowDeps {
  /** Live config read — called per candidate so the kill-switch needs no restart. */
  getConfig: () => JevSignalShadowConfig | undefined;
  /** Live advisory config, `enabled` already dev-gate-resolved. Absent ⇒ never live. */
  getLiveConfig?: () => JevSignalLiveConfig | undefined;
  /**
   * Resolves the vault key. May block (a keychain lookup), so it is called once
   * at construction — boot, never the message path — and afterwards at most once
   * per KEY_REREAD_MS, only when the key is missing or was rejected.
   */
  readKey: () => string | null;
  /** Path of the JSONL audit log. */
  logPath: string;
  /** Feature-metrics funnel (null-safe). */
  metrics?: { record(r: Record<string, unknown>): void } | null;
  /** The referee model (Codex fast tier = GPT-6 Luna). Null/absent ⇒ no cascade. */
  referee?: IntelligenceProvider | null;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
  now?: () => number;
  random?: () => number;
  maxScanBytes?: number;
}

export class JevSignalShadow {
  private inFlight = false;
  /** When the current in-flight call started (stale-slot reclaim). */
  private inFlightSince = 0;
  /** Slot generation: only the call that holds the CURRENT slot may release it. */
  private slotGen = 0;
  /** Vendor-down breaker for live mode: consecutive failures, and when it closes again. */
  private liveFailures = 0;
  private liveBreakerUntil = 0;
  private cachedKey: string | null = null;
  /** When the key was last read; re-reads are rate-limited from here. */
  private keyReadAt = 0;
  private bootNoted = new Set<NotComparedReason>();
  private readonly deps: JevSignalShadowDeps;

  constructor(deps: JevSignalShadowDeps) {
    this.deps = deps;
    this.refreshKey();
  }

  private refreshKey(): void {
    this.keyReadAt = (this.deps.now ?? Date.now)();
    try {
      this.cachedKey = this.deps.readKey() || null;
    } catch {
      // @silent-fallback-ok — an unreadable vault means "no key"; the shadow records disabled-no-key and stays inert.
      this.cachedKey = null;
    }
  }

  /**
   * The single-flight slot. A slot held past STALE_SLOT_MS belongs to a call
   * that never settled (a fetch that ignored its abort); it is reclaimed so one
   * stuck request cannot turn every later candidate into a fallback forever.
   * Outstanding requests stay bounded: at most one per STALE_SLOT_MS.
   */
  private slotBusy(nowMs: number): boolean {
    return this.inFlight && nowMs - this.inFlightSince < STALE_SLOT_MS;
  }

  /**
   * Take the slot and return its release. The release is generation-checked: a
   * reclaimed (stale) call that settles later cannot free the slot a newer call
   * now holds, so single-flight survives a reclaim.
   */
  private takeSlot(nowMs: number): () => void {
    const gen = ++this.slotGen;
    this.inFlight = true;
    this.inFlightSince = nowMs;
    return () => { if (this.slotGen === gen) this.inFlight = false; };
  }

  /**
   * Live entry point (docs/specs/jev-signal-live.md). Returns null — without
   * doing anything — when live mode is off, so the caller falls back to
   * `observe()` and today's detector-only path. Otherwise returns a promise that
   * never rejects and settles within timeoutMs + LIVE_RACE_SLACK_MS with the
   * merged signals; any failure resolves to the plain detector signals.
   * The live call IS the shadow's measurement call: it writes the same rows
   * (tagged `live: true`) and feeds the same referee cascade.
   */
  liveSignals(text: string): Promise<LiveSignalsResult> | null {
    let live: JevSignalLiveConfig | undefined;
    try {
      live = this.deps.getLiveConfig?.();
    } catch {
      // @silent-fallback-ok — an unreadable live config means live is off; the gate keeps today's detector-only path.
      return null;
    }
    if (!live || live.enabled !== true) return null;
    try {
      return this.liveInner(text, live);
    } catch {
      // @silent-fallback-ok — any live-path fault resolves to the detector signals (today's behaviour).
      return Promise.resolve(detectorOnly(text));
    }
  }

  private liveInner(text: string, live: JevSignalLiveConfig): Promise<LiveSignalsResult> {
    const cfg = this.deps.getConfig() ?? {};
    const nowMs = (this.deps.now ?? Date.now)();
    const ts = new Date(nowMs).toISOString();
    const bytes = Buffer.byteLength(text, 'utf8');
    const maxBytes = this.deps.maxScanBytes ?? 1_000_000;
    const sha256 = crypto.createHash('sha256').update(bytes > maxBytes ? text.slice(0, maxBytes) : text, 'utf8').digest('hex');
    const fallback = (reason: NotComparedReason): Promise<LiveSignalsResult> => {
      this.write({ kind: 'not-compared', ts, sha256, bytes, reason, live: true });
      return Promise.resolve(detectorOnly(text));
    };
    if (!this.cachedKey && nowMs - this.keyReadAt >= KEY_REREAD_MS) this.refreshKey();
    if (!this.cachedKey) {
      // A standing condition: one row per process, not one per message.
      if (this.bootNoted.has('disabled-no-key')) return Promise.resolve(detectorOnly(text));
      this.bootNoted.add('disabled-no-key');
      return fallback('disabled-no-key');
    }
    // During a vendor outage every message would otherwise wait the full
    // timeout; an open breaker keeps them on the detector path (one row when it
    // opens, not one per message).
    if (nowMs < this.liveBreakerUntil) return Promise.resolve(detectorOnly(text));
    if (bytes > maxBytes) return fallback('oversize');
    if (this.slotBusy(nowMs)) return fallback('skipped-concurrent');
    // Live mode is not soak-bounded, so the text is secret-scrubbed before it
    // leaves the machine (the detectors and the row hash still see the original).
    const scrubbed = scrubForStore(text);
    if (scrubbed.error || scrubbed.truncated) return fallback('scrub-error');

    const signals = detectGateSignals(text);
    const timeoutMs = typeof live.timeoutMs === 'number' && Number.isFinite(live.timeoutMs)
      ? Math.max(LIVE_TIMEOUT_MIN_MS, Math.min(LIVE_TIMEOUT_MAX_MS, live.timeoutMs))
      : LIVE_DEFAULT_TIMEOUT_MS;
    const race = { late: false };
    const release = this.takeSlot(nowMs);
    const call = this.dispatch(text, cfg, { ts, sha256, bytes, detectorSignals: signals.map((x) => x.kind), signals }, { live, timeoutMs, race, sendText: scrubbed.text });
    this.lastDispatch = call.then(() => undefined, () => undefined).finally(release);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<null>((resolve) => {
      timer = setTimeout(() => {
        race.late = true;
        // The caller stops waiting now: record that outcome now, so a call that
        // never settles still leaves a row (a late answer adds a liveLate row).
        this.write({ kind: 'not-compared', ts, sha256, bytes, reason: 'timeout', live: true });
        resolve(null);
      }, timeoutMs + LIVE_RACE_SLACK_MS);
      (timer as { unref?: () => void }).unref?.();
    });
    // The breaker counts what the CALLER saw, once: a missed deadline is a
    // failure even if the answer lands later, and a late success resets nothing.
    return Promise.race([call.catch(() => null), deadline])
      .then((merged) => {
        this.noteLiveOutcome(merged !== null, ts, sha256, bytes);
        return merged ?? { signals, jevUsed: false };
      })
      .finally(() => { if (timer) clearTimeout(timer); });
  }

  /** Breaker bookkeeping per live candidate, as the caller saw it: an answer in
   *  time resets the count; a missed deadline, HTTP error, timeout or model
   *  mismatch counts as one failure. */
  private noteLiveOutcome(ok: boolean, ts: string, sha256: string, bytes: number): void {
    if (ok) { this.liveFailures = 0; return; }
    this.liveFailures++;
    if (this.liveFailures < LIVE_BREAKER_FAILURES) return;
    this.liveFailures = 0;
    this.liveBreakerUntil = (this.deps.now ?? Date.now)() + LIVE_BREAKER_OPEN_MS;
    this.write({ kind: 'not-compared', ts, sha256, bytes, reason: 'breaker-open', live: true });
  }

  /**
   * Fire-and-forget entry point. Synchronous, never throws, never awaited by
   * the caller. The only synchronous work is a config read, a hash, and (when
   * dispatching) building one small request body — bounded by the size guard.
   */
  observe(text: string): void {
    try {
      this.observeInner(text);
    } catch {
      // @silent-fallback-ok — a research instrument must never touch the message path; its own errors surface as missing rows, not as gate failures.
    }
  }

  /** Test seam: resolves when the detached call (if any) settles. */
  lastDispatch: Promise<void> = Promise.resolve();

  private observeInner(text: string): void {
    const cfg = this.deps.getConfig() ?? {};
    if (cfg.enabled !== true) return;
    const nowMs = (this.deps.now ?? Date.now)();
    const ts = new Date(nowMs).toISOString();
    const bytes = Buffer.byteLength(text, 'utf8');
    const maxBytes = this.deps.maxScanBytes ?? 1_000_000;
    // Hash cost is bounded by the size guard: an oversize message is identified by its first maxBytes characters.
    const sha256 = crypto.createHash('sha256').update(bytes > maxBytes ? text.slice(0, maxBytes) : text, 'utf8').digest('hex');
    const notCompared = (reason: NotComparedReason) => this.write({ kind: 'not-compared', ts, sha256, bytes, reason });

    const endsAt = cfg.soakEndsAt ? Date.parse(cfg.soakEndsAt) : NaN;
    if (!Number.isFinite(endsAt) || nowMs >= endsAt) {
      // One status row per process for a standing condition, not one per message.
      if (!this.bootNoted.has('soak-expired')) { this.bootNoted.add('soak-expired'); notCompared('soak-expired'); }
      return;
    }
    if (!this.cachedKey && nowMs - this.keyReadAt >= KEY_REREAD_MS) this.refreshKey();
    if (!this.cachedKey) {
      if (!this.bootNoted.has('disabled-no-key')) { this.bootNoted.add('disabled-no-key'); notCompared('disabled-no-key'); }
      return;
    }
    const sampleRate = typeof cfg.sampleRate === 'number' ? cfg.sampleRate : 1;
    if (sampleRate < 1 && (this.deps.random ?? Math.random)() >= sampleRate) { notCompared('skipped-sample'); return; }
    if (bytes > maxBytes) { notCompared('oversize'); return; }
    if (this.slotBusy(nowMs)) { notCompared('skipped-concurrent'); return; }

    // Keep the FULL signals (not just kinds): their spans are what anchors a
    // retained excerpt to the artifact in dispute, so retention can never widen
    // beyond what the detector actually pointed at.
    const signals = detectGateSignals(text);
    const detectorSignals = signals.map((s) => s.kind);
    const release = this.takeSlot(nowMs);
    this.lastDispatch = this.dispatch(text, cfg, { ts, sha256, bytes, detectorSignals, signals })
      .then(() => undefined)
      .catch(() => { /* @silent-fallback-ok — dispatch records its own reason rows; a throw here only means the row write failed */ })
      .finally(release);
  }

  private async dispatch(
    text: string,
    cfg: JevSignalShadowConfig,
    base: { ts: string; sha256: string; bytes: number; detectorSignals: string[]; signals: ReturnType<typeof detectGateSignals> },
    /** Live mode: `sendText` is the scrubbed text that leaves the machine; `text`
     *  stays the original for excerpt anchoring (spans index the original). */
    live?: { live: JevSignalLiveConfig; timeoutMs: number; race: { late: boolean }; sendText: string },
  ): Promise<LiveSignalsResult | null> {
    const model = cfg.model || 'jev-1.13.0';
    const timeoutMs = live ? live.timeoutMs : typeof cfg.timeoutMs === 'number' && cfg.timeoutMs > 0 ? cfg.timeoutMs : 1500;
    const liveTag = live ? { live: true as const } : {};
    const questions = Object.fromEntries(SHADOW_QUESTIONS.map((q) => [q.rule, { type: 'noul', instructions: q.instructions }]));
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const t0 = (this.deps.now ?? Date.now)();
    const nc = (reason: NotComparedReason): null => {
      // A live candidate whose caller deadline already passed has its timeout
      // row; a failure landing after that is the same candidate, not a new row.
      if (live?.race.late) return null;
      this.write({ kind: 'not-compared', ts: base.ts, sha256: base.sha256, bytes: base.bytes, reason, ...liveTag });
      return null;
    };
    let tokensIn: number | undefined;
    let outcome: 'fired' | 'noop' | 'error' = 'error';
    let modelServed: string | undefined;
    try {
      const res = await (this.deps.fetchImpl ?? fetch)(ENDPOINT, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.cachedKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ state: live ? live.sendText : text, model, questions }),
        signal: ctrl.signal,
      });
      if (!res.ok) {
        if (res.status === 401 || res.status === 403) { this.cachedKey = null; this.keyReadAt = (this.deps.now ?? Date.now)(); } // re-read after KEY_REREAD_MS, never per message
        return nc('http-error');
      }
      const json = (await res.json()) as { model?: string; answers?: Record<string, { noul?: number }>; usage?: { input_tokens?: number } };
      modelServed = typeof json.model === 'string' ? json.model : undefined;
      tokensIn = json.usage?.input_tokens;
      if (modelServed !== model) return nc('model-mismatch');
      const jev: Record<string, number> = {};
      const disagree: string[] = [];
      for (const q of SHADOW_QUESTIONS) {
        const p = json.answers?.[q.rule]?.noul;
        if (typeof p !== 'number' || !Number.isFinite(p)) continue;
        jev[q.rule] = p;
        const jevSays = p > POSITIVE_THRESHOLD;
        const detectorSays = base.detectorSignals.includes(q.signalKind);
        if (jevSays !== detectorSays) disagree.push(q.rule);
      }
      // A response with no usable probability is a failure, not an answer: it
      // must count toward the breaker instead of resetting it.
      if (live && Object.keys(jev).length === 0) return nc('no-answers');
      outcome = disagree.length ? 'fired' : 'noop';
      const { signals, ...rowBase } = base;
      // Measurement EXTRAS (retained excerpts, the referee) belong to the shadow:
      // on a live call they run only while the shadow itself is measuring (on,
      // inside its soak), so live mode — which is not soak-bound — never carries
      // them past the window. One check, so every extra is bound the same way.
      const measuring = !live || shadowMeasuring(cfg, (this.deps.now ?? Date.now)());
      const retained = measuring && disagree.length > 0 && cfg.retainDisagreementExcerpts === true
        ? this.buildExcerpt(text, signals, disagree, cfg, base.ts)
        : {};
      // Live: merge, and record which source decided each rule. A late answer
      // (the caller already stopped waiting) is recorded as such, so a row never
      // claims Jev supplied a signal the gate did not actually use.
      const merged = live ? mergeLiveSignals(signals, jev, live.live) : null;
      const liveFields = !live ? {}
        : live.race.late ? { live: true as const, liveLate: true as const }
        : { live: true as const, liveSources: merged!.sources };
      this.write({ kind: 'compared', ...rowBase, jev, ms: (this.deps.now ?? Date.now)() - t0, modelServed, disagree, ...liveFields, ...retained });
      if (measuring) this.maybeRefer(text, cfg, base.ts, base.sha256, jev, base.detectorSignals);
      return merged ? { signals: merged.signals, jevUsed: merged.jevUsed } : null;
    } catch (err) {
      // Everything after the fetch is guarded (merge is pure, excerpt and referee
      // hand-off catch their own errors), so a throw here is the transport.
      return nc((err as Error)?.name === 'AbortError' ? 'timeout' : 'http-error');
    } finally {
      clearTimeout(timer);
      try {
        this.deps.metrics?.record({
          feature: JEV_SHADOW_FEATURE,
          kind: 'llm',
          outcome,
          tokensIn,
          tokensOut: 0, // TypeSafe does not bill output tokens
          latencyMs: (this.deps.now ?? Date.now)() - t0,
          model: modelServed ?? model,
          framework: 'typesafe-api',
        });
      } catch { /* @silent-fallback-ok — metering must never break the instrument */ }
    }
  }

  /** Retained-excerpt volume counter, keyed by UTC day. In-memory: it resets on
   *  restart, so it bounds VOLUME rather than acting as a secrecy guarantee —
   *  secrecy is carried by span-anchoring (never the whole message) plus the
   *  scrub, both of which hold per-excerpt regardless of this count. */
  private excerptDay = '';
  private excerptCount = 0;

  /**
   * Build a scrubbed excerpt anchored to the detector spans of the DISAGREEING
   * rules only. Where the detector fired and the model did not, the spans point
   * at the disputed artifact. Where the model fired and the detector did NOT,
   * there is no span to anchor to — and rather than widen the window to the
   * message, the row honestly records `no-detector-span`.
   */
  private buildExcerpt(
    text: string,
    signals: ReturnType<typeof detectGateSignals>,
    disagree: string[],
    cfg: JevSignalShadowConfig,
    ts: string,
  ): { excerpt?: string; excerptRedactions?: number; excerptUnavailable?: 'no-detector-span' | 'daily-cap' | 'scrub-error' } {
    try {
      const day = ts.slice(0, 10);
      if (this.excerptDay !== day) { this.excerptDay = day; this.excerptCount = 0; }
      const cap = typeof cfg.maxExcerptsPerDay === 'number' && cfg.maxExcerptsPerDay >= 0
        ? cfg.maxExcerptsPerDay
        : EXCERPT_DAILY_CAP;
      if (this.excerptCount >= cap) return { excerptUnavailable: 'daily-cap' };

      const kinds = new Set(
        disagree
          .map((rule) => SHADOW_QUESTIONS.find((q) => q.rule === rule)?.signalKind)
          .filter((k): k is string => typeof k === 'string'),
      );
      const spans = signals
        .filter((sig) => kinds.has(sig.kind))
        .flatMap((sig) => sig.spans ?? [])
        .map((sp) => ({
          start: Math.max(0, sp.start - EXCERPT_CONTEXT_CHARS),
          end: Math.min(text.length, sp.end + EXCERPT_CONTEXT_CHARS),
        }))
        .sort((a, b) => a.start - b.start);
      if (spans.length === 0) return { excerptUnavailable: 'no-detector-span' };

      // Merge overlaps so context is not duplicated, then clamp the total.
      const merged: Array<{ start: number; end: number }> = [];
      for (const sp of spans) {
        const last = merged[merged.length - 1];
        if (last && sp.start <= last.end) last.end = Math.max(last.end, sp.end);
        else merged.push({ ...sp });
      }
      let out = '';
      for (const sp of merged) {
        if (out.length >= EXCERPT_MAX_CHARS) break;
        const piece = text.slice(sp.start, sp.end);
        out += (out ? ' … ' : '') + piece;
      }
      out = out.slice(0, EXCERPT_MAX_CHARS);

      const scrubbed = scrubForStore(out);
      if (scrubbed.error) return { excerptUnavailable: 'scrub-error' };
      this.excerptCount++;
      return {
        excerpt: scrubbed.text,
        ...(scrubbed.redactions.length > 0 ? { excerptRedactions: scrubbed.redactions.length } : {}),
      };
    } catch {
      // @silent-fallback-ok — retention is observability; it must never cost a comparison row.
      return { excerptUnavailable: 'scrub-error' };
    }
  }

  private refereeInFlight = false;
  private refereeDay = '';
  private refereeCount = 0;
  /** Test seam: resolves when the detached referee call (if any) settles. */
  lastReferee: Promise<void> = Promise.resolve();

  /**
   * Detached, never awaited by dispatch: the referee is slower than Jev (a
   * model call, seconds), and holding the Jev in-flight slot for it would turn
   * referee latency into lost Jev comparisons. One referee call at a time; a
   * candidate that arrives while one runs is recorded as `busy`, so coverage
   * loss is visible rather than silent.
   */
  private maybeRefer(
    text: string,
    cfg: JevSignalShadowConfig,
    ts: string,
    sha256: string,
    jev: Record<string, number>,
    detectorSignals: string[],
  ): void {
    const rc = cfg.referee;
    if (!rc || rc.enabled !== true || !this.deps.referee) return;
    const escalated = selectEscalations(jev, { band: rc.band, bands: rc.bands, auditRate: rc.auditRate, random: this.deps.random });
    const rules = Object.keys(escalated);
    if (rules.length === 0) return;
    const jevSub: Record<string, number> = {};
    const detector: Record<string, boolean> = {};
    for (const rule of rules) {
      jevSub[rule] = jev[rule];
      const kind = SHADOW_QUESTIONS.find((q) => q.rule === rule)?.signalKind;
      detector[rule] = !!kind && detectorSignals.includes(kind);
    }
    const base = { kind: 'referee' as const, ts, sha256, escalated, jev: jevSub, detector };
    const day = ts.slice(0, 10);
    if (this.refereeDay !== day) { this.refereeDay = day; this.refereeCount = 0; }
    const cap = typeof rc.maxPerDay === 'number' && rc.maxPerDay >= 0 ? rc.maxPerDay : REFEREE_DAILY_CAP;
    if (this.refereeCount >= cap) { this.write({ ...base, reason: 'daily-cap' }); return; }
    if (this.refereeInFlight) { this.write({ ...base, reason: 'busy' }); return; }
    // Secrets are scrubbed before the text leaves the machine for the referee.
    const scrubbed = scrubForStore(text);
    if (scrubbed.error) { this.write({ ...base, reason: 'scrub-error' }); return; }
    this.refereeCount++;
    this.refereeInFlight = true;
    const questions = SHADOW_QUESTIONS.filter((q) => rules.includes(q.rule)).map((q) => ({ rule: q.rule, instructions: q.instructions }));
    this.lastReferee = askReferee(this.deps.referee, scrubbed.text, questions, {
      timeoutMs: rc.timeoutMs,
      component: JEV_REFEREE_COMPONENT,
      now: this.deps.now,
    })
      .then((out) => {
        if (out.ok) this.write({ ...base, referee: out.answers, model: out.model, ms: out.ms });
        else this.write({ ...base, reason: out.reason, model: out.model, ms: out.ms });
      })
      .catch(() => { /* @silent-fallback-ok — askReferee never throws; a throw here only means the row write failed */ })
      .finally(() => { this.refereeInFlight = false; });
  }

  private write(row: ShadowRow): void {
    try {
      fs.mkdirSync(path.dirname(this.deps.logPath), { recursive: true });
      fs.appendFileSync(this.deps.logPath, JSON.stringify(row) + '\n');
    } catch {
      // @silent-fallback-ok — an unwritable research log loses rows, never messages.
    }
  }
}

/** True while the shadow itself is measuring: enabled and inside its soak window. */
function shadowMeasuring(cfg: JevSignalShadowConfig, nowMs: number): boolean {
  const endsAt = cfg.soakEndsAt ? Date.parse(cfg.soakEndsAt) : NaN;
  return cfg.enabled === true && Number.isFinite(endsAt) && nowMs < endsAt;
}

/** The plain detector path, for every live fallback. Never throws. */
function detectorOnly(text: string): LiveSignalsResult {
  try {
    return { signals: detectGateSignals(text), jevUsed: false };
  } catch {
    // @silent-fallback-ok — detectGateSignals already contains its own throws; this only guards the impossible.
    return { signals: [], jevUsed: false };
  }
}

/**
 * Merge Jev's answers into the detector signals (docs/specs/jev-signal-live.md).
 * Per kind:
 *   - Jev confident YES (p > band.hi): detected. The detector's signal is kept
 *     (its spans + sample still anchor the judge); if the detector missed it, a
 *     sample-less model signal is added.
 *   - Jev confident NO (p < band.lo) against a detector match: the detection
 *     STANDS (detected:true, so every B1–B7 rule can still fire on it) and is
 *     annotated with Jev's disagreement for the judge to weigh. Jev never hides
 *     or overrides an observation; it can only add to or comment on the list.
 *   - Unsure or no answer: the detector's output, unchanged.
 * Pure. Output order follows GATE_SIGNAL_KINDS.
 */
export function mergeLiveSignals(
  detected: GateSignal[],
  jev: Record<string, number>,
  opts: { band?: CascadeBand; bands?: Record<string, CascadeBand> } = {},
): { signals: GateSignal[]; sources: Record<string, LiveSource>; jevUsed: boolean } {
  const byKind = new Map<GateSignalKind, GateSignal>();
  for (const sig of detected) if (sig.detected) byKind.set(sig.kind, sig);
  const signals: GateSignal[] = [];
  const sources: Record<string, LiveSource> = {};
  for (const kind of GATE_SIGNAL_KINDS) {
    const rule = SHADOW_QUESTIONS.find((q) => q.signalKind === kind)?.rule;
    const det = byKind.get(kind);
    const p = rule ? jev[rule] : undefined;
    const band = rule ? bandFor(rule, opts) : undefined;
    const confident = typeof p === 'number' && Number.isFinite(p) && !!band && (p < band.lo || p > band.hi);
    if (!rule || !confident) {
      if (rule) sources[rule] = 'detector-fallback';
      if (det) signals.push(det.source ? det : { ...det, source: 'detector' });
      continue;
    }
    const prob = Math.max(0, Math.min(1, p as number));
    if (prob > band!.hi) {
      sources[rule] = 'jev';
      signals.push(det ? { ...det, source: 'jev', modelProbability: prob } : { kind, detected: true, source: 'jev', modelProbability: prob });
    } else if (det) {
      sources[rule] = 'disputed';
      signals.push({ ...det, source: 'detector', modelProbability: prob });
    } else {
      sources[rule] = 'jev';
    }
  }
  // Nothing Jev-sourced reached the list (all unsure, or only agreed "nothing
  // here") ⇒ hand back the detector list untouched, so the prompt and its
  // promptId stay exactly today's.
  const jevUsed = signals.some((sig) => sig.modelProbability !== undefined);
  return jevUsed ? { signals, sources, jevUsed } : { signals: detected, sources, jevUsed };
}

/**
 * The production wiring, shared by server.ts and the E2E test so the test
 * exercises the same config resolution, key lookup and log location the server
 * uses. The live `intelligence` block wins; the boot config is the fallback.
 */
export function buildJevSignalShadow(opts: {
  readLiveIntelligence: () => unknown;
  bootBlock?: JevSignalShadowConfig;
  readSecret: (name: string) => unknown;
  stateDir: string;
  metrics?: JevSignalShadowDeps['metrics'];
  fetchImpl?: typeof fetch;
  referee?: IntelligenceProvider | null;
  /** Boot-time `intelligence.jevSignalLive`, the fallback when the live read has none. */
  bootLiveBlock?: JevSignalLiveConfig;
  /** The agent's `developmentAgent` flag — decides live mode when `enabled` is omitted. */
  developmentAgent?: boolean;
  /**
   * Is decision-quality recording live? The outbound route hardens a migration
   * advisory into a non-overridable hold when it is not, so live mode is off
   * then. Default: the real recorder's answer.
   */
  recordingLive?: () => boolean;
}): JevSignalShadow {
  const liveBlock = <K extends 'jevSignalShadow' | 'jevSignalLive'>(key: K): unknown => {
    const intel = opts.readLiveIntelligence();
    const block = intel && typeof intel === 'object' ? (intel as Record<string, unknown>)[key] : undefined;
    return block && typeof block === 'object' ? block : undefined;
  };
  return new JevSignalShadow({
    getConfig: () => (liveBlock('jevSignalShadow') ?? opts.bootBlock) as JevSignalShadowConfig | undefined,
    getLiveConfig: () => {
      const block = (liveBlock('jevSignalLive') ?? opts.bootLiveBlock ?? {}) as JevSignalLiveConfig;
      // Dev-gated: an omitted `enabled` is live on a development agent, dark on the fleet.
      // And never while decision-quality recording is off (the route would harden the advisory).
      const gated = resolveDevAgentGate(typeof block.enabled === 'boolean' ? block.enabled : undefined, { developmentAgent: opts.developmentAgent });
      return { ...block, enabled: gated && (opts.recordingLive ?? decisionQualityRecordingLive)() };
    },
    readKey: () => {
      const v = opts.readSecret('typesafe_api_key');
      return typeof v === 'string' && v ? v : null;
    },
    logPath: path.join(opts.stateDir, '..', 'logs', 'jev-signal-shadow.jsonl'),
    metrics: opts.metrics,
    fetchImpl: opts.fetchImpl,
    referee: opts.referee ?? null,
  });
}
