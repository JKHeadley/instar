/**
 * McpLoadedSetStore — durable per-topic "which MCP servers is this session running
 * with" state for the dynamic MCP lifecycle (DYNAMIC-MCP-LIFECYCLE-SPEC). This is
 * the single source of truth the spawn builder reads (to launch with the current
 * set) and the driver writes (load/offload), so a `--resume` restart re-launches
 * with the right set.
 *
 * Two-phase commit (fold M1/M3): a `committed:false` write is in-flight and is
 * IGNORED by the reader (`readCommitted` returns null) — so a load/offload that
 * writes the new set then fails to restart leaves the live session on its OLD set,
 * never a phantom unapproved change. Only a `committed:true` write is authoritative.
 *
 * Writes are atomic (temp + rename on the same dir) so a crash mid-write can never
 * leave a torn file the reader would choke on.
 */

import fs from 'node:fs';
import path from 'node:path';

export interface LoadedSetRecord {
  servers: string[];
  committed: boolean;
  updatedAt: string;
  reason: string;
}

export class McpLoadedSetStore {
  /** @param dir e.g. `<projectDir>/.instar/state/mcp-loaded` */
  constructor(private readonly dir: string) {}

  private pathFor(topicId: number): string {
    return path.join(this.dir, `${topicId}.json`);
  }

  /** Raw record (committed or not), or null if absent/unreadable. */
  read(topicId: number): LoadedSetRecord | null {
    try {
      const raw = fs.readFileSync(this.pathFor(topicId), 'utf-8');
      const rec = JSON.parse(raw);
      if (!rec || typeof rec !== 'object') return null;
      const servers = Array.isArray(rec.servers)
        ? rec.servers.filter((s: unknown) => typeof s === 'string' && (s as string).length > 0)
        : [];
      return {
        servers,
        committed: rec.committed === true,
        updatedAt: typeof rec.updatedAt === 'string' ? rec.updatedAt : '',
        reason: typeof rec.reason === 'string' ? rec.reason : '',
      };
    } catch {
      return null; // absent OR unreadable — caller distinguishes via exists()
    }
  }

  /** True iff a state file EXISTS on disk (regardless of readability). */
  exists(topicId: number): boolean {
    try { return fs.existsSync(this.pathFor(topicId)); } catch { return false; }
  }

  /** The COMMITTED server set, or null when there is no committed record (absent,
   *  un-committed/in-flight, or unreadable). The reader's two-phase contract. */
  readCommitted(topicId: number): string[] | null {
    const rec = this.read(topicId);
    if (!rec || !rec.committed) return null;
    return rec.servers;
  }

  /** Atomically write the loaded set. `committed:false` = in-flight (ignored by
   *  readCommitted); `committed:true` = authoritative. Throws on a write failure
   *  so the caller (driver) can react — the caller is responsible for fail-safety. */
  write(topicId: number, servers: string[], committed: boolean, reason: string, nowIso?: string): void {
    fs.mkdirSync(this.dir, { recursive: true });
    const rec: LoadedSetRecord = {
      servers: [...new Set(servers.filter((s) => typeof s === 'string' && s.length > 0))],
      committed,
      updatedAt: nowIso ?? new Date().toISOString(),
      reason,
    };
    const finalPath = this.pathFor(topicId);
    const tmpPath = `${finalPath}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(rec, null, 2));
    fs.renameSync(tmpPath, finalPath); // atomic on the same filesystem
  }
}
