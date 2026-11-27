/**
 * Reads a passkey cell's REPAIR admission state from the real stores (spec
 * docs/specs/agent-held-google-passkey.md §3.4): the grant store, the credential store's custody
 * (no key material), the Chrome version gate and the cell health store, fed into the pure
 * `passkeyRepairAdmissionState`.
 *
 * Synchronous, because repair admission is synchronous. The Chrome self-test is not: when the gate
 * for the installed Chrome major has never run, the reader refuses this time (`chrome-unverified`)
 * and starts ONE background self-test (never two at once), so a later admission pass can admit.
 * The installed major is read at most once per `chromeMajorTtlMs`.
 *
 * Suspension (§2) is a restrictive-only input. The pool-wide suspension record is not published
 * on this build; the reader takes the local kill flag through `suspended()` and says so in the
 * caller's wiring. Missing that input can only ever ADMIT less, never more, once it lands.
 */
import type { PasskeyCellAdmissionState } from './SubscriptionReloginPolicy.js';
import { passkeyRepairAdmissionState, type PasskeyRepairCustody } from './PasskeyRepairAdmission.js';
import type { PasskeyChromeGateStore } from './PasskeyChromeGate.js';
import type { PasskeyCellHealthRecord } from './PasskeyCellHealth.js';

export interface PasskeyCellStateReaderDeps {
  hasActiveGrant: (canonicalEmail: string) => boolean;
  custodyOf: (canonicalEmail: string) => PasskeyRepairCustody;
  health: (canonicalEmail: string) => PasskeyCellHealthRecord | null;
  chromeGate: PasskeyChromeGateStore;
  readChromeMajor: () => number | null;
  /** Runs the fixture self-test for `major` and records it. Called at most once at a time. */
  runChromeGate: (major: number) => Promise<unknown>;
  suspended: () => boolean;
  /**
   * A Google risk or throttle pause on this account or this machine (§2 risk budget, §4 throttle
   * safety). Restrictive only: a paused account is refused like a suspension (`passkey-suspended`),
   * so its repair takes the approval path. Reads this machine's ledger; peers' pauses arrive through
   * the pool read path for proofs and enrollment.
   */
  paused?: (canonicalEmail: string) => boolean;
  now?: () => number;
  chromeMajorTtlMs?: number;
  log?: (line: string) => void;
}

export function createPasskeyCellStateReader(deps: PasskeyCellStateReaderDeps): (input: { canonicalEmail: string }) => PasskeyCellAdmissionState {
  const now = deps.now ?? Date.now;
  const ttl = deps.chromeMajorTtlMs ?? 10 * 60_000;
  let cachedMajor: { major: number | null; at: number } | null = null;
  let gateRun: Promise<unknown> | null = null;

  const currentMajor = (): number | null => {
    const t = now();
    if (!cachedMajor || t - cachedMajor.at > ttl) cachedMajor = { major: deps.readChromeMajor(), at: t };
    return cachedMajor.major;
  };

  return ({ canonicalEmail }) => {
    const email = canonicalEmail.trim().toLowerCase();
    const granted = deps.hasActiveGrant(email);
    const major = currentMajor();
    const chromeGate = deps.chromeGate.gateFor(major);
    // Only a granted cell is worth a Chrome self-test; an ungranted one is refused anyway.
    if (granted && chromeGate === 'unchecked' && major !== null && !gateRun) {
      gateRun = deps.runChromeGate(major)
        .catch((err: unknown) => { deps.log?.(`[passkeys] chrome gate self-test could not run: ${err instanceof Error ? err.name : 'unknown'}`); })
        .finally(() => { gateRun = null; });
    }
    return passkeyRepairAdmissionState({
      granted, custody: granted ? deps.custodyOf(email) : 'absent', chromeGate,
      chromeVerifiedAtMs: chromeGate === 'passed' ? deps.chromeGate.verifiedAtMs(major) : null,
      health: deps.health(email), suspended: deps.suspended() || (deps.paused?.(email) ?? false), nowMs: now(),
    });
  };
}
