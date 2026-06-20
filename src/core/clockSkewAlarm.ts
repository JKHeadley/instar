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

export type SkewBlame = 'self' | 'peer' | 'unknown';

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
