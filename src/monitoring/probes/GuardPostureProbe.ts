/**
 * Guard-Posture Probe — the structural consumer (GUARD-POSTURE-ENDPOINT-SPEC §2.4).
 *
 * A readable posture surface nobody reads is a wish (Structure > Willpower):
 * on the established probe cadence this probe evaluates the local guard
 * inventory plus every peer's heartbeat-sourced posture and raises ONE
 * aggregated, episode-keyed Attention item when an anomaly persists across
 * consecutive probe ticks.
 *
 * Anomaly classes: `diverged-from-default` offs (the load-shed signature),
 * `off-runtime-divergent` (the in-memory disable class), `on-stale`,
 * `missing`, `errored` — and `flapping` (sub-cadence toggling: a guard whose
 * posture flipped more than K times within the probe's recorded window of its
 * own ticks, even when each individual sighting looks settled or quiet).
 * `dark-default` offs are quiet — never anomalies.
 *
 * Data source rule (spec): heartbeat posture (with its age) is the input for
 * every peer; the deep-read fallback fires ONLY for peers the registry
 * currently believes ONLINE whose heartbeat block is missing or stale — for
 * offline/dark peers the probe evaluates the durable last-known posture
 * directly, NEVER a doomed fan-out (a permanently-dark peer must not buy a
 * timeout on every probe tick forever).
 *
 * Episode semantics (P17/P19): ONE aggregated item per episode under the
 * stable healthKey; while an episode is open the probe never re-emits (the
 * attention layer's healthKey dedup is the backstop, not the mechanism); an
 * episode ends only when ALL anomalies clear; a cleared-then-recurring
 * anomaly set is a NEW episode (new id suffix, same healthKey).
 *
 * Episode state is durable JSON (atomic tmp+rename); a corrupt file
 * re-baselines without crashing.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { Probe, ProbeResult } from '../SystemReviewer.js';
import type { ProbeVerifyScope } from './__shared.js';
import type {
  GuardInventoryResult,
  HeartbeatGuardPosture,
} from '../guardPostureView.js';
import { GUARD_MANIFEST } from '../guardManifest.js';

/** Local, fleet-uniform manifest lookup: guardKey → criticalPath. A peer's
 *  criticalPath (heartbeat gaps carry only the key) is looked up here — the
 *  manifest ships atomic with the code, so it is valid fleet-wide (spec §2.3/§4). */
const CRITICAL_PATH_BY_KEY: ReadonlyMap<string, string> = new Map(
  GUARD_MANIFEST.filter((e) => e.loadBearing && e.criticalPath).map((e) => [e.key, e.criticalPath!]),
);

export const __verifyScope = ['guard-posture'] as const satisfies ProbeVerifyScope;

/** An anomaly must be seen on this many CONSECUTIVE ticks before alerting. */
export const PERSISTENCE_TICKS = 2;
/** Flapping threshold K — more than K flips within the window raises `flapping`. */
export const FLAP_K = 3;
/** Window (in probe ticks) over which posture flips are counted. */
export const FLAP_WINDOW_TICKS = 10;
/** A peer heartbeat posture older than this counts as stale for the deep-read fallback. */
export const STALE_POSTURE_AGE_MS = 15 * 60_000;
/** Stable episode healthKey — same across episodes so the attention layer dedups per-episode. */
export const GUARD_POSTURE_HEALTH_KEY = 'guard-posture-anomalies';
/** G3: the load-bearing-gap track's healthKey. NB: guard-posture items carry no
 *  `lane:'agent-health'`, so healthKey is INERT for them (the agent-health lane's
 *  same-key suppression never runs) — the separate ITEM-ID namespace (episode
 *  track) is the real de-masking lever, NOT this key (spec §2.3/§2.5). */
export const GUARD_POSTURE_LOADBEARING_HEALTH_KEY = 'guard-posture-loadbearing-gaps';

export type GuardAnomalyClass =
  | 'diverged-from-default'
  | 'off-runtime-divergent'
  | 'on-stale'
  | 'missing'
  | 'errored'
  | 'flapping'
  // G3: a load-bearing critical path silently unguarded past its soak window.
  // A DESIGNED long-lived anomaly (the graduate/accept decision takes days) — so
  // it runs on its OWN episode track, never masking an acute load-shed (§2.3).
  | 'load-bearing-gap';

export interface PeerPostureRead {
  machineId: string;
  nickname?: string;
  online: boolean;
  /** Heartbeat-sourced compact block; durable last-known for offline peers. */
  posture: HeartbeatGuardPosture | null;
  /** Receiver-side age of the posture block; null when no posture ever received. */
  postureAgeMs: number | null;
}

export interface GuardPostureAttentionItem {
  id: string;
  title: string;
  summary: string;
  category: string;
  priority: 'URGENT' | 'HIGH' | 'NORMAL' | 'LOW';
  sourceContext?: string;
  healthKey?: string;
}

export interface GuardPostureProbeDeps {
  /** One-read local inventory (GET /guards source) or null when unavailable. */
  getLocalPosture: () => GuardInventoryResult | null;
  /** Heartbeat-sourced peer postures (durable last-known for offline peers). */
  getPeerPostures: () => PeerPostureRead[];
  /**
   * Optional deep read — used ONLY for peers reported ONLINE whose posture is
   * null or stale. NEVER called for offline peers (spec §2.4).
   */
  deepReadPeer?: (machineId: string) => Promise<unknown>;
  /** Aggregated emit funnel (P17) — ONE item per episode, per track. */
  emitAttention: (item: GuardPostureAttentionItem) => Promise<void>;
  /** Episode state persists at `<stateDir>/state/guard-posture-episodes.json`. */
  stateDir: string;
  now?: () => number;
  /** G3 rollout sub-flag (§6): gate the load-bearing-gap ATTENTION alert only.
   *  Default-on (soak-gated is automatic — soak windows are manifest constants).
   *  When false, /guards still classifies loadBearingGap; the probe just doesn't
   *  raise the load-bearing-gap attention item (rollback lever). The ACUTE track
   *  is unaffected. */
  alertLoadBearingGaps?: boolean;
}

// ────────────────────────────── durable state ──────────────────────────────

interface AnomalyEpisodeRecord {
  firstSeenTick: number;
  lastSeenTick: number;
}

interface GuardFlipRecord {
  lastPosture: string;
  /** Tick numbers at which a posture flip was observed (pruned to the window). */
  flips: number[];
}

interface EpisodeState {
  version: 1;
  tick: number;
  // ── ACUTE track (the load-shed signature classes; legacy field names kept) ──
  episodeCounter: number;
  openEpisodeId: string | null;
  /** Whether the open episode's aggregated item was successfully emitted. */
  episodeEmitted: boolean;
  anomalies: Record<string, AnomalyEpisodeRecord>;
  // ── G3 LOAD-BEARING-GAP track (independent lifecycle + item-id namespace) ──
  lbEpisodeCounter: number;
  lbOpenEpisodeId: string | null;
  lbEpisodeEmitted: boolean;
  lbAnomalies: Record<string, AnomalyEpisodeRecord>;
  guardHistory: Record<string, GuardFlipRecord>;
  updatedAt: number;
}

function freshState(now: number): EpisodeState {
  return {
    version: 1,
    tick: 0,
    episodeCounter: 0,
    openEpisodeId: null,
    episodeEmitted: false,
    anomalies: {},
    lbEpisodeCounter: 0,
    lbOpenEpisodeId: null,
    lbEpisodeEmitted: false,
    lbAnomalies: {},
    guardHistory: {},
    updatedAt: now,
  };
}

function stateFilePath(stateDir: string): string {
  return path.join(stateDir, 'state', 'guard-posture-episodes.json');
}

function loadState(stateDir: string, now: number): EpisodeState {
  const file = stateFilePath(stateDir);
  try {
    if (!fs.existsSync(file)) return freshState(now);
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8')) as Partial<EpisodeState>;
    if (
      parsed?.version === 1 &&
      typeof parsed.tick === 'number' &&
      typeof parsed.episodeCounter === 'number' &&
      parsed.anomalies !== null && typeof parsed.anomalies === 'object' &&
      parsed.guardHistory !== null && typeof parsed.guardHistory === 'object'
    ) {
      return {
        version: 1,
        tick: parsed.tick,
        episodeCounter: parsed.episodeCounter,
        openEpisodeId: typeof parsed.openEpisodeId === 'string' ? parsed.openEpisodeId : null,
        episodeEmitted: parsed.episodeEmitted === true,
        anomalies: parsed.anomalies as Record<string, AnomalyEpisodeRecord>,
        // G3 lb-track fields — absent on a pre-G3 state file: default to a fresh
        // (closed) track rather than crashing (back-compat, the safe direction).
        lbEpisodeCounter: typeof parsed.lbEpisodeCounter === 'number' ? parsed.lbEpisodeCounter : 0,
        lbOpenEpisodeId: typeof parsed.lbOpenEpisodeId === 'string' ? parsed.lbOpenEpisodeId : null,
        lbEpisodeEmitted: parsed.lbEpisodeEmitted === true,
        lbAnomalies:
          parsed.lbAnomalies !== null && typeof parsed.lbAnomalies === 'object'
            ? (parsed.lbAnomalies as Record<string, AnomalyEpisodeRecord>)
            : {},
        guardHistory: parsed.guardHistory as Record<string, GuardFlipRecord>,
        updatedAt: typeof parsed.updatedAt === 'number' ? parsed.updatedAt : now,
      };
    }
  } catch {
    // Corrupt episode state — re-baseline rather than crash; persistence
    // counting restarts (the safe direction: no alert fires off bad state).
  }
  return freshState(now);
}

function saveState(stateDir: string, state: EpisodeState): void {
  const file = stateFilePath(stateDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  /* state-registry: guard-posture-episodes */
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf-8');
  fs.renameSync(tmp, file);
}

// ─────────────────────────── anomaly evaluation ────────────────────────────

interface CurrentAnomaly {
  /** Stable identity: `<machineId>|<class>|<guardKey or *>`. */
  key: string;
  machineId: string;
  label: string;
  cls: GuardAnomalyClass;
  guardKey?: string;
  /** Count-only classes (heartbeat-sourced peers) carry a count, no keys. */
  count?: number;
  /** G3 (§2.3): the load-bearing critical path — rides ANY anomaly of a
   *  load-bearing guard, so a loud class reads "a LOAD-BEARING path (X) is down." */
  criticalPath?: string;
}

function anomalyKey(machineId: string, cls: GuardAnomalyClass, guardKey?: string): string {
  return `${machineId}|${cls}|${guardKey ?? '*'}`;
}

const HISTORY_SEP = '::';

/**
 * Evaluate a full inventory (local machine, or a peer deep-read that returned
 * one). Full per-key detail for every class; dark-default offs are quiet.
 */
function evaluateInventory(
  machineId: string,
  label: string,
  inv: GuardInventoryResult,
  anomalies: CurrentAnomaly[],
  postures: Map<string, string>,
): void {
  for (const g of inv.guards) {
    // Posture signature for flap tracking — offClass included so a flip
    // between dark-default-off and on is still a flip.
    const signature = g.effective === 'off' ? `off:${g.offClass ?? 'unknown'}` : g.effective;
    postures.set(`${machineId}${HISTORY_SEP}${g.key}`, signature);

    // G3: criticalPath rides ANY anomaly of a load-bearing guard (§2.3).
    const cp = g.criticalPath;

    switch (g.effective) {
      case 'off':
        if (g.offClass === 'diverged-from-default') {
          anomalies.push({
            key: anomalyKey(machineId, 'diverged-from-default', g.key),
            machineId, label, cls: 'diverged-from-default', guardKey: g.key, criticalPath: cp,
          });
        }
        // dark-default offs are quiet — EXCEPT a load-bearing one past soak (below).
        break;
      case 'off-runtime-divergent':
      case 'on-stale':
      case 'missing':
      case 'errored':
        anomalies.push({
          key: anomalyKey(machineId, g.effective, g.key),
          machineId, label, cls: g.effective, guardKey: g.key, criticalPath: cp,
        });
        break;
      default:
        break;
    }

    // G3 (§2.3): a load-bearing guard silently unguarded past its soak window
    // (dark-default off OR on-dry-run) hits `case 'off'` (only pushes on
    // diverged-from-default) or `default:break` — so the explicit loadBearingGap
    // check is REQUIRED. Loud classes above already alarm (no double-alarm).
    if (g.loadBearingGap) {
      anomalies.push({
        key: anomalyKey(machineId, 'load-bearing-gap', g.key),
        machineId, label, cls: 'load-bearing-gap', guardKey: g.key, criticalPath: cp,
      });
    }
  }
}

/**
 * Evaluate a compact heartbeat posture block. Only the two sharpest signals
 * carry per-key detail (offDeviantKeys, offRuntimeDivergentKeys); the other
 * classes are count-only (spec §2.4 last line / §3(f)).
 */
function evaluateHeartbeat(
  machineId: string,
  label: string,
  hb: HeartbeatGuardPosture,
  anomalies: CurrentAnomaly[],
  postures: Map<string, string>,
  priorHistory: Record<string, GuardFlipRecord>,
): void {
  const offDeviant = new Set(Array.isArray(hb.offDeviantKeys) ? hb.offDeviantKeys : []);
  const offRuntime = new Set(Array.isArray(hb.offRuntimeDivergentKeys) ? hb.offRuntimeDivergentKeys : []);
  // G3: a peer's load-bearing-gap keys (Array.isArray-guarded — an un-upgraded
  // peer omits the field → empty). criticalPath is looked up from the LOCAL
  // fleet-uniform manifest (§2.3/§4).
  const loadBearingGap = new Set(Array.isArray(hb.loadBearingGapKeys) ? hb.loadBearingGapKeys : []);

  for (const key of offDeviant) {
    anomalies.push({
      key: anomalyKey(machineId, 'diverged-from-default', key),
      machineId, label, cls: 'diverged-from-default', guardKey: key,
      criticalPath: CRITICAL_PATH_BY_KEY.get(key),
    });
    postures.set(`${machineId}${HISTORY_SEP}${key}`, 'off:diverged-from-default');
  }
  for (const key of offRuntime) {
    anomalies.push({
      key: anomalyKey(machineId, 'off-runtime-divergent', key),
      machineId, label, cls: 'off-runtime-divergent', guardKey: key,
      criticalPath: CRITICAL_PATH_BY_KEY.get(key),
    });
    postures.set(`${machineId}${HISTORY_SEP}${key}`, 'off-runtime-divergent');
  }
  for (const key of loadBearingGap) {
    anomalies.push({
      key: anomalyKey(machineId, 'load-bearing-gap', key),
      machineId, label, cls: 'load-bearing-gap', guardKey: key,
      criticalPath: CRITICAL_PATH_BY_KEY.get(key),
    });
    postures.set(`${machineId}${HISTORY_SEP}${key}`, 'load-bearing-gap');
  }

  // Previously-tracked keys that are no longer in either list record a
  // 'settled' posture so the flip OUT is observable (flap awareness).
  const prefix = `${machineId}${HISTORY_SEP}`;
  for (const histKey of Object.keys(priorHistory)) {
    if (histKey.startsWith(prefix) && !postures.has(histKey)) {
      postures.set(histKey, 'settled');
    }
  }

  const countOnly: Array<[GuardAnomalyClass, number]> = [
    ['on-stale', typeof hb.onStale === 'number' ? hb.onStale : 0],
    ['missing', typeof hb.missing === 'number' ? hb.missing : 0],
    ['errored', typeof hb.errored === 'number' ? hb.errored : 0],
  ];
  for (const [cls, count] of countOnly) {
    if (count > 0) {
      anomalies.push({ key: anomalyKey(machineId, cls), machineId, label, cls, count });
    }
  }
}

/** Best-effort interpretation of an untyped deep-read response. */
function interpretDeepRead(
  raw: unknown,
): { inventory?: GuardInventoryResult; heartbeat?: HeartbeatGuardPosture } | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (Array.isArray(o.guards)) return { inventory: o as unknown as GuardInventoryResult };
  if (Array.isArray(o.offDeviantKeys)) return { heartbeat: o as unknown as HeartbeatGuardPosture };
  return null;
}

function formatAnomaly(a: CurrentAnomaly): string {
  // G3: a load-bearing anomaly names its critical path, so a gap reads
  // "a LOAD-BEARING critical path (X) is down," never a bare row (§2.3).
  const cp = a.criticalPath ? ` — LOAD-BEARING critical path: ${a.criticalPath}` : '';
  if (a.guardKey) return `[${a.label}] ${a.guardKey}: ${a.cls}${cp}`;
  return `[${a.label}] ${a.count ?? '?'} guard(s) ${a.cls} (count-only via heartbeat)${cp}`;
}

// ───────────────────────────────── probe ───────────────────────────────────

export function createGuardPostureProbes(deps: GuardPostureProbeDeps): Probe[] {
  const tier = 2 as const;
  const feature = 'Guard Posture';
  const probeId = 'instar.guard-posture.anomalies';
  const probeName = 'Guard Posture Anomalies';
  const now = deps.now ?? (() => Date.now());

  async function runTick(): Promise<ProbeResult> {
    const base = { probeId, name: probeName, tier, durationMs: 0 };
    try {
      const state = loadState(deps.stateDir, now());
      const tick = state.tick + 1;

      const current: CurrentAnomaly[] = [];
      const postures = new Map<string, string>();

      // ── Local machine ──
      const localInv = deps.getLocalPosture();
      if (localInv) evaluateInventory('local', 'local', localInv, current, postures);

      // ── Peers ──
      for (const peer of deps.getPeerPostures()) {
        const label = peer.nickname ?? peer.machineId;
        const postureStale =
          peer.postureAgeMs !== null && peer.postureAgeMs > STALE_POSTURE_AGE_MS;

        let evaluated = false;
        if (peer.online && deps.deepReadPeer && (peer.posture === null || postureStale)) {
          // ONLINE peer with a missing/stale heartbeat block — the only case
          // the deep read may fire (never offline peers: a permanently-dark
          // peer must not buy a timeout on every probe tick forever).
          try {
            const interpreted = interpretDeepRead(await deps.deepReadPeer(peer.machineId));
            if (interpreted?.inventory) {
              evaluateInventory(peer.machineId, label, interpreted.inventory, current, postures);
              evaluated = true;
            } else if (interpreted?.heartbeat) {
              evaluateHeartbeat(
                peer.machineId, label, interpreted.heartbeat, current, postures, state.guardHistory,
              );
              evaluated = true;
            }
          } catch {
            // Deep read failed — fall back to last-known posture below.
          }
        }
        if (!evaluated && peer.posture) {
          // Heartbeat (or durable last-known, for offline peers) is the input.
          evaluateHeartbeat(peer.machineId, label, peer.posture, current, postures, state.guardHistory);
        }
        // No posture ever received and no deep read: unknown — no anomaly to
        // raise from nothing (the pool surface renders "guards: unknown").
      }

      // ── Flap awareness — record posture deltas between our own ticks ──
      const nextHistory: Record<string, GuardFlipRecord> = {};
      for (const [histKey, signature] of postures) {
        const prev = state.guardHistory[histKey];
        let flips = prev ? prev.flips.filter((t) => t > tick - FLAP_WINDOW_TICKS) : [];
        if (prev && prev.lastPosture !== signature) flips = [...flips, tick];
        nextHistory[histKey] = { lastPosture: signature, flips };
        if (flips.length > FLAP_K) {
          const sep = histKey.indexOf(HISTORY_SEP);
          const machineId = histKey.slice(0, sep);
          const guardKey = histKey.slice(sep + HISTORY_SEP.length);
          const label =
            current.find((a) => a.machineId === machineId)?.label ??
            (machineId === 'local' ? 'local' : machineId);
          current.push({
            key: anomalyKey(machineId, 'flapping', guardKey),
            machineId, label, cls: 'flapping', guardKey,
          });
        }
      }
      state.guardHistory = nextHistory;

      // ── G3: partition the anomaly stream into TWO independent tracks (§2.3) ──
      // The load-bearing-gap track and the acute track run separate episode
      // lifecycles so a long-lived designed gap can NEVER hold an episode open in
      // a way that masks an acute load-shed. `load-bearing-gap` and the acute
      // classes are mutually exclusive per guard (a load-bearing loud class pushes
      // the acute anomaly, NOT a gap), so a clean partition by class is exact.
      // The lb-alert sub-flag (§6) gates ONLY the lb track — /guards classification
      // is a separate route, unaffected. When off, the lb track closes + never emits.
      const lbAlertEnabled = deps.alertLoadBearingGaps !== false;
      const currentAcute = current.filter((a) => a.cls !== 'load-bearing-gap');
      const currentLb = lbAlertEnabled ? current.filter((a) => a.cls === 'load-bearing-gap') : [];

      // ── Persistence accounting (≥2 consecutive ticks) — one map PER track ──
      const accrue = (
        subset: CurrentAnomaly[],
        prior: Record<string, AnomalyEpisodeRecord>,
      ): Record<string, AnomalyEpisodeRecord> => {
        const next: Record<string, AnomalyEpisodeRecord> = {};
        for (const a of subset) {
          const prev = prior[a.key];
          next[a.key] = prev && prev.lastSeenTick === tick - 1
            ? { firstSeenTick: prev.firstSeenTick, lastSeenTick: tick }
            : { firstSeenTick: tick, lastSeenTick: tick };
        }
        return next;
      };
      const nextAcute = accrue(currentAcute, state.anomalies);
      const nextLb = accrue(currentLb, state.lbAnomalies);
      state.anomalies = nextAcute;
      state.lbAnomalies = nextLb;

      const persisted = (a: CurrentAnomaly, recs: Record<string, AnomalyEpisodeRecord>): boolean => {
        // Flapping is alertable on sight: its >K flips were, by construction,
        // recorded across multiple prior ticks — the persistence intent is met.
        if (a.cls === 'flapping') return true;
        const rec = recs[a.key];
        return !!rec && rec.lastSeenTick - rec.firstSeenTick + 1 >= PERSISTENCE_TICKS;
      };
      const alertableAcute = currentAcute.filter((a) => persisted(a, nextAcute));
      const alertableLb = currentLb.filter((a) => persisted(a, nextLb));

      // ── Episode lifecycle — run each track independently ──
      // CRITICAL COUPLING (§2.3): the acute track's CLOSE condition tests
      // currentAcute (its own subset), NOT the shared `current` — else a
      // long-lived load-bearing gap keeps `current.length>0` and re-masks acute.
      let acuteEmitted = false;
      let lbEmitted = false;

      // Acute track (`guard-posture:ep-N`).
      if (currentAcute.length === 0) {
        state.openEpisodeId = null;
        state.episodeEmitted = false;
      } else if (alertableAcute.length > 0) {
        if (!state.openEpisodeId) {
          state.episodeCounter += 1;
          state.openEpisodeId = `ep-${state.episodeCounter}`;
          state.episodeEmitted = false;
        }
        if (!state.episodeEmitted) {
          const lines = [...currentAcute].sort((x, y) => x.key.localeCompare(y.key)).map(formatAnomaly);
          try {
            await deps.emitAttention({
              id: `guard-posture:${state.openEpisodeId}`,
              title: `Guard posture anomalies (${currentAcute.length})`,
              summary:
                `Guard-posture anomalies persisting across probe ticks:\n` +
                lines.map((l) => `- ${l}`).join('\n'),
              category: 'guard-posture',
              priority: 'HIGH',
              sourceContext: 'guard-posture-probe',
              healthKey: GUARD_POSTURE_HEALTH_KEY,
            });
            state.episodeEmitted = true;
            acuteEmitted = true;
          } catch {
            // Emit failed — keep episodeEmitted=false so the next tick retries.
          }
        }
      }

      // Load-bearing-gap track (`guard-posture-loadbearing:ep-N`) — separate
      // item-id namespace + separate open/emit state, so it cannot mask the acute
      // track. Soaking pushes NO anomaly (§2.3), so it can never open this track.
      if (currentLb.length === 0) {
        state.lbOpenEpisodeId = null;
        state.lbEpisodeEmitted = false;
      } else if (alertableLb.length > 0) {
        if (!state.lbOpenEpisodeId) {
          state.lbEpisodeCounter += 1;
          state.lbOpenEpisodeId = `ep-${state.lbEpisodeCounter}`;
          state.lbEpisodeEmitted = false;
        }
        if (!state.lbEpisodeEmitted) {
          const lines = [...currentLb].sort((x, y) => x.key.localeCompare(y.key)).map(formatAnomaly);
          try {
            await deps.emitAttention({
              id: `guard-posture-loadbearing:${state.lbOpenEpisodeId}`,
              title: `Load-bearing guard gap (${currentLb.length})`,
              summary:
                `A LOAD-BEARING critical path depends on a guard that is silently ` +
                `unguarded (past its soak window, not accepted). Graduate it, let it ` +
                `soak, OR record an owned accepted-fallback (PIN):\n` +
                lines.map((l) => `- ${l}`).join('\n'),
              category: 'guard-posture',
              priority: 'HIGH',
              sourceContext: 'guard-posture-probe-loadbearing',
              healthKey: GUARD_POSTURE_LOADBEARING_HEALTH_KEY,
            });
            state.lbEpisodeEmitted = true;
            lbEmitted = true;
          } catch {
            // Emit failed — retry next tick (same id, attention-layer dedup backstop).
          }
        }
      }

      const alertable = [...alertableAcute, ...alertableLb];
      const emittedThisTick = acuteEmitted || lbEmitted;

      state.tick = tick;
      state.updatedAt = now();
      saveState(deps.stateDir, state);

      const diagnostics = {
        tick,
        currentAnomalies: current.length,
        alertable: alertable.length,
        openEpisode: state.openEpisodeId,
        loadBearingGapEpisode: state.lbOpenEpisodeId,
        emittedThisTick,
      };

      if (alertable.length > 0) {
        const lines = alertable
          .sort((x, y) => x.key.localeCompare(y.key))
          .map(formatAnomaly);
        return {
          ...base,
          passed: false,
          description: `Guard-posture anomalies persisting (${alertable.length}): ${lines.join('; ')}`,
          error: `Episode ${state.openEpisodeId ?? state.lbOpenEpisodeId}: ${alertable.length} anomaly(ies) across machines`,
          diagnostics,
          remediation: [
            'Read GET /guards?scope=pool for the full per-machine posture',
            'A diverged-from-default off is the load-shed signature — re-enable deliberately (send the FULL config block; PATCH /config merges one level deep)',
            'off-runtime-divergent means the live runtime contradicts an on-config — restart the component or its server',
            'A load-bearing-gap means a critical path depends on a dark guard — graduate it, let it soak, OR record an owned accept: POST /guards/:key/accept-fallback {reason, owner} (dashboard PIN)',
          ],
        };
      }

      return {
        ...base,
        passed: true,
        description:
          current.length === 0
            ? 'No guard-posture anomalies across machines'
            : `${current.length} anomaly(ies) observed once — awaiting persistence (no alert yet)`,
        diagnostics,
      };
    } catch (err) {
      return {
        ...base,
        passed: false,
        description: 'Guard-posture probe failed to evaluate',
        error: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
        remediation: ['Check guard-posture wiring (getLocalPosture/getPeerPostures deps)'],
      };
    }
  }

  return [
    {
      id: probeId,
      name: probeName,
      tier,
      feature,
      timeoutMs: 10_000,
      prerequisites: () => true,
      run: runTick,
    },
  ];
}
