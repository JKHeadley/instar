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

/** CMT-1119: one durable record per completed check (logs/identity-divergence-monitor.jsonl). */
export interface IdentityDivergenceRunRecord {
  at: string;
  /** Views read this run (self + every peer that answered). */
  sourcesRead: number;
  sources: string[];
  /** Distinct machine identities compared across those views. */
  machinesCompared: number;
  /** Divergence ids active after this run. */
  active: string[];
  /** Newly-seen episodes this run and what `raise` did with each. */
  raised: Array<{ id: string; disposition: string }>;
  /** Episodes that were active last run and are gone now. */
  cleared: string[];
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
  private lastTickAt = 0;

  constructor(private readonly deps: {
    stateDir: string;
    readViews: () => Promise<IdentityProjectionView[]>;
    /** Returns an optional disposition label (e.g. 'raised', 'dry-run'). */
    raise: (row: IdentityDivergence) => void | string | Promise<void | string>;
    now?: () => number;
    /** Durable per-run record sink (CMT-1119). Best-effort; never gates. */
    record?: (row: IdentityDivergenceRunRecord) => void;
  }) {
    this.statePath = path.join(deps.stateDir, 'state', 'identity-divergence-monitor.json');
  }

  async tick(): Promise<IdentityDivergence[]> {
    if (this.running) return this.load().active;
    this.running = true;
    try {
      const previous = this.load();
      const views = await this.deps.readViews();
      const next = detectIdentityDivergences(views);
      const priorIds = new Set(previous.active.map((row) => row.id));
      const raised: IdentityDivergenceRunRecord['raised'] = [];
      for (const row of next) {
        if (priorIds.has(row.id)) continue;
        const disposition = await this.deps.raise(row);
        raised.push({ id: row.id, disposition: typeof disposition === 'string' ? disposition : 'raised' });
      }
      const nowMs = (this.deps.now ?? Date.now)();
      const checkedAt = new Date(nowMs).toISOString();
      this.save({ version: 1, checkedAt, active: next });
      this.lastTickAt = nowMs;
      if (this.deps.record) {
        const nextIds = new Set(next.map((row) => row.id));
        const machines = new Set<string>();
        for (const view of views) for (const p of view.projections) if (p?.machineId) machines.add(p.machineId);
        try {
          this.deps.record({
            at: checkedAt,
            sourcesRead: views.length,
            sources: views.map((view) => view.sourceMachineId),
            machinesCompared: machines.size,
            active: [...nextIds],
            raised,
            cleared: previous.active.map((row) => row.id).filter((id) => !nextIds.has(id)),
          });
        } catch { /* @silent-fallback-ok — the record is observability only; the persisted state above is authoritative */ }
      }
      return next;
    } finally {
      this.running = false;
    }
  }

  status(): PersistedState {
    return this.load();
  }

  /** GET /guards runtime getter: lastTickAt is the last COMPLETED check. */
  guardStatus(dryRun: boolean): { enabled: true; dryRun: boolean; lastTickAt: number } {
    return { enabled: true, dryRun, lastTickAt: this.lastTickAt };
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
