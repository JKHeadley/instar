import { parentPort, workerData } from 'node:worker_threads';
import fs from 'node:fs';
import path from 'node:path';
import { parseCodexRollout, type ParsedCodexSession } from './CodexRolloutParser.js';
import { listAllRollouts } from '../providers/adapters/openai-codex/observability/sessionPaths.js';

export interface ScanInput {
  projectDir?: string;
  codexHome?: string;
  limit: number;
  maxFileAgeMs?: number;
}
export interface ScanUpdate { parsed: ParsedCodexSession; lastTs: number }
export interface ScanOutput { filesScanned: number; updates: ScanUpdate[] }

async function scan(input: ScanInput): Promise<ScanOutput> {
  const targetDir = input.projectDir ? path.resolve(input.projectDir) : null;
  const cutoff = input.maxFileAgeMs && input.maxFileAgeMs > 0 ? Date.now() - input.maxFileAgeMs : 0;
  let rollouts: ReadonlyArray<{ path: string; mtime: number }>;
  try {
    rollouts = await listAllRollouts(input.codexHome, input.limit);
  } catch {
    return { filesScanned: 0, updates: [] };
  }
  const updates: ScanUpdate[] = [];
  let filesScanned = 0;
  // Preserve listAllRollouts' descending-mtime order exactly. This is
  // observable when duplicate files contain the same session id: the legacy
  // scan upserted in this order, so the oldest selected file won.
  for (const { path: rolloutPath, mtime } of rollouts) {
    if (cutoff && mtime < cutoff) continue;
    filesScanned++;
    let content: string;
    try {
      content = await fs.promises.readFile(rolloutPath, 'utf8');
    } catch { continue; }
    const parsed = parseCodexRollout(content);
    if (!parsed) continue;
    if (targetDir) {
      const cwd = parsed.cwd ? path.resolve(parsed.cwd) : null;
      if (!cwd || (cwd !== targetDir && !cwd.startsWith(targetDir + path.sep))) continue;
    }
    updates.push({ parsed, lastTs: mtime });
  }
  return { filesScanned, updates };
}

if (parentPort) {
  scan(workerData as ScanInput)
    .then((result) => parentPort!.postMessage({ ok: true, result }))
    .catch((error) => parentPort!.postMessage({ ok: false, error: error instanceof Error ? error.message : String(error) }));
}
