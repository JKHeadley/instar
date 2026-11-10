/**
 * Keep-instructions for the PreCompact steering hook
 * (context-budget-layered-summaries §9.1, §9.5, §7.1).
 *
 * When Claude Code compacts a conversation it runs the `PreCompact` hooks and
 * merges every successful hook's stdout into the summary prompt as
 * `newCustomInstructions` (verified in Claude Code 2.1.321: stdout of a hook
 * that succeeded and did not block is pushed, joined with blank lines, and cut
 * at 10,000 characters). The installed `pre-compact-steer.sh` prints the
 * PRE-RENDERED keep-instructions staged here for its Instar session and never
 * composes anything itself.
 *
 *   <stateDir>/state/context-layers/_keep/<instarSessionId>.md    the text
 *   <stateDir>/state/context-layers/_keep/<instarSessionId>.json  the pointer
 *
 * The pointer carries the text's sha256; the hook prints the text only when
 * the hash matches, so a half-written or swapped file prints nothing. Unlike
 * the clear-seed pointer this one is STANDING: it is not claimed, and applies
 * to every compaction of that session until rewritten or removed. Keyed on
 * INSTAR_SESSION_ID (survives /clear and compaction; the Claude id does not).
 *
 * This module is the single writer of the schema the hook reads; keep the two
 * in step (KEEP_INSTRUCTIONS_PY in PostUpdateMigrator).
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { SafeFsExecutor } from '../core/SafeFsExecutor.js';
import { contextLayersRoot } from './clearSeedPointer.js';

const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;
/**
 * Claude Code cuts each PreCompact hook's output at 10,000 characters (2.1.321,
 * `DFe=1e4`, applied per output before the join). We refuse anything over 9,000
 * so the text always arrives whole, with a margin against a future lower cap.
 */
export const KEEP_INSTRUCTIONS_MAX_CHARS = 9000;
/** The hook reads at most this many bytes of the text file. */
export const KEEP_INSTRUCTIONS_MAX_BYTES = 4 * KEEP_INSTRUCTIONS_MAX_CHARS;

export interface KeepInstructionsPointer {
  schema: 'keep-instructions/1';
  instarSessionId: string;
  /** Text path relative to the context-layers root. */
  textPath: string;
  sha256: string;
  chars: number;
  /** What rendered it (e.g. `standing-packet`, `fold:<foldId>`), for the audit trail. */
  source: string;
  writtenAt: number;
}

export type WriteKeepResult =
  | { written: true; pointer: KeepInstructionsPointer }
  | { written: false; reason: 'unsafe-id' | 'empty' | 'too-long' | 'unsafe-source' | 'write-failed' };

export function keepInstructionsDir(stateDir: string): string {
  return path.join(contextLayersRoot(stateDir), '_keep');
}

function paths(stateDir: string, instarSessionId: string): { text: string; pointer: string } | null {
  if (!SAFE_ID.test(instarSessionId)) return null;
  const dir = keepInstructionsDir(stateDir);
  return { text: path.join(dir, `${instarSessionId}.md`), pointer: path.join(dir, `${instarSessionId}.json`) };
}

/**
 * Stage pre-rendered keep-instructions for one Instar session. Text first,
 * then the pointer (atomic renames), so the hook never sees a pointer whose
 * text is missing; a stale pointer over new text fails the hash and prints
 * nothing. Dirs 0700, files 0600.
 */
export function writeKeepInstructions(
  stateDir: string,
  input: { instarSessionId: string; text: string; source: string },
  now: number = Date.now(),
): WriteKeepResult {
  const p = paths(stateDir, input.instarSessionId);
  if (!p) return { written: false, reason: 'unsafe-id' };
  if (!/^[A-Za-z0-9_:.-]{1,160}$/.test(input.source)) return { written: false, reason: 'unsafe-source' };
  const text = typeof input.text === 'string' ? input.text.trim() : '';
  if (!text) return { written: false, reason: 'empty' };
  if (text.length > KEEP_INSTRUCTIONS_MAX_CHARS) return { written: false, reason: 'too-long' };
  const body = Buffer.from(text, 'utf-8');
  if (body.length > KEEP_INSTRUCTIONS_MAX_BYTES) return { written: false, reason: 'too-long' };
  const pointer: KeepInstructionsPointer = {
    schema: 'keep-instructions/1',
    instarSessionId: input.instarSessionId,
    textPath: path.relative(contextLayersRoot(stateDir), p.text),
    sha256: crypto.createHash('sha256').update(body).digest('hex'),
    chars: text.length,
    source: input.source,
    writtenAt: now,
  };
  try {
    for (const d of [contextLayersRoot(stateDir), keepInstructionsDir(stateDir)]) {
      fs.mkdirSync(d, { recursive: true, mode: 0o700 });
      fs.chmodSync(d, 0o700);
    }
    fs.writeFileSync(`${p.text}.tmp`, body, { mode: 0o600 });
    fs.renameSync(`${p.text}.tmp`, p.text);
    fs.writeFileSync(`${p.pointer}.tmp`, JSON.stringify(pointer), { mode: 0o600 });
    fs.renameSync(`${p.pointer}.tmp`, p.pointer);
    return { written: true, pointer };
  } catch {
    return { written: false, reason: 'write-failed' };
  }
}

/** Remove a session's keep-instructions (pointer first, so the hook goes quiet at once). */
export function removeKeepInstructions(stateDir: string, instarSessionId: string): void {
  const p = paths(stateDir, instarSessionId);
  if (!p) return;
  for (const f of [p.pointer, p.text]) {
    if (fs.existsSync(f)) {
      SafeFsExecutor.safeRmSync(f, { force: true, operation: 'src/monitoring/keepInstructions.ts:removeKeepInstructions' });
    }
  }
}

/** The staged pointer for a session, or null (absent, torn, or another session's). */
export function readKeepInstructionsPointer(stateDir: string, instarSessionId: string): KeepInstructionsPointer | null {
  const p = paths(stateDir, instarSessionId);
  if (!p || !fs.existsSync(p.pointer)) return null;
  try {
    const v = JSON.parse(fs.readFileSync(p.pointer, 'utf-8')) as KeepInstructionsPointer;
    return v.instarSessionId === instarSessionId ? v : null;
  } catch {
    return null; // @silent-fallback-ok — a torn pointer reads as absent; the hook treats it the same way
  }
}
