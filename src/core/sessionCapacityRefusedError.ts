/** The host's bounded session slots are full; callers can retry when room opens. */
export class SessionCapacityRefusedError extends Error {
  readonly code = 'session-capacity-refused' as const;

  constructor(readonly running: number, readonly limit: number) {
    super(`Max sessions (${limit}) reached with ${running} running`);
    this.name = 'SessionCapacityRefusedError';
  }
}
