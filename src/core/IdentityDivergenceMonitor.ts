/**
 * Periodic, episode-deduped detector for equal-epoch identity divergence.
 * It is visibility only: it never mutates identity authority and never votes in
 * the re-announce acceptance composite. Successful peer reads are the live set;
 * dark/unreadable peers contribute neither agreement nor divergence.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { IdentityProjection } from './IdentityStore.js';

export interface IdentityProjectionView {
  sourceMachineId: string;
  projections: IdentityProjection[];
}

export interface IdentityDivergence {
  id: string;
  kind: 'signing' | 'recovery';
  machineId: string;
  epoch: number;
  fingerprints: string[];
  sources: string[];
}

interface PersistedState {
  version: 1;
  checkedAt: string;
  active: IdentityDivergence[];
}

export function detectIdentityDivergences(views: IdentityProjectionView[]): IdentityDivergence[] {
  const rows = new Map<string, Array<{ source: string; projection: IdentityProjection }>>();
  for (const view of views) {
    for (const projection of view.projections) {
      if (!projection?.machineId || projection.registryStatus === 'revoked') continue;
      const list = rows.get(projection.machineId) ?? [];
      list.push({ source: view.sourceMachineId, projection });
      rows.set(projection.machineId, list);
    }
  }
  const out: IdentityDivergence[] = [];
  for (const [machineId, copies] of rows) {
    const inspect = (kind: 'signing' | 'recovery') => {
      const byEpoch = new Map<number, Array<{ source: string; fingerprint: string }>>();
      for (const copy of copies) {
        const epoch = kind === 'signing' ? copy.projection.keyEpoch : copy.projection.recoveryEpoch;
        const fingerprint = kind === 'signing' ? copy.projection.signingFingerprint : copy.projection.recoveryFingerprint;
        if (!fingerprint) continue;
        const list = byEpoch.get(epoch) ?? [];
        list.push({ source: copy.source, fingerprint });
        byEpoch.set(epoch, list);
      }
      for (const [epoch, values] of byEpoch) {
        const fingerprints = [...new Set(values.map((row) => row.fingerprint))].sort();
        const sources = [...new Set(values.map((row) => row.source))].sort();
        if (fingerprints.length < 2 || sources.length < 2) continue;
        out.push({
          id: `identity-divergence:${kind}:${machineId}:${epoch}`,
          kind,
          machineId,
          epoch,
          fingerprints,
          sources,
        });
      }
    };
    inspect('signing');
    inspect('recovery');
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

export class IdentityDivergenceMonitor {
  private readonly statePath: string;
  private running = false;

  constructor(private readonly deps: {
    stateDir: string;
    readViews: () => Promise<IdentityProjectionView[]>;
    raise: (row: IdentityDivergence) => void | Promise<void>;
    now?: () => number;
  }) {
    this.statePath = path.join(deps.stateDir, 'state', 'identity-divergence-monitor.json');
  }

  async tick(): Promise<IdentityDivergence[]> {
    if (this.running) return this.load().active;
    this.running = true;
    try {
      const previous = this.load();
      const next = detectIdentityDivergences(await this.deps.readViews());
      const priorIds = new Set(previous.active.map((row) => row.id));
      for (const row of next) {
        if (!priorIds.has(row.id)) await this.deps.raise(row);
      }
      this.save({ version: 1, checkedAt: new Date((this.deps.now ?? Date.now)()).toISOString(), active: next });
      return next;
    } finally {
      this.running = false;
    }
  }

  status(): PersistedState {
    return this.load();
  }

  private load(): PersistedState {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.statePath, 'utf8')) as PersistedState;
      if (parsed?.version === 1 && Array.isArray(parsed.active)) return parsed;
    } catch { /* first run/corruption: recompute from live projections */ }
    return { version: 1, checkedAt: '', active: [] };
  }

  private save(state: PersistedState): void {
    fs.mkdirSync(path.dirname(this.statePath), { recursive: true });
    const tmp = `${this.statePath}.tmp.${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.statePath);
  }
}
