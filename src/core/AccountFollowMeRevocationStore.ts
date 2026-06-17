/**
 * WS5.2 R12.iii — durable pending-wipe ledger for AccountFollowMeRevocation.
 *
 * The pure executor (`AccountFollowMeRevocation`) takes a `PendingWipeStore` seam; the in-memory
 * variant (`inMemoryPendingWipeStore`) is for tests. This is the PRODUCTION durable backing: a
 * single JSON file under the agent state dir, written atomically via SafeFsExecutor (crash-safe,
 * audited). A pending wipe MUST survive a server restart — an offline target that reconnects after
 * a bounce must still get its copy destroyed, and the reconnect-deadline give-up must still fire.
 *
 * Keyed exactly as the executor expects: `${accountId}::${targetMachineId}`. Reads tolerate a
 * missing/corrupt file (treated as empty — fail-safe: a lost ledger means a pending wipe is
 * forgotten, which the spec's honest end-state handles via provider rotation, never a false
 * "removed"). Writes are best-effort-atomic; a write failure throws so the caller surfaces it
 * rather than silently losing durability.
 */

import fs from 'node:fs';
import path from 'node:path';
import { SafeFsExecutor } from './SafeFsExecutor.js';
import type { PendingWipeRecord, PendingWipeStore } from './AccountFollowMeRevocation.js';

const FILE = 'account-follow-me-revocation-pending.json';

interface FileShape {
  version: 1;
  records: PendingWipeRecord[];
}

const keyOf = (accountId: string, targetMachineId: string): string => `${accountId}::${targetMachineId}`;

/**
 * Durable, JSON-file-backed pending-wipe store. `stateDir` is the agent state dir
 * (`config.stateDir`); the ledger lives at `<stateDir>/account-follow-me-revocation-pending.json`.
 */
export class DurablePendingWipeStore implements PendingWipeStore {
  private readonly filePath: string;
  private map = new Map<string, PendingWipeRecord>();

  constructor(opts: { stateDir: string }) {
    this.filePath = path.join(opts.stateDir, FILE);
    this.load();
  }

  private load(): void {
    try {
      if (!fs.existsSync(this.filePath)) return;
      const raw = fs.readFileSync(this.filePath, 'utf-8');
      const parsed = JSON.parse(raw) as FileShape;
      if (!parsed || !Array.isArray(parsed.records)) return;
      for (const r of parsed.records) {
        if (r && typeof r.accountId === 'string' && typeof r.targetMachineId === 'string') {
          this.map.set(keyOf(r.accountId, r.targetMachineId), r);
        }
      }
    } catch {
      // @silent-fallback-ok: a missing/corrupt ledger is treated as empty. A forgotten pending wipe
      // resolves to the honest provider-rotation end-state, never a false "removed" — fail-safe.
      this.map = new Map();
    }
  }

  private persist(): void {
    const out: FileShape = { version: 1, records: [...this.map.values()] };
    // Throws on failure — durability is load-bearing here; the caller surfaces a write error
    // rather than silently believing the pending wipe is recorded.
    SafeFsExecutor.atomicWriteJsonSync(this.filePath, out, {
      operation: 'AccountFollowMeRevocationStore.persist',
    });
  }

  put(record: PendingWipeRecord): void {
    this.map.set(keyOf(record.accountId, record.targetMachineId), record);
    this.persist();
  }

  remove(accountId: string, targetMachineId: string): void {
    if (this.map.delete(keyOf(accountId, targetMachineId))) {
      this.persist();
    }
  }

  get(accountId: string, targetMachineId: string): PendingWipeRecord | undefined {
    return this.map.get(keyOf(accountId, targetMachineId));
  }

  all(): PendingWipeRecord[] {
    return [...this.map.values()];
  }
}
