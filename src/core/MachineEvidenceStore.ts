/**
 * MachineEvidenceStore — durable last DIRECT contact per peer machine
 * (trustworthy-machine-load-and-mesh-floor spec, A3).
 *
 * The pool registry is rebuilt from heartbeats, so after a local server
 * restart every peer used to read `online:false` with no time at all — the
 * 2026-10-25 "offline" misreport. This store persists each peer's most recent
 * direct success (receiver-side receipt time, plus the load average it carried)
 * so a restart renders "stale, last direct contact 20:35, load 11.5" instead.
 *
 * Saved evidence is DISPLAY ONLY: it never makes a machine `online`, never
 * feeds placement, and keeps its original receipt time forever (re-reading the
 * file never makes it younger). Follows the GuardPostureStore pattern.
 *
 * Identity rule: records are keyed on the REGISTRY's machine identity at the
 * heartbeat-ingestion chokepoint; a body-claimed id never reaches this store.
 */

import fs from 'node:fs';
import path from 'node:path';

export interface StoredDirectEvidence {
  /** Receiver-side receipt epoch-ms of the direct success. */
  receivedAtMs: number;
  /** The machine's own reported time at that contact (advisory, ISO). */
  originAt?: string;
  /** Raw load average carried by that contact, when it carried one. */
  loadAvg?: number;
}

interface StoreFileShape {
  version: 1;
  machines: Record<string, StoredDirectEvidence>;
}

/** Re-persist a machine at most this often (the presence pass runs every 30 s). */
export const EVIDENCE_PERSIST_INTERVAL_MS = 60_000;
/** Saved evidence older than this is dropped at load (the file stays bounded). */
export const EVIDENCE_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

export class MachineEvidenceStore {
  private readonly filePath: string;
  private machines: Record<string, StoredDirectEvidence> = {};
  private readonly lastPersistMs = new Map<string, number>();
  private readonly nowFn: () => number;

  constructor(stateDir: string, now: () => number = Date.now) {
    this.filePath = path.join(stateDir, 'state', 'machine-direct-evidence.json');
    this.nowFn = now;
    this.load();
  }

  private load(): void {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf-8')) as StoreFileShape;
      if (parsed && typeof parsed === 'object' && parsed.machines && typeof parsed.machines === 'object') {
        const cutoff = this.nowFn() - EVIDENCE_RETENTION_MS;
        this.machines = Object.fromEntries(
          Object.entries(parsed.machines).filter(
            ([, v]) => v && typeof v.receivedAtMs === 'number' && Number.isFinite(v.receivedAtMs) && v.receivedAtMs >= cutoff,
          ),
        );
      }
    } catch {
      // @silent-fallback-ok — absent/corrupt store starts empty; peers then
      // read `unknown` until a direct contact, never an invented time.
      this.machines = {};
    }
  }

  /** Record a direct success. Persists at most once per interval per machine. */
  record(machineId: string, ev: StoredDirectEvidence): void {
    const prev = this.machines[machineId];
    if (prev && prev.receivedAtMs >= ev.receivedAtMs) return; // never move backwards
    this.machines[machineId] = ev;
    const last = this.lastPersistMs.get(machineId);
    if (last !== undefined && ev.receivedAtMs - last < EVIDENCE_PERSIST_INTERVAL_MS) return;
    this.lastPersistMs.set(machineId, ev.receivedAtMs);
    this.persist();
  }

  private persist(): void {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      const tmp = `${this.filePath}.tmp`;
      /* state-registry: machine-direct-evidence */
      fs.writeFileSync(tmp, JSON.stringify({ version: 1, machines: this.machines } satisfies StoreFileShape, null, 2));
      fs.renameSync(tmp, this.filePath);
    } catch {
      // @silent-fallback-ok — a failed persist keeps the in-memory copy
      // serving; only restart durability degrades, and the next interval retries.
    }
  }

  /** The saved record as it was LOADED or last recorded (original time preserved). */
  get(machineId: string): StoredDirectEvidence | null {
    return this.machines[machineId] ?? null;
  }
}
