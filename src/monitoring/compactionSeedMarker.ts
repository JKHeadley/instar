/**
 * Seeded-marker reader for the one-carrier post-compaction path
 * (context-budget-layered-summaries §9.1, §7.7).
 *
 * The installed `session-start.sh` writes
 * `<stateDir>/state/context-layers/_seeded/<claudeSessionId>.json` after its
 * SessionStart(compact) recovery seed succeeded. CompactionSentinel reads it to
 * decide whether the server-side recovery inject must stand down.
 */
import fs from 'node:fs';
import path from 'node:path';
import { deriveContextEpoch } from './contextEpoch.js';

export interface SeedMarker {
  seededAt: number;
  epoch: string;
  /** Who wrote it: `compact` (the hook), `server-fallback` or `heal` (the server). Absent on older markers. */
  source?: string;
}

/** Sources the server writes after it delivered a compaction's context itself. */
export type ServerSeedSource = 'server-fallback' | 'heal';

const SESSION_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

export function seedMarkerPath(stateDir: string, claudeSessionId: string): string | null {
  if (!SESSION_ID_RE.test(claudeSessionId)) return null;
  return path.join(stateDir, 'state', 'context-layers', '_seeded', `${claudeSessionId}.json`);
}

/**
 * Read the compaction seed marker; null when missing, malformed, the id is not a
 * plain session id, or the marker was written by a fold's clear seed
 * (`source: 'clear'`, clear-seed.sh): a fold's seed is not a compaction's
 * recovery and must never stand the compaction path down.
 */
export function readSeedMarkerFile(stateDir: string, claudeSessionId: string | undefined): SeedMarker | null {
  if (!claudeSessionId) return null;
  const p = seedMarkerPath(stateDir, claudeSessionId);
  if (!p) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(p, 'utf-8')) as { seededAt?: unknown; epoch?: unknown; sessionId?: unknown; source?: unknown };
    if (raw.sessionId !== undefined && raw.sessionId !== claudeSessionId) return null;
    if (raw.source === 'clear') return null;
    if (typeof raw.seededAt !== 'number' || !Number.isFinite(raw.seededAt)) return null;
    return { seededAt: raw.seededAt, epoch: typeof raw.epoch === 'string' ? raw.epoch : '', ...(typeof raw.source === 'string' ? { source: raw.source } : {}) };
  } catch {
    return null; // @silent-fallback-ok — missing or torn marker reads as "not seeded"; the server sends recovery, never less
  }
}

/**
 * The server's own writer of the seeded marker (§9.1 "whose seeded marker then
 * makes any late hook seed a no-op"; §7.7): written after the server delivered a
 * compaction's context (the idle-gated fallback, or the heal ladder's re-inject).
 * The epoch is derived by the shared rule (`deriveContextEpoch`, the
 * compact-boundary entry's id), so every reader binds it to the same compaction
 * as a hook-written marker. Same file, modes and atomic rename as the hook.
 * Returns false (and writes nothing) for an unsafe id or an empty epoch.
 */
export function writeSeedMarkerFile(stateDir: string, claudeSessionId: string | undefined, o: { boundaryUuid: string; source: ServerSeedSource; seededAt?: number }): boolean {
  if (!claudeSessionId) return false;
  const p = seedMarkerPath(stateDir, claudeSessionId);
  const epoch = deriveContextEpoch({ source: 'compact', boundaryUuid: o.boundaryUuid });
  if (!p || !epoch) return false;
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
    const tmp = `${p}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ sessionId: claudeSessionId, epoch, source: o.source, seededAt: o.seededAt ?? Date.now(), carrier: 'server' }), { mode: 0o600 });
    fs.renameSync(tmp, p);
    return true;
  } catch {
    return false; // @silent-fallback-ok — the caller reports a marker it could not write; the only cost is a later carrier not seeing this delivery
  }
}
