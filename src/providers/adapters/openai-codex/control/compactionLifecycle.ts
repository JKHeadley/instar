/**
 * CompactionLifecycle implementation for openai-codex.
 *
 * Codex has NO native pre-compact hook (per the deep-dive §E). Codex
 * silently auto-compacts at `effective_window - 13k` tokens. This adapter
 * SYNTHESIZES the pre-compact signal by tracking
 * `turn.completed.usage.context_window_used` from the event stream and
 * emitting a notice when crossing a configurable threshold.
 *
 * hasNativePreCompactHook() returns FALSE. Capability flag
 * `PreCompactHook` is NOT declared for this adapter.
 *
 * RULE 3.1 RATIONALE
 *   Criticality: high (resume continuity, sentinel-state persistence)
 *   Frequency:   per-session (one notice per pre-compact threshold cross)
 *   Stability:   semi-stable (Codex's `effective_window - 13k` threshold can change)
 *   Fallback:    when usage is unavailable, no notice fires; consumer falls back to post-compact observation
 *   Verdict:     deterministic threshold tracking + canary verifying usage field parsing
 */

import { EventEmitter } from 'node:events';
import type { CancellationOptions, SessionHandle } from '../../../types.js';
import type {
  CompactionLifecycle,
  PreCompactNotice,
  PostCompactNotice,
} from '../../../primitives/control/compactionLifecycle.js';
import { CapabilityFlag } from '../../../capabilities.js';
import { UnsupportedCapabilityError } from '../../../errors.js';
import { OPENAI_CODEX_ID } from '../errors.js';

const preCompactEmitter = new EventEmitter();
const postCompactEmitter = new EventEmitter();

// Synthesis threshold: how full the context window can get before we emit
// a pre-compact notice. Codex auto-compacts near `effective_window - 13k`
// (measured 2026-11-10: compactions at 84-95% of a 258,400 window), so we
// emit our synthetic notice at 85% of the window.
const PRE_COMPACT_THRESHOLD_RATIO = 0.85;
const ASSUMED_CONTEXT_WINDOW = 200_000;

const lastNoticeBySession = new Set<SessionHandle>();

/**
 * Called with each usage reading (the rollout's `token_count` event, read by
 * the context-budget transcript channel; context-budget-layered-summaries
 * §9.6 "Compaction detection"). Emits ONE synthesized pre-compact notice per
 * compaction cycle when the context used crosses 85% of the window: the
 * engine-reported `model_context_window` when the rollout carries it, else
 * the assumed 200K. Re-armed by `emitPostCompactFromTranscript`.
 * Returns true when this call emitted the notice.
 */
export function trackContextUsage(session: SessionHandle, contextWindowUsed: number, contextWindow?: number): boolean {
  const reported = typeof contextWindow === 'number' && Number.isFinite(contextWindow) && contextWindow > 0;
  const window = reported ? contextWindow : ASSUMED_CONTEXT_WINDOW;
  const threshold = window * PRE_COMPACT_THRESHOLD_RATIO;
  if (!(contextWindowUsed >= threshold) || lastNoticeBySession.has(session)) return false;
  lastNoticeBySession.add(session);
  preCompactEmitter.emit('pre-compact', {
    session,
    timestamp: new Date().toISOString(),
    source: 'synthesized',
    contextWindowUsed,
    remainingBeforeForced: Math.max(0, window - 13_000 - contextWindowUsed),
    providerSpecific: { [OPENAI_CODEX_ID]: { synthesized: true, thresholdRatio: PRE_COMPACT_THRESHOLD_RATIO, contextWindow: window, windowAssumed: !reported } },
  } as PreCompactNotice);
  return true;
}

/** Re-arm the synthesized notice without announcing (a historical compaction seen late). */
export function rearmContextUsage(session: SessionHandle): void {
  lastNoticeBySession.delete(session);
}

/**
 * The post-compaction PRODUCER (§9.6 "Post-compaction event with the
 * summary": Codex `absent`). Codex has no post-compact hook; the context-budget
 * transcript channel calls this when the rollout records a `compacted` entry.
 * Codex exposes no summary (the entry's `message` is empty in every measured
 * rollout), so the notice carries `summary: null` and says so. Re-arms the
 * synthesized pre-compact notice for the next cycle.
 */
export function emitPostCompactFromTranscript(session: SessionHandle, o: { timestamp: string; windowId: string; tokensBefore?: number }): void {
  lastNoticeBySession.delete(session);
  postCompactEmitter.emit('post-compact', {
    session,
    timestamp: o.timestamp,
    summary: null,
    providerSpecific: { [OPENAI_CODEX_ID]: { source: 'transcript', summary: 'absent', windowId: o.windowId, ...(typeof o.tokensBefore === 'number' ? { tokensBefore: o.tokensBefore } : {}) } },
  } as PostCompactNotice);
}

class OpenAiCodexCompactionLifecycle implements CompactionLifecycle {
  readonly capability = CapabilityFlag.CompactionLifecycle;
  hasNativePreCompactHook(): boolean { return false; }

  subscribePreCompact(session: SessionHandle, options?: CancellationOptions): AsyncIterable<PreCompactNotice> {
    const signal = options?.signal;
    return {
      async *[Symbol.asyncIterator]() {
        const queue: PreCompactNotice[] = [];
        let resolveNext: (() => void) | null = null;
        const onNotice = (notice: PreCompactNotice) => {
          if (notice.session !== session) return;
          queue.push(notice);
          if (resolveNext) { resolveNext(); resolveNext = null; }
        };
        preCompactEmitter.on('pre-compact', onNotice);
        const cleanup = () => preCompactEmitter.off('pre-compact', onNotice);
        signal?.addEventListener('abort', cleanup, { once: true });
        try {
          while (!signal?.aborted) {
            while (queue.length > 0) yield queue.shift()!;
            await new Promise<void>((resolve) => {
              resolveNext = resolve;
              if (signal) signal.addEventListener('abort', () => { resolveNext = null; resolve(); }, { once: true });
            });
          }
        } finally { cleanup(); }
      },
    };
  }

  subscribePostCompact(session: SessionHandle, options?: CancellationOptions): AsyncIterable<PostCompactNotice> {
    const signal = options?.signal;
    return {
      async *[Symbol.asyncIterator]() {
        const queue: PostCompactNotice[] = [];
        let resolveNext: (() => void) | null = null;
        const onNotice = (notice: PostCompactNotice) => {
          if (notice.session !== session) return;
          queue.push(notice);
          if (resolveNext) { resolveNext(); resolveNext = null; }
        };
        postCompactEmitter.on('post-compact', onNotice);
        const cleanup = () => postCompactEmitter.off('post-compact', onNotice);
        signal?.addEventListener('abort', cleanup, { once: true });
        try {
          while (!signal?.aborted) {
            while (queue.length > 0) yield queue.shift()!;
            await new Promise<void>((resolve) => {
              resolveNext = resolve;
              if (signal) signal.addEventListener('abort', () => { resolveNext = null; resolve(); }, { once: true });
            });
          }
        } finally { cleanup(); }
      },
    };
  }

  async triggerCompact(_session: SessionHandle, _options?: CancellationOptions): Promise<void> {
    // Codex exposes `thread/compact/start` JSON-RPC method on the app-server.
    // For the headless-exec path used in Phase 4 there is no manual compact
    // trigger — Codex auto-compacts at the threshold. Surface as unsupported.
    throw new UnsupportedCapabilityError(
      CapabilityFlag.CompactionLifecycle,
      OPENAI_CODEX_ID,
    );
  }
}

export function createCompactionLifecycle(): CompactionLifecycle {
  return new OpenAiCodexCompactionLifecycle();
}

/** Reset the "already notified" set; used by tests. */
export function _resetCompactionState(): void {
  lastNoticeBySession.clear();
}
