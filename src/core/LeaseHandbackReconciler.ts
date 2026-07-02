/**
 * LeaseHandbackReconciler — U4.4 (docs/specs/u4-4-lease-handback.md): the
 * missing RECONCILER for F4's `preferredAwakeMachineId`. Today the preference
 * only SUPPRESSES standby acquisition while the preferred holder is healthy;
 * nothing hands the lease BACK after a failover — the mesh drifts onto the
 * wrong long-term holder until a human runs the manual captain-flip playbook.
 *
 * Design (all R-markers binding):
 *   - Authority: F4's EXISTING per-machine config field, unchanged. NOT
 *     replicated, NOT in the lease record, NEVER writable by a peer. Unset =
 *     today's sticky behavior (strict no-op).
 *   - Observation rides the existing ~5s lease pull tick (no new dial loop);
 *     the HOLDER (only) evaluates.
 *   - Health source: the U4.3 rope-health snapshot seam (R-r2-7). An ABSENT
 *     snapshot reading for the preferred captain reads NOT-HEALTHY → defer —
 *     the reconciler fails toward HOLDING, never toward a transfer on missing
 *     data. (Pre-U4.3 there is no health source at all, so the reconciler
 *     never arms — safe.)
 *   - Hysteresis: hand-back arms only after `healthWindowMs` (default 10 min)
 *     of CONTINUOUS preferred-captain health; any unhealthy observation resets
 *     the window. In-memory; a holder restart resets it (declared: the safe
 *     direction — defers, never rushes).
 *   - Clean boundary, bounded deferral (P19): fires only at a quiet moment (no
 *     in-flight forwards, no queued inbound, no ingress ~90s). Past
 *     `deferralCeilingMs` (default 2h) of continuous deferral: ONE deduped
 *     notice + the boundary relaxes to "no in-flight forward" only — but the
 *     relaxed boundary must NOT strand queued inbound (R-r2-6): queued/held
 *     items are drained (via the existing durable inbound-queue semantics)
 *     BEFORE step-down, never abandoned.
 *   - Transfer ordering: claim-before-release via the holder-signed consent
 *     token (R-r2-1) carried on the `handback-offer` MeshCommand (R-r2-2). If
 *     the claim never lands, the holder KEEPS HOLDING — zero-holder states are
 *     impossible by construction.
 *   - Refused/failed offers never loop (R-r2-3): per-target offer backoff
 *     (widening), offers metered, and the episode cap counts OFFERS as well as
 *     completed hand-backs. A legacy peer (403/no-handler) stops re-offering
 *     for the episode.
 *   - The human always wins (R-r2-5): the operator latch is WRITTEN BY the
 *     explicit flip action itself (the PIN-gated flip route / playbook POST
 *     step) — NEVER inferred from a transfer's origin. While latched, the
 *     reconciler is fully inert and says so in its status.
 *   - Flap bounds: hand-backs COUNT as flips for the existing churn breaker,
 *     and a LATCHED breaker suppresses hand-back (breaker wins). Own episode
 *     cap: `maxPerWindow` (default 2) per rolling `windowMs` (6h) — at the cap
 *     the reconciler goes sticky + raises ONE deduped item.
 *   - Split-brain: suppressed while `splitBrainState` is active.
 *   - Post-hand-back verification: the NEW holder runs one delivery-canary
 *     round-trip; failure raises ONE loud escalation (never silent). That side
 *     lives in the offer HANDLER path (`decideOffer` + the claim runner).
 *
 * Observability (§4 — half-metered funnels forbidden): every transition emits
 * a `lease-handback` feature-metric event (window-starts, window-resets,
 * armed, deferrals, ceiling-relaxations, offers, claims, step-downs, failures,
 * canary-verify, suppressed-by-latch, suppressed-by-churn, episode-cap trips,
 * dry-run would-hand-back).
 */

import type { HandbackConsentToken } from './FencedLease.js';

/** Config subtree: multiMachine.leaseSelfHeal.preferredCaptainHandback (§5). */
export interface LeaseHandbackConfig {
  enabled: boolean;
  dryRun: boolean;
  healthWindowMs: number;
  deferralCeilingMs: number;
  operatorLatchMs: number;
  maxPerWindow: number;
  windowMs: number;
}

export const DEFAULT_LEASE_HANDBACK_CONFIG: LeaseHandbackConfig = {
  enabled: false,
  dryRun: true,
  healthWindowMs: 600_000,
  deferralCeilingMs: 7_200_000,
  operatorLatchMs: 86_400_000,
  maxPerWindow: 2,
  windowMs: 21_600_000,
};

/** Consent-token TTL: short — one offer round-trip plus slack. */
export const HANDBACK_CONSENT_TTL_MS = 60_000;
/** "No ingress in the last ~90s" clean-boundary bound (drift-promoter shape). */
export const HANDBACK_QUIET_INGRESS_MS = 90_000;

/**
 * §5 HARD graduation dependency, enforced at the enable chokepoint:
 * `dryRun:false` with pollFollowsLease still dry-run is REFUSED loudly at boot
 * — otherwise hand-back moves the lease while the old holder keeps polling
 * Telegram (a lease/ingress split, the exact class this project eliminates).
 * `hasPollerSplit` false (the install has no poller split) waives the check.
 * Returns null when valid, else the rejection message.
 */
export function validateHandbackEnableChokepoint(
  cfg: Pick<LeaseHandbackConfig, 'enabled' | 'dryRun'>,
  pollFollowsLeaseLive: boolean,
  hasPollerSplit: boolean,
): string | null {
  if (!cfg.enabled || cfg.dryRun) return null;
  if (!hasPollerSplit) return null;
  if (pollFollowsLeaseLive) return null;
  return (
    'multiMachine.leaseSelfHeal.preferredCaptainHandback: dryRun:false requires pollFollowsLease to be LIVE ' +
    '(multiMachine.pollFollowsLease enabled AND dryRun:false) — otherwise a hand-back moves the serving lease ' +
    'while Telegram polling stays on the old holder (a lease/ingress split). Refusing to start (u4-4 spec §5).'
  );
}

export type HandbackOfferResponse =
  | 'accept'
  | 'declined:churn-latched'
  | 'declined:quota'
  | 'declined:legacy-peer'
  | 'declined:other'
  | 'timeout';

export interface PreferredHealthView {
  /** Heartbeat-fresh in the pool registry (observer-stamped). */
  heartbeatFresh: boolean;
  /** Reachable on ≥1 rope per the U4.3 rope-health snapshot. `undefined` =
   *  absent snapshot record (never dialed / evicted / pre-U4.3) ⇒ NOT healthy. */
  ropeReachable: boolean | undefined;
  /** Registered + eligible to hold the lease. */
  leaseEligible: boolean;
  /** Not quota-blocked. */
  quotaOk: boolean;
}

export interface CleanBoundaryView {
  inFlightForwards: boolean;
  queuedInbound: number;
  /** ms since the last inbound ingress (null = none observed / no signal). */
  msSinceLastIngress: number | null;
}

export interface HandbackMetricSink {
  (event:
    | 'window-start'
    | 'window-reset'
    | 'armed'
    | 'deferral'
    | 'ceiling-relaxation'
    | 'offer'
    | 'claim'
    | 'step-down'
    | 'failure'
    | 'canary-verify-ok'
    | 'canary-verify-fail'
    | 'suppressed-by-latch'
    | 'suppressed-by-churn'
    | 'suppressed-by-split-brain'
    | 'episode-cap-trip'
    | 'would-hand-back'): void;
}

export interface LeaseHandbackDeps {
  config: () => LeaseHandbackConfig;
  selfMachineId: () => string | null;
  /** F4's `multiMachine.leaseSelfHeal.preferredAwakeMachineId` — the ONE
   *  authority; the wiring MUST read the same config field
   *  `shouldDeferToPreferred` reads (asserted by the wiring test). */
  preferredAwakeMachineId: () => string | null;
  holdsLease: () => boolean;
  currentEpoch: () => number;
  /** Health of the preferred captain (heartbeat + U4.3 rope snapshot + quota). */
  preferredHealth: (machineId: string) => PreferredHealthView;
  cleanBoundary: () => CleanBoundaryView;
  /** Kick one drain pass of the durable inbound queue (R-r2-6). */
  kickInboundDrain: () => void;
  splitBrainActive: () => boolean;
  churnLatched: () => boolean;
  /** Hand-back transfers COUNT as flips for the existing churn breaker. */
  recordChurnFlip: () => void;
  /** The machine-local operator latch marker (written BY the flip action —
   *  R-r2-5; never inferred). Returns the suppressed-until epoch-ms, or null. */
  operatorLatchUntilMs: () => number | null;
  /** HOLDER-side mint (LeaseCoordinator.mintHandbackConsent). Null = refused. */
  mintConsentToken: (target: string, ttlMs: number) => HandbackConsentToken | null;
  /** Send the handback-offer to the preferred captain (MeshRpcClient). The
   *  wiring maps 403/`no-handler` to 'declined:legacy-peer' and transport
   *  timeout/silence to 'timeout'. */
  sendOffer: (target: string, offer: { proposedEpoch: number; consentToken: HandbackConsentToken; expiresAt: string }) => Promise<HandbackOfferResponse>;
  metric: HandbackMetricSink;
  /** ONE deduped operator notice (deferral ceiling / episode cap). */
  notify: (key: string, title: string, body: string) => void;
  now?: () => number;
  monotonicNow?: () => number;
  logger?: (msg: string) => void;
}

export interface LeaseHandbackStatus {
  enabled: boolean;
  dryRun: boolean;
  preferred: string | null;
  state:
    | 'inactive'
    | 'not-holder'
    | 'self-is-preferred'
    | 'latched'
    | 'suppressed-churn'
    | 'suppressed-split-brain'
    | 'observing'
    | 'window-open'
    | 'armed'
    | 'deferring'
    | 'offer-in-flight'
    | 'episode-cap-sticky'
    | 'handed-back';
  windowOpenedAt: string | null;
  armedAt: string | null;
  deferralSinceMs: number | null;
  latchSuppressedUntil: string | null;
  lastEpisode: { at: string; outcome: string; target: string } | null;
  episodeEventsInWindow: number;
  counters: Record<string, number>;
}

interface EpisodeEvent {
  atMono: number;
  kind: 'offer' | 'handback';
}

export class LeaseHandbackReconciler {
  private readonly d: LeaseHandbackDeps;
  // Hysteresis window (in-memory on the holder; restart resets — safe).
  private windowOpenMono: number | null = null;
  private windowOpenWall: number | null = null;
  private armedAtMono: number | null = null;
  private armedAtWall: number | null = null;
  private ceilingRelaxed = false;
  private ceilingNoticeSent = false;
  private offerInFlight = false;
  private nextOfferAtMono = 0;
  private offerFailures = 0;
  private stopOfferingThisEpisode = false;
  /** Rolling episode events (offers + completed hand-backs — R-r2-3). */
  private episodeEvents: EpisodeEvent[] = [];
  private episodeCapNoticeSent = false;
  private lastOfferAccepted = false;
  private lastEpisode: LeaseHandbackStatus['lastEpisode'] = null;
  private state: LeaseHandbackStatus['state'] = 'inactive';
  private wouldHandbackLogged = false;
  private readonly counters: Record<string, number> = {};

  constructor(deps: LeaseHandbackDeps) {
    this.d = deps;
  }

  private now(): number {
    return (this.d.now ?? Date.now)();
  }
  private mono(): number {
    if (this.d.monotonicNow) return this.d.monotonicNow();
    return Number(process.hrtime.bigint() / 1_000_000n);
  }
  private log(m: string): void {
    try { this.d.logger?.(`[LeaseHandback] ${m}`); } catch { /* @silent-fallback-ok — a logger fault must never gate the lease decision (observability only) */ }
  }
  private metric(event: Parameters<HandbackMetricSink>[0]): void {
    this.counters[event] = (this.counters[event] ?? 0) + 1;
    try { this.d.metric(event); } catch { /* @silent-fallback-ok — a metrics-sink fault must never gate the lease decision (the in-memory counter above already recorded it) */ }
  }

  private resetWindow(reason: 'unhealthy' | 'role-change' | 'suppressed'): void {
    if (this.windowOpenMono !== null) {
      this.metric('window-reset');
      this.log(`hysteresis window reset (${reason})`);
    }
    this.windowOpenMono = null;
    this.windowOpenWall = null;
    this.armedAtMono = null;
    this.armedAtWall = null;
    this.ceilingRelaxed = false;
    this.ceilingNoticeSent = false;
    this.wouldHandbackLogged = false;
  }

  private pruneEpisodeEvents(nowMono: number, windowMs: number): void {
    const floor = nowMono - windowMs;
    this.episodeEvents = this.episodeEvents.filter((e) => e.atMono > floor);
  }

  /**
   * One holder-side observation (rides the ~5s lease pull tick). Synchronous
   * decision; the offer send is fired asynchronously with a single-flight
   * latch. Every gate fails toward HOLDING.
   */
  observe(): void {
    const cfg = this.d.config();
    if (!cfg.enabled) {
      this.state = 'inactive';
      return;
    }
    const self = this.d.selfMachineId();
    const preferred = this.d.preferredAwakeMachineId();
    if (!self || !preferred) {
      // Unset preference = today's sticky behavior (strict no-op).
      this.state = 'inactive';
      return;
    }
    if (self === preferred) {
      // We ARE the preferred captain — nothing to hand back FROM us.
      this.state = 'self-is-preferred';
      this.resetWindowIfOpen();
      return;
    }
    if (!this.d.holdsLease()) {
      // Post-hand-back: if our last offer was accepted and we no longer hold,
      // the step-down landed — count the flip + close the episode.
      if (this.lastOfferAccepted) {
        this.lastOfferAccepted = false;
        this.metric('step-down');
        try { this.d.recordChurnFlip(); } catch { /* breaker feed is best-effort */ }
        this.lastEpisode = { at: new Date(this.now()).toISOString(), outcome: 'handed-back', target: preferred };
        this.episodeEvents.push({ atMono: this.mono(), kind: 'handback' });
        this.state = 'handed-back';
        this.log(`hand-back to ${preferred} completed (higher epoch observed — stepped down)`);
      } else {
        this.state = 'not-holder';
      }
      this.resetWindowIfOpen();
      return;
    }

    const nowMono = this.mono();
    const nowWall = this.now();

    // The human always wins (R-r2-5): the latch fully inerts the reconciler.
    const latchUntil = this.d.operatorLatchUntilMs();
    if (latchUntil !== null && nowWall < latchUntil) {
      if (this.state !== 'latched') this.metric('suppressed-by-latch');
      this.state = 'latched';
      this.resetWindowIfOpen();
      return;
    }
    // A LATCHED churn breaker suppresses hand-back (the two compose: breaker wins).
    if (this.d.churnLatched()) {
      if (this.state !== 'suppressed-churn') this.metric('suppressed-by-churn');
      this.state = 'suppressed-churn';
      this.resetWindowIfOpen();
      return;
    }
    // Split-brain: reconciliation waits for a settled mesh.
    if (this.d.splitBrainActive()) {
      if (this.state !== 'suppressed-split-brain') this.metric('suppressed-by-split-brain');
      this.state = 'suppressed-split-brain';
      this.resetWindowIfOpen();
      return;
    }

    // Preferred-captain health (R-r2-7: absent rope snapshot ⇒ NOT healthy).
    const h = this.d.preferredHealth(preferred);
    const healthy = h.heartbeatFresh && h.ropeReachable === true && h.leaseEligible && h.quotaOk;
    if (!healthy) {
      this.state = 'observing';
      this.resetWindowIfOpen();
      return;
    }

    // Hysteresis: continuous health for healthWindowMs arms the hand-back.
    if (this.windowOpenMono === null) {
      this.windowOpenMono = nowMono;
      this.windowOpenWall = nowWall;
      this.metric('window-start');
      this.state = 'window-open';
      return;
    }
    if (nowMono - this.windowOpenMono < cfg.healthWindowMs) {
      this.state = 'window-open';
      return;
    }

    if (this.armedAtMono === null) {
      this.armedAtMono = nowMono;
      this.armedAtWall = nowWall;
      this.metric('armed');
      this.log(`hand-back to ${preferred} ARMED (healthy ${Math.round(cfg.healthWindowMs / 60000)}m)`);
    }
    this.state = 'armed';

    // Episode cap (R-r2-3: offers count too) → sticky + ONE deduped item.
    this.pruneEpisodeEvents(nowMono, cfg.windowMs);
    if (this.episodeEvents.length >= cfg.maxPerWindow) {
      this.state = 'episode-cap-sticky';
      if (!this.episodeCapNoticeSent) {
        this.episodeCapNoticeSent = true;
        this.metric('episode-cap-trip');
        try {
          this.d.notify(
            'lease-handback-episode-cap',
            'Lease hand-back went sticky (ping-pong bound)',
            `Hand-back to ${preferred} hit the episode cap (${cfg.maxPerWindow} offers/hand-backs per ${Math.round(cfg.windowMs / 3_600_000)}h). ` +
              'The lease stays where it is until the window rolls or you flip manually — this bounds a slow oscillation the churn window cannot see.',
          );
        } catch { /* notice is best-effort */ }
      }
      return;
    }
    this.episodeCapNoticeSent = false;

    if (this.stopOfferingThisEpisode) return; // legacy peer — sticky this episode
    if (this.offerInFlight) {
      this.state = 'offer-in-flight';
      return;
    }
    if (nowMono < this.nextOfferAtMono) return; // offer backoff (R-r2-3)

    // Clean boundary, bounded deferral (P19 + R-r2-6).
    const b = this.d.cleanBoundary();
    const quietIngress = b.msSinceLastIngress === null || b.msSinceLastIngress >= HANDBACK_QUIET_INGRESS_MS;
    const cleanOk = !b.inFlightForwards && b.queuedInbound === 0 && quietIngress;
    if (!cleanOk) {
      this.metric('deferral');
      this.state = 'deferring';
      const deferredMs = nowMono - (this.armedAtMono ?? nowMono);
      if (deferredMs >= cfg.deferralCeilingMs) {
        if (!this.ceilingNoticeSent) {
          this.ceilingNoticeSent = true;
          this.ceilingRelaxed = true;
          this.metric('ceiling-relaxation');
          try {
            this.d.notify(
              'lease-handback-deferral-ceiling',
              `Hand-back to ${preferred} has been waiting for a quiet moment`,
              `The armed hand-back has deferred for ${Math.round(deferredMs / 3_600_000 * 10) / 10}h waiting for a clean boundary. ` +
                'Relaxing the boundary to "no in-flight forward" — queued messages are drained across first, never abandoned.',
            );
          } catch { /* notice is best-effort */ }
        }
      }
      if (!this.ceilingRelaxed) return;
      // Relaxed boundary (R-r2-6): queued/held inbound is DRAINED before
      // step-down — never abandoned on the old holder.
      if (b.queuedInbound > 0) {
        try { this.d.kickInboundDrain(); } catch { /* drain kick is best-effort; retried next tick */ }
        return;
      }
      if (b.inFlightForwards) return;
      // fall through: relaxed boundary satisfied (no in-flight forward, queue empty)
    }

    // Fire (or dry-run).
    if (cfg.dryRun) {
      if (!this.wouldHandbackLogged) {
        this.wouldHandbackLogged = true;
        this.metric('would-hand-back');
        this.log(`DRY-RUN would hand back the lease to ${preferred} at a clean boundary`);
        this.lastEpisode = { at: new Date(nowWall).toISOString(), outcome: 'would-hand-back (dry-run)', target: preferred };
      }
      return;
    }

    const token = this.d.mintConsentToken(preferred, HANDBACK_CONSENT_TTL_MS);
    if (!token) return; // not actually holding / mint refused — hold
    this.offerInFlight = true;
    this.episodeEvents.push({ atMono: nowMono, kind: 'offer' });
    this.metric('offer');
    this.lastEpisode = { at: new Date(nowWall).toISOString(), outcome: 'offer-sent', target: preferred };
    void this.d
      .sendOffer(preferred, { proposedEpoch: this.d.currentEpoch() + 1, consentToken: token, expiresAt: token.expiresAt })
      .then((resp) => {
        this.offerInFlight = false;
        const monoNow = this.mono();
        if (resp === 'accept') {
          this.lastOfferAccepted = true;
          this.metric('claim');
          this.lastEpisode = { at: new Date(this.now()).toISOString(), outcome: 'offer-accepted (claim pending)', target: preferred };
          this.log(`hand-back offer accepted by ${preferred} — awaiting its fenced claim (holder keeps holding until the higher epoch lands)`);
          // The step-down is observed on a later tick via holdsLease() —
          // claim-before-release; a silent claim leaves us holding.
          this.nextOfferAtMono = monoNow + HANDBACK_CONSENT_TTL_MS * 2;
          return;
        }
        this.metric('failure');
        this.offerFailures++;
        // Widening backoff on decline/timeout (R-r2-3).
        this.nextOfferAtMono = monoNow + Math.min(6, this.offerFailures) * 5 * 60_000;
        this.lastEpisode = { at: new Date(this.now()).toISOString(), outcome: resp, target: preferred };
        if (resp === 'declined:legacy-peer') {
          // Version skew: peer-cannot-hand-back — STOP re-offering for the
          // episode (degrade to today's sticky behavior).
          this.stopOfferingThisEpisode = true;
          this.log(`peer ${preferred} cannot hand-back (legacy/refused) — sticky for this episode`);
        } else {
          this.log(`hand-back offer to ${preferred} ${resp} — holder keeps holding, backoff widened`);
        }
      })
      .catch(() => {
        // @silent-fallback-ok — a rejected offer send reads as failure: the holder
        // KEEPS HOLDING (claim-before-release, the safe direction), metered + backed off.
        this.offerInFlight = false;
        this.offerFailures++;
        this.metric('failure');
        this.nextOfferAtMono = this.mono() + Math.min(6, this.offerFailures) * 5 * 60_000;
      });
  }

  private resetWindowIfOpen(): void {
    if (this.windowOpenMono !== null) this.resetWindow('role-change');
    this.stopOfferingThisEpisode = false;
    this.offerFailures = 0;
  }

  status(): LeaseHandbackStatus {
    const cfg = this.d.config();
    const latchUntil = (() => { try { return this.d.operatorLatchUntilMs(); } catch { return null; /* @silent-fallback-ok — status read only; observe() reads the latch itself */ } })();
    return {
      enabled: cfg.enabled,
      dryRun: cfg.dryRun,
      preferred: (() => { try { return this.d.preferredAwakeMachineId(); } catch { return null; /* @silent-fallback-ok — status read only; observe() fails toward inactive on the same fault */ } })(),
      state: this.state,
      windowOpenedAt: this.windowOpenWall !== null ? new Date(this.windowOpenWall).toISOString() : null,
      armedAt: this.armedAtWall !== null ? new Date(this.armedAtWall).toISOString() : null,
      deferralSinceMs: this.armedAtMono !== null && this.state === 'deferring' ? this.mono() - this.armedAtMono : null,
      latchSuppressedUntil: latchUntil !== null ? new Date(latchUntil).toISOString() : null,
      lastEpisode: this.lastEpisode,
      episodeEventsInWindow: this.episodeEvents.length,
      counters: { ...this.counters },
    };
  }
}

/**
 * PREFERRED-CAPTAIN side — decide an inbound `handback-offer` (typed declines,
 * R-r2-2). The RBAC gate already proved the SENDER is the current lease
 * holder; the load-bearing authority is the consent token presented at
 * acquire time. Pure decision: the caller (server handler) runs the async
 * claim + delivery canary on 'accept'.
 */
export interface HandbackOfferDecisionDeps {
  enabled: boolean;
  selfMachineId: string | null;
  /** The SAME F4 field — does this machine agree it is the preferred captain? */
  preferredAwakeMachineId: string | null;
  churnLatched: boolean;
  quotaBlocked: boolean;
  /** Single-use: has this (holder, nonce) consent token been seen before? */
  tokenAlreadyUsed: boolean;
}

export function decideHandbackOffer(deps: HandbackOfferDecisionDeps): Exclude<HandbackOfferResponse, 'timeout'> {
  if (!deps.enabled) return 'declined:legacy-peer'; // feature dark here = cannot hand-back
  if (!deps.selfMachineId || deps.preferredAwakeMachineId !== deps.selfMachineId) {
    // Config disagreement — this machine does not consider itself the
    // preferred captain, so it cannot accept the role (the sender stops
    // re-offering for the episode; disagreement is visible on GET /pool).
    return 'declined:legacy-peer';
  }
  if (deps.tokenAlreadyUsed) return 'declined:other'; // replayed offer never re-authorizes
  if (deps.churnLatched) return 'declined:churn-latched';
  if (deps.quotaBlocked) return 'declined:quota';
  return 'accept';
}
