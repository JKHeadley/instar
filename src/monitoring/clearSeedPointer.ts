/**
 * Clear-seed pointer (context-budget-layered-summaries §9.2 rung 1).
 *
 * The fold ladder's first rung injects `/clear` into a session and lets the
 * SessionStart `clear` hook (`clear-seed.sh`, PostUpdateMigrator) print the
 * staged fold packet into the fresh context. The hook seeds ONLY when this
 * pointer exists for exactly that Instar session (INSTAR_SESSION_ID, which
 * survives /clear; the Claude session id does not), names a packet under the
 * context-layers root whose sha256 matches, and its lock has not expired. The
 * hook claims the pointer with an atomic rename before printing, so a packet
 * seeds at most once; it then writes the seeded marker with `epoch = foldId`.
 *
 * This module is the single writer of the pointer schema the hook reads; keep
 * the two in step (CLEAR_SEED_PY in PostUpdateMigrator).
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { SafeFsExecutor } from '../core/SafeFsExecutor.js';

/** Matches the hook's id check: `[A-Za-z0-9_-]`, at most 128 characters. */
const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;
/** The hook refuses a packet larger than this (it reads at most this many bytes). */
export const CLEAR_SEED_MAX_PACKET_BYTES = 8 * 1024 * 1024;

export interface ClearSeedPointer {
  /** The Instar session id (INSTAR_SESSION_ID in the pane); the pointer's key. */
  instarSessionId: string;
  /** The Claude session id before the clear, for the audit trail only. */
  claudeSessionId: string;
  foldId: string;
  /** Packet path relative to `<stateDir>/state/context-layers/`. */
  packetPath: string;
  sha256: string;
  /** Epoch ms; the hook refuses the pointer at or after this instant. */
  leaseExpiresAt: number;
  writtenAt: number;
  /** The fold's topic, so the fold boot sweep can match this carrier to its record. */
  topicKey?: string;
}

export function contextLayersRoot(stateDir: string): string {
  return path.join(stateDir, 'state', 'context-layers');
}

export function clearSeedPointerPath(stateDir: string, instarSessionId: string): string | null {
  if (!SAFE_ID.test(instarSessionId)) return null;
  return path.join(contextLayersRoot(stateDir), '_clear-seed', `${instarSessionId}.json`);
}

/**
 * Stage a pointer to an already-written packet. Refuses (returns null) an
 * unsafe id, a packet outside the context-layers root, a packet over the hook's
 * size limit, or an expiry not in the future. Atomic replace; dir 0700, file 0600.
 */
export function writeClearSeedPointer(
  stateDir: string,
  input: { instarSessionId: string; claudeSessionId: string; foldId: string; packetFile: string; leaseExpiresAt: number; topicKey?: string },
  now: number = Date.now(),
): ClearSeedPointer | null {
  const ptrPath = clearSeedPointerPath(stateDir, input.instarSessionId);
  if (!ptrPath || !SAFE_ID.test(input.foldId) || !(input.leaseExpiresAt > now)) return null;
  const root = fs.existsSync(contextLayersRoot(stateDir)) ? fs.realpathSync(contextLayersRoot(stateDir)) : null;
  if (!root || !fs.existsSync(input.packetFile)) return null;
  const real = fs.realpathSync(input.packetFile);
  if (!real.startsWith(root + path.sep)) return null;
  const body = fs.readFileSync(real);
  if (body.length > CLEAR_SEED_MAX_PACKET_BYTES) return null;
  const pointer: ClearSeedPointer = {
    instarSessionId: input.instarSessionId,
    claudeSessionId: input.claudeSessionId,
    foldId: input.foldId,
    packetPath: path.relative(root, real),
    sha256: crypto.createHash('sha256').update(body).digest('hex'),
    leaseExpiresAt: Math.floor(input.leaseExpiresAt),
    writtenAt: now,
    ...(input.topicKey && SAFE_ID.test(input.topicKey) ? { topicKey: input.topicKey } : {}),
  };
  fs.mkdirSync(path.dirname(ptrPath), { recursive: true, mode: 0o700 });
  const tmp = `${ptrPath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(pointer), { mode: 0o600 });
  fs.renameSync(tmp, ptrPath);
  return pointer;
}

/**
 * Release the pointer carrier for an Instar session: the live pointer (fold
 * rolled back or aborted before the clear) and every `.claimed-<ts>` sibling
 * the hook left after seeding. Called by the fold's terminal transition and the
 * boot sweep (§9.3: every carrier is released by the terminal transition).
 */
export function removeClearSeedPointer(stateDir: string, instarSessionId: string): void {
  const ptrPath = clearSeedPointerPath(stateDir, instarSessionId);
  if (!ptrPath) return;
  const dir = path.dirname(ptrPath);
  if (!fs.existsSync(dir)) return;
  const base = path.basename(ptrPath);
  for (const f of fs.readdirSync(dir)) {
    if (f === base || f.startsWith(`${base}.claimed-`)) {
      SafeFsExecutor.safeRmSync(path.join(dir, f), { force: true, operation: 'src/monitoring/clearSeedPointer.ts:removeClearSeedPointer' });
    }
  }
}

/**
 * Every clear-seed pointer on disk (live and claimed), for the fold carrier's
 * boot-sweep listing. Torn files are skipped.
 */
export function listClearSeedPointers(stateDir: string): Array<{ file: string; pointer: ClearSeedPointer }> {
  const dir = path.join(contextLayersRoot(stateDir), '_clear-seed');
  let files: string[] = [];
  try { files = fs.readdirSync(dir); } catch { return []; }
  const out: Array<{ file: string; pointer: ClearSeedPointer }> = [];
  for (const f of files) {
    if (!/\.json(\.claimed-\d+)?$/.test(f)) continue;
    try {
      const pointer = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8')) as ClearSeedPointer;
      if (pointer && typeof pointer.foldId === 'string' && typeof pointer.instarSessionId === 'string') out.push({ file: path.join(dir, f), pointer });
    } catch { /* @silent-fallback-ok — a torn pointer is not a carrier the sweep can attribute; the hook refuses it too */ }
  }
  return out;
}
