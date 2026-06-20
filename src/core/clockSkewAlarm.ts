/**
 * B4 (multimachine-lease-poll-robustness, Decision 9) — the clock-skew alarm
 * decision.
 *
 * The mesh RPC rejects a signed envelope whose timestamp is >30s off the
 * receiver's clock (`MeshRpc.verifyEnvelope`). When two machines' clocks drift
 * past that, the cross-machine handshake silently breaks (the 2026-06-20
 * post-reboot incident: a transient skew 403'd every lease/heartbeat RPC, the lease
 * couldn't settle, and nobody was told). This decides whether to raise an
 * EARLY-WARNING — at a margin BELOW the 30s reject cliff — so an operator hears
 * about drift before the handshake fails, not after.
 *
 * Two N=2 subtleties this encodes:
 *   - Attribution: with only two machines and no third reference, a measured
 *     offset is RELATIVE — each sees the other as skewed. So each machine checks
 *     its OWN NTP sync and, when ITS clock is unsynced, blames ITSELF rather than
 *     finger-pointing the peer (Decision 9). Only when our own clock is verified
 *     synced do we point at the peer.
 *   - Hysteresis: the measured offset is a noisy signal near the threshold;
 *     alarm at `alarmThresholdMs`, clear only below `clearThresholdMs`, so it
 *     doesn't flap the attention surface.
 *
 * Pure + deterministic → fully unit-testable. SIGNAL only — never widens the
 * MeshRpc reject (replay-safety) and never gates; it raises an advisory alarm.
 */

export type SkewBlame = 'self' | 'peer' | 'unknown' | 'local-freeze';

export interface ClockSkewInputs {
  /** Measured offset to the peer in ms — use max(ewma, lastSample) so a STEP
   *  skew (the real incident) alarms immediately, not after an EWMA ramp. */
  observedOffsetMs: number;
  /** Is THIS machine's clock NTP-synced (probed via sntp/timedatectl)? undefined =
   *  unknown (couldn't probe) → don't confidently blame the peer. */
  ownNtpSynced: boolean | undefined;
  /** Raise threshold (ms). Default caller: 20000 (⅔ of the 30s reject cliff). */
  alarmThresholdMs: number;
  /** Hysteresis clear threshold (ms). Default caller: 12000. Must be < alarm. */
  clearThresholdMs: number;
  /** Current alarm state for this peer (hysteresis). */
  currentlyAlarming: boolean;
  /** ms since the last LOCAL event-loop STARVATION burst (e.g. SleepWakeDetector
   *  drift). undefined = no recent freeze observed. THE LIVE LESSON (2026-06-20,
   *  topic 13481): when this machine's event loop freezes for many seconds, mesh
   *  timestamps set BEFORE the freeze are verified AFTER it and look "stale" — so
   *  a large `observedOffsetMs` appears even when BOTH clocks are perfectly synced
   *  (measured: Laptop vs Mini = 1s). Without this guard the alarm would
   *  FALSE-POSITIVE as "peer clock skew" during a purely-local freeze. */
  recentLocalStarvationAgeMs?: number;
  /** How recent a local starvation counts as "could explain this offset" (ms).
   *  Default caller: 30000. Within this window a large offset is attributed to the
   *  freeze (blame 'local-freeze'), and the peer-skew alarm is SUPPRESSED — the
   *  safe direction: a genuine PERSISTENT skew still alarms once the freeze ages
   *  out, but we never finger-point a peer for our own freeze. */
  starvationFreshnessMs?: number;
}

export interface ClockSkewVerdict {
  alarming: boolean;
  blame: SkewBlame;
  reason: string;
}

export function evaluateClockSkew(i: ClockSkewInputs): ClockSkewVerdict {
  const mag = Math.abs(i.observedOffsetMs);
  // Hysteresis: once alarming, stay until below the clear threshold; otherwise
  // only start alarming at/above the alarm threshold.
  const alarming = i.currentlyAlarming ? mag >= i.clearThresholdMs : mag >= i.alarmThresholdMs;
  if (!alarming) {
    return { alarming: false, blame: 'unknown', reason: `clock offset ${Math.round(mag)}ms within tolerance` };
  }
  // Freeze-vs-skew disambiguation (the 2026-06-20 live lesson). If THIS machine's
  // event loop just starved, a large apparent offset is most likely the freeze
  // making pre-freeze timestamps look stale — NOT genuine peer clock drift. Defer
  // to the starvation signal (which has its own surface) and SUPPRESS the peer
  // alarm. Safe direction: a persistent genuine skew re-alarms once the freeze
  // window ages out; we never raise a misleading "peer skew" during our own freeze.
  const freshFreeze =
    i.recentLocalStarvationAgeMs !== undefined &&
    i.recentLocalStarvationAgeMs <= (i.starvationFreshnessMs ?? 30_000);
  if (freshFreeze) {
    return {
      alarming: false,
      blame: 'local-freeze',
      reason: `clock offset ${Math.round(mag)}ms coincides with a LOCAL event-loop starvation ${Math.round(i.recentLocalStarvationAgeMs!)}ms ago — apparent staleness is freeze-induced (pre-freeze timestamps verified post-freeze), not peer skew; deferring to the starvation signal`,
    };
  }
  // Attribution (N=2). If our own clock is unsynced, the fault is plausibly OURS
  // — blame self. If ours is verified synced, point at the peer. If we couldn't
  // probe our own sync, stay 'unknown' (never a confident finger-point).
  let blame: SkewBlame;
  let reason: string;
  if (i.ownNtpSynced === false) {
    blame = 'self';
    reason = `clock offset ${Math.round(mag)}ms AND my own clock is not NTP-synced — fix my clock`;
  } else if (i.ownNtpSynced === true) {
    blame = 'peer';
    reason = `clock offset ${Math.round(mag)}ms; my clock is NTP-synced, so the peer's clock is likely drifting — mesh RPC will start failing past ${30}s`;
  } else {
    blame = 'unknown';
    reason = `clock offset ${Math.round(mag)}ms with one of us drifting (own NTP status unknown) — mesh RPC at risk`;
  }
  return { alarming: true, blame, reason };
}
