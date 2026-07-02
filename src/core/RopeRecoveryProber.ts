/**
 * RopeRecoveryProber — U4.3 traffic-independent rope-health recovery probe
 * (docs/specs/u4-3-breaker-recovery-probe.md).
 *
 * The hedge transport starves dead ropes: endpoints[0] wins inside hedgeDelayMs
 * and the losers are cancelled, so a dead rope sorted behind a healthy one is
 * never re-dialed — and (before the R-r2-1 transport fix) a cancelled recovering
 * rope had its streak reset by the winner. This prober guarantees dead ropes get
 * DIALED: riding the existing ~5s lease-pull tick (no new loop — the carrier is
 * an attached tick listener), it sends a pinned, signed, bogus-uid canary probe
 * to each probe-eligible (peer, kind) and feeds the typed result into the ONE
 * health authority (`PeerEndpointResolver.recordResult`) — no second state
 * machine; the shipped hysteresis/EWMA own the `lastKnownGood` reclaim.
 *
 * Probe selection is EPISODE-scoped (R-r2-2/R-r3-1/R-r3-2): an episode OPENS
 * when a rope goes dead; while open, the rope stays eligible regardless of the
 * dead flag's momentary state (a fail-after-partial-recovery — recoveryStreak 0,
 * consecutiveFailures 1 — stays in-episode: the limbo fix); it CLOSES when the
 * rope reclaims lastKnownGood (traffic takes over). Within an episode the probe
 * layer owns the cadence in BOTH health states: exponential backoff toward the
 * P19 floor on the failure path, `midIntervalMs` mid-recovery, and the floor
 * after `maxUnreclaimedSuccesses` successes without reclaim (slow-but-alive).
 * Exhaustion (`exhaustAttempts` consecutive failures) drops to the floor cadence
 * and escalates ONCE per (peer, kind, episode) — the Eternal-Sentinel exemption:
 * probing NEVER hard-stops (a healed rope must always be rediscoverable).
 *
 * The probe layer holds SCHEDULING state ONLY (R-r2-4): lastProbeAt, episode
 * markers, and a dry-run shadow streak. Health truth lives solely in the
 * resolver's HealthRecord. Dry-run SENDS real probes (harmless by the typed-
 * refusal contract) with the same due-gate/backoff/floor brakes, logs would-close
 * verdicts from the shadow streak, and never mutates the HealthRecord.
 */

import type { PeerEndpointResolver, RopeHealthSnapshotRow } from './PeerEndpointResolver.js';
import type { MeshEndpoint } from './types.js';

/** Same base as the resolver's own probe backoff — the failure path widens from here. */
export const PROBE_BACKOFF_BASE_MS = 5_000;

export interface RopeProbeTarget {
  machineId: string;
  kind: MeshEndpoint['kind'];
  url: string;
}

export interface RopeProbeSendResult {
  /** TRUE only for the exact typed contract (see ropeProbeContract.parseProbeResponse). */
  typedSuccess: boolean;
  /** Classification/detail for logs + metrics (never surfaced to users). */
  detail: string;
  latencyMs: number;
}

export interface RopeRecoveryProberConfig {
  /** Live mode feeds recordResult; dry-run keeps a shadow streak and never mutates health. */
  dryRun: boolean;
  /** P19 floor cadence (max interval) — failure exhaustion AND slow-but-alive both cap here. */
  floorMs: number;
  /** Consecutive probe failures before the exhaustion transition + escalate-once. */
  exhaustAttempts: number;
  /** A close→re-death inside this window is a probe FAILURE for backoff (episode brake). */
  reopenEpisodeWindowMs: number;
  /** Mid-recovery cadence (episode open, rope not dead, lastKnownGood not reclaimed). */
  midIntervalMs: number;
  /** Consecutive successful probes WITHOUT lastKnownGood reclaim before floor cadence. */
  maxUnreclaimedSuccesses: number;
}

export interface RopeRecoveryProberDeps {
  resolver: PeerEndpointResolver;
  /** The dialable (peer, kind, url) set — server wiring derives it from the same
   *  validated registry view the transport dials (resolver.resolve output). */
  listTargets: () => RopeProbeTarget[];
  /** Send ONE pinned probe (MeshRpcClient envelope → POST <url>/mesh/rpc → typed
   *  classification). Must never throw — a transport error is a failure result. */
  sendProbe: (target: RopeProbeTarget) => Promise<RopeProbeSendResult>;
  /** Escalate-once sink (deduped per (peer,kind,episode)). Absent = log-only. */
  raiseAttention?: (item: { id: string; title: string; body: string }) => unknown;
  /** Feature-metrics sink (key `rope-recovery-probe`). Absent = no metrics. */
  recordMetric?: (event:
    | 'probe-sent' | 'probe-success' | 'probe-failure' | 'rope-recovered'
    | 'exhaustion-trip' | 'slow-alive-floor'
    | 'dry-run-would-probe' | 'dry-run-would-close') => void;
  now?: () => number;
  logger?: (msg: string) => void;
}

interface ProbeEpisode {
  openedAt: number;
  lastProbeAt: number; // 0 = never probed this episode
  /** Consecutive probe failures (drives backoff widening + exhaustion). */
  probeFailures: number;
  /** Consecutive typed successes without lastKnownGood reclaim (slow-but-alive bound). */
  unreclaimedSuccesses: number;
  exhausted: boolean;
  escalatedExhaust: boolean;
  escalatedSlowAlive: boolean;
  /** Dry-run shadow recovery streak (the real HealthRecord is untouched by design). */
  shadowStreak: number;
  shadowWouldClose: boolean;
}

interface RopeKeyState {
  episode: ProbeEpisode | null;
  /** When the last episode closed (for the reopen brake window). */
  lastClosedAt: number;
  /** probeFailures carried out of the last episode (reopen brake seeds from it). */
  lastClosedProbeFailures: number;
  /** Previous tick's dead flag (the rope-recovered breadcrumb keys on dead→clear). */
  prevDead: boolean;
}

/** One row of the /health `ropeHealth` surface (spec §3). */
export interface RopeHealthViewRow {
  peer: string;
  kind: MeshEndpoint['kind'];
  state: 'healthy' | 'dead' | 'exhausted';
  consecutiveFailures: number;
  recoveryStreak: number;
  lastResultAt: number | null;
  lastProbeAt: number | null;
  nextProbeDueAt: number | null;
}

export class RopeRecoveryProber {
  private readonly d: RopeRecoveryProberDeps;
  private readonly cfg: RopeRecoveryProberConfig;
  /** key = `${peer} ${kind}` (same key shape as the resolver's health map). */
  private readonly ropes = new Map<string, RopeKeyState>();
  /** Single-in-flight CAS per (peer, kind). */
  private readonly inFlight = new Set<string>();

  constructor(deps: RopeRecoveryProberDeps, cfg: RopeRecoveryProberConfig) {
    this.d = deps;
    this.cfg = cfg;
  }

  private now(): number {
    return (this.d.now ?? Date.now)();
  }
  private log(m: string): void {
    this.d.logger?.(`[rope-probe] ${m}`);
  }
  private key(peer: string, kind: string): string {
    return `${peer} ${kind}`;
  }

  /**
   * One carrier tick (attached to the coordinator's lease-pull tick). Scans the
   * resolver snapshot, manages episodes, and fires due probes (fire-and-forget —
   * the CAS prevents overlap; the carrier tick is never blocked on a dial).
   */
  onTick(): void {
    const nowMs = this.now();
    const targets = this.d.listTargets();
    if (targets.length === 0) return; // single-machine / no dialable peers — strict no-op
    const targetByKey = new Map<string, RopeProbeTarget>();
    for (const t of targets) targetByKey.set(this.key(t.machineId, t.kind), t);

    for (const row of this.d.resolver.snapshot()) {
      const k = this.key(row.peer, row.kind);
      const target = targetByKey.get(k);
      if (!target) continue; // not currently dialable (evicted/undiscovered) — nothing to pin

      const st = this.ropes.get(k) ?? { episode: null, lastClosedAt: 0, lastClosedProbeFailures: 0, prevDead: false };
      this.ropes.set(k, st);

      // ── The rope-recovered breadcrumb keys on the DEAD FLAG clearing (R-r2-3). ──
      if (st.prevDead && !row.dead) {
        this.log(`rope-recovered ${row.peer}/${row.kind} (dead flag cleared; lastKnownGood reclaim follows the shipped hysteresis)`);
        this.d.recordMetric?.('rope-recovered');
      }
      st.prevDead = row.dead;

      // ── Episode lifecycle (R-r2-2 / R-r3-1). ──
      if (!st.episode && row.dead) {
        // OPEN. Episode brake: a close→re-death within the reopen window counts as
        // a probe FAILURE for backoff purposes — the new episode's backoff starts
        // widened (overriding the resolver's freshly-reset isProbeDue).
        const braked = st.lastClosedAt > 0 && nowMs - st.lastClosedAt <= this.cfg.reopenEpisodeWindowMs;
        st.episode = {
          openedAt: nowMs,
          // A braked reopen also DEFERS its first probe by the widened interval
          // (lastProbeAt seeded to now) — an immediate re-probe per episode would
          // let a flapping rope cycle hot at the reopen rate.
          lastProbeAt: braked ? nowMs : 0,
          probeFailures: braked ? st.lastClosedProbeFailures + 1 : 0,
          unreclaimedSuccesses: 0,
          exhausted: false,
          escalatedExhaust: false,
          escalatedSlowAlive: false,
          shadowStreak: 0,
          shadowWouldClose: false,
        };
        this.log(`episode open ${row.peer}/${row.kind}${braked ? ' (reopen brake: backoff widened)' : ''}`);
      } else if (st.episode && row.lastKnownGood) {
        // CLOSE — lastKnownGood reclaimed; traffic takes over.
        st.lastClosedAt = nowMs;
        st.lastClosedProbeFailures = st.episode.probeFailures;
        this.log(`episode close ${row.peer}/${row.kind} (lastKnownGood reclaimed)`);
        st.episode = null;
      }

      const ep = st.episode;
      if (!ep) continue;

      // ── Probe-layer due gate — owns the cadence in BOTH modes (R-r2-4a). ──
      const interval = this.currentIntervalMs(ep, row);
      if (ep.lastProbeAt !== 0 && nowMs - ep.lastProbeAt < interval) continue;
      if (this.inFlight.has(k)) continue; // single-in-flight CAS

      this.inFlight.add(k);
      ep.lastProbeAt = nowMs;
      this.d.recordMetric?.(this.cfg.dryRun ? 'dry-run-would-probe' : 'probe-sent');
      // Fire-and-forget: the tick is a carrier, never blocked on a dial.
      void this.d
        .sendProbe(target)
        .then((res) => this.onProbeResult(k, row, res))
        .catch((err) => {
          // A sendProbe seam that throws despite its contract is a failure result.
          this.onProbeResult(k, row, {
            typedSuccess: false,
            detail: `send-error: ${err instanceof Error ? err.message : String(err)}`,
            latencyMs: 0,
          });
        })
        .finally(() => {
          this.inFlight.delete(k);
        });
    }
  }

  /** The episode-owned cadence (R-r3-2): failure backoff → floor; mid-recovery 45s;
   *  slow-but-alive → floor; exhaustion → floor. */
  private currentIntervalMs(ep: ProbeEpisode, row: RopeHealthSnapshotRow): number {
    if (ep.exhausted) return this.cfg.floorMs;
    // In dry-run the HealthRecord is never probe-fed, so `row.dead` stays true
    // even while probes SUCCEED — the shadow streak stands in for the dead-clear
    // so a succeeding dry-run rope rides the mid-recovery cadence (and then the
    // slow-alive floor), never a hot 5s loop (R-r2-4a: the floor applies in
    // dry-run too).
    const shadowRecovered = this.cfg.dryRun && ep.shadowStreak > 0;
    const failurePath = ep.probeFailures > 0 || (row.dead && !shadowRecovered);
    if (failurePath) {
      const exp = Math.min(ep.probeFailures, 30); // 2^30 clamp — floorMs caps anyway
      return Math.min(this.cfg.floorMs, PROBE_BACKOFF_BASE_MS * 2 ** exp);
    }
    // Mid-recovery (in-episode, not dead, not reclaimed): the probe layer's own
    // cadence — NEVER the resolver's trivially-true ~5s (the 17k/day shape).
    if (ep.unreclaimedSuccesses >= this.cfg.maxUnreclaimedSuccesses) return this.cfg.floorMs;
    return this.cfg.midIntervalMs;
  }

  private onProbeResult(k: string, rowAtSend: RopeHealthSnapshotRow, res: RopeProbeSendResult): void {
    const st = this.ropes.get(k);
    const ep = st?.episode;
    if (!st || !ep) return; // episode closed while the probe was in flight — result moot
    const [peer, kind] = [rowAtSend.peer, rowAtSend.kind];

    if (res.typedSuccess) {
      this.d.recordMetric?.('probe-success');
      ep.probeFailures = 0;
      ep.unreclaimedSuccesses += 1;
      if (ep.exhausted) {
        // Re-arm: any success clears exhaustion and re-enables the normal backoff.
        ep.exhausted = false;
        this.log(`exhaustion cleared ${peer}/${kind} (typed success — re-armed)`);
      }
      if (this.cfg.dryRun) {
        ep.shadowStreak += 1;
        if (!ep.shadowWouldClose) {
          ep.shadowWouldClose = true;
          this.log(`dry-run would-close ${peer}/${kind}: first typed success would clear the dead flag (shadow streak ${ep.shadowStreak})`);
          this.d.recordMetric?.('dry-run-would-close');
        }
      } else {
        this.d.resolver.recordResult(peer, kind, true, res.latencyMs);
      }
      if (
        ep.unreclaimedSuccesses === this.cfg.maxUnreclaimedSuccesses &&
        !ep.escalatedSlowAlive
      ) {
        // Slow-but-alive: answers probes but the EWMA keeps it below the reclaim
        // bar — drop to floor cadence + the same escalate-once posture.
        ep.escalatedSlowAlive = true;
        this.d.recordMetric?.('slow-alive-floor');
        this.escalate(
          `rope-probe-slow-alive:${peer}:${kind}:${ep.openedAt}`,
          `Mesh rope ${kind} answers probes but stays demoted`,
          `The ${kind} rope to peer ${peer} has answered ${ep.unreclaimedSuccesses} consecutive recovery probes but has not reclaimed preferred status — latency above the reclaim bar. Probing continues at the floor cadence.`,
        );
      }
    } else {
      this.d.recordMetric?.('probe-failure');
      ep.probeFailures += 1;
      ep.unreclaimedSuccesses = 0;
      if (this.cfg.dryRun) {
        ep.shadowStreak = 0;
      } else {
        this.d.resolver.recordResult(peer, kind, false, res.latencyMs);
      }
      this.log(`probe failed ${peer}/${kind} (${res.detail}; consecutive ${ep.probeFailures})`);
      if (ep.probeFailures >= this.cfg.exhaustAttempts && !ep.exhausted) {
        ep.exhausted = true;
        this.d.recordMetric?.('exhaustion-trip');
        if (!ep.escalatedExhaust) {
          ep.escalatedExhaust = true; // escalate ONCE per (peer, kind, episode)
          this.escalate(
            `rope-probe-exhausted:${peer}:${kind}:${ep.openedAt}`,
            `Mesh rope ${kind} not recovering`,
            `The ${kind} rope to peer ${peer} has failed ${ep.probeFailures} recovery probes; probing continues at the floor rate (${Math.round(this.cfg.floorMs / 60000)} min).`,
          );
        }
      }
    }
  }

  private escalate(id: string, title: string, body: string): void {
    try {
      const r = this.d.raiseAttention?.({ id, title, body });
      if (r && typeof (r as Promise<unknown>).catch === 'function') {
        void (r as Promise<unknown>).catch(() => {
          // @silent-fallback-ok: escalation is best-effort observability — the probe
          // itself keeps running at the floor; the item re-arms on the next episode.
        });
      }
      this.log(`escalated: ${title}`);
    } catch {
      // @silent-fallback-ok: same as above — a throwing attention sink must never
      // break the probe loop (signal, not authority).
    }
  }

  /**
   * The /health `ropeHealth` rows (spec §3): resolver truth + probe scheduling
   * state, per (peer, kind). Served via MultiMachineCoordinator's registration
   * handle into the AUTHED branch only.
   */
  view(): RopeHealthViewRow[] {
    const nowRows: RopeHealthViewRow[] = [];
    for (const row of this.d.resolver.snapshot()) {
      const st = this.ropes.get(this.key(row.peer, row.kind));
      const ep = st?.episode ?? null;
      const lastResultAt = Math.max(row.lastOkAt, row.lastFailAt);
      nowRows.push({
        peer: row.peer,
        kind: row.kind,
        state: ep?.exhausted ? 'exhausted' : row.dead ? 'dead' : 'healthy',
        consecutiveFailures: row.consecutiveFailures,
        recoveryStreak: row.recoveryStreak,
        lastResultAt: lastResultAt > 0 ? lastResultAt : null,
        lastProbeAt: ep && ep.lastProbeAt > 0 ? ep.lastProbeAt : null,
        nextProbeDueAt: ep ? (ep.lastProbeAt === 0 ? this.now() : ep.lastProbeAt + this.currentIntervalMs(ep, row)) : null,
      });
    }
    return nowRows;
  }

  /** Test/observability helper — is a probe currently in flight for (peer, kind)? */
  isInFlight(peer: string, kind: string): boolean {
    return this.inFlight.has(this.key(peer, kind));
  }

  /** Test helper — the episode-open state for (peer, kind). */
  episodeOpen(peer: string, kind: string): boolean {
    return !!this.ropes.get(this.key(peer, kind))?.episode;
  }
}
