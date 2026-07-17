/** Minimal ownership row needed to decide whether local delivery may confirm. */
export interface LocalClaimOwnershipRow {
  ownerMachineId: string;
  status: string;
}

/** Dependencies for the post-local-delivery placing → active transition. */
export interface LocalClaimConfirmationDeps {
  selfMachineId: string;
  readOwnership: (sessionKey: string) => LocalClaimOwnershipRow | null | undefined;
  claimOwnership: (sessionKey: string, machineId: string) => {
    confirmed: boolean;
    afterConfirm?: () => void;
  };
  onError?: (error: unknown) => void;
}

/**
 * Confirm a local placement after the established local delivery tail succeeds.
 *
 * Active traffic and rows owned by another machine are strict no-ops. Keeping
 * this decision separate from SessionRouter matters: its local handler is only
 * a fall-through marker, not proof that injection or spawn succeeded.
 */
export function confirmLocalPlacementAfterDelivery(
  deps: LocalClaimConfirmationDeps,
  sessionKey: string,
): boolean {
  try {
    const current = deps.readOwnership(sessionKey);
    if (current?.status !== 'placing' || current.ownerMachineId !== deps.selfMachineId) return false;
    const outcome = deps.claimOwnership(sessionKey, deps.selfMachineId);
    if (!outcome.confirmed) return false;
    try {
      outcome.afterConfirm?.();
    } catch (error) {
      // @silent-fallback-ok — observer failure is reported through onError;
      // the authoritative ownership transition has already committed.
      // The authoritative transition already committed. Observer emission is
      // best-effort and cannot reverse or falsify the confirmed outcome.
      deps.onError?.(error);
    }
    return true;
  } catch (error) {
    // @silent-fallback-ok — registry failure is reported through onError;
    // local message delivery has already succeeded and must not be falsified.
    // Delivery already succeeded before this helper is called. Ownership
    // confirmation is best-effort and never turns a registry failure into a
    // false delivery failure. The exact row state is intentionally not claimed.
    deps.onError?.(error);
    return false;
  }
}
