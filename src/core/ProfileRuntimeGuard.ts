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
