/**
 * The force-mode reroute gate's refusal (cap reached or host memory pressure). A typed error so a
 * caller (the feedback executor) can tell "no capacity right now" from a real failure by CLASS,
 * never by message text (docs/specs/confined-spawn-subscription-reroute.md, Cap contention).
 */
export class RerouteRefusedError extends Error {
  readonly code = 'reroute-refused' as const;
  constructor(readonly why: string) {
    super(`Reroute refused (force-mode): ${why}`);
    this.name = 'RerouteRefusedError';
  }
}
