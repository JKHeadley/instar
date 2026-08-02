/**
 * Zero-cost Cartographer population lifecycle.
 *
 * This path maintains only the structural hierarchy and its read snapshot. It
 * has no router, queue, model, provider, or egress dependency; semantic summary
 * authoring remains exclusively behind freshnessSweep.enabled.
 */
import type { CartographerTree } from './CartographerTree.js';
import {
  persistDetectSnapshot,
  type DetectRefusalReason,
  type DetectResult,
  type LastDetectStatus,
} from './cartographerDetect.js';
import { runCartographerWorker } from './cartographerDetectWorker.js';

export interface CartographerPopulationConfig {
  scaffoldChunkNodes?: number;
  scaffoldTimeoutMs?: number;
  detectTimeoutMs?: number;
  detectWorkerHeapMb?: number;
  maxIndexBytes?: number;
  snapshotSampleMax?: number;
  gitMaxBuffer?: number;
  graceMs?: number;
}

export interface CartographerPopulationResult {
  nodeCount: number;
  scaffoldedNodeCount: number;
  snapshotWritten: boolean;
  detectStatus: LastDetectStatus;
  refused: boolean;
  refusalReason?: DetectRefusalReason;
}

export interface CartographerPopulationDeps {
  tree: CartographerTree;
  config?: CartographerPopulationConfig;
  now?: () => number;
  onYield?: () => Promise<void>;
}

function refusedDetect(reason: DetectRefusalReason, durationMs: number): DetectResult {
  return {
    refused: true,
    refusalReason: reason,
    candidates: [],
    deferredApplied: 0,
    counts: { nodeCount: 0, authoredCount: 0, neverAuthored: 0, stale: 0, pathGone: 0, generatedAt: null, headSha: null },
    freshness: {
      nodeCount: 0, authorableCount: 0, freshCount: 0, staleCount: 0, neverAuthoredCount: 0,
      neverAuthoredWithinGrace: 0, neverAuthoredPastGrace: 0, authorFailedCount: 0,
      freshRatio: null, generatedAt: null,
    },
    revalidationSample: [],
    staleSample: [],
    staleTotal: 0,
    durationMs,
  };
}

/** Rebuild structure in yielding chunks, then publish an aggregate-only snapshot. */
export async function populateCartographer(deps: CartographerPopulationDeps): Promise<CartographerPopulationResult> {
  const cfg = deps.config ?? {};
  const now = deps.now ?? Date.now;
  const scaffoldStartedAt = now();
  const scaffold = await deps.tree.scaffoldChunked({
    chunkNodes: cfg.scaffoldChunkNodes ?? 500,
    onYield: deps.onYield ?? (() => new Promise<void>((resolve) => setImmediate(resolve))),
    shouldAbort: () => now() - scaffoldStartedAt > (cfg.scaffoldTimeoutMs ?? 10 * 60_000),
  });

  const out = await runCartographerWorker<DetectResult>('detect', {
    indexPath: deps.tree.indexFilePath(),
    projectDir: deps.tree.projectDirPath(),
    maxIndexBytes: cfg.maxIndexBytes ?? 200 * 1024 * 1024,
    // snapshotOnly means these candidate/defer bounds are inert; keep them
    // minimal so this path cannot become an author-work queue by accident.
    maxCandidates: 1,
    maxNodesPerPass: 1,
    maxDeferredPasses: 1,
    revalidateSamplePerPass: 0,
    graceMs: cfg.graceMs ?? 1_200_000,
    gitMaxBuffer: cfg.gitMaxBuffer ?? 64 * 1024 * 1024,
    snapshotSampleMax: cfg.snapshotSampleMax ?? 500,
    nowMs: now(),
    snapshotOnly: true,
  }, {
    timeoutMs: cfg.detectTimeoutMs,
    heapMb: cfg.detectWorkerHeapMb,
    now,
  });

  let detect: DetectResult;
  if (out.startFailed || (!out.ok && !out.timedOut)) {
    detect = refusedDetect('detect-worker-start-failure', out.durationMs);
  } else if (out.timedOut) {
    detect = refusedDetect('detect-timeout', out.durationMs);
  } else if (!out.result) {
    detect = refusedDetect('detect-worker-start-failure', out.durationMs);
  } else {
    detect = out.result;
  }

  const snap = persistDetectSnapshot(deps.tree.snapshotPath(), detect, now());
  return {
    nodeCount: snap.counts.nodeCount,
    scaffoldedNodeCount: scaffold.nodeCount,
    snapshotWritten: true,
    detectStatus: snap.lastDetectStatus,
    refused: detect.refused,
    refusalReason: detect.refusalReason,
  };
}
