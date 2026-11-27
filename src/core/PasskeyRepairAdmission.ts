/**
 * The (account × machine) passkey cell's admission state for a REPAIR (spec
 * docs/specs/agent-held-google-passkey.md §3.4, §4, §5.1). Pure: every input is read by the
 * caller, so the rule is tested on both sides of each boundary without a browser or a store.
 *
 * Only `ready` admits a passkey repair. Every other result maps to a named refusal in
 * `SubscriptionReloginPolicy` (PASSKEY_CELL_REFUSALS). The order is "most restrictive first":
 * a cell that is both quarantined and in `security` reads `security`.
 *
 * What `ready` means here, stated honestly: the cell holds an active grant and a usable
 * credential on THIS machine, this machine's Chrome passed the virtual-authenticator gate, and
 * the last cold proof (§3.8) — a signed-out, assertion-verified, identity-verified sign-in —
 * returned `ready` within the 21-day window and nothing since has moved the cell out of a
 * live state. It does NOT mean Google will accept the next sign-in; the repair itself still
 * runs the identity check and the closed page classes.
 */
import type { PasskeyCellAdmissionState } from './SubscriptionReloginPolicy.js';
import type { PasskeyCellHealthRecord } from './PasskeyCellHealth.js';
import { NO_READY_UNVERIFIED_DAYS } from './PasskeyCellHealth.js';

/** The custody of the credential on THIS machine, as the credential store reports it. */
export type PasskeyRepairCustody = 'present' | 'legacy-adopted' | 'quarantined' | 'absent' | 'unreadable';

/** The Chrome version gate result for THIS machine (§2): `unchecked` = never run on this major. */
export type PasskeyChromeGate = 'passed' | 'failed' | 'unchecked';

export interface PasskeyRepairAdmissionInput {
  /** An ACTIVE grant for (email, this machine) exists. Revoked or missing ⇒ false. */
  granted: boolean;
  custody: PasskeyRepairCustody;
  chromeGate: PasskeyChromeGate;
  /**
   * When THIS Chrome major passed the gate (ms). §2: the first passkey use on a newly verified major
   * is a single cold proof, so a `ready` proof from before this instant (an older Chrome) does not
   * admit a repair. Absent ⇒ no such constraint (tests of the other rules).
   */
  chromeVerifiedAtMs?: number | null;
  /** This machine's health record for the cell, or null when none was ever written. */
  health: PasskeyCellHealthRecord | null;
  /** Restrictive-only pool inputs. A local kill flag and a published suspension both stop use. */
  suspended: boolean;
  nowMs: number;
}

const DAY_MS = 24 * 60 * 60_000;

export function passkeyRepairAdmissionState(input: PasskeyRepairAdmissionInput): PasskeyCellAdmissionState {
  const h = input.health;
  // Terminal health states first: they outrank custody and pool state (§4 "terminal states take
  // precedence over every other row").
  if (h?.state === 'security') return 'security';
  if (h?.state === 'breaker-open') return 'breaker-open';
  if (h?.state === 'unverified-stopped') return 'unverified-stopped';
  if (input.suspended) return 'suspended';
  if (!input.granted) return 'unknown';
  if (input.custody === 'quarantined') return 'quarantined';
  if (input.custody !== 'present' && input.custody !== 'legacy-adopted') return 'unknown';
  if (input.chromeGate !== 'passed') return 'chrome-unverified';
  if (!h) return 'unknown';
  if (h.state === 'rejected') return 'rejected';
  if (h.state !== 'healthy' && h.state !== 'degraded') return 'unknown';
  // A live state still needs a real `ready` proof inside the 21-day window; a clock that has
  // not advanced the state yet must not admit a cell nobody has proven recently.
  const lastReadyMs = h.lastReadyAt ? Date.parse(h.lastReadyAt) : NaN;
  if (!Number.isFinite(lastReadyMs)) return 'unknown';
  if (input.nowMs - lastReadyMs > NO_READY_UNVERIFIED_DAYS * DAY_MS + (h.pausedMs ?? 0)) return 'unknown';
  if (typeof input.chromeVerifiedAtMs === 'number' && lastReadyMs < input.chromeVerifiedAtMs) return 'chrome-unverified';
  return 'ready';
}
