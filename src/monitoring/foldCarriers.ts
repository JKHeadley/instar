/**
 * The fold carriers that exist today, adapted to `FoldCarrier`
 * (context-budget-layered-summaries §9.3: "Every carrier the fold touches is
 * keyed by foldId … all are released by the terminal transition").
 *
 *  - `clear-seed-pointer`: the staged packet's single-use pointer for the
 *    rung-1 clear (clearSeedPointer.ts), live or claimed.
 *  - `keep-instructions`: PreCompact steering text staged for a fold (source
 *    `fold:<topicKey>:<foldId>`; the standing packet's own text is never a
 *    fold carrier and is never released here).
 *  - `pending-inject`: a PendingInjectStore record tagged with the fold.
 *
 *  - `fold-marker`: the per-session marker the fold-marker tool policy reads
 *    (foldMarker.ts).
 *
 *  - `engine-checkpoint`: the byte-exact pre-fold transcript (engineCheckpoint.ts);
 *    deleted on commit or abort, kept for the grace period after a rollback.
 *
 * The fold hold registers its carrier at boot (it lives in the routes).
 */
import fs from 'node:fs';
import path from 'node:path';
import type { FoldCarrier } from './FoldCoordinator.js';
import { listClearSeedPointers, contextLayersRoot } from './clearSeedPointer.js';
import { keepInstructionsDir, removeKeepInstructions } from './keepInstructions.js';
import { PendingInjectStore } from '../core/PendingInjectStore.js';
import { SafeFsExecutor } from '../core/SafeFsExecutor.js';
import { foldMarkerCarrier } from './foldMarker.js';
import { engineCheckpointCarrier } from './engineCheckpoint.js';
import { FoldRecordStore } from './FoldCoordinator.js';

/** The keep-instructions source string for a fold's staged steering text. */
export function foldKeepSource(topicKey: string, foldId: string): string {
  return `fold:${topicKey}:${foldId}`;
}

/** The staged packet a pointer names, only if it resolves inside the fold's topic directory (never its fold records). */
function stagedPacketFile(stateDir: string, rel: unknown, topicKey: string): string | null {
  if (typeof rel !== 'string' || !rel || !/^[A-Za-z0-9_-]{1,128}$/.test(topicKey)) return null;
  try {
    // Confined to the fold's own topic directory, never the whole layers root
    // (a pointer naming a fold record or a summary must not delete it).
    const layers = fs.realpathSync(contextLayersRoot(stateDir));
    const root = fs.realpathSync(path.join(layers, topicKey));
    const records = path.join(root, 'fold-records') + path.sep;
    const f = path.resolve(layers, rel); // pointers store the path relative to the layers root
    if (!f.startsWith(root + path.sep) || f.startsWith(records) || !fs.existsSync(f)) return null;
    const real = fs.realpathSync(f);
    return real.startsWith(root + path.sep) && !real.startsWith(records) && fs.statSync(real).isFile() ? real : null;
  } catch {
    return null; // @silent-fallback-ok — no layers root or no packet: nothing to delete
  }
}

export function clearSeedPointerCarrier(stateDir: string): FoldCarrier {
  return {
    kind: 'clear-seed-pointer',
    list: () => listClearSeedPointers(stateDir)
      .filter((p) => typeof p.pointer.topicKey === 'string')
      .map((p) => ({ topicKey: p.pointer.topicKey as string, foldId: p.pointer.foldId })),
    release: (topicKey, foldId) => {
      for (const p of listClearSeedPointers(stateDir)) {
        if (p.pointer.foldId === foldId && (p.pointer.topicKey === undefined || p.pointer.topicKey === topicKey)) {
          SafeFsExecutor.safeRmSync(p.file, { force: true, operation: 'src/monitoring/foldCarriers.ts:clearSeedPointer' });
          // §9.3: "delete the packet" — only a packet confined to the layers root.
          const packet = stagedPacketFile(stateDir, p.pointer.packetPath, topicKey);
          if (packet) SafeFsExecutor.safeRmSync(packet, { force: true, operation: 'src/monitoring/foldCarriers.ts:clearSeedPacket' });
        }
      }
    },
  };
}

function listKeep(stateDir: string): Array<{ iid: string; topicKey: string; foldId: string }> {
  const dir = keepInstructionsDir(stateDir);
  let files: string[] = [];
  try { files = fs.readdirSync(dir); } catch { return []; }
  const out: Array<{ iid: string; topicKey: string; foldId: string }> = [];
  for (const f of files.filter((x) => x.endsWith('.json'))) {
    try {
      const p = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8')) as { source?: string; instarSessionId?: string };
      const m = typeof p.source === 'string' ? /^fold:([A-Za-z0-9_-]+):([A-Za-z0-9_-]+)$/.exec(p.source) : null;
      if (m && typeof p.instarSessionId === 'string') out.push({ iid: p.instarSessionId, topicKey: m[1], foldId: m[2] });
    } catch { /* @silent-fallback-ok — a torn pointer prints nothing (hash check) and is not attributable */ }
  }
  return out;
}

export function keepInstructionsCarrier(stateDir: string): FoldCarrier {
  return {
    kind: 'keep-instructions',
    list: () => listKeep(stateDir).map(({ topicKey, foldId }) => ({ topicKey, foldId })),
    release: (topicKey, foldId) => {
      for (const k of listKeep(stateDir)) if (k.topicKey === topicKey && k.foldId === foldId) removeKeepInstructions(stateDir, k.iid);
    },
  };
}

export function pendingInjectCarrier(store: PendingInjectStore): FoldCarrier {
  return {
    kind: 'pending-inject',
    list: () => store.list().records.filter((r) => r.fold).map((r) => ({ topicKey: r.fold!.topicKey, foldId: r.fold!.foldId })),
    release: (topicKey, foldId) => {
      for (const r of store.list().records) {
        if (r.fold && r.fold.foldId === foldId && r.fold.topicKey === topicKey) store.clear(r.tmuxSession);
      }
    },
  };
}

/** All of today's carriers for a machine's state directory. */
export function defaultFoldCarriers(stateDir: string): FoldCarrier[] {
  return [
    clearSeedPointerCarrier(stateDir),
    keepInstructionsCarrier(stateDir),
    pendingInjectCarrier(new PendingInjectStore(path.join(stateDir, 'state'))),
    foldMarkerCarrier(stateDir),
    engineCheckpointCarrier(stateDir, (topicKey, foldId) => new FoldRecordStore(stateDir).get(topicKey, foldId)?.state ?? null),
  ];
}
