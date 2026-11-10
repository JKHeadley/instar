/**
 * Production wiring of the topic-intent layer into the context layer store
 * (context-budget-layered-summaries Phase 1, §6 H1/H2, §6.4), mirrored by the
 * e2e test. Given the capture pipeline's parts, it returns:
 *  - `captureDeps`: the brakes (`layerBudget`) and the projection hook
 *    (`onCaptured`, called ONLY when the awareness moved) to spread into
 *    `createCaptureLoop`;
 *  - `startTicker()`: the transcript-growth ticker over this machine's live
 *    topic sessions, attached to the layers' status.
 *
 * Origin is read off the awareness itself: a current-work level whose source
 * message is a tick (`tick-…`) is `origin: tool`, whoever ran last, so a turn
 * and a tick completing concurrently can never mislabel each other's content.
 */
import fs from 'node:fs';
import { resolveFrameworkTranscriptPath } from '../../core/FrameworkSessionStore.js';
import { captureTick, TICK_MESSAGE_PREFIX, type CaptureLoopDeps, type CaptureTurnEntry } from '../../core/TopicIntentCapture.js';
import type { TopicIntentStore } from '../../core/TopicIntent.js';
import type { ContextLayers } from './contextLayersBoot.js';
import { projectAwareness } from './layerProjection.js';
import { LayerTicker, type TickSession } from './layerTicker.js';

export interface LayerSessionSource {
  listRunningSessions(): Array<{ tmuxSession: string; telegramTopicId?: number | null; claudeSessionId?: string | null; framework?: string; cwd?: string }>;
  /** Event-loop-safe tri-state probe (SessionManager.checkSessionWorkState). */
  checkSessionWorkState(tmuxSession: string): Promise<'working' | 'idle' | 'indeterminate'>;
  configHomeForSession?(tmuxSession: string, opts?: { defaultWhenUnset?: boolean; defaultWhenAbsent?: boolean }): string | undefined;
}

export interface LayerCaptureWiring {
  captureDeps: Pick<CaptureLoopDeps, 'layerBudget' | 'onCaptured'>;
  startTicker(base: Omit<CaptureLoopDeps, 'layerBudget' | 'onCaptured'>, opts?: { intervalMs?: number; baseMs?: number; liveSecrets?: () => readonly string[] }): { ticker: LayerTicker; stop(): void };
  /** Projection outcomes, for the status and tests. */
  counts: { projected: number; failed: number };
  /** The session → transcript resolver the ticker uses (exposed for the wiring test). */
  tickSessions(): TickSession[];
  /**
   * The ContextBudgetSentinel's layer-rebuild seam (§7.8, §17 stale layers):
   * re-run the H1/H2 projection from the topic's stored awareness, ONLY when
   * that awareness covers a newer message than the H1 record (a projection
   * that failed or never ran). Deterministic, no model call, the layer's own
   * writer. When the awareness itself is behind, nothing is written and the
   * outcome says so (re-capturing the awareness is a later slice's seam).
   */
  reproject(topicId: number): 'reprojected' | 'awareness-behind' | 'no-awareness' | 'failed';
}

export function wireLayerCapture(o: {
  layers: ContextLayers;
  store: TopicIntentStore;
  sessions: LayerSessionSource;
  machine: string;
  projectDir: string;
  model?: string | null;
}): LayerCaptureWiring {
  const counts = { projected: 0, failed: 0 };
  let ticker: LayerTicker | null = null;

  const project = (topicId: number, sessionId: string | null, sampled?: number) => {
    const awareness = o.store.read(topicId).awareness;
    if (!awareness) return;
    const src = awareness.currentWork.sourceMessageId;
    const fromTick = typeof src === 'string' && src.startsWith(TICK_MESSAGE_PREFIX);
    // A tick covers no new message: carry the last message the layer covered forward.
    const prev = o.layers.store.read(String(topicId), 'h1', 'current');
    const srcId = Number(src);
    const lastMessageId = fromTick ? (prev?.asOf.lastMessageId ?? null) : (Number.isSafeInteger(srcId) ? srcId : (prev?.asOf.lastMessageId ?? null));
    const r = projectAwareness(o.layers.store, String(topicId), awareness, {
      machine: o.machine, model: o.model ?? null, sessionId, lastMessageId,
      origin: fromTick ? 'tool' : 'message',
      // A turn-triggered projection of tick-sourced awareness keeps the tick's own disclosure.
      ...(fromTick ? { sampled: sampled ?? (Number(String(prev?.data.disclosure ?? '').split(' ')[0]) || 0) } : {}),
    });
    if (r.h1 === 'written') counts.projected++;
    else counts.failed++;
  };
  const onCaptured = (topicId: number, _entry: CaptureTurnEntry) => {
    project(topicId, null);
    ticker?.noteTopicUpdate(topicId);
  };

  // Transcript paths are resolved once per engine session (the config-home
  // lookup forks tmux), never on every pass.
  const pathCache = new Map<string, string>();
  const tickSessions = (): TickSession[] => {
    const out: TickSession[] = [];
    const live = new Set<string>();
    for (const s of o.sessions.listRunningSessions()) {
      if (typeof s.telegramTopicId !== 'number' || !s.claudeSessionId || (s.framework ?? 'claude-code') !== 'claude-code') continue;
      live.add(s.claudeSessionId);
      let transcriptPath = pathCache.get(s.claudeSessionId);
      if (transcriptPath === undefined) {
        const configHome = o.sessions.configHomeForSession?.(s.tmuxSession, { defaultWhenUnset: true });
        transcriptPath = resolveFrameworkTranscriptPath({ framework: 'claude-code', sessionId: s.claudeSessionId, projectDir: s.cwd ?? o.projectDir, ...(configHome ? { configHome } : {}) });
        // Cache only a path that exists: a lookup that fell back to a default is retried next pass.
        if (transcriptPath && fs.existsSync(transcriptPath)) pathCache.set(s.claudeSessionId, transcriptPath);
      }
      if (transcriptPath) out.push({ topicId: s.telegramTopicId, sessionKey: s.claudeSessionId, transcriptPath, tmuxSession: s.tmuxSession });
    }
    for (const k of [...pathCache.keys()]) if (!live.has(k)) pathCache.delete(k);
    return out;
  };

  const reproject = (topicId: number): 'reprojected' | 'awareness-behind' | 'no-awareness' | 'failed' => {
    const awareness = o.store.read(topicId).awareness;
    if (!awareness) return 'no-awareness';
    const src = awareness.currentWork.sourceMessageId;
    const srcId = Number(src);
    // A tick-sourced level is projected by the tick itself; a non-numeric source cannot be compared.
    if ((typeof src === 'string' && src.startsWith(TICK_MESSAGE_PREFIX)) || !Number.isSafeInteger(srcId)) return 'awareness-behind';
    const prev = o.layers.store.read(String(topicId), 'h1', 'current');
    if (prev && prev.asOf.lastMessageId !== null && srcId <= prev.asOf.lastMessageId) return 'awareness-behind';
    const before = counts.projected;
    project(topicId, null);
    return counts.projected > before ? 'reprojected' : 'failed';
  };

  return {
    counts,
    tickSessions,
    reproject,
    captureDeps: { layerBudget: o.layers.budget, onCaptured },
    startTicker(base, opts = {}) {
      const deps: CaptureLoopDeps = { ...base, layerBudget: o.layers.budget, onCaptured };
      ticker = new LayerTicker({
        sessions: tickSessions,
        midTurn: async (t) => (await o.sessions.checkSessionWorkState(t)) !== 'idle',
        budget: o.layers.budget,
        baseMs: opts.baseMs,
        liveSecrets: opts.liveSecrets,
        ingest: async (s, digest) => {
          const r = await captureTick(deps, s.topicId, digest.text);
          if (r.status === 'skipped-shed') return 'shed';
          if (r.status !== 'captured') return 'failed';
          if (!r.awarenessUpdated) return 'no-update';
          project(s.topicId, s.sessionKey, digest.sampled);
          return 'updated';
        },
      });
      o.layers.attachTicker(ticker);
      const t = ticker;
      const timer = setInterval(() => { void t.pass(); }, opts.intervalMs ?? 60_000);
      timer.unref?.();
      return { ticker: t, stop: () => clearInterval(timer) };
    },
  };
}
