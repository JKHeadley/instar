/**
 * guardAcceptedFallbacks — durable, per-machine operator-accept records for the
 * G3 dark-but-load-bearing classification (g3-dark-but-load-bearing-guards §2.4).
 *
 * A load-bearing guard sitting in a silent-unguarded posture is a loud
 * `loadBearingGap` — UNLESS an operator has recorded an OWNED acceptance of the
 * risk. That acceptance lives here: `state/guard-accepted-fallbacks.json`, keyed
 * `<machineId>:<guardKey>` → `{ reason, owner, acceptedAt }`. Per-machine by
 * design (an accept on the Mini does NOT silence a peer's gap — each decision is
 * local, §4).
 *
 * This module owns ALL disk I/O for accepts so the classifier
 * (`guardPostureView.ts`) stays PURE: the CALLER reads the file ONCE per inventory
 * build via `readAcceptedFallbacks` + `scopeAcceptedFallbacks`, then threads the
 * scoped guardKey→record map into `buildGuardInventory` (§2.6). The route
 * (`POST/DELETE /guards/:key/accept-fallback`) uses the write/delete helpers.
 */

import fs from 'node:fs';
import path from 'node:path';

export interface AcceptedFallbackRecord {
  reason: string;
  owner: string;
  acceptedAt: string;
}

/** The full on-disk map, keyed `<machineId>:<guardKey>`. */
export type AcceptedFallbackFile = Record<string, AcceptedFallbackRecord>;

/** A single machine's records, re-keyed by guardKey (what the classifier consumes). */
export type ScopedAcceptedFallbacks = Record<string, AcceptedFallbackRecord>;

function acceptFilePath(stateDir: string): string {
  return path.join(stateDir, 'state', 'guard-accepted-fallbacks.json');
}

/** meshSelfId ?? 'local' — a single-machine agent (no mesh id) keys under 'local'
 *  consistently across the write (route) and the read (inventory build). */
export function machineScopeId(meshSelfId: string | null | undefined): string {
  return meshSelfId && meshSelfId.trim() ? meshSelfId.trim() : 'local';
}

function composeKey(machineId: string, guardKey: string): string {
  return `${machineId}:${guardKey}`;
}

function isRecord(v: unknown): v is AcceptedFallbackRecord {
  if (!v || typeof v !== 'object') return false;
  const r = v as Record<string, unknown>;
  return typeof r.reason === 'string' && typeof r.owner === 'string' && typeof r.acceptedAt === 'string';
}

/**
 * Read the full accept file (all machines). Missing/corrupt ⇒ empty map (the SAFE
 * direction: no phantom accept can suppress a real gap from a bad file).
 */
export function readAcceptedFallbacks(stateDir: string): AcceptedFallbackFile {
  const file = acceptFilePath(stateDir);
  try {
    if (!fs.existsSync(file)) return {};
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8')) as unknown;
    if (!parsed || typeof parsed !== 'object') return {};
    const out: AcceptedFallbackFile = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (isRecord(v)) out[k] = { reason: v.reason, owner: v.owner, acceptedAt: v.acceptedAt };
    }
    return out;
  } catch {
    // @silent-fallback-ok — a missing/corrupt accept file must yield an EMPTY map
    // (the SAFE direction): no phantom accept can suppress a real load-bearing gap.
    return {};
  }
}

/** Filter the full map to ONE machine's records, re-keyed by guardKey. */
export function scopeAcceptedFallbacks(
  all: AcceptedFallbackFile,
  meshSelfId: string | null | undefined,
): ScopedAcceptedFallbacks {
  const machineId = machineScopeId(meshSelfId);
  const prefix = `${machineId}:`;
  const out: ScopedAcceptedFallbacks = {};
  for (const [k, v] of Object.entries(all)) {
    if (k.startsWith(prefix)) out[k.slice(prefix.length)] = v;
  }
  return out;
}

function writeFile(stateDir: string, data: AcceptedFallbackFile): void {
  const file = acceptFilePath(stateDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  /* state-registry: guard-accepted-fallbacks */
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8');
  fs.renameSync(tmp, file);
}

/**
 * Record an owned operator acceptance for `<machineId>:<guardKey>`. `acceptedAt`
 * is the server timestamp (never client-supplied). Returns the written record.
 */
export function writeAcceptedFallback(
  stateDir: string,
  meshSelfId: string | null | undefined,
  guardKey: string,
  reason: string,
  owner: string,
  now: number = Date.now(),
): AcceptedFallbackRecord {
  const all = readAcceptedFallbacks(stateDir);
  const record: AcceptedFallbackRecord = { reason, owner, acceptedAt: new Date(now).toISOString() };
  all[composeKey(machineScopeId(meshSelfId), guardKey)] = record;
  writeFile(stateDir, all);
  return record;
}

/**
 * Revoke a per-machine accept. Returns true when a record existed and was removed.
 * Scopes to the JSON operator record ONLY — never touches the manifest soak
 * constant (nothing to re-seed; reboot-stable, §2.4).
 */
export function deleteAcceptedFallback(
  stateDir: string,
  meshSelfId: string | null | undefined,
  guardKey: string,
): boolean {
  const all = readAcceptedFallbacks(stateDir);
  const key = composeKey(machineScopeId(meshSelfId), guardKey);
  if (!(key in all)) return false;
  delete all[key];
  writeFile(stateDir, all);
  return true;
}
