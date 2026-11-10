/**
 * The per-session fold marker (context-budget-layered-summaries §10, §9.3):
 * the single writer of the file the fold-marker tool policy reads
 * (`src/templates/hooks/fold-marker-guard.js`). Keep the two in step.
 *
 * `<stateDir>/state/context-layers/_fold-markers/<INSTAR_SESSION_ID>.json`
 * (dir 0700, file 0600, atomic replace). Keyed by the Instar session id, never
 * the engine's own id (which rotates at a /clear). The coordinator supplies the
 * candidate's and answerer's INSTAR_SESSION_ID to the spawn call, so their
 * markers exist before their first tool call (§9.3). The expiry equals the lock
 * TTL ceiling and is IGNORED by the hook while the fold record is non-terminal;
 * only the terminal transition (or the boot sweep, for an orphan) removes it.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { FoldCarrier } from './FoldCoordinator.js';
import { SafeFsExecutor } from '../core/SafeFsExecutor.js';

const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;

export interface FoldMarker {
  schema: 'fold-marker/1';
  instarSessionId: string;
  foldId: string;
  topicKey: string;
  writtenAt: number;
  expiresAt: number;
}

export function foldMarkersDir(stateDir: string): string {
  return path.join(stateDir, 'state', 'context-layers', '_fold-markers');
}

export function foldMarkerPath(stateDir: string, instarSessionId: string): string | null {
  return SAFE_ID.test(instarSessionId) ? path.join(foldMarkersDir(stateDir), `${instarSessionId}.json`) : null;
}

/** Write (or re-stamp) a session's marker. Returns null when it could not be made durable. */
export function writeFoldMarker(
  stateDir: string,
  input: { instarSessionId: string; foldId: string; topicKey: string; expiresAt: number },
  now: number = Date.now(),
): FoldMarker | null {
  const file = foldMarkerPath(stateDir, input.instarSessionId);
  if (!file || !SAFE_ID.test(input.foldId) || !SAFE_ID.test(input.topicKey) || !Number.isFinite(input.expiresAt)) return null;
  const marker: FoldMarker = {
    schema: 'fold-marker/1',
    instarSessionId: input.instarSessionId,
    foldId: input.foldId,
    topicKey: input.topicKey,
    writtenAt: now,
    expiresAt: Math.floor(input.expiresAt),
  };
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(marker), { mode: 0o600 });
    fs.renameSync(`${file}.tmp`, file);
    return marker;
  } catch {
    return null; // @silent-fallback-ok — a fold that cannot write its marker must not begin; the caller sees null
  }
}

/** The fold key a torn or mismatched marker is listed under, so the boot sweep releases it as an orphan. */
export const TORN_MARKER_KEY = '_torn';

/** Every marker file on disk, keyed by its FILENAME (the session it governs). */
function scanMarkerFiles(stateDir: string): Array<{ file: string; iid: string; marker: FoldMarker | null }> {
  let files: string[] = [];
  try { files = fs.readdirSync(foldMarkersDir(stateDir)); } catch { return []; } // @silent-fallback-ok — no directory means no markers
  const out: Array<{ file: string; iid: string; marker: FoldMarker | null }> = [];
  for (const f of files) {
    const m = /^([A-Za-z0-9_-]{1,128})\.json$/.exec(f);
    if (!m) continue;
    const file = path.join(foldMarkersDir(stateDir), f);
    let raw: string;
    // A read ERROR (EMFILE, EIO, EACCES…) says nothing about the marker: skip it
    // this pass rather than class a valid marker as torn and delete it.
    try { raw = fs.readFileSync(file, 'utf-8'); } catch { continue; } // @silent-fallback-ok — transient read error: the marker is kept, next pass re-reads it
    let marker: FoldMarker | null = null;
    try {
      const x = JSON.parse(raw) as FoldMarker;
      // A marker is attributable only when its content agrees with its filename.
      if (x?.schema === 'fold-marker/1' && x.instarSessionId === m[1] && SAFE_ID.test(x.foldId) && SAFE_ID.test(x.topicKey)) marker = x;
    } catch { marker = null; /* @silent-fallback-ok — torn (read but unparseable): listed under TORN_MARKER_KEY so the boot sweep releases it loudly */ }
    out.push({ file, iid: m[1], marker });
  }
  return out;
}

/** Every attributable marker on disk. */
export function listFoldMarkers(stateDir: string): FoldMarker[] {
  return scanMarkerFiles(stateDir).flatMap((e) => (e.marker ? [e.marker] : []));
}

/** Remove the marker files that belong to one fold (or, for TORN_MARKER_KEY, every unattributable one). */
export function removeFoldMarkers(stateDir: string, topicKey: string, foldId: string): void {
  for (const e of scanMarkerFiles(stateDir)) {
    const match = topicKey === TORN_MARKER_KEY
      ? e.marker === null
      : e.marker !== null && e.marker.foldId === foldId && e.marker.topicKey === topicKey;
    if (match) SafeFsExecutor.safeRmSync(e.file, { force: true, operation: 'src/monitoring/foldMarker.ts:remove' });
  }
}

/** The markers as a fold carrier: listed and released by foldId (§9.3). */
export function foldMarkerCarrier(stateDir: string): FoldCarrier {
  return {
    kind: 'fold-marker',
    list: () => {
      const all = scanMarkerFiles(stateDir);
      const out = all.flatMap((e) => (e.marker ? [{ topicKey: e.marker.topicKey, foldId: e.marker.foldId }] : []));
      // A torn or mismatched marker denies its session forever (the hook reads it as malformed)
      // and has no fold to settle it, so it is offered to the boot sweep as an orphan.
      if (all.some((e) => e.marker === null)) out.push({ topicKey: TORN_MARKER_KEY, foldId: TORN_MARKER_KEY });
      return out;
    },
    release: (topicKey, foldId) => removeFoldMarkers(stateDir, topicKey, foldId),
  };
}
