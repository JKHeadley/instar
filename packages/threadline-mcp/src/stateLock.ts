/**
 * One threadline-mcp per state directory owns pairing (Echo's review of #2192, SEC-5).
 *
 * Claude Desktop and every Claude Code session each start their own threadline-mcp, all on one
 * state directory and one identity. Without coordination they race on the pairing stores and the
 * relay. The owner holds `<stateDir>/threadline/owner.lock` (its pid, created exclusively); a lock
 * whose pid is no longer running is stale and is taken over. Only the owner pairs and writes
 * pairing state; the others refuse pairing and credentials and re-read
 * pins from disk for every message.
 */

import fs from 'node:fs';
import path from 'node:path';

export interface StateLock { held: boolean; holderPid: number | null; release(): void }

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; } };

export function acquireStateLock(stateDir: string, pid = process.pid): StateLock {
  const file = path.join(stateDir, 'threadline', 'owner.lock');
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(file, String(pid), { flag: 'wx', mode: 0o600 });
      return { held: true, holderPid: pid, release: () => { try { if (fs.readFileSync(file, 'utf8').trim() === String(pid)) fs.unlinkSync(file); } catch { /* gone */ } } };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      const holder = Number.parseInt(fs.readFileSync(file, 'utf8').trim(), 10);
      if (Number.isInteger(holder) && holder > 0 && holder !== pid && alive(holder)) {
        return { held: false, holderPid: holder, release: () => {} };
      }
      // Stale (dead holder or unreadable): remove and try once more. A racing starter that wins
      // the exclusive create in between is respected.
      try { fs.unlinkSync(file); } catch { /* someone else removed it */ }
    }
  }
  const holder = Number.parseInt(fs.readFileSync(file, 'utf8').trim(), 10);
  return { held: false, holderPid: Number.isInteger(holder) ? holder : null, release: () => {} };
}
