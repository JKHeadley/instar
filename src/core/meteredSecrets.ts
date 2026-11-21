/**
 * meteredSecrets — the single list of vault names that hold PAY-PER-USE provider keys
 * (spec docs/specs/gemini-payg-metered-lane.md §4).
 *
 * A metered key bills real money per token. Every protection in §4 reads THIS list:
 *   - `secret-get.mjs` refuses these names (its literal copy is pinned to this list by a
 *     template-drift test),
 *   - `filterSecretsForSync` drops them for every recipient except the door's designated
 *     machine (none designated → dropped for all),
 *   - `SecretShareHandler` strips them on receive at a non-designated machine,
 *   - `scripts/lint-metered-secret-readers.js` refuses a named read outside the one reader.
 *
 * Membership is exact names plus the reserved `metered_` prefix, so a future bench key
 * named `metered_<x>` is covered without an edit here. This is the secrets ruled exception
 * (Rule 86): an exact name match whose miss (a leaked paid key) cannot be recalled.
 */

/** The production Gemini pay-per-use key (the `gemini-api` door's keyRef). */
export const GEMINI_PAYG_SECRET_NAME = 'gemini_api_key_payg';

/** Reserved prefix: any top-level vault name starting with it is metered. */
export const METERED_SECRET_PREFIX = 'metered_';

/** Exact metered names known today (the three bench keys found in the vault 2026-11-20). */
export const METERED_SECRET_NAMES: readonly string[] = Object.freeze([
  GEMINI_PAYG_SECRET_NAME,
  'metered_gemini_bench',
  'metered_openrouter_bench',
  'metered_groq_bench',
]);

/**
 * True when a vault key path names a metered secret. Only the FIRST dot segment counts:
 * metered keys live at the vault root (`gemini_api_key_payg`, `metered_*`).
 */
export function isMeteredSecretName(keyPath: string): boolean {
  if (typeof keyPath !== 'string' || keyPath.length === 0) return false;
  const first = keyPath.split('.')[0] ?? '';
  return METERED_SECRET_NAMES.includes(first) || first.startsWith(METERED_SECRET_PREFIX);
}

/**
 * Where metered keys may travel. `designatedMachineId` is the door's single spender
 * (GoLiveRecord); `transferPending` is true while a lane-transfer proposal exists.
 * `null` (no designation known) means metered keys go to NO peer.
 */
export interface MeteredDesignation {
  designatedMachineId: string | null;
  transferPending?: boolean;
}

/**
 * Whether a metered secret may be sent to `recipientMachineId`. Fail-closed: unknown
 * designation, an empty id, or a pending transfer all answer false.
 */
export function meteredSendAllowed(recipientMachineId: string | null | undefined, designation: MeteredDesignation | null | undefined): boolean {
  if (!designation || !designation.designatedMachineId) return false;
  if (designation.transferPending) return false;
  if (!recipientMachineId) return false;
  return recipientMachineId === designation.designatedMachineId;
}

/**
 * Whether THIS machine may keep a metered secret it received. Fail-closed: only when the
 * last designation it saw names it.
 */
export function meteredReceiveAllowed(selfMachineId: string | null | undefined, designation: MeteredDesignation | null | undefined): boolean {
  return meteredSendAllowed(selfMachineId, designation);
}
