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
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { detectGateSignals } from './GateSignalDetectors.js';

export const JEV_SHADOW_FEATURE = 'jev-signal-shadow';
const ENDPOINT = 'https://api.typesafe.ai/v1/systemone';

export interface JevSignalShadowConfig {
  enabled?: boolean;
  sampleRate?: number;
  model?: string;
  timeoutMs?: number;
  /** ISO instant; the shadow is inert at or after it, and when absent. */
  soakEndsAt?: string | null;
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
  | 'soak-expired';

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
    }
  | { kind: 'not-compared'; ts: string; sha256: string; bytes: number; reason: NotComparedReason };

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
/** Minimum spacing between key re-reads after a miss or a 401/403 (bounds any blocking lookup). */
export const KEY_REREAD_MS = 10 * 60_000;

export interface JevSignalShadowDeps {
  /** Live config read — called per candidate so the kill-switch needs no restart. */
  getConfig: () => JevSignalShadowConfig | undefined;
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
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
  now?: () => number;
  random?: () => number;
  maxScanBytes?: number;
}

export class JevSignalShadow {
  private inFlight = false;
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
    if (this.inFlight) { notCompared('skipped-concurrent'); return; }

    const detectorSignals = detectGateSignals(text).map((s) => s.kind);
    this.inFlight = true;
    this.lastDispatch = this.dispatch(text, cfg, { ts, sha256, bytes, detectorSignals })
      .catch(() => { /* @silent-fallback-ok — dispatch records its own reason rows; a throw here only means the row write failed */ })
      .finally(() => { this.inFlight = false; });
  }

  private async dispatch(
    text: string,
    cfg: JevSignalShadowConfig,
    base: { ts: string; sha256: string; bytes: number; detectorSignals: string[] },
  ): Promise<void> {
    const model = cfg.model || 'jev-1.13.0';
    const timeoutMs = typeof cfg.timeoutMs === 'number' && cfg.timeoutMs > 0 ? cfg.timeoutMs : 1500;
    const questions = Object.fromEntries(SHADOW_QUESTIONS.map((q) => [q.rule, { type: 'noul', instructions: q.instructions }]));
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const t0 = (this.deps.now ?? Date.now)();
    const nc = (reason: NotComparedReason) => this.write({ kind: 'not-compared', ts: base.ts, sha256: base.sha256, bytes: base.bytes, reason });
    let tokensIn: number | undefined;
    let outcome: 'fired' | 'noop' | 'error' = 'error';
    let modelServed: string | undefined;
    try {
      const res = await (this.deps.fetchImpl ?? fetch)(ENDPOINT, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.cachedKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ state: text, model, questions }),
        signal: ctrl.signal,
      });
      if (!res.ok) {
        if (res.status === 401 || res.status === 403) { this.cachedKey = null; this.keyReadAt = (this.deps.now ?? Date.now)(); } // re-read after KEY_REREAD_MS, never per message
        nc('http-error');
        return;
      }
      const json = (await res.json()) as { model?: string; answers?: Record<string, { noul?: number }>; usage?: { input_tokens?: number } };
      modelServed = typeof json.model === 'string' ? json.model : undefined;
      tokensIn = json.usage?.input_tokens;
      if (modelServed !== model) { nc('model-mismatch'); return; }
      const jev: Record<string, number> = {};
      const disagree: string[] = [];
      for (const q of SHADOW_QUESTIONS) {
        const p = json.answers?.[q.rule]?.noul;
        if (typeof p !== 'number') continue;
        jev[q.rule] = p;
        const jevSays = p > POSITIVE_THRESHOLD;
        const detectorSays = base.detectorSignals.includes(q.signalKind);
        if (jevSays !== detectorSays) disagree.push(q.rule);
      }
      outcome = disagree.length ? 'fired' : 'noop';
      this.write({ kind: 'compared', ...base, jev, ms: (this.deps.now ?? Date.now)() - t0, modelServed, disagree });
    } catch (err) {
      nc((err as Error)?.name === 'AbortError' ? 'timeout' : 'http-error');
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

  private write(row: ShadowRow): void {
    try {
      fs.mkdirSync(path.dirname(this.deps.logPath), { recursive: true });
      fs.appendFileSync(this.deps.logPath, JSON.stringify(row) + '\n');
    } catch {
      // @silent-fallback-ok — an unwritable research log loses rows, never messages.
    }
  }
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
}): JevSignalShadow {
  return new JevSignalShadow({
    getConfig: () => {
      const intel = opts.readLiveIntelligence();
      const block = intel && typeof intel === 'object' ? (intel as { jevSignalShadow?: unknown }).jevSignalShadow : undefined;
      return (block && typeof block === 'object' ? block : opts.bootBlock) as JevSignalShadowConfig | undefined;
    },
    readKey: () => {
      const v = opts.readSecret('typesafe_api_key');
      return typeof v === 'string' && v ? v : null;
    },
    logPath: path.join(opts.stateDir, '..', 'logs', 'jev-signal-shadow.jsonl'),
    metrics: opts.metrics,
    fetchImpl: opts.fetchImpl,
  });
}
