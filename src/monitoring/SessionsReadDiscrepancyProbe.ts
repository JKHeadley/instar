import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const SESSIONS_READ_PROBE_MAX_BYTES = 128 * 1024;

export interface SessionsReadDiscrepancy {
  sessionsCount: number;
  reaperCount: number;
  sessionIds: string[];
  reaperSessionIds: string[];
}

/**
 * Record only a disagreement between the two independently-backed live-session
 * read surfaces. The single JSONL file is hard-capped: once the next row would
 * cross the cap, it starts a fresh file with that row. This probe must never
 * make GET /sessions fail.
 */
export function recordSessionsReadDiscrepancy(
  stateDir: string,
  observation: SessionsReadDiscrepancy,
  now: () => Date = () => new Date(),
  hostname: () => string = os.hostname,
): boolean {
  if (observation.sessionsCount === observation.reaperCount) return false;

  try {
    const logPath = path.join(stateDir, 'logs', 'sessions-read-discrepancies.jsonl');
    const row = `${JSON.stringify({
      ts: now().toISOString(),
      hostname: hostname(),
      ...observation,
    })}\n`;
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    const currentBytes = fs.existsSync(logPath) ? fs.statSync(logPath).size : 0;
    if (currentBytes + Buffer.byteLength(row) > SESSIONS_READ_PROBE_MAX_BYTES) {
      fs.writeFileSync(logPath, row, { mode: 0o600 });
    } else {
      fs.appendFileSync(logPath, row, { mode: 0o600 });
    }
    return true;
  } catch {
    return false;
  }
}
