/**
 * Last-resort model for the subscription sign-in repair (spec relogin-last-resort-model).
 *
 * The repair's two model calls (the Tier-1 step supervisor and the agent navigator) normally run
 * on the agent's shared internal intelligence, which is a subscription CLI (`claude -p` /
 * `codex exec`). On an agent with ONE subscription, that CLI runs on the very login that is
 * dead, so the repair of the only account can never get a model answer; and on the
 * agent-session path there is no other healthy account to run the helper on either. The
 * operator then has to finish every expired sign-in by hand.
 *
 * This module is a narrowly scoped alternative: the lightweight (haiku) tier over an Anthropic
 * API key the operator placed in the vault UNDER A REPAIR-SPECIFIC NAME. Placing the key under
 * that name is the consent to spend; nothing here reads `ANTHROPIC_API_KEY` or the general
 * `intelligenceProvider` setting, and the subscription-by-default rule for every other LLM
 * call is untouched. It is used only after the primary provider failed (or is absent), only
 * for the repair's own calls, and only within per-drive and per-day call caps.
 *
 * The inference itself goes through the anthropic-headless adapter's one-shot transport (the
 * repo's chokepoint for key-authenticated Claude calls): `claude -p` with the key in the
 * CHILD's environment only, in a DEDICATED EMPTY config home under the state dir, so the dead
 * subscription login in the ambient home can never be what the CLI picks up. Every call is
 * recorded on the feature-metrics ledger (Token-Audit Completeness) under the caller's
 * attribution, framework `anthropic-api-key`.
 *
 * It decides NOTHING about the repair's success: the orchestrator's arbiter (completed login,
 * verified identity, an authenticated call) is unchanged. The key never leaves this module:
 * status and errors carry an error name, never the key or the prompt.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { IntelligenceOptions, IntelligenceProvider } from './types.js';
import type { AnthropicHeadlessConfig } from '../providers/adapters/anthropic-headless/config.js';
import type { OneShotCompletion } from '../providers/primitives/transport/oneShotCompletion.js';
import { getFeatureMetricsRecorder } from './CircuitBreakingIntelligenceProvider.js';

export const RELOGIN_LAST_RESORT_DEFAULT_KEY_NAME = 'relogin_last_resort_anthropic_api_key';
export type ReloginLastResortModelTier = 'fast' | 'balanced' | 'capable';
export const RELOGIN_LAST_RESORT_DEFAULT_MODEL: ReloginLastResortModelTier = 'fast';
/** The framework label the ledger shows for these calls (Observable Intelligence). */
export const RELOGIN_LAST_RESORT_FRAMEWORK = 'anthropic-api-key';
const DEFAULT_FEATURE = 'subscription-relogin-last-resort';
const DEFAULT_MAX_CALLS_PER_DRIVE = 60;
const DEFAULT_MAX_CALLS_PER_DAY = 300;
const DEFAULT_TIMEOUT_MS = 30_000;
const KEY_NAME_RE = /^[a-z0-9_]{1,80}$/;
const MODEL_TIERS: ReadonlySet<string> = new Set(['fast', 'balanced', 'capable']);
const CONFIG_HOME_DIRNAME = 'relogin-last-resort-claude-home';

export interface ReloginLastResortConfigInput {
  enabled?: boolean;
  keyName?: string;
  /** Model tier; the lightweight `fast` (haiku) tier by default. */
  model?: string;
  maxCallsPerDrive?: number;
  maxCallsPerDay?: number;
}

export interface ReloginLastResortConfig {
  enabled: boolean;
  keyName: string;
  model: ReloginLastResortModelTier;
  maxCallsPerDrive: number;
  maxCallsPerDay: number;
}

/** Absent ⇒ enabled, the repair-specific key name, the fast tier, 60 calls per drive, 300 per day. */
export function resolveReloginLastResortConfig(input: ReloginLastResortConfigInput | undefined): ReloginLastResortConfig {
  const keyName = typeof input?.keyName === 'string' && KEY_NAME_RE.test(input.keyName)
    ? input.keyName : RELOGIN_LAST_RESORT_DEFAULT_KEY_NAME;
  const model = typeof input?.model === 'string' && MODEL_TIERS.has(input.model)
    ? input.model as ReloginLastResortModelTier : RELOGIN_LAST_RESORT_DEFAULT_MODEL;
  return {
    enabled: input?.enabled !== false,
    keyName,
    model,
    maxCallsPerDrive: positiveInt(input?.maxCallsPerDrive, DEFAULT_MAX_CALLS_PER_DRIVE),
    maxCallsPerDay: positiveInt(input?.maxCallsPerDay, DEFAULT_MAX_CALLS_PER_DAY),
  };
}

export interface ReloginLastResortStatus {
  available: true;
  keyName: string;
  model: ReloginLastResortModelTier;
  callsToday: number;
  maxCallsPerDay: number;
  callsThisDrive: number;
  maxCallsPerDrive: number;
  driveEpisodeId: string | null;
  /** True once this drive's calls are answered here without trying the shared model first. */
  preferredThisDrive: boolean;
  lastUsedAt: string | null;
  /** The last failure as an error name/class. Never the key, never a prompt. */
  lastError: string | null;
  /** How many calls the caps refused, since the process started. */
  capRefusals: number;
}

export interface ReloginLastResortDeps {
  config: ReloginLastResortConfigInput | undefined;
  /** Reads a vault secret by name; non-string ⇒ no key. Read lazily, per call. */
  readSecret: (name: string) => unknown;
  /** The `claude` binary the one-shot runs. */
  claudePath: string;
  /** Required by the adapter config shape; unused by one-shot calls. */
  tmuxPath: string;
  /** The agent state dir; the dedicated empty config home lives under it. */
  stateDir: string;
  /** Test seam: the adapter's one-shot transport factory. Production: `createOneShotCompletion`. */
  createCompletion: (config: AnthropicHeadlessConfig) => OneShotCompletion;
  now?: () => number;
}

/**
 * The provider itself. `available()` is live: it is true only while the vault holds a string
 * under the configured name, so removing the key turns the path off without a restart.
 */
export class ReloginLastResortProvider implements IntelligenceProvider {
  readonly config: ReloginLastResortConfig;
  readonly configHome: string;
  private readonly now: () => number;
  private dayKey = '';
  private callsToday = 0;
  private callsThisDrive = 0;
  private driveEpisodeId: string | null = null;
  private answeredThisDrive = false;
  private lastUsedAt: string | null = null;
  private lastError: string | null = null;
  private capRefusals = 0;

  constructor(private readonly deps: ReloginLastResortDeps) {
    this.config = resolveReloginLastResortConfig(deps.config);
    this.configHome = path.join(deps.stateDir, CONFIG_HOME_DIRNAME);
    this.now = deps.now ?? Date.now;
  }

  /** Enabled AND a string key is in the vault right now. */
  available(): boolean {
    if (!this.config.enabled) return false;
    return typeof this.readKey() === 'string';
  }

  /**
   * Sticky within a drive: once this provider answered a call of the current drive, the shared
   * model is skipped for the rest of that drive (second-pass finding: a dead login that HANGS
   * rather than fails would otherwise cost a timeout on every step and eat the drive deadline).
   * Reset by `beginDrive` / `endDrive`; outside a drive every call tries the primary first.
   */
  preferred(): boolean {
    return this.driveEpisodeId !== null && this.answeredThisDrive && this.available();
  }

  /** Opens the per-drive budget for one repair drive. One drive runs at a time (seat lease). */
  beginDrive(episodeId: string): void {
    this.driveEpisodeId = episodeId;
    this.callsThisDrive = 0;
    this.answeredThisDrive = false;
  }

  endDrive(episodeId: string): void {
    if (this.driveEpisodeId !== episodeId) return;
    this.driveEpisodeId = null;
    this.callsThisDrive = 0;
    this.answeredThisDrive = false;
  }

  status(): ReloginLastResortStatus {
    this.rollDay();
    return {
      available: true, keyName: this.config.keyName, model: this.config.model,
      callsToday: this.callsToday, maxCallsPerDay: this.config.maxCallsPerDay,
      callsThisDrive: this.callsThisDrive, maxCallsPerDrive: this.config.maxCallsPerDrive,
      driveEpisodeId: this.driveEpisodeId, preferredThisDrive: this.driveEpisodeId !== null && this.answeredThisDrive,
      lastUsedAt: this.lastUsedAt, lastError: this.lastError, capRefusals: this.capRefusals,
    };
  }

  async evaluate(prompt: string, options: IntelligenceOptions = {}): Promise<string> {
    if (!this.config.enabled) throw new Error('relogin-last-resort-disabled');
    const key = this.readKey();
    if (typeof key !== 'string') throw new Error('relogin-last-resort-key-missing');
    this.rollDay();
    if (this.callsToday >= this.config.maxCallsPerDay) {
      this.capRefusals += 1;
      throw new Error('relogin-last-resort-daily-cap-reached');
    }
    if (this.driveEpisodeId !== null && this.callsThisDrive >= this.config.maxCallsPerDrive) {
      this.capRefusals += 1;
      throw new Error('relogin-last-resort-drive-cap-reached');
    }
    this.callsToday += 1;
    if (this.driveEpisodeId !== null) this.callsThisDrive += 1;
    const startedAt = this.now();
    this.lastUsedAt = new Date(startedAt).toISOString();

    try { fs.mkdirSync(this.configHome, { recursive: true, mode: 0o700 }); }
    catch { /* @silent-fallback-ok — the one-shot fails loudly below if the home is unusable */ }
    const completion = this.deps.createCompletion({
      claudePath: this.deps.claudePath, tmuxPath: this.deps.tmuxPath,
      credential: key, defaultModel: this.config.model,
      defaultOneShotTimeoutMs: Math.max(1_000, options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      configDir: this.configHome,
    });
    const feature = options.attribution?.component ?? DEFAULT_FEATURE;
    try {
      // The tier is this provider's own (lightweight by design): a caller's `balanced` request
      // is not honored here, the whole point is a cheap last resort.
      const result = await completion.evaluate(prompt, {
        model: this.config.model, signal: options.signal,
        ...(typeof options.maxTokens === 'number' ? { maxTokens: options.maxTokens } : {}),
        ...(typeof options.temperature === 'number' ? { temperature: options.temperature } : {}),
      });
      const text = result.text.trim();
      if (text.length === 0) { this.lastError = 'empty-answer'; throw new Error('relogin-last-resort-empty-answer'); }
      this.lastError = null;
      if (this.driveEpisodeId !== null) this.answeredThisDrive = true;
      this.recordMetric(feature, 'unclassified', startedAt, result.usage);
      return text;
    } catch (error) {
      this.recordMetric(feature, 'error', startedAt, null);
      if (error instanceof Error && error.message.startsWith('relogin-last-resort-')) throw error;
      const name = error instanceof Error ? (error.name || 'Error') : 'Error';
      this.lastError = name;
      throw new Error(`relogin-last-resort-call-failed:${name}`);
    }
  }

  private recordMetric(feature: string, outcome: 'unclassified' | 'error', startedAt: number,
    usage: { inputTokens?: number; outputTokens?: number } | null): void {
    try {
      getFeatureMetricsRecorder()?.record({
        feature, kind: 'llm', outcome, latencyMs: Math.max(0, this.now() - startedAt),
        model: this.config.model, framework: RELOGIN_LAST_RESORT_FRAMEWORK,
        ...(typeof usage?.inputTokens === 'number' ? { tokensIn: usage.inputTokens } : {}),
        ...(typeof usage?.outputTokens === 'number' ? { tokensOut: usage.outputTokens } : {}),
      });
    } catch { /* @silent-fallback-ok — metrics never gate the repair */ }
  }

  private readKey(): unknown {
    try { return this.deps.readSecret(this.config.keyName); }
    catch { return undefined; } // @silent-fallback-ok — an unreadable vault is "no key", never a thrown boot
  }

  private rollDay(): void {
    const key = new Date(this.now()).toISOString().slice(0, 10);
    if (key !== this.dayKey) { this.dayKey = key; this.callsToday = 0; }
  }
}

/**
 * Builds the provider when the feature is on. Returns null only for `enabled: false`; a missing
 * key leaves the provider constructed but `available()` false, so a key added later is picked up
 * live.
 */
export function createReloginLastResort(deps: ReloginLastResortDeps): ReloginLastResortProvider | null {
  const config = resolveReloginLastResortConfig(deps.config);
  if (!config.enabled) return null;
  return new ReloginLastResortProvider(deps);
}

export type ReloginEvaluate = (prompt: string, options?: IntelligenceOptions) => Promise<string>;

export interface WithLastResortStats {
  primaryAnswered: number;
  lastResortAnswered: number;
  lastResortFailed: number;
  /** Calls that skipped the primary because the last resort was sticky for the drive. */
  primarySkipped: number;
}

export interface WithLastResortOptions {
  /** Timeout applied to the PRIMARY call only (the last resort keeps its own). */
  primaryTimeoutMs?: number;
}

/**
 * The repair's evaluate: the primary (shared) provider first; the last resort only when the
 * primary threw or there is none. Once the last resort is `preferred()` (sticky within a drive)
 * the primary is skipped. A last resort that is unavailable or capped rethrows the primary's
 * error, so the driver sees the same failure it would have seen before this existed.
 */
export function withLastResort(
  primary: ReloginEvaluate | null,
  lastResort: (Pick<ReloginLastResortProvider, 'available' | 'evaluate'> & { preferred?: () => boolean }) | null,
  onFallback?: (reason: string) => void,
  options: WithLastResortOptions = {},
): { evaluate: ReloginEvaluate; stats: () => WithLastResortStats } {
  const stats: WithLastResortStats = { primaryAnswered: 0, lastResortAnswered: 0, lastResortFailed: 0, primarySkipped: 0 };
  const evaluate: ReloginEvaluate = async (prompt, callOptions) => {
    let primaryError: unknown = new Error('relogin-primary-provider-absent');
    const sticky = lastResort?.preferred?.() === true;
    if (primary && !sticky) {
      try {
        const primaryOptions = typeof options.primaryTimeoutMs === 'number'
          ? { ...callOptions, timeoutMs: options.primaryTimeoutMs } : callOptions;
        const answer = await primary(prompt, primaryOptions);
        stats.primaryAnswered += 1;
        return answer;
      } catch (error) {
        if (callOptions?.signal?.aborted) throw error;
        primaryError = error;
      }
    } else if (primary && sticky) {
      stats.primarySkipped += 1;
      primaryError = new Error('relogin-primary-skipped-sticky-last-resort');
    }
    if (!lastResort || !lastResort.available()) throw primaryError;
    if (!sticky) onFallback?.(primaryError instanceof Error ? primaryError.message : String(primaryError));
    try {
      const answer = await lastResort.evaluate(prompt, callOptions);
      stats.lastResortAnswered += 1;
      return answer;
    } catch (error) {
      stats.lastResortFailed += 1;
      throw error;
    }
  };
  return { evaluate, stats: () => ({ ...stats }) };
}

function positiveInt(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : fallback;
}
