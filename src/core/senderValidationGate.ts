/**
 * SenderValidationGate (silent-loss-refusal-conservation §2.D — the wiring-time
 * registry gate + per-call re-arm).
 *
 * The 2026-07-01 incident: sender re-validation armed UNCONDITIONALLY against a
 * degenerate `users.json` and rejected EVERYONE (including the operator). This
 * gate re-decides arm/disarm PER MESSAGE (a restored registry re-arms with no
 * restart) by probing REAL registry state — never a config flag ("Verify the
 * State, Not Its Symbol"):
 *
 *   - degenerate (never-populated / clean-ENOENT / valid-`[]`-no-high-water) →
 *     DISARM → fail toward DELIVERY (a fresh install must let the operator's first
 *     message through) + a rate-limited loud log + a deduped alert.
 *   - unknown-unsafe (parse-failure / corrupt / partial-write / high-water-but-
 *     unreadable) → ARM but fail CLOSED: keep rejecting unresolved senders + HIGH
 *     alert. The operator still passes via the LOCAL topic-operator binding (KYP).
 *   - populated → the PRIMARY arm decision is the OPERATOR-RESOLUTION store-HEALTH
 *     probe: if the CURRENT topic's LOCALLY-bound operator uid does NOT resolve in
 *     the registry, DISARM + HIGH alert (the incident's exact signature). Else arm
 *     and resolve the actual sender.
 *
 * The registry read is stat-gated on `(mtimeMs, size)` so repeated messages under
 * a degenerate broadcast collapse to O(1) while a restored registry re-arms within
 * one write. Pure logic + injected I/O → both sides of every boundary are testable.
 */

import { classifyRegistry, type RegistryClass } from './registryHighWater.js';

export type SenderVerdict = 'deliver' | 'reject';

export interface SenderValidationDecision {
  verdict: SenderVerdict;
  /** armed=false means re-validation was skipped (fail toward delivery). */
  armed: boolean;
  klass: RegistryClass;
  reason: string;
}

export interface SenderValidationGateDeps {
  usersFilePath: string;
  stateDir: string;
  /** stat (mtimeMs,size) of users.json for the classify cache; null on ENOENT/error. */
  statUsers: () => { mtimeMs: number; size: number } | null;
  /** Does this uid resolve in THIS machine's authoritative registry? (read-only.) */
  resolveUid: (uid: number) => boolean;
  /** The CURRENT topic's LOCALLY-bound (authenticated) operator uid, or null. Reads
   *  the local topic-operator binding ONLY — never a WS2.6 replicated record. */
  operatorUidForTopic: (session: string) => number | null;
  /** Deduped/rate-limited alert sink (once-per-boot + 24h per cause handled here). */
  alert: (level: 'HIGH' | 'INFO', cause: string, message: string) => void;
  /** Loud log sink (the gate applies its own 1/min-per-cause throttle). */
  log: (line: string) => void;
  now?: () => number;
  /** For tests: override the classifier (default reads the raw file + high-water). */
  classify?: () => { klass: RegistryClass; detail: string; rawUserCount: number };
}

const DEGENERATE_LOG_THROTTLE_MS = 60 * 1000; // 1/min per cause
const ALERT_DEDUPE_MS = 24 * 60 * 60 * 1000; // once-per-boot + 24h per cause

export class SenderValidationGate {
  private readonly d: SenderValidationGateDeps;
  private readonly now: () => number;
  private cachedStat: { mtimeMs: number; size: number } | null | undefined = undefined;
  private cachedClass: { klass: RegistryClass; detail: string; rawUserCount: number } | null = null;
  private readonly logThrottle = new Map<string, number>();
  private readonly alertDedupe = new Map<string, number>();

  constructor(deps: SenderValidationGateDeps) {
    this.d = deps;
    this.now = deps.now ?? Date.now;
  }

  private classifyStatGated(): { klass: RegistryClass; detail: string; rawUserCount: number } {
    const stat = this.d.statUsers();
    // Re-classify only when (mtimeMs,size) changed vs the cached read.
    const unchanged =
      this.cachedClass !== null &&
      ((stat === null && this.cachedStat === null) ||
        (stat !== null && this.cachedStat != null && stat.mtimeMs === this.cachedStat.mtimeMs && stat.size === this.cachedStat.size));
    if (unchanged) return this.cachedClass!;
    const c = this.d.classify
      ? this.d.classify()
      : classifyRegistry(this.d.usersFilePath, this.d.stateDir);
    this.cachedStat = stat;
    this.cachedClass = c;
    return c;
  }

  private throttledLog(cause: string, line: string): void {
    const nowMs = this.now();
    const last = this.logThrottle.get(cause) ?? -Infinity;
    if (nowMs - last >= DEGENERATE_LOG_THROTTLE_MS) {
      this.logThrottle.set(cause, nowMs);
      this.d.log(line);
    }
  }

  private dedupedAlert(level: 'HIGH' | 'INFO', cause: string, message: string): void {
    const nowMs = this.now();
    const last = this.alertDedupe.get(cause) ?? -Infinity;
    if (nowMs - last >= ALERT_DEDUPE_MS) {
      this.alertDedupe.set(cause, nowMs);
      this.d.alert(level, cause, message);
    }
  }

  /**
   * Per-call arm + resolve decision for a forwarded sender envelope. `deliver`
   * means the sender re-validation ALLOWS the message (armed+resolved, or
   * disarmed); `reject` means a first-class refusal (→ `sender-rejected` NACK →
   * §2.A rejected outcome → §2.C notice — the refusal is conserved).
   */
  decide(uid: number, session: string): SenderValidationDecision {
    // A non-numeric / zero uid cannot be re-validated on the Telegram path — fail
    // toward delivery (Slack sender re-validation is tracked-followup 4).
    if (!Number.isFinite(uid) || uid === 0) {
      return { verdict: 'deliver', armed: false, klass: 'populated', reason: 'no-numeric-uid' };
    }

    let c: { klass: RegistryClass; detail: string; rawUserCount: number };
    try {
      c = this.classifyStatGated();
    } catch {
      // A classifier fault is NOT "never populated" — fail CLOSED conservatively,
      // but still honor the local operator binding (KYP).
      c = { klass: 'unknown-unsafe', detail: 'classifier-error', rawUserCount: 0 };
    }

    if (c.klass === 'degenerate') {
      this.throttledLog('registry-degenerate', `[sender-validation] registry DEGENERATE (${c.detail}) — DISARMING sender re-validation (fail toward delivery). ${session}`);
      this.dedupedAlert('INFO', 'registry-degenerate',
        `Sender re-validation is DISARMED because this machine's user registry is degenerate (${c.detail}). Messages are delivered without sender re-validation until a real user is registered. This is expected on a fresh install; if it is not, the registry may have been emptied — check the registration path and logs/mesh-rejections.jsonl.`);
      return { verdict: 'deliver', armed: false, klass: c.klass, reason: `degenerate:${c.detail}` };
    }

    const opUid = this.safeOperatorUid(session);

    if (c.klass === 'unknown-unsafe') {
      this.dedupedAlert('HIGH', 'registry-unknown-unsafe',
        `This machine's user registry is UNPARSEABLE/corrupt (${c.detail}). Sender re-validation is failing CLOSED (rejecting unresolved senders) to avoid trusting a tampered store; the locally-bound operator still passes. Repair the registry — do NOT delete it.`);
      // Operator passes via the LOCAL binding even when the registry can't be
      // parsed (KYP) — the incident's operator must never be locked out.
      if (opUid != null && uid === opUid) {
        return { verdict: 'deliver', armed: true, klass: c.klass, reason: 'unknown-unsafe:operator-via-binding' };
      }
      if (this.d.resolveUid(uid)) {
        return { verdict: 'deliver', armed: true, klass: c.klass, reason: 'unknown-unsafe:resolved' };
      }
      return { verdict: 'reject', armed: true, klass: c.klass, reason: 'unknown-unsafe:unresolved' };
    }

    // populated — PRIMARY arm: the operator-resolution store-HEALTH probe.
    if (opUid != null && !this.d.resolveUid(opUid)) {
      this.dedupedAlert('HIGH', 'operator-unresolvable',
        `The verified operator bound to a topic on this machine no longer resolves in the user registry (uid ${opUid}). Sender re-validation is DISARMED (fail toward reachability) so the operator is never silently locked out — this is the exact 2026-07-01 silent-loss signature. Check the user registration path.`);
      return { verdict: 'deliver', armed: false, klass: c.klass, reason: 'operator-unresolvable-disarm' };
    }

    // Armed + healthy: resolve the actual sender against the real registry.
    return this.d.resolveUid(uid)
      ? { verdict: 'deliver', armed: true, klass: c.klass, reason: 'populated:resolved' }
      : { verdict: 'reject', armed: true, klass: c.klass, reason: 'populated:unresolved' };
  }

  private safeOperatorUid(session: string): number | null {
    try {
      const v = this.d.operatorUidForTopic(session);
      return v != null && Number.isFinite(v) && v !== 0 ? v : null;
    } catch {
      // @silent-fallback-ok: an operator-resolution fault → null → the gate
      // declines to arm against a populated registry (fails toward delivery +
      // alerts), never a silent reject of the operator.
      return null;
    }
  }
}
