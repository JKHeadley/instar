/**
 * Disk Steward category `context-archive` (context-budget-layered-summaries
 * §9.7 "Retention is a new Disk Steward category", §12 "Archive retention").
 *
 * Runs inside the prune child, never on the server's event loop. Only acts
 * when the archive is over its size limit; then frees down to 80% of the
 * limit, per topic in proportion, oldest-superseded-first, and never a span
 * the topic's current phase points at (H2's `spanIds` and every open chunk's
 * `spanIds`). An evicted span keeps its index row marked evicted, so a chunk
 * that points at it reads `raw-evicted`, never unknown. Every doubt skips.
 */
import fs from 'node:fs';
import { TranscriptArchive, contextArchiveRoot } from '../contextLayers/TranscriptArchive.js';
import { LayerStore } from '../contextLayers/LayerStore.js';
import { GiB, type CategoryResult } from './pruneCategories.js';

export const CONTEXT_ARCHIVE_DEFAULT_MAX_GIB = 2;
const SAFE_TOPIC = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * The spans a topic's current phase points at: never evicted (§12 floor). Read
 * from each record's own `spanIds` (kept outside the scrubbed data, span-id
 * shaped) and its `status`. `null` when the topic has no readable H2 or chunk
 * record at all: the floor is unknown, so the topic is skipped (every doubt
 * skips), never treated as unprotected.
 */
export function currentPhaseSpans(store: LayerStore, topicKey: string): Set<string> | null {
  const h2 = store.list(topicKey, 'h2');
  const chunks = store.list(topicKey, 'chunk');
  if (h2.length === 0 && chunks.length === 0) return null;
  const out = new Set<string>();
  const add = (v: unknown) => { if (Array.isArray(v)) for (const s of v) if (typeof s === 'string') out.add(s); };
  for (const r of h2) add(r.spanIds);
  for (const c of chunks) if (c.status === 'open' || c.status === 'current-phase') add(c.spanIds);
  return out;
}

export function pruneContextArchive(opts: { stateDir: string; dryRun: boolean; maxGiB: number; budgetMs: number; now?: () => number }): CategoryResult {
  const base = { category: 'context-archive' as const, plannedBytes: 0, plannedItems: 0, removedItems: 0, bytesFreed: 0 };
  const root = contextArchiveRoot(opts.stateDir);
  let st: fs.Stats;
  try { st = fs.lstatSync(root); } catch { return { ...base, skipped: 'no-archive' }; }
  if (st.isSymbolicLink() || !st.isDirectory()) return { ...base, skipped: 'archive-not-a-plain-folder' };
  const now = opts.now ?? Date.now;
  const started = now();
  // No live secrets needed: eviction reads only the index, never span bodies.
  const archive = new TranscriptArchive({ stateDir: opts.stateDir, liveSecrets: () => [] });
  const store = new LayerStore({ stateDir: opts.stateDir, liveSecrets: () => [] });
  let topics: string[];
  try { topics = fs.readdirSync(root).filter((t) => SAFE_TOPIC.test(t)); } catch { return { ...base, skipped: 'unreadable' }; }
  const sizes = topics.map((t) => ({ t, bytes: archive.readIndex(t).spans.filter((s) => s.evictedAt === undefined).reduce((a, s) => a + s.bytes, 0) }));
  const total = sizes.reduce((a, s) => a + s.bytes, 0);
  const limit = opts.maxGiB * GiB;
  if (total <= limit) return { ...base, skipped: 'under-limit' };
  const toFree = total - Math.floor(limit * 0.8);
  const plans = sizes.filter((s) => s.bytes > 0).flatMap((s) => {
    const floor = currentPhaseSpans(store, s.t);
    if (floor === null) return []; // the floor is unknown here (e.g. a topic received by move): skip it
    const share = Math.ceil(toFree * (s.bytes / total));
    return [{ t: s.t, plan: archive.planEviction(s.t, share, floor) }];
  });
  const plannedItems = plans.reduce((a, p) => a + p.plan.evict.length, 0);
  const plannedBytes = plans.reduce((a, p) => a + p.plan.bytes, 0);
  if (opts.dryRun) return { ...base, plannedBytes, plannedItems, skipped: 'dry-run' };
  let removedItems = 0;
  let bytesFreed = 0;
  for (const p of plans) {
    const idx = archive.readIndex(p.t);
    for (const spanId of p.plan.evict) {
      if (now() - started > opts.budgetMs) return { ...base, plannedBytes, plannedItems, removedItems, bytesFreed, skipped: 'budget' };
      // Re-read the floor right before each removal: a chunk may have opened since planning.
      const floor = currentPhaseSpans(store, p.t);
      if (floor === null || floor.has(spanId)) continue;
      const row = idx.spans.find((s) => s.spanId === spanId);
      if (archive.evictSpan(p.t, spanId)) { removedItems++; bytesFreed += row?.bytes ?? 0; }
    }
  }
  return { ...base, plannedBytes, plannedItems, removedItems, bytesFreed };
}
