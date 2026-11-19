/**
 * Codex resume follows the account.
 *
 * `codex resume <thread>` finds the conversation only inside the `CODEX_HOME`
 * it runs under (`$CODEX_HOME/sessions/YYYY/MM/DD/rollout-<ts>-<thread>.jsonl`);
 * verified 2026-11-18 against codex 0.169.1: an empty home answers "no rollout
 * found for thread id", the same home with the rollout copied in resumes. So
 * when a Codex session is relaunched under another account's home (account swap,
 * pin), the freshest copy of its rollout must be placed there first, the Codex
 * sibling of `placeResumeTranscript` (claudeResumeTranscript.ts).
 *
 * Never deletes: a stale copy already in the target is renamed aside (the new
 * name no longer ends in `.jsonl`, so Codex and instar's lookups ignore it).
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  findRolloutFile,
  invalidateRolloutLookup,
} from '../providers/adapters/openai-codex/observability/sessionPaths.js';

export type CodexRolloutPlacement = 'present' | 'copied' | 'replaced' | 'not-found';

interface Copy { file: string; home: string; mtimeMs: number }

async function copyIn(home: string, threadId: string): Promise<Copy | null> {
  const file = await findRolloutFile(threadId, home);
  if (!file) return null;
  try {
    const st = await fs.stat(file);
    return st.isFile() ? { file, home, mtimeMs: st.mtimeMs } : null;
  } catch {
    return null;
  }
}

/**
 * Make sure `targetHome` holds the freshest copy of thread `threadId`'s rollout,
 * looking for it in `sourceHomes`. Returns what it did.
 */
export async function placeCodexResumeRollout(
  threadId: string,
  targetHome: string,
  sourceHomes: readonly string[],
): Promise<{ outcome: CodexRolloutPlacement; from?: string }> {
  if (!/^[A-Za-z0-9._-]+$/.test(threadId) || threadId.includes('..')) return { outcome: 'not-found' };
  const target = path.resolve(targetHome);
  const seen = new Set<string>([target]);
  const sources: Copy[] = [];
  for (const h of sourceHomes) {
    const home = path.resolve(h);
    if (seen.has(home)) continue;
    seen.add(home);
    const c = await copyIn(home, threadId);
    if (c) sources.push(c);
  }
  const existing = await copyIn(target, threadId);
  const newest = sources.sort((a, b) => b.mtimeMs - a.mtimeMs)[0];
  if (existing && (!newest || newest.mtimeMs <= existing.mtimeMs)) return { outcome: 'present' };
  if (!newest) return { outcome: 'not-found' };

  const rel = path.relative(path.join(newest.home, 'sessions'), newest.file);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return { outcome: 'not-found' };
  const dest = existing ? existing.file : path.join(target, 'sessions', rel);
  await fs.mkdir(path.dirname(dest), { recursive: true });
  // Copy under a name Codex ignores, then swap it in: a copy cut off partway never
  // sits at the real name looking like the newest copy, and the old copy is moved
  // aside only once the new one is complete. A failed copy is left under its
  // ignored name (this module never deletes).
  const partial = `${dest}.partial-${process.pid}-${Date.now()}`;
  await fs.copyFile(newest.file, partial);
  if (existing) {
    await fs.rename(existing.file, `${existing.file}.set-aside-${Date.now()}`);
  }
  await fs.rename(partial, dest);
  invalidateRolloutLookup(threadId, targetHome);
  if (target !== targetHome) invalidateRolloutLookup(threadId, target);
  return { outcome: existing ? 'replaced' : 'copied', from: newest.home };
}
