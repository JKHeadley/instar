/**
 * RopeHealthMonitor — U4.5 rope-health alerts
 * (docs/specs/u4-5-rope-health-alerts.md).
 *
 * Mesh transport degradation was silent: a Tailscale key expiry dropped a rope
 * with no warning; a persistently-down rope was visible only to someone who
 * went looking; an all-transports-down partition — the precondition for silent
 * message loss — had no prompt alert at all. This monitor is the productized,
 * in-server detector: it runs its OWN bounded 30s evaluation loop (constructed
 * and torn down by the real server boot — R-r2-2), reads the U4.3
 * `PeerEndpointResolver.snapshot()` seam (the HARD data dependency; no interim
 * fallback exists), and classifies each peer deterministically:
 *
 *   ok           — silence (no digest line, nothing).
 *   degraded     — a rope down while ≥1 other rope is healthy, or a Tailscale
 *                  key expiring within `keyExpiryWarnDays`. Digest-only.
 *   peer-offline — ALL ropes down AND the peer's git-synced coarse heartbeat
 *                  has STOPPED advancing (or the registry already marks it
 *                  offline). Digest-only — a lid-close is NEVER urgent.
 *   urgent       — ALL ropes down to a peer whose git-synced coarse heartbeat
 *                  is still ADVANCING — advancement-since-onset semantics
 *                  (R-r3-1): a beat NEWER than the all-down onset, observed
 *                  after the onset. Freshness-window semantics are REJECTED
 *                  (a just-lid-closed peer's last beat looks fresh for up to
 *                  an hour). ONE HIGH attention item per episode.
 *
 * The urgent tier's honest detection latency is bounded by the heartbeat
 * interval plus up to two git-sync cadences (~30-90 min); `urgentDebounceMs`
 * is only the short-term flap filter on the all-down condition itself.
 *
 * Episode semantics: episodeKey = sorted machine pair + the onset quantized to
 * 15 min — deterministically computable on BOTH sides without coordination;
 * post-heal grouping matches ADJACENT quantization windows (R-r2-5). An episode
 * ends only after `clearSustainMs` of continuous health (a blip cannot
 * clear-then-re-fire). At most ONE item per side per episode; if a split-brain
 * item is already open for the same peer, the monitor does not raise a second.
 *
 * Durable state (`state/rope-health.json`): transition-only writes with a short
 * debounce (R-r2-4) — a steady-state evaluation never touches disk; counters
 * lost to a restart are accepted (the safe direction: a restart re-debounces,
 * never fabricates an episode).
 *
 * Content scrub (hard rule): alert/digest text carries rope KIND + machine
 * NICKNAME + relative times ONLY — never raw IPs, URLs, tunnel hostnames,
 * tailnet names, or account emails (the tailscale JSON's identifying fields
 * never leave `parseTailscaleStatus`).
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import type { RopeHealthSnapshotRow } from '../core/PeerEndpointResolver.js';
import {
  parseTailscaleStatus,
  soonestKeyExpiry,
} from '../core/tailscaleStatusParser.js';

export type RopeHealthCondition = 'ok' | 'degraded' | 'peer-offline' | 'urgent' | 'unknown';

export interface RopeHealthPeerInfo {
  machineId: string;
  /** User-facing handle — the ONLY peer identity that reaches alert/digest text. */
  nickname: string;
  /** Registry online flag (staleness-derived; WS4.2 offline-since semantics). */
  registryOnline: boolean;
}

export type RopeHealthMetricEvent =
  | 'evaluation'
  | 'transition-ok'
  | 'transition-degraded'
  | 'transition-peer-offline'
  | 'transition-urgent'
  | 'urgent-episode'
  | 'suppressed-by-sleep-gate'
  | 'suppressed-by-split-brain'
  | 'detected-not-notified-retry'
  | 'key-expiry-warning'
  | 'digest-emission';

export interface RopeHealthMonitorDeps {
  /** U4.3 read seam — the REAL resolver snapshot, never a copy. */
  snapshot: () => RopeHealthSnapshotRow[];
  /** This machine's stable id (episodeKey pair member). */
  selfMachineId: string;
  /** Known peers (excluding self) with nicknames + registry online flags. */
  listPeers: () => RopeHealthPeerInfo[];
  /**
   * The mesh-INDEPENDENT liveness discriminator (R-r2-1): epoch-ms of the
   * peer's last git-synced coarse heartbeat, or null when none/malformed.
   */
  readHeartbeatAtMs: (machineId: string) => number | null;
  /** HIGH attention sink. May return a promise; a rejection = not-notified. */
  raiseAttention: (item: { id: string; title: string; body: string }) => unknown;
  /** Episode-registry check: a split-brain item already open for this peer wins. */
  splitBrainItemOpen?: (peerMachineId: string) => boolean;
  /**
   * Bounded exec seam for `tailscale status --json` (R-r2-3). Resolves to the
   * raw stdout, or null when the CLI is absent/timed out (the expiry tier is
   * then silently absent). Default impl provided; tests inject.
   */
  execTailscaleStatusJson?: () => Promise<string | null>;
  /** Durable state file (state/rope-health.json). */
  stateFilePath: string;
  recordMetric?: (event: RopeHealthMetricEvent) => void;
  now?: () => number;
  logger?: (msg: string) => void;
}

export interface RopeHealthMonitorConfig {
  /** The urgent tier master (rides the same dev gate; spec §5). Default true. */
  urgentEnabled: boolean;
  /** Time-pinned short-term flap filter on the all-down condition (R-r2-2). Default 60000. */
  urgentDebounceMs: number;
  /** Continuous health required before an episode ends. Default 600000. */
  clearSustainMs: number;
  /** Tailscale key expiry warning horizon. Default 14. */
  keyExpiryWarnDays: number;
  /** The monitor's OWN evaluation loop cadence. Default 30000. */
  evaluateIntervalMs: number;
  /** Key-expiry exec cadence. Default 3600000 (hourly). */
  keyExpiryCheckIntervalMs: number;
  /**
   * HARD CAP on how long a self-wake grace window may suppress the urgent tier.
   *
   * HAZARD (docs/audits/multi-machine-seamless-ux-audit-2026-07.md finding
   * P1-A7): SleepWakeDetector is known to emit FALSE wake events on this class
   * of machine — event-loop stalls misread as sleeps (26 spurious "wake after
   * ~12-24s sleep" events in one night while caffeinate held a
   * PreventSystemSleep assertion). A false "recently slept" signal must never
   * suppress a genuine partition alert for long, so the grace window is
   * BOUNDED: suppression ends as soon as every (peer, kind) has been
   * re-observed post-wake OR this cap elapses — whichever comes first. It is a
   * short post-wake grace, never an open-ended veto. Default 300000 (5 min).
   */
  wakeGraceMaxMs: number;
  /** Episode-key onset quantization. Default 900000 (15 min). */
  episodeQuantumMs: number;
  /** State-write debounce for transition bursts (R-r2-4). Default 2000. */
  writeDebounceMs: number;
}

export const ROPE_HEALTH_DEFAULTS: RopeHealthMonitorConfig = {
  urgentEnabled: true,
  urgentDebounceMs: 60_000,
  clearSustainMs: 600_000,
  keyExpiryWarnDays: 14,
  evaluateIntervalMs: 30_000,
  keyExpiryCheckIntervalMs: 3_600_000,
  wakeGraceMaxMs: 300_000,
  episodeQuantumMs: 900_000,
  writeDebounceMs: 2_000,
};

/**
 * Deterministic shared episode key: both sides compute the same value from the
 * sorted machine pair + the onset's quantization window (spec §2).
 */
export function computeEpisodeKey(
  machineA: string,
  machineB: string,
  onsetMs: number,
  quantumMs: number = ROPE_HEALTH_DEFAULTS.episodeQuantumMs,
): string {
  const pair = [machineA, machineB].sort().join('+');
  const win = Math.floor(onsetMs / quantumMs) * quantumMs;
  return `${pair}:${win}`;
}

/**
 * Post-heal grouping (R-r2-5): two episode keys group when they name the same
 * machine pair and their quantization windows are ADJACENT (±1 quantum) — the
 * two sides detect at different instants, so an onset straddling a boundary
 * yields adjacent window keys. Beyond one quantum the keys honestly show as
 * two groups (declared best-effort display degradation).
 */
export function episodeKeysGroup(
  a: string,
  b: string,
  quantumMs: number = ROPE_HEALTH_DEFAULTS.episodeQuantumMs,
): boolean {
  const pa = a.lastIndexOf(':');
  const pb = b.lastIndexOf(':');
  if (pa <= 0 || pb <= 0) return false;
  if (a.slice(0, pa) !== b.slice(0, pb)) return false;
  const wa = Number(a.slice(pa + 1));
  const wb = Number(b.slice(pb + 1));
  if (!Number.isFinite(wa) || !Number.isFinite(wb)) return false;
  return Math.abs(wa - wb) <= quantumMs;
}

interface PeerRuntimeState {
  condition: RopeHealthCondition;
  /** All-down condition onset (epoch-ms), null when not all-down. */
  allDownSince: number | null;
  /** Consecutive evaluations observing the all-down condition. */
  consecutiveObservations: number;
  episodeKey: string | null;
  /** When the ONE urgent item for this episode was raised (lastAlertAt). */
  urgentRaisedAt: number | null;
  /** Urgent detected but attention delivery failed — retried next evaluation. */
  detectedNotNotified: boolean;
  /** Continuous-health start while an episode is still open (clear-sustain). */
  healthySince: number | null;
  /** First observation of a post-onset heartbeat (the R-r3-1 discriminator). */
  postOnsetBeatObservedAt: number | null;
}

/** One row of GET /mesh/rope-health (content-scrubbed: kind + nickname only). */
export interface RopeHealthPeerView {
  machineId: string;
  nickname: string;
  condition: RopeHealthCondition;
  kinds: Array<{ kind: string; dead: boolean; consecutiveFailures: number }>;
  allDownSince: number | null;
  episodeKey: string | null;
  urgentRaisedAt: number | null;
  detectedNotNotified: boolean;
}

export interface RopeHealthStatus {
  lastEvaluatedAt: number | null;
  evaluations: number;
  peers: RopeHealthPeerView[];
  keyExpiry: {
    /** false ⇒ CLI absent / never checked / unparseable — tier silently absent. */
    available: boolean;
    soonest?: { role: 'self' | 'peer'; expiresAtIso: string; inDays: number };
    warn?: boolean;
    lastCheckedAt?: number | null;
  };
  /** ≤3-sentence consolidated digest section, or null when everything is ok. */
  digest: string | null;
  counters: {
    urgentEpisodes: number;
    suppressedBySleepGate: number;
    suppressedBySplitBrain: number;
    notNotifiedRetries: number;
  };
}

/** Candidate tailscale CLI paths (same set as MeshUrlAdvertiser Decision 16). */
const TAILSCALE_CANDIDATES = [
  '/opt/homebrew/bin/tailscale',
  '/usr/local/bin/tailscale',
  '/Applications/Tailscale.app/Contents/MacOS/Tailscale',
  'tailscale',
];

/** Default bounded exec: 5s hard timeout; absent CLI / any failure ⇒ null. */
export function defaultExecTailscaleStatusJson(): Promise<string | null> {
  return new Promise((resolve) => {
    const tryNext = (i: number): void => {
      if (i >= TAILSCALE_CANDIDATES.length) {
        resolve(null);
        return;
      }
      const file = TAILSCALE_CANDIDATES[i];
      if (file !== 'tailscale' && !fs.existsSync(file)) {
        tryNext(i + 1);
        return;
      }
      execFile(file, ['status', '--json'], { timeout: 5_000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
        if (err || !stdout) {
          tryNext(i + 1);
          return;
        }
        resolve(String(stdout));
      });
    };
    tryNext(0);
  });
}

export class RopeHealthMonitor {
  private readonly d: RopeHealthMonitorDeps;
  private readonly cfg: RopeHealthMonitorConfig;
  private readonly peers = new Map<string, PeerRuntimeState>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastEvaluatedAt: number | null = null;
  private evaluations = 0;
  private evaluating = false;

  // Self-wake grace (bounded — see wakeGraceMaxMs hazard note / P1-A7).
  private ownWakeAt: number | null = null;

  // Key-expiry tier state.
  private keyExpiryLastCheckedAt: number | null = null;
  private keyExpiryAvailable = false;
  private keyExpirySoonest: { role: 'self' | 'peer'; expiresAtIso: string; inDays: number } | null = null;
  private keyExpiryAbsentLogged = false;
  private keyExpiryInFlight = false;

  // Counters (observability only).
  private urgentEpisodes = 0;
  private suppressedBySleepGate = 0;
  private suppressedBySplitBrain = 0;
  private notNotifiedRetries = 0;

  // Transition-only durable writes (R-r2-4).
  private writePending = false;
  private writeTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(deps: RopeHealthMonitorDeps, cfg?: Partial<RopeHealthMonitorConfig>) {
    this.d = deps;
    this.cfg = { ...ROPE_HEALTH_DEFAULTS, ...cfg };
    this.loadState();
  }

  private now(): number {
    return (this.d.now ?? Date.now)();
  }
  private log(m: string): void {
    this.d.logger?.(`[rope-health] ${m}`);
  }
  private metric(e: RopeHealthMetricEvent): void {
    try {
      this.d.recordMetric?.(e);
    } catch {
      // @silent-fallback-ok: metrics are observability, never authority — a
      // recorder fault must not break the evaluation loop.
    }
  }

  /** Start the monitor's OWN bounded evaluation loop (R-r2-2). */
  start(): void {
    if (this.timer) return;
    this.evaluate();
    this.timer = setInterval(() => this.evaluate(), this.cfg.evaluateIntervalMs);
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  /** Torn down at server shutdown (R-r2-2). Flushes any pending state write. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.writeTimer) {
      clearTimeout(this.writeTimer);
      this.writeTimer = null;
    }
    if (this.writePending) this.writeStateNow();
  }

  /** Is the evaluation loop currently armed? (e2e wiring-integrity read.) */
  running(): boolean {
    return this.timer !== null;
  }

  /**
   * Own-machine wake note (SleepWakeDetector 'wake' — the ONE thing it can
   * tell us). Post-wake, all snapshots are stale; urgent is suppressed until
   * each (peer, kind) is re-observed post-wake — BOUNDED by wakeGraceMaxMs
   * (P1-A7: false wake events must never become an open-ended veto).
   */
  noteOwnWake(atMs?: number): void {
    this.ownWakeAt = atMs ?? this.now();
  }

  /** One evaluation pass. Public for tests; the loop calls it on cadence. */
  evaluate(): void {
    if (this.evaluating) return;
    this.evaluating = true;
    try {
      this.evaluateInner();
    } catch (err) {
      // Fail toward silence, never a crashed loop (signal, not authority).
      this.log(`evaluation error: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.evaluating = false;
    }
  }

  private evaluateInner(): void {
    const nowMs = this.now();
    this.lastEvaluatedAt = nowMs;
    this.evaluations += 1;
    this.metric('evaluation');

    const rows = this.safeSnapshot();
    const rowsByPeer = new Map<string, RopeHealthSnapshotRow[]>();
    for (const r of rows) {
      const list = rowsByPeer.get(r.peer) ?? [];
      list.push(r);
      rowsByPeer.set(r.peer, list);
    }

    for (const peer of this.safePeers()) {
      const st = this.peers.get(peer.machineId) ?? freshPeerState();
      this.peers.set(peer.machineId, st);
      const peerRows = rowsByPeer.get(peer.machineId) ?? [];
      const prev = st.condition;

      // Absent-record semantics (R-r2-minor): a peer with NO snapshot rows is
      // UNKNOWN, not down — fails toward NOT-urgent.
      if (peerRows.length === 0) {
        this.settleHealthy(st, nowMs);
        st.condition = 'unknown';
        this.recordTransition(prev, st.condition);
        continue;
      }

      const deadRows = peerRows.filter((r) => r.dead);
      const allDown = deadRows.length === peerRows.length;

      if (!allDown) {
        this.settleHealthy(st, nowMs);
        st.condition = deadRows.length > 0 ? 'degraded' : 'ok';
        this.recordTransition(prev, st.condition);
        continue;
      }

      // ── ALL ropes down. ──
      st.healthySince = null;
      if (st.allDownSince === null) {
        st.allDownSince = nowMs;
        st.consecutiveObservations = 1;
        st.episodeKey = computeEpisodeKey(this.d.selfMachineId, peer.machineId, nowMs, this.cfg.episodeQuantumMs);
        st.postOnsetBeatObservedAt = null;
        this.log(`all-down onset for ${peer.nickname} (episode ${st.episodeKey})`);
      } else {
        st.consecutiveObservations += 1;
      }

      // The R-r3-1 discriminator: advancement-since-onset — a heartbeat NEWER
      // than the onset, observed after the onset. Freshness-window semantics
      // are rejected (a just-lid-closed peer's pre-sleep beat looks fresh).
      const hbAt = this.safeHeartbeat(peer.machineId);
      if (hbAt !== null && st.allDownSince !== null && hbAt > st.allDownSince && st.postOnsetBeatObservedAt === null) {
        st.postOnsetBeatObservedAt = nowMs;
      }

      if (!peer.registryOnline) {
        // WS4.2 'offline since <t>' — expected. Never urgent.
        st.condition = 'peer-offline';
        this.recordTransition(prev, st.condition);
        continue;
      }

      if (st.postOnsetBeatObservedAt === null) {
        // Heartbeat stopped (peer likely asleep/off) or no post-onset beat has
        // landed YET — late-but-honest: a later post-onset beat upgrades this.
        st.condition = 'peer-offline';
        this.recordTransition(prev, st.condition);
        continue;
      }

      // ── Urgent candidate: all-down + advancing heartbeat. ──
      st.condition = 'urgent';
      this.recordTransition(prev, st.condition);

      if (!this.cfg.urgentEnabled) continue;
      // Time-pinned debounce (R-r2-2) + ≥2 consecutive observations: a spurious
      // single-evaluation blip (or a spurious SLEEP signal coinciding with a
      // real rope failure — the P1-A7 hazard test) never fires alone, and a
      // REAL sustained partition always fires once the debounce elapses.
      if (nowMs - (st.allDownSince ?? nowMs) < this.cfg.urgentDebounceMs) continue;
      if (st.consecutiveObservations < 2) continue;

      // Self-wake grace (BOUNDED — P1-A7): suppress only while (a) inside the
      // wakeGraceMaxMs cap AND (b) some rope of this peer has not been
      // re-observed since the wake. A false wake event therefore delays an
      // urgent item by AT MOST wakeGraceMaxMs, never vetoes it.
      if (this.sleepGateSuppresses(peerRows, nowMs)) {
        this.suppressedBySleepGate += 1;
        this.metric('suppressed-by-sleep-gate');
        continue;
      }

      if (st.urgentRaisedAt !== null && !st.detectedNotNotified) continue; // one item per episode

      if (this.safeSplitBrainOpen(peer.machineId)) {
        // One episode, one ask — the already-open split-brain item wins.
        this.suppressedBySplitBrain += 1;
        this.metric('suppressed-by-split-brain');
        continue;
      }

      this.raiseUrgent(peer, st, nowMs);
    }

    // ── Key-expiry tier (own cadence, R-r2-3). ──
    if (
      this.keyExpiryLastCheckedAt === null ||
      nowMs - this.keyExpiryLastCheckedAt >= this.cfg.keyExpiryCheckIntervalMs
    ) {
      this.checkKeyExpiry(nowMs);
    }
  }

  private settleHealthy(st: PeerRuntimeState, nowMs: number): void {
    if (st.allDownSince === null) return;
    // Episode still open: sustained-clear gate (a blip cannot clear-then-re-fire).
    if (st.healthySince === null) st.healthySince = nowMs;
    if (nowMs - st.healthySince >= this.cfg.clearSustainMs) {
      this.log(`episode ${st.episodeKey ?? '?'} ended after sustained health`);
      st.allDownSince = null;
      st.consecutiveObservations = 0;
      st.episodeKey = null;
      st.urgentRaisedAt = null;
      st.detectedNotNotified = false;
      st.postOnsetBeatObservedAt = null;
      st.healthySince = null;
      this.scheduleWrite();
    }
  }

  private sleepGateSuppresses(peerRows: RopeHealthSnapshotRow[], nowMs: number): boolean {
    if (this.ownWakeAt === null) return false;
    if (nowMs - this.ownWakeAt > this.cfg.wakeGraceMaxMs) return false; // bounded (P1-A7)
    // Suppress only while some rope has NOT been re-observed post-wake.
    return peerRows.some((r) => Math.max(r.lastOkAt, r.lastFailAt) <= this.ownWakeAt!);
  }

  private raiseUrgent(peer: RopeHealthPeerInfo, st: PeerRuntimeState, nowMs: number): void {
    // The urgent-episode counter fires on the FIRST successful delivery for
    // this episode (a delivery that only succeeded on a retry still counts once).
    const firstDelivery = st.urgentRaisedAt === null;
    const sinceMin = st.allDownSince ? Math.round((nowMs - st.allDownSince) / 60_000) : 0;
    // Content scrub: kind + nickname + relative time ONLY.
    const kinds = 'every mesh rope';
    const item = {
      id: `rope-health-urgent:${st.episodeKey ?? peer.machineId}`,
      title: `Mesh partition: ${peer.nickname} unreachable but alive`,
      body:
        `ALL mesh ropes (${kinds}) to ${peer.nickname} have been down for ~${sinceMin} min, ` +
        `but its machine heartbeat is still advancing — it is alive yet unreachable (a genuine partition, ` +
        `not a sleeping machine). Messages routed to it may be delayed until a rope recovers. ` +
        `Episode ${st.episodeKey ?? 'n/a'}; this is the ONE alert for this episode.`,
    };
    try {
      const r = this.d.raiseAttention(item);
      if (r && typeof (r as Promise<unknown>).then === 'function') {
        void (r as Promise<unknown>).then(
          () => this.settleNotified(st, nowMs, firstDelivery),
          () => this.markNotNotified(st),
        );
      } else {
        this.settleNotified(st, nowMs, firstDelivery);
      }
    } catch {
      // Detected-but-silent must be impossible to lose silently: the failure is
      // recorded and the next evaluation retries (spec "alert delivery honesty").
      this.markNotNotified(st);
    }
  }

  private settleNotified(st: PeerRuntimeState, nowMs: number, firstDelivery: boolean): void {
    st.urgentRaisedAt = nowMs;
    st.detectedNotNotified = false;
    if (firstDelivery) {
      this.urgentEpisodes += 1;
      this.metric('urgent-episode');
    }
    this.scheduleWrite();
  }

  private markNotNotified(st: PeerRuntimeState): void {
    if (st.detectedNotNotified) {
      this.notNotifiedRetries += 1;
      this.metric('detected-not-notified-retry');
    }
    st.detectedNotNotified = true;
    if (st.urgentRaisedAt === null) st.urgentRaisedAt = null; // stays unraised — retried next evaluation
    this.scheduleWrite();
  }

  private checkKeyExpiry(nowMs: number): void {
    if (this.keyExpiryInFlight) return;
    this.keyExpiryInFlight = true;
    this.keyExpiryLastCheckedAt = nowMs;
    const exec = this.d.execTailscaleStatusJson ?? defaultExecTailscaleStatusJson;
    void Promise.resolve()
      .then(() => exec())
      .then((raw) => {
        if (raw === null) {
          // Absent CLI ⇒ the expiry tier is silently absent (ONE debug line).
          this.keyExpiryAvailable = false;
          this.keyExpirySoonest = null;
          if (!this.keyExpiryAbsentLogged) {
            this.keyExpiryAbsentLogged = true;
            this.log('tailscale CLI absent/unavailable — key-expiry tier silently absent');
          }
          return;
        }
        const parse = parseTailscaleStatus(raw);
        if (!parse.parsed) {
          this.keyExpiryAvailable = false;
          this.keyExpirySoonest = null;
          return;
        }
        this.keyExpiryAvailable = true;
        this.keyExpirySoonest = soonestKeyExpiry(parse, this.now());
        if (this.keyExpiryWarn()) this.metric('key-expiry-warning');
      })
      .catch((err) => {
        // @silent-fallback-ok: the expiry tier degrades to absent on any exec
        // fault (the rest of the monitor is unaffected — spec R-r2-3).
        this.log(`key-expiry check failed: ${err instanceof Error ? err.message : String(err)}`);
        this.keyExpiryAvailable = false;
      })
      .finally(() => {
        this.keyExpiryInFlight = false;
      });
  }

  private keyExpiryWarn(): boolean {
    return (
      this.keyExpiryAvailable &&
      this.keyExpirySoonest !== null &&
      this.keyExpirySoonest.inDays <= this.cfg.keyExpiryWarnDays
    );
  }

  /** The GET /mesh/rope-health read surface (content-scrubbed). */
  status(): RopeHealthStatus {
    const rows = this.safeSnapshot();
    const rowsByPeer = new Map<string, RopeHealthSnapshotRow[]>();
    for (const r of rows) {
      const list = rowsByPeer.get(r.peer) ?? [];
      list.push(r);
      rowsByPeer.set(r.peer, list);
    }
    const peers: RopeHealthPeerView[] = [];
    for (const p of this.safePeers()) {
      const st = this.peers.get(p.machineId);
      peers.push({
        machineId: p.machineId,
        nickname: p.nickname,
        condition: st?.condition ?? 'unknown',
        kinds: (rowsByPeer.get(p.machineId) ?? []).map((r) => ({
          kind: r.kind,
          dead: r.dead,
          consecutiveFailures: r.consecutiveFailures,
        })),
        allDownSince: st?.allDownSince ?? null,
        episodeKey: st?.episodeKey ?? null,
        urgentRaisedAt: st?.urgentRaisedAt ?? null,
        detectedNotNotified: st?.detectedNotNotified ?? false,
      });
    }
    return {
      lastEvaluatedAt: this.lastEvaluatedAt,
      evaluations: this.evaluations,
      peers,
      keyExpiry: {
        available: this.keyExpiryAvailable,
        ...(this.keyExpirySoonest
          ? { soonest: { ...this.keyExpirySoonest, inDays: Math.round(this.keyExpirySoonest.inDays * 10) / 10 } }
          : {}),
        warn: this.keyExpiryWarn(),
        lastCheckedAt: this.keyExpiryLastCheckedAt,
      },
      digest: this.composeDigest(),
      counters: {
        urgentEpisodes: this.urgentEpisodes,
        suppressedBySleepGate: this.suppressedBySleepGate,
        suppressedBySplitBrain: this.suppressedBySplitBrain,
        notNotifiedRetries: this.notNotifiedRetries,
      },
    };
  }

  /**
   * The consolidated daily-digest section (≤3 sentences, clamped,
   * machine-named), or null when everything is ok — the rope-health-digest
   * job's content source. Deterministic; content-scrubbed by construction.
   */
  composeDigest(): string | null {
    const nowMs = this.now();
    const sentences: string[] = [];
    for (const p of this.safePeers()) {
      const st = this.peers.get(p.machineId);
      if (!st) continue;
      if (st.condition === 'urgent') {
        const min = st.allDownSince ? Math.round((nowMs - st.allDownSince) / 60_000) : 0;
        sentences.push(`ALL mesh ropes to ${p.nickname} are down (~${min} min) while its heartbeat still advances — alive but unreachable.`);
      } else if (st.condition === 'peer-offline') {
        const min = st.allDownSince ? Math.round((nowMs - st.allDownSince) / 60_000) : 0;
        sentences.push(`${p.nickname} is offline (~${min} min) — expected (its heartbeat stopped).`);
      } else if (st.condition === 'degraded') {
        const rows = this.safeSnapshot().filter((r) => r.peer === p.machineId && r.dead);
        const kinds = rows.map((r) => r.kind).join(', ') || 'a rope';
        sentences.push(`The ${kinds} rope to ${p.nickname} is down; another rope is carrying traffic.`);
      } else {
        // calm-alerting M-P3: the RECOVERING class — a rope answering probes
        // (recovery streak alive) but not yet reclaimed preferred status. This is
        // the digest home the demoted slow-alive escalations route to; without it
        // the demotion would be a black hole (the round-3 verified gap: the digest
        // previously had NO class for this state). Directionally honest wording.
        const recovering = this.safeSnapshot().filter((r) => r.peer === p.machineId && !r.dead && !r.lastKnownGood && r.recoveryStreak > 0);
        if (recovering.length > 0) {
          const kinds = recovering.map((r) => r.kind).join(', ');
          sentences.push(`The ${kinds} rope to ${p.nickname} is answering probes but still demoted (recovering; observed from this machine).`);
        }
      }
    }
    if (this.keyExpiryWarn() && this.keyExpirySoonest) {
      const who = this.keyExpirySoonest.role === 'self' ? 'this machine' : 'a peer machine';
      sentences.push(`A Tailscale key (${who}) expires in ${Math.max(0, Math.floor(this.keyExpirySoonest.inDays))} days — re-authenticate before it drops the rope.`);
    }
    if (sentences.length === 0) return null;
    return sentences.slice(0, 3).join(' ');
  }

  /** Record a digest emission (the digest job calls the route with ?digest=1). */
  recordDigestEmission(): void {
    this.metric('digest-emission');
  }

  // ── Safe dep reads (fail toward silence). ──

  private safeSnapshot(): RopeHealthSnapshotRow[] {
    try {
      return this.d.snapshot();
    } catch {
      // @silent-fallback-ok: a throwing snapshot source yields an empty view this
      // pass (UNKNOWN, fails toward NOT-urgent) — the next pass re-reads.
      return [];
    }
  }
  private safePeers(): RopeHealthPeerInfo[] {
    try {
      return this.d.listPeers().filter((p) => p.machineId !== this.d.selfMachineId);
    } catch {
      // @silent-fallback-ok: same posture as safeSnapshot.
      return [];
    }
  }
  private safeHeartbeat(machineId: string): number | null {
    try {
      return this.d.readHeartbeatAtMs(machineId);
    } catch {
      // @silent-fallback-ok: an unreadable heartbeat is "no evidence" — the
      // classifier then reads peer-offline (fails toward NOT-urgent).
      return null;
    }
  }
  private safeSplitBrainOpen(machineId: string): boolean {
    try {
      return this.d.splitBrainItemOpen?.(machineId) ?? false;
    } catch {
      // @silent-fallback-ok: an unreadable episode registry must not block the
      // urgent item (the failure direction here is a possible duplicate ask,
      // never a silent partition).
      return false;
    }
  }

  private recordTransition(prev: RopeHealthCondition, next: RopeHealthCondition): void {
    if (prev === next) return;
    const evt = (`transition-${next}` as RopeHealthMetricEvent);
    if (next !== 'unknown') this.metric(evt);
    this.scheduleWrite();
  }

  // ── Durable state (R-r2-4: transition-only writes + short debounce). ──

  private scheduleWrite(): void {
    this.writePending = true;
    if (this.writeTimer) return;
    if (this.cfg.writeDebounceMs <= 0) {
      this.writeStateNow();
      return;
    }
    this.writeTimer = setTimeout(() => {
      this.writeTimer = null;
      if (this.writePending) this.writeStateNow();
    }, this.cfg.writeDebounceMs);
    if (typeof this.writeTimer.unref === 'function') this.writeTimer.unref();
  }

  private writeStateNow(): void {
    this.writePending = false;
    try {
      const out: Record<string, unknown> = {};
      for (const [id, st] of this.peers) {
        out[id] = {
          condition: st.condition,
          allDownSince: st.allDownSince,
          consecutiveObservations: st.consecutiveObservations,
          episodeKey: st.episodeKey,
          urgentRaisedAt: st.urgentRaisedAt,
          detectedNotNotified: st.detectedNotNotified,
        };
      }
      fs.mkdirSync(path.dirname(this.d.stateFilePath), { recursive: true });
      const tmp = `${this.d.stateFilePath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ version: 1, peers: out }, null, 2));
      fs.renameSync(tmp, this.d.stateFilePath);
    } catch (err) {
      // @silent-fallback-ok: state persistence is debounce memory, never
      // authority — a failed write means a restart re-debounces (the declared
      // safe direction); the alert path is unaffected.
      this.log(`state write failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private loadState(): void {
    try {
      if (!fs.existsSync(this.d.stateFilePath)) return;
      const raw = JSON.parse(fs.readFileSync(this.d.stateFilePath, 'utf-8')) as {
        version?: number;
        peers?: Record<string, Partial<PeerRuntimeState>>;
      };
      for (const [id, p] of Object.entries(raw.peers ?? {})) {
        this.peers.set(id, {
          ...freshPeerState(),
          condition: isCondition(p.condition) ? p.condition : 'unknown',
          allDownSince: typeof p.allDownSince === 'number' ? p.allDownSince : null,
          // Intra-episode counters lost to a restart are ACCEPTED (a restart
          // re-debounces; it never fabricates an episode) — R-r2-4.
          consecutiveObservations: 0,
          episodeKey: typeof p.episodeKey === 'string' ? p.episodeKey : null,
          urgentRaisedAt: typeof p.urgentRaisedAt === 'number' ? p.urgentRaisedAt : null,
          detectedNotNotified: p.detectedNotNotified === true,
        });
      }
    } catch {
      // @silent-fallback-ok: a corrupt state file is a missing one (the safe
      // direction: re-debounce from scratch) — never a boot failure.
    }
  }
}

function freshPeerState(): PeerRuntimeState {
  return {
    condition: 'unknown',
    allDownSince: null,
    consecutiveObservations: 0,
    episodeKey: null,
    urgentRaisedAt: null,
    detectedNotNotified: false,
    healthySince: null,
    postOnsetBeatObservedAt: null,
  };
}

function isCondition(v: unknown): v is RopeHealthCondition {
  return v === 'ok' || v === 'degraded' || v === 'peer-offline' || v === 'urgent' || v === 'unknown';
}
