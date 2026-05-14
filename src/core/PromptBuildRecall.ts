/**
 * PromptBuildRecall — bounded pre-reply memory recall, imported from OpenClaw's
 * `before_prompt_build` hook pattern.
 *
 * OpenClaw's active-memory plugin runs a recall pass before every eligible
 * prompt and injects the result as a system-prompt prefix. The shape Instar
 * adopts here:
 *
 *   1. A typed primitive (`PromptBuildRecall.recall()`) that takes the user's
 *      message + a session id, returns a context-text string to inject.
 *   2. Bounded blast radius: result is capped at `maxRecallChars` (default
 *      1200), pulls at most `maxRecallResults` entries (default 5).
 *   3. Per-call timeout (default 2000 ms — the recall runs synchronously inside
 *      a Claude Code UserPromptSubmit hook, so it must be fast).
 *   4. Cache: identical (user-message, agent) pairs dedupe with a `cacheTtlMs`
 *      window (default 15 s). Repeated rapid prompts don't re-search.
 *   5. Circuit breaker: after `circuitBreakerMaxFailures` consecutive errors
 *      (default 3) the breaker opens for `circuitBreakerCooldownMs` (default
 *      60 s) and recall short-circuits to empty.
 *   6. Tool allowlist: the OpenClaw pattern restricts the recall sub-agent to
 *      `[memory_recall, memory_search, memory_get]`. Here there's no
 *      sub-agent — recall calls `SemanticMemory.search` directly. Implicit
 *      allowlist: read-only memory queries, never anything else.
 *
 * Spec: docs/specs/OPENCLAW-IMPORT-BEFORE-PROMPT-BUILD-SPEC.md.
 */

import crypto from 'node:crypto';
import type { SemanticMemory } from '../memory/SemanticMemory.js';

export interface PromptBuildRecallConfig {
  enabled: boolean;
  /** Hard cap on the size of the injected context block. Default 1200. */
  maxRecallChars: number;
  /** Hard cap on the number of memory entries pulled. Default 5. */
  maxRecallResults: number;
  /** TTL for the in-process recall cache. Default 15 000 ms. */
  cacheTtlMs: number;
  /** Consecutive failures before the circuit opens. Default 3. */
  circuitBreakerMaxFailures: number;
  /** Cooldown after the circuit opens. Default 60 000 ms. */
  circuitBreakerCooldownMs: number;
  /** Per-call timeout in ms. Default 2 000 ms. Recall is on the hot path. */
  recallTimeoutMs: number;
  /** Minimum confidence filter passed to SemanticMemory.search. Default 0.5. */
  minConfidence: number;
}

export const DEFAULT_PROMPT_BUILD_RECALL_CONFIG: PromptBuildRecallConfig = {
  enabled: false,
  maxRecallChars: 1200,
  maxRecallResults: 5,
  cacheTtlMs: 15_000,
  circuitBreakerMaxFailures: 3,
  circuitBreakerCooldownMs: 60_000,
  recallTimeoutMs: 2_000,
  minConfidence: 0.5,
};

export interface PromptBuildRecallDeps {
  semanticMemory: SemanticMemory | null;
  now?: () => number;
}

export type PromptBuildRecallSource =
  | 'fresh'
  | 'cached'
  | 'disabled'
  | 'no-memory'
  | 'circuit-open'
  | 'timeout'
  | 'empty'
  | 'error';

export interface PromptBuildRecallResult {
  contextText: string;
  source: PromptBuildRecallSource;
  elapsedMs: number;
  resultsCount: number;
  cacheKey: string;
}

interface CacheEntry {
  value: PromptBuildRecallResult;
  expiresAt: number;
}

interface CircuitState {
  consecutiveFailures: number;
  openUntil: number;
}

export class PromptBuildRecall {
  private readonly deps: PromptBuildRecallDeps;
  private readonly config: PromptBuildRecallConfig;
  private readonly cache = new Map<string, CacheEntry>();
  private circuit: CircuitState = { consecutiveFailures: 0, openUntil: 0 };

  constructor(deps: PromptBuildRecallDeps, config: PromptBuildRecallConfig) {
    this.deps = deps;
    this.config = config;
  }

  /**
   * Run a recall pass for a user message. Returns the context-text to inject
   * into the system prompt (or empty string if nothing useful surfaces).
   *
   * Synchronous because the caller (UserPromptSubmit hook) blocks on the
   * response. The recall path itself uses sqlite-backed SemanticMemory which
   * is fast and synchronous; the only "async" guard is the timeout, which is
   * enforced by checking elapsed time after the search.
   */
  recall(opts: { userMessage: string; sessionId?: string }): PromptBuildRecallResult {
    const start = this.now();
    const cacheKey = this.makeCacheKey(opts);

    if (!this.config.enabled) {
      return { contextText: '', source: 'disabled', elapsedMs: 0, resultsCount: 0, cacheKey };
    }

    // Cache hit?
    const cached = this.cache.get(cacheKey);
    if (cached && cached.expiresAt > start) {
      return { ...cached.value, source: 'cached', elapsedMs: this.now() - start };
    }

    // Circuit breaker open?
    if (this.circuit.openUntil > start) {
      return { contextText: '', source: 'circuit-open', elapsedMs: 0, resultsCount: 0, cacheKey };
    }

    if (!this.deps.semanticMemory) {
      return { contextText: '', source: 'no-memory', elapsedMs: 0, resultsCount: 0, cacheKey };
    }

    let entries: Array<{ name: string; description?: string; confidence?: number }> = [];
    try {
      const raw = this.deps.semanticMemory.search(opts.userMessage, {
        limit: this.config.maxRecallResults,
        minConfidence: this.config.minConfidence,
      });
      entries = raw as typeof entries;
      this.circuit.consecutiveFailures = 0;
    } catch {
      this.circuit.consecutiveFailures++;
      if (this.circuit.consecutiveFailures >= this.config.circuitBreakerMaxFailures) {
        this.circuit.openUntil = start + this.config.circuitBreakerCooldownMs;
      }
      return { contextText: '', source: 'error', elapsedMs: this.now() - start, resultsCount: 0, cacheKey };
    }

    const elapsed = this.now() - start;
    if (elapsed > this.config.recallTimeoutMs) {
      return { contextText: '', source: 'timeout', elapsedMs: elapsed, resultsCount: 0, cacheKey };
    }

    if (entries.length === 0) {
      const result: PromptBuildRecallResult = { contextText: '', source: 'empty', elapsedMs: elapsed, resultsCount: 0, cacheKey };
      this.cache.set(cacheKey, { value: result, expiresAt: start + this.config.cacheTtlMs });
      return result;
    }

    const contextText = this.formatContextBlock(entries);
    const result: PromptBuildRecallResult = {
      contextText,
      source: 'fresh',
      elapsedMs: elapsed,
      resultsCount: entries.length,
      cacheKey,
    };
    this.cache.set(cacheKey, { value: result, expiresAt: start + this.config.cacheTtlMs });
    return result;
  }

  /**
   * Format the recall context block. Capped at `maxRecallChars`. Each entry
   * gets a single line: "- <name>: <description-first-line>". Entries are
   * dropped (not truncated) if adding them would exceed the cap.
   */
  private formatContextBlock(
    entries: Array<{ name: string; description?: string; confidence?: number }>,
  ): string {
    const header = '<active_memory_recall>';
    const footer = '</active_memory_recall>';
    const lines: string[] = [header];
    let used = header.length + footer.length + 2; // \n boundaries
    for (const entry of entries) {
      const desc = (entry.description ?? '').split('\n')[0].trim();
      const line = desc ? `- ${entry.name}: ${desc}` : `- ${entry.name}`;
      if (used + line.length + 1 > this.config.maxRecallChars) break;
      lines.push(line);
      used += line.length + 1;
    }
    lines.push(footer);
    return lines.join('\n');
  }

  private makeCacheKey(opts: { userMessage: string; sessionId?: string }): string {
    const normalized = opts.userMessage.trim().toLowerCase().slice(0, 500);
    return crypto.createHash('sha1').update(normalized).digest('hex').slice(0, 16);
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  /** Test hook: inspect the cache without exporting Map. */
  getCacheSize(): number {
    return this.cache.size;
  }

  /** Test hook: inspect the circuit. */
  getCircuitState(): Readonly<CircuitState> {
    return { ...this.circuit };
  }

  /** Test hook: clear cache and circuit. */
  reset(): void {
    this.cache.clear();
    this.circuit = { consecutiveFailures: 0, openUntil: 0 };
  }
}
