/**
 * Durable staging for the CompactionSentinel's §9.1 server fallback
 * (context-budget-layered-summaries §9.1: "the server-side path runs once with
 * the standing packet through the idle-gated inject path (PendingInjectStore)").
 *
 * Adapts PendingInjectStore to `CompactionFallbackDeps`. A staged fallback is a
 * store record under its own key (`compactionFallbackKey`), so it can never
 * overwrite the session's pending initial-message record, and it is written
 * `doNotReplay`, so SessionManager's generic boot sweep never re-injects it
 * ungated (that sweep only ages such records out after 24 h). The sentinel
 * owns delivery (idle + ready prompt) and the boot resume.
 */
import {
  PendingInjectStore,
  compactionFallbackKey,
  type PendingInjectRecord,
} from '../core/PendingInjectStore.js';
import type { CompactionFallbackDeps, StagedCompactionFallback } from './CompactionSentinel.js';

export interface CompactionFallbackWiring {
  store: PendingInjectStore;
  build: CompactionFallbackDeps['build'];
  isReadyPrompt: CompactionFallbackDeps['isReadyPrompt'];
  inject: CompactionFallbackDeps['inject'];
}

export function toStagedFallback(r: PendingInjectRecord): StagedCompactionFallback | null {
  const cf = r.compactionFallback;
  if (!cf || r.tmuxSession !== compactionFallbackKey(cf.tmuxSession)) return null;
  const stagedAt = Date.parse(r.createdAt);
  if (!Number.isFinite(stagedAt)) return null;
  return {
    tmuxSession: cf.tmuxSession, epoch: cf.epoch, trigger: cf.trigger, text: r.initialMessage, stagedAt,
    ...(typeof cf.boundaryAt === 'number' ? { boundaryAt: cf.boundaryAt } : {}),
  };
}

export function createCompactionFallbackDeps(w: CompactionFallbackWiring): CompactionFallbackDeps {
  return {
    build: w.build,
    isReadyPrompt: w.isReadyPrompt,
    inject: w.inject,
    stage: (rec) => w.store.record({
      tmuxSession: compactionFallbackKey(rec.tmuxSession),
      initialMessage: rec.text,
      createdAt: new Date(rec.stagedAt).toISOString(),
      doNotReplay: true,
      compactionFallback: {
        tmuxSession: rec.tmuxSession, epoch: rec.epoch, trigger: rec.trigger,
        ...(rec.boundaryAt !== undefined ? { boundaryAt: rec.boundaryAt } : {}),
      },
    }),
    clear: (tmuxSession) => w.store.clear(compactionFallbackKey(tmuxSession)),
    otherInjectPending: (tmuxSession) => w.store.list().records.some(
      (r) => r.tmuxSession === tmuxSession && !r.doNotReplay && !r.tombstone,
    ),
    list: () => w.store.list().records.map(toStagedFallback).filter((x): x is StagedCompactionFallback => x !== null),
  };
}
