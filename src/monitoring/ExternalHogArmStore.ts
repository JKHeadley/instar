/**
 * ExternalHogArmStore — durable persistence for the External-Hog armed marker (CMT-1901,
 * docs/specs/external-hog-zombie-autokill-sentinel.md §7-§8). The VALIDATION logic lives in the
 * reviewed ExternalHogArmMarker module; THIS is the tiny durable file behind it — the thing the
 * PIN arm route writes, the disarm route bumps, and the poll loop reads.
 *
 * On-disk shape (a small, fixed-size JSON at `<stateDir>/external-hog-arm.json`, 0600):
 *   { "marker": ArmMarker | null, "lastDisarmEpoch": number, "disarmedAt"?: string }
 *
 * The two load-bearing safety properties (proven in the marker module) are UPHELD by how this
 * store mutates the epochs:
 *  - ARM raises `armEpoch` to strictly ABOVE both the prior armEpoch AND lastDisarmEpoch, so a
 *    fresh arm always wins.
 *  - DISARM raises `lastDisarmEpoch` to ≥ the current armEpoch, so the marker becomes INVALID
 *    (`armEpoch > lastDisarmEpoch` is now false) and can never be silently un-done — returning to
 *    live-kill ALWAYS needs a fresh PIN arm (a new, higher armEpoch).
 *
 * FAIL-CLOSED reads: a missing / unreadable / corrupt / wrong-shape file returns
 * `{ marker: null, lastDisarmEpoch: 0 }` → `marker: null` means NOT armed regardless of any
 * epoch, so a damaged marker file can never authorize a kill. Writes are atomic (tmp + rename)
 * so a torn write never yields a half-parsed marker.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { ArmMarker } from './ExternalHogArmMarker.js';

export interface ArmStoreState {
  readonly marker: ArmMarker | null;
  readonly lastDisarmEpoch: number;
  readonly disarmedAt?: string;
}

/** The disarmed baseline — also the fail-closed result of any read anomaly. */
const DISARMED: ArmStoreState = { marker: null, lastDisarmEpoch: 0 };

export function armMarkerPath(stateDir: string): string {
  return path.join(stateDir, 'external-hog-arm.json');
}

/** Validate a parsed object into an ArmMarker, or null if it is not a well-formed marker. */
function coerceMarker(raw: unknown): ArmMarker | null {
  if (!raw || typeof raw !== 'object') return null;
  const m = raw as Record<string, unknown>;
  if (typeof m.armEpoch !== 'number' || !Number.isFinite(m.armEpoch)) return null;
  if (typeof m.armedBy !== 'string' || typeof m.armedAt !== 'string') return null;
  const snap = m.allowlistSnapshot;
  if (!snap || typeof snap !== 'object') return null;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(snap as Record<string, unknown>)) {
    if (typeof v !== 'string') return null; // any non-string hash → reject the whole marker (fail closed)
    out[k] = v;
  }
  return { armEpoch: m.armEpoch, armedBy: m.armedBy, armedAt: m.armedAt, allowlistSnapshot: out };
}

/**
 * Read the armed state. FAIL-CLOSED: any missing / unreadable / corrupt / wrong-shape input →
 * the disarmed baseline (marker null → not armed), never a throw.
 */
export function loadArmState(stateDir: string): ArmStoreState {
  const file = armMarkerPath(stateDir);
  try {
    if (!fs.existsSync(file)) return DISARMED;
    // The marker file is bounded-tiny by design (one marker + two numbers); a whole read is safe.
    const raw = fs.readFileSync(file, 'utf-8');
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') return DISARMED;
    const p = parsed as Record<string, unknown>;
    const lastDisarmEpoch = typeof p.lastDisarmEpoch === 'number' && Number.isFinite(p.lastDisarmEpoch)
      ? p.lastDisarmEpoch : NaN;
    if (Number.isNaN(lastDisarmEpoch) || lastDisarmEpoch < 0) return DISARMED; // corrupt epoch → fail closed
    const marker = coerceMarker(p.marker);
    const disarmedAt = typeof p.disarmedAt === 'string' ? p.disarmedAt : undefined;
    return { marker, lastDisarmEpoch, disarmedAt };
  } catch {
    return DISARMED; // unreadable / unparseable → not armed
  }
}

/**
 * Atomically + DURABLY persist a state object (tmp → fsync → rename, 0600). Never leaves a torn
 * file. The fsync closes the Phase-5 residual: a power loss in the sub-second window after a
 * DISARM must not revert to armed (the one safety-critical write direction) — fsyncing the tmp
 * fd forces the content to disk BEFORE the rename publishes it. Portable (content fsync only; the
 * rename is atomic so a reader always sees old-or-new, and "old" is a previously operator-
 * authorized, content-hash-scoped arm — never a new or widened authorization).
 */
function writeState(stateDir: string, state: ArmStoreState): void {
  fs.mkdirSync(stateDir, { recursive: true });
  const file = armMarkerPath(stateDir);
  const tmp = `${file}.tmp-${process.pid}`;
  const fd = fs.openSync(tmp, 'w', 0o600);
  try {
    fs.writeSync(fd, JSON.stringify(state, null, 2));
    fs.fsyncSync(fd); // durable: content on disk before the rename publishes it
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file); // atomic overwrite on POSIX — a reader sees old-or-new, never partial
}

/**
 * ARM: raise armEpoch strictly above both the prior armEpoch AND lastDisarmEpoch, recording the
 * class→content-hash snapshot the PIN consented to. Returns the new marker.
 */
export function armStore(
  stateDir: string,
  allowlistSnapshot: Readonly<Record<string, string>>,
  armedBy: string,
  nowIso: () => string,
): ArmMarker {
  const cur = loadArmState(stateDir);
  const priorEpoch = cur.marker && Number.isFinite(cur.marker.armEpoch) ? cur.marker.armEpoch : 0;
  const armEpoch = Math.max(priorEpoch, cur.lastDisarmEpoch) + 1;
  const marker: ArmMarker = { armEpoch, armedBy, armedAt: nowIso(), allowlistSnapshot: { ...allowlistSnapshot } };
  writeState(stateDir, { marker, lastDisarmEpoch: cur.lastDisarmEpoch });
  return marker;
}

/**
 * DISARM: raise lastDisarmEpoch to ≥ the current armEpoch so the marker is now INVALID. The
 * marker object is RETAINED (for audit) but can no longer authorize a kill. Idempotent — a
 * disarm when already disarmed just re-persists the (already ≥) epoch.
 */
export function disarmStore(stateDir: string, nowIso: () => string): ArmStoreState {
  const cur = loadArmState(stateDir);
  const markerEpoch = cur.marker && Number.isFinite(cur.marker.armEpoch) ? cur.marker.armEpoch : 0;
  const lastDisarmEpoch = Math.max(cur.lastDisarmEpoch, markerEpoch);
  const next: ArmStoreState = { marker: cur.marker, lastDisarmEpoch, disarmedAt: nowIso() };
  writeState(stateDir, next);
  return next;
}
