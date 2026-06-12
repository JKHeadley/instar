/**
 * GuardPostureStore — durable last-known guard posture per machine
 * (GUARD-POSTURE-ENDPOINT-SPEC §2.3(c)).
 *
 * The in-memory pool registry is rebuilt from heartbeats, so last-known
 * posture would evaporate on a local server restart — defeating dark-peer
 * honesty in exactly the GAP-001 topology (a week-dark Mini + the laptop's
 * routine update restarts). This store persists each machine's most recent
 * posture block alongside the RECEIVER-side receipt time, reloads at boot,
 * and lets the pool view render "as of <age> ago" for a peer that has been
 * dark for days.
 *
 * Identity rule: callers key records on the REGISTRY's machine identity
 * (the heartbeat ingestion chokepoint already does) — a body-claimed
 * machineId never reaches this store.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { GuardPostureSummary } from './types.js';

export interface StoredGuardPosture {
  posture: GuardPostureSummary;
  /** Receiver-side receipt epoch-ms (the router's clock at heartbeat arrival). */
  receivedAtMs: number;
}

interface StoreFileShape {
  version: 1;
  machines: Record<string, StoredGuardPosture>;
}

export class GuardPostureStore {
  private readonly filePath: string;
  private machines: Record<string, StoredGuardPosture> = {};

  constructor(stateDir: string) {
    this.filePath = path.join(stateDir, 'state', 'guard-posture-peers.json');
    this.load();
  }

  private load(): void {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf-8')) as StoreFileShape;
      if (parsed && typeof parsed === 'object' && parsed.machines && typeof parsed.machines === 'object') {
        this.machines = parsed.machines;
      }
    } catch {
      // @silent-fallback-ok — absent/corrupt store starts empty; the next
      // heartbeat repopulates it. Posture honesty degrades to "unknown",
      // never to invented data.
      this.machines = {};
    }
  }

  /** Persist a machine's posture (write-on-change: an unchanged generatedAt
   *  refreshes nothing on disk, so the 30s heartbeat loop doesn't churn fs). */
  record(machineId: string, posture: GuardPostureSummary, receivedAtMs: number): void {
    const prev = this.machines[machineId];
    this.machines[machineId] = { posture, receivedAtMs };
    if (prev && prev.posture.generatedAt === posture.generatedAt) return;
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      const tmp = `${this.filePath}.tmp`;
      /* state-registry: guard-posture-peers */
      fs.writeFileSync(
        tmp,
        JSON.stringify({ version: 1, machines: this.machines } satisfies StoreFileShape, null, 2),
      );
      fs.renameSync(tmp, this.filePath);
    } catch {
      // @silent-fallback-ok — a failed persist keeps the in-memory copy
      // serving; durability degrades for this beat only and the next changed
      // beat retries.
    }
  }

  get(machineId: string): StoredGuardPosture | null {
    return this.machines[machineId] ?? null;
  }
}
