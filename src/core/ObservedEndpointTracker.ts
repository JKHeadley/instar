/** Local-first corroboration of direct, fully-authenticated peer source addresses. */

import { isRfc1918, isTailscaleCgnat } from './PeerEndpointResolver.js';
import type { PeerEndpointRecorder } from './PeerEndpointRecorder.js';
import type { MeshEndpoint } from './types.js';

interface Observation {
  address: string;
  kind: 'tailscale' | 'lan';
  firstAt: number;
  lastAt: number;
  count: number;
  keyEpoch: number;
}

export interface ObservedEndpointConfig {
  enabled: boolean;
  dryRun: boolean;
  corroborationObservations: number;
  corroborationWindowMinutes: number;
  ttlDays: number;
  rotationQuarantineHours: number;
}

export interface DirectEndpointObservation {
  machineId: string;
  remoteAddress: string;
  keyEpoch: number;
  /** False for proxy/tunnel-fronted requests or any forwarded-header path. */
  direct: boolean;
}

export interface ObservedEndpointTrackerDeps {
  config: () => ObservedEndpointConfig;
  recorder: PeerEndpointRecorder;
  serverPort: number;
  dialBack: (machineId: string, endpoint: MeshEndpoint) => Promise<boolean>;
  now?: () => number;
  logger?: (message: string) => void;
}

export type ObservationResult =
  | 'disabled' | 'not-direct' | 'invalid-address' | 'recorded' | 'insufficient'
  | 'shared-egress' | 'would-retract-shared-egress' | 'rotation-quarantine'
  | 'dialback-failed' | 'would-promote' | 'promoted';

function normalizeAddress(raw: string): string | null {
  const unwrapped = raw.startsWith('::ffff:') ? raw.slice(7) : raw;
  const address = unwrapped.includes(':') && /^\d+\.\d+\.\d+\.\d+:\d+$/.test(unwrapped)
    ? unwrapped.slice(0, unwrapped.lastIndexOf(':'))
    : unwrapped;
  return isTailscaleCgnat(address) || isRfc1918(address) ? address : null;
}

export class ObservedEndpointTracker {
  private readonly d: ObservedEndpointTrackerDeps;
  private readonly byPeer = new Map<string, Map<string, Observation>>();
  private readonly quarantinedUntil = new Map<string, number>();

  constructor(deps: ObservedEndpointTrackerDeps) {
    this.d = deps;
  }

  noteRotation(machineId: string): void {
    const cfg = this.d.config();
    this.byPeer.delete(machineId);
    const configuredMs = cfg.rotationQuarantineHours * 60 * 60_000;
    const evidenceWindowPlusMargin = cfg.corroborationWindowMinutes * 60_000 + 60_000;
    this.quarantinedUntil.set(machineId, (this.d.now ?? Date.now)() + Math.max(configuredMs, evidenceWindowPlusMargin));
  }

  async observe(input: DirectEndpointObservation): Promise<ObservationResult> {
    const cfg = this.d.config();
    if (!cfg.enabled) return 'disabled';
    if (!input.direct) return 'not-direct';
    const address = normalizeAddress(input.remoteAddress);
    if (!address) return 'invalid-address';
    const now = (this.d.now ?? Date.now)();
    this.prune(now, cfg.ttlDays * 24 * 60 * 60_000);
    if ((this.quarantinedUntil.get(input.machineId) ?? 0) > now) return 'rotation-quarantine';

    const peer = this.byPeer.get(input.machineId) ?? new Map<string, Observation>();
    const kind = isTailscaleCgnat(address) ? 'tailscale' : 'lan';
    const prior = peer.get(address);
    const row: Observation = prior && prior.keyEpoch === input.keyEpoch
      ? { ...prior, lastAt: now, count: prior.count + 1 }
      : { address, kind, firstAt: now, lastAt: now, count: 1, keyEpoch: input.keyEpoch };
    peer.delete(address);
    peer.set(address, row);
    while (peer.size > 8) peer.delete(peer.keys().next().value!);
    this.byPeer.set(input.machineId, peer);

    const shared = [...this.byPeer.entries()].filter(([machineId, rows]) => machineId !== input.machineId && rows.has(address));
    if (shared.length > 0) {
      const endpoint = { kind, url: `http://${address}:${this.d.serverPort}` } as const;
      for (const [machineId] of [...shared, [input.machineId, peer] as const]) {
        this.byPeer.get(machineId)?.delete(address);
        if (!cfg.dryRun) this.d.recorder.removeObservedEndpoint(machineId, endpoint);
      }
      return cfg.dryRun ? 'would-retract-shared-egress' : 'shared-egress';
    }
    const windowMs = cfg.corroborationWindowMinutes * 60_000;
    if (row.count < cfg.corroborationObservations || row.lastAt - row.firstAt < windowMs) {
      return row.count === 1 ? 'recorded' : 'insufficient';
    }
    const endpoint: MeshEndpoint = {
      kind,
      url: `http://${address}:${this.d.serverPort}`,
      origin: 'observed',
      observedAt: new Date(now).toISOString(),
    };
    if (!(await this.d.dialBack(input.machineId, endpoint))) return 'dialback-failed';
    // Rotation or a newer observation can land while dial-back is in flight.
    // Re-read every authority input after await; pre-rotation evidence can
    // never be promoted into the post-rotation epoch.
    const afterDialback = (this.d.now ?? Date.now)();
    if ((this.quarantinedUntil.get(input.machineId) ?? 0) > afterDialback) return 'rotation-quarantine';
    const current = this.byPeer.get(input.machineId)?.get(address);
    if (!current || current.keyEpoch !== input.keyEpoch || current.lastAt !== row.lastAt) return 'rotation-quarantine';
    if ([...this.byPeer.entries()].some(([machineId, rows]) => machineId !== input.machineId && rows.has(address))) {
      return 'shared-egress';
    }
    if (cfg.dryRun) return 'would-promote';
    return this.d.recorder.promoteObservedEndpoint(input.machineId, endpoint) ? 'promoted' : 'recorded';
  }

  snapshot(machineId: string): ReadonlyArray<Observation> {
    return [...(this.byPeer.get(machineId)?.values() ?? [])].map((row) => ({ ...row }));
  }

  /** Condition 5a: source was seen under the incumbent key on an authenticated
   * direct Tailscale connection. LAN observations never satisfy identity
   * continuity, even though they may still become routing hints. */
  isIncumbentVerifiedSource(machineId: string, remoteAddress: string, keyEpoch: number, maxAgeMs = 60 * 60_000): boolean {
    const address = normalizeAddress(remoteAddress);
    if (!address || !isTailscaleCgnat(address)) return false;
    const row = this.byPeer.get(machineId)?.get(address);
    if (!row || row.kind !== 'tailscale' || row.keyEpoch !== keyEpoch) return false;
    return (this.d.now ?? Date.now)() - row.lastAt <= maxAgeMs;
  }

  private prune(now: number, ttlMs: number): void {
    for (const [machineId, rows] of this.byPeer) {
      for (const [address, row] of rows) if (now - row.lastAt > ttlMs) rows.delete(address);
      if (rows.size === 0) this.byPeer.delete(machineId);
    }
    for (const [machineId, until] of this.quarantinedUntil) if (until <= now) this.quarantinedUntil.delete(machineId);
  }
}
