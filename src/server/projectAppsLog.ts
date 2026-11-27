/**
 * Project apps audit log (docs/specs/project-apps.md §10a): `logs/project-apps.jsonl` in the agent's
 * state dir. Offers, answers (how made), Open taps (app ref only) and pin outcomes. Never content.
 */
import fs from 'node:fs';
import path from 'node:path';

const MAX_READ_BYTES = 2 * 1024 * 1024;

function logPath(stateDir: string): string {
  return path.join(stateDir, 'logs', 'project-apps.jsonl');
}

export function projectAppsLog(stateDir: string, entry: Record<string, unknown>): void {
  try {
    const p = logPath(stateDir);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.appendFileSync(p, `${JSON.stringify(entry)}\n`);
  } catch { /* @silent-fallback-ok — an audit line that cannot be written never fails the owner's tap */ }
}

/** Open taps recorded on this machine (newest 2 MB of the log). */
export function projectAppsOpens(stateDir: string): Array<{ appRef: string; conversationKey: string; at: string }> {
  try {
    const p = logPath(stateDir);
    const size = fs.statSync(p).size;
    const fd = fs.openSync(p, 'r');
    try {
      const start = Math.max(0, size - MAX_READ_BYTES);
      const buf = Buffer.alloc(size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      const out: Array<{ appRef: string; conversationKey: string; at: string }> = [];
      for (const line of buf.toString('utf8').split('\n')) {
        if (!line.trim()) continue;
        try {
          const e = JSON.parse(line) as Record<string, unknown>;
          if (e.event === 'opened' && typeof e.appRef === 'string' && typeof e.conversationKey === 'string' && typeof e.at === 'string') out.push({ appRef: e.appRef, conversationKey: e.conversationKey, at: e.at });
        } catch { /* @silent-fallback-ok — a torn line (the first one after the cut) is skipped */ }
      }
      return out;
    } finally { fs.closeSync(fd); }
  } catch { return []; } // @silent-fallback-ok — no log yet means no Open taps recorded here
}
