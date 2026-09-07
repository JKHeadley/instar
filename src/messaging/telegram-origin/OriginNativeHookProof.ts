import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';
import path from 'node:path';

export const originHookSettingsDigest = (text: string): string => createHash('sha256').update(text).digest('hex');

/** Called only by the real CLI launch seam, never by restart re-enrollment.
 * Missing/unreadable settings allow session launch but cannot establish load proof. */
export async function captureOriginHookSettings(projectDir: string, harness: string): Promise<string | undefined> {
  const file = harness === 'claude-code' ? '.claude/settings.json' : harness === 'codex-cli' ? '.codex/hooks.json' : null;
  if (!file) return;
  try {
    const handle = await open(path.join(projectDir, file), 'r');
    try {
      const before = await handle.stat();
      if (!before.isFile() || before.size > 2 * 1024 * 1024) return;
      const bytes = Buffer.alloc(before.size), result = await handle.read(bytes, 0, bytes.length, 0), after = await handle.stat();
      if (result.bytesRead !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs) return;
      return originHookSettingsDigest(bytes.toString('utf8'));
    } finally { await handle.close(); }
  } catch { return; }
}

/** A challenge response becomes evidence only inside a native hook result.
 * Ordinary API replies and assistant/tool text are not listener observations. */
export const ORIGIN_HOOK_PROOF_PREFIX = 'INSTAR_ORIGIN_HOOK_PROOF_V1:';
export interface OriginHookChallenge {
  nonce: string;
  sessionIncarnation: string;
  nativeSessionId: string;
  guardDigest: string;
  issuedAt: number;
}
export interface OriginNativeHookProof extends OriginHookChallenge {
  command: string;
  toolUseId: string;
  sourceEventRef: string;
  observedAt: number;
}
export interface OriginHookMarker extends OriginHookChallenge { command?: string; toolUseId?: string; hookEvent?: string }
export function parseOriginHookMarker(output: unknown): OriginHookMarker | undefined {
  if (typeof output !== 'string' || output.length > 16_384) return;
  for (const line of output.split('\n')) {
    if (!line.startsWith(ORIGIN_HOOK_PROOF_PREFIX) || line.length > 1024) continue;
    try {
      const value = JSON.parse(Buffer.from(line.slice(ORIGIN_HOOK_PROOF_PREFIX.length), 'base64url').toString('utf8'));
      if (value && /^[A-Za-z0-9_-]{43}$/.test(value.nonce) && /^[a-f0-9-]{36}$/.test(value.sessionIncarnation) &&
        typeof value.nativeSessionId === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value.nativeSessionId) &&
        /^[a-f0-9]{64}$/.test(value.guardDigest) && Number.isSafeInteger(value.issuedAt) && value.issuedAt > 0) return value;
    } catch { /* Non-markers never become observations. */ }
  }
}
