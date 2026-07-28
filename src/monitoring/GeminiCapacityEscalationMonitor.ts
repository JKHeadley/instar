/**
 * GeminiCapacityEscalationMonitor — observe-only escalation for LONG Gemini
 * capacity blocks.
 *
 * #708's gemini capacity policy correctly DEFERS calls when Gemini reports a
 * quota reset window (e.g. "retry after 46758s" → ~13h), refusing doomed
 * subprocesses until the window passes. But it only schedules/defers — it never
 * ESCALATES. A short defer (a few minutes) is fine to absorb silently; a
 * multi-HOUR block means the agent/mentee is invisibly unavailable for half a
 * day, which the operator should know about. Item-3's original intent was
 * "detect quota → schedule/retry/ESCALATE, not silently stall" — this closes the
 * missing escalate half.
 *
 * Design = observe-and-escalate (NOT a callback threaded into the two low-level
 * provider call sites): the deferral state is already a queryable module-global
 * via getGeminiCapacityGate(), so a monitor riding the existing cadence reads it
 * and raises ONE attention item per deferral episode. Observe-only — it never
 * mutates the gate, never blocks a call, never auto-recovers. Ships OFF.
 *
 * Mirrors ApprenticeshipCycleSlaMonitor: injectable clock + gate reader +
 * raiseAttention for testability, per-episode dedup, enabled gate.
 */

import {
  getGeminiCapacityGate,
  type GeminiCapacityGate,
} from '../providers/adapters/gemini-cli/observability/geminiCapacityPolicy.js';

export interface GeminiCapacityEscalationConfig {
  enabled?: boolean;
  /** Only escalate when the remaining defer window is at/above this. Default 60. */
  escalateAfterMinutes?: number;
}

export interface GeminiCapacityEscalationAttention {
  id: string;
  title: string;
  summary: string;
  category: string;
  priority: 'LOW' | 'NORMAL' | 'HIGH' | 'URGENT';
  sourceContext: string;
}

export interface GeminiCapacityEscalationMonitorOptions {
  config?: GeminiCapacityEscalationConfig;
  now?: () => number;
  /** Reads the live capacity gate. Defaults to the module-global getGeminiCapacityGate. */
  gateReader?: (now: number) => GeminiCapacityGate;
  raiseAttention?: (item: GeminiCapacityEscalationAttention) => Promise<unknown> | unknown;
}

export interface GeminiCapacityEscalationTickResult {
  enabled: boolean;
  blocked: boolean;
  remainingMs: number;
  escalated: boolean;
}

const DEFAULT_ESCALATE_AFTER_MINUTES = 60;

function normalizeMinutes(value: unknown): number {
  const n = typeof value === 'number' ? value : Number.NaN;
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_ESCALATE_AFTER_MINUTES;
  return Math.max(1, Math.floor(n));
}

export class GeminiCapacityEscalationMonitor {
  private readonly config: Required<GeminiCapacityEscalationConfig>;
  private readonly now: () => number;
  private readonly gateReader: (now: number) => GeminiCapacityGate;
  private readonly raiseAttention:
    | ((item: GeminiCapacityEscalationAttention) => Promise<unknown> | unknown)
    | null;
  /** The `deferredUntil` value of the episode we've already escalated (dedup key). */
  private escalatedEpisode: number | null = null;

  constructor(opts: GeminiCapacityEscalationMonitorOptions = {}) {
    this.config = {
      enabled: opts.config?.enabled === true,
      escalateAfterMinutes: normalizeMinutes(opts.config?.escalateAfterMinutes),
    };
    this.now = opts.now ?? (() => Date.now());
    this.gateReader = opts.gateReader ?? getGeminiCapacityGate;
    this.raiseAttention = opts.raiseAttention ?? null;
  }

  get enabled(): boolean {
    return this.config.enabled;
  }

  /** Live view: is Gemini currently capacity-blocked, and for how much longer. */
  status(): { blocked: boolean; remainingMs: number; deferredUntil: number | null; reason: string | null } {
    const gate = this.gateReader(this.now());
    return {
      blocked: !gate.allow,
      remainingMs: gate.allow ? 0 : Math.max(0, gate.retryAfterMs),
      deferredUntil: gate.deferredUntil,
      reason: gate.reason,
    };
  }

  async tick(): Promise<GeminiCapacityEscalationTickResult> {
    if (!this.config.enabled) {
      return { enabled: false, blocked: false, remainingMs: 0, escalated: false };
    }
    const gate = this.gateReader(this.now());

    // Not blocked → the episode (if any) is over; re-arm for the next one.
    if (gate.allow) {
      this.escalatedEpisode = null;
      return { enabled: true, blocked: false, remainingMs: 0, escalated: false };
    }

    const remainingMs = Math.max(0, gate.retryAfterMs);
    const thresholdMs = this.config.escalateAfterMinutes * 60_000;
    const longEnough = remainingMs >= thresholdMs;
    // Dedup per deferral episode, keyed on deferredUntil (a fresh defer → fresh key).
    const episodeKey = gate.deferredUntil ?? -1;
    const alreadyEscalated = this.escalatedEpisode === episodeKey;

    if (!longEnough || alreadyEscalated || !this.raiseAttention) {
      return { enabled: true, blocked: true, remainingMs, escalated: false };
    }

    this.escalatedEpisode = episodeKey;
    const remainingMin = Math.round(remainingMs / 60_000);
    const human = remainingMin >= 120 ? `${Math.round(remainingMin / 60)}h` : `${remainingMin}m`;
    await this.raiseAttention({
      id: `gemini-capacity-block-${episodeKey}`,
      title: 'Gemini capacity-blocked for an extended window',
      summary:
        `Gemini is quota/capacity-blocked and deferring all calls for ~${human} ` +
        `(threshold ${this.config.escalateAfterMinutes}m). The agent/mentee is effectively ` +
        `unavailable until the window resets. Reason: ${gate.reason ?? 'capacity exhausted'}.`,
      category: 'gemini-capacity',
      priority: remainingMin >= 120 ? 'HIGH' : 'NORMAL',
      sourceContext: 'gemini-capacity-escalation',
    });
    return { enabled: true, blocked: true, remainingMs, escalated: true };
  }
}
