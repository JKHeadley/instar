/** Server-owned, generation-local fence carried to the actual deferred runtime effect. */
export class ProfileRuntimeOwnershipChangedError extends Error {
  constructor() { super('The conversation ownership changed before the runtime action.'); this.name = 'ProfileRuntimeOwnershipChangedError'; }
}
/** Refuse a new runtime effect when the captured ownership fence is stale or unreadable. */
export function assertProfileRuntimeGuard(guard?: () => boolean): void {
  if (!guard) return;
  let current = false;
  try { current = guard() === true; } catch { /* Unreadable placement grants no runtime authority. */ }
  if (!current) throw new ProfileRuntimeOwnershipChangedError();
}

// Only guards created here can acquire an owned-stop transition. The callable
// remains compatible with SessionManager's existing final launch check.
const ownedStopTransitions = new WeakMap<() => boolean, () => void>();

export function createProfileRuntimeFence(input: {
  sessionId: string;
  readSessionId: () => string | null;
  validAssignment: () => boolean;
}): () => boolean {
  let stopped = false;
  let invalid = !input.sessionId;
  const read = (): string | null | undefined => {
    if (invalid) return undefined;
    try {
      if (input.validAssignment() !== true) { invalid = true; return undefined; }
      const current = input.readSessionId();
      if (current !== null && (typeof current !== 'string' || !current)) { invalid = true; return undefined; }
      return current;
    } catch { invalid = true; return undefined; }
  };
  const guard = (): boolean => {
    const current = read();
    const valid = !invalid && (stopped ? current === null : current === input.sessionId);
    if (!valid) invalid = true;
    return valid;
  };
  ownedStopTransitions.set(guard, () => {
    const current = read();
    if (invalid || stopped || current !== null) {
      invalid = true;
      throw new ProfileRuntimeOwnershipChangedError();
    }
    stopped = true;
  });
  return guard;
}

/** Trusted kill consumer only: call after successfully killing the captured incarnation. */
export function markProfileRuntimeOwnedStop(guard?: () => boolean): void {
  if (guard) ownedStopTransitions.get(guard)?.();
}
