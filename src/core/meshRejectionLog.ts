/**
 * Mesh-rejection trace log (silent-loss-refusal-conservation §2.B).
 *
 * The DECIDING (owner) machine appends ONE metadata-only JSONL row to
 * `logs/mesh-rejections.jsonl` whenever it NACKs a forwarded `deliverMessage`
 * with `sender-rejected`. The 2026-07-01 incident was forensically blank on the
 * deciding machine — it was diagnosed only from the SENDER's ledger. This closes
 * that gap.
 *
 * Contract (§2.B):
 *   - fields EXACTLY `{ ts, reason, session, messageId, senderUid }` — never
 *     payload (`rejection-trace-never-contains-payload`).
 *   - file mode 0600, re-chmod'd 0600 after any `maybeRotateJsonl` rewrite (the
 *     rotator writes with no mode → 0644, so 0600 must be re-applied post-rotation).
 *   - bounded via `maybeRotateJsonl(logPath, {maxBytes, keepRatio:0.5})` on the
 *     APPEND path only (NOT the SessionMaintenanceRunner allowlist — a no-op for
 *     logs/, which is a sibling of stateDir).
 *   - machine-local BY DESIGN (forensics of the deciding owner — replicating
 *     defeats "which machine decided").
 *   - never throws — a trace fault never changes the NACK.
 */

import fs from 'node:fs';
import path from 'node:path';
import { maybeRotateJsonl } from '../utils/jsonl-rotation.js';

export const MESH_REJECTIONS_LOG_FILENAME = 'mesh-rejections.jsonl';
/** ~2MB cap — metadata-only rows, small blast radius; keep the recent half. */
const MESH_REJECTIONS_MAX_BYTES = 2 * 1024 * 1024;
const MESH_REJECTIONS_KEEP_RATIO = 0.5;

export interface MeshRejectionRow {
  reason: 'sender-rejected';
  session: string;
  messageId: string;
  senderUid?: number;
}

/** Resolve the machine-local trace log path (a `logs/` sibling of the state dir). */
export function meshRejectionsLogPath(stateDir: string): string {
  return path.join(stateDir, 'logs', MESH_REJECTIONS_LOG_FILENAME);
}

/**
 * Append one metadata-only rejection row. Never throws. Rotates on the append
 * path and re-chmods 0600 (the rotator rewrites 0644). METADATA ONLY — the
 * caller must never pass payload/command bytes.
 */
export function appendMeshRejection(stateDir: string, row: MeshRejectionRow): void {
  try {
    const logPath = meshRejectionsLogPath(stateDir);
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    // Bound BEFORE the append (rotate the existing file if oversized), then
    // re-apply 0600 — the rotator's writeFileSync leaves 0644.
    const rotated = maybeRotateJsonl(logPath, { maxBytes: MESH_REJECTIONS_MAX_BYTES, keepRatio: MESH_REJECTIONS_KEEP_RATIO });
    if (rotated) {
      try { fs.chmodSync(logPath, 0o600); } catch { /* best-effort */ }
    }
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      reason: row.reason,
      session: row.session,
      messageId: row.messageId,
      ...(typeof row.senderUid === 'number' && Number.isFinite(row.senderUid) ? { senderUid: row.senderUid } : {}),
    }) + '\n';
    const existed = fs.existsSync(logPath);
    fs.appendFileSync(logPath, line);
    // Set 0600 on first creation (appendFileSync creates 0666&~umask).
    if (!existed) {
      try { fs.chmodSync(logPath, 0o600); } catch { /* best-effort */ }
    }
  } catch {
    // @silent-fallback-ok: a trace fault must never change the NACK or crash the
    // owner-side handler; the durable ledger is the authority for dedupe.
  }
}
