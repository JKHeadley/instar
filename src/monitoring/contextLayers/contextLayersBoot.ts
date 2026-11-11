/**
 * Production construction of the layer store and transcript archive
 * (context-budget-layered-summaries §9.7), mirrored by the e2e test.
 *
 * Behind `contextBudget.enabled`, resolved through the development-agent gate
 * (omitted ⇒ live on a development agent, dark on the fleet). Off ⇒ nothing is
 * constructed and nothing is created on disk.
 *
 * Replication: every record is offered to the journal-backed emitter as a
 * `context-layer-record` put, which itself stays dark until
 * `multiMachine.stateSync.contextLayers` is on. The local write stands either
 * way; the writer is told what replication did.
 */
import fs from 'node:fs';
import { resolveDevAgentGate } from '../../core/devAgentGate.js';
import { buildContextLayerPut, CONTEXT_LAYER_STORE_KEY } from '../contextLayerKind.js';
import { LayerStore, contextLayersRoot, dirBytes, type ReplicateLayer, type ReplicationOutcome } from './LayerStore.js';
import { TranscriptArchive, contextArchiveRoot } from './TranscriptArchive.js';
import { cachedLiveSecrets } from './liveSecrets.js';
import { featureEvidence } from '../FeatureEvidenceLog.js';
import { TopicLayerBudget, type LayerBudgetStatus } from './layerCadence.js';
import type { LayerTicker, LayerTickerStatus } from './layerTicker.js';
import { layerFreshness } from './layerProjection.js';

/** The feature id the maturation ladder reads (src/data/feature-ladders.json). */
export const CONTEXT_LAYERS_FEATURE_ID = 'contextBudget.layers';

export interface ContextLayers {
  store: LayerStore;
  archive: TranscriptArchive;
  /** The layer brakes (§6.4): per-topic and component daily token ceilings, shared by turns and ticks. */
  budget: TopicLayerBudget;
  /** Attach the transcript-growth ticker once the capture pipeline exists (its status joins ours). */
  attachTicker(t: LayerTicker): void;
  /** The agent's live secret values (cached), for scrubbing anything bound for an LLM. */
  liveSecrets(): readonly string[];
  /** The current-work layer's freshness against TopicMemory; `unknown` when no H1 record exists yet. */
  h1Freshness(topicId: number, topicMemory: { countMessagesAfter(topicId: number, messageId: number): { total: number; fromUser: number } | null }): { line: string; stale: boolean | 'unknown' } | null;
  status(): ContextLayersStatus;
}

export interface ContextLayersStatus {
  enabled: true;
  layersRoot: { path: string; mode: string | null };
  archiveRoot: { path: string; mode: string | null };
  topics: number;
  layerBytes: number;
  archiveBytes: number;
  replication: Record<ReplicationOutcome, number>;
  budget: LayerBudgetStatus;
  ticker: LayerTickerStatus | null;
}

/** The minimal emitter seam (ReplicatedRecordEmitter.emit). */
export interface LayerEmitter {
  emit(store: string, recordKey: string, build: (hlc: never, origin: string, observed?: never) => Record<string, unknown> | null): { outcome: string };
}

export function contextLayersEnabled(config: { developmentAgent?: boolean; contextBudget?: { enabled?: boolean } }, explicit?: boolean): boolean {
  return resolveDevAgentGate(explicit ?? config.contextBudget?.enabled, config);
}

function modeOf(p: string): string | null {
  try { return (fs.statSync(p).mode & 0o777).toString(8).padStart(4, '0'); } catch { return null; }
}

/** Turn the emitter seam into the store's replication seam. */
export function replicateVia(emitter: LayerEmitter | null | undefined): ReplicateLayer | undefined {
  if (!emitter) return undefined;
  return (input) => {
    const b = buildContextLayerPut(input);
    if (!b.ok) return b.reason;
    const r = emitter.emit(CONTEXT_LAYER_STORE_KEY, b.recordKey, (hlc, origin, observed) => b.build(hlc as never, origin, observed as never));
    if (r.outcome === 'emitted') return 'emitted';
    if (r.outcome === 'unconfirmed') return 'unconfirmed';
    if (r.outcome === 'disabled') return 'disabled';
    return 'dropped';
  };
}

export function buildContextLayers(deps: {
  stateDir: string;
  authToken?: unknown;
  dashboardPin?: unknown;
  forceFileKey?: boolean;
  emitter?: LayerEmitter | null;
}): ContextLayers {
  const counts: Record<ReplicationOutcome, number> = { emitted: 0, unconfirmed: 0, disabled: 0, oversize: 0, invalid: 0, dropped: 0, 'not-replicated': 0 };
  // Live secrets are read per write (a rotated token is redacted from the next write on).
  const liveSecrets = cachedLiveSecrets(
    { stateDir: deps.stateDir, authToken: deps.authToken, dashboardPin: deps.dashboardPin, forceFileKey: deps.forceFileKey },
    { onStoreError: (e) => featureEvidence.recordAtMostEvery(CONTEXT_LAYERS_FEATURE_ID, 'secret-store-unreadable', 60 * 60_000, { kind: 'error', reason: `secret store unreadable; live-value pass limited to the auth token, PIN and lifeline secret: ${e instanceof Error ? e.message : String(e)}`.slice(0, 300) }) },
  );
  const inner = replicateVia(deps.emitter);
  const replicate: ReplicateLayer | undefined = inner ? (i) => { const o = inner(i); counts[o]++; return o; } : undefined;
  const store = new LayerStore({
    stateDir: deps.stateDir, liveSecrets, replicate,
    onWrite: (topicKey, recordType, r) => {
      if (r.written) {
        featureEvidence.recordAtMostEvery(CONTEXT_LAYERS_FEATURE_ID, `${topicKey}:${recordType}`, 10 * 60_000, { kind: 'fired', reason: `${recordType} layer written`, context: { topicKey, recordType, replication: r.replication } });
      } else if (r.reason === 'write-failed') {
        featureEvidence.record(CONTEXT_LAYERS_FEATURE_ID, { kind: 'error', reason: `${recordType} layer write failed`, context: { topicKey, recordType } });
      }
    },
  });
  const archive = new TranscriptArchive({ stateDir: deps.stateDir, liveSecrets });
  const budget = new TopicLayerBudget();
  let ticker: LayerTicker | null = null;
  // Both roots exist, permissioned, from boot: the e2e "alive" check and the
  // never-served / never-backed-up rules have something real to act on.
  for (const root of [contextLayersRoot(deps.stateDir), contextArchiveRoot(deps.stateDir)]) {
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    fs.chmodSync(root, 0o700);
  }
  return {
    store,
    archive,
    budget,
    attachTicker(t) { ticker = t; },
    liveSecrets,
    h1Freshness(topicId, topicMemory) {
      const rec = store.read(String(topicId), 'h1', 'current');
      // No layer record yet (an existing topic at rollout, or a machine where
      // capture cannot run): the stamp says unknown, never nothing.
      if (!rec) return { line: 'no layer record yet', stale: 'unknown' };
      const f = layerFreshness(rec, (id) => topicMemory.countMessagesAfter(topicId, id));
      return { line: f.line, stale: f.stale };
    },
    status(): ContextLayersStatus {
      const lr = contextLayersRoot(deps.stateDir);
      const ar = contextArchiveRoot(deps.stateDir);
      let topics = 0;
      try { topics = fs.readdirSync(lr, { withFileTypes: true }).filter((e) => e.isDirectory() && /^[A-Za-z0-9_-]{1,128}$/.test(e.name) && !e.name.startsWith('_')).length; } catch { /* @silent-fallback-ok — no root yet reads as zero topics */ }
      return {
        enabled: true,
        layersRoot: { path: lr, mode: modeOf(lr) },
        archiveRoot: { path: ar, mode: modeOf(ar) },
        topics,
        layerBytes: dirBytes(lr),
        archiveBytes: dirBytes(ar),
        replication: { ...counts },
        budget: budget.status(),
        ticker: ticker ? ticker.status() : null,
      };
    },
  };
}
