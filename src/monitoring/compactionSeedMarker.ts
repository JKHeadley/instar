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

export interface SeedMarker {
  seededAt: number;
  epoch: string;
}

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
    return { seededAt: raw.seededAt, epoch: typeof raw.epoch === 'string' ? raw.epoch : '' };
  } catch {
    return null; // @silent-fallback-ok — missing or torn marker reads as "not seeded"; the server sends recovery, never less
  }
}
