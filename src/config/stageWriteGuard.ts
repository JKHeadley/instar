/**
 * stageWriteGuard — the structural enforcement that `multiMachine.sessionPool.stage`
 * is written ONLY through StageAdvancer (Multi-Machine Session Pool §Rollout).
 *
 * Per "Structure > Willpower": the rollout stage decides whether sessions actually
 * move between machines, so flipping it must be gated by the E2E proof in
 * StageAdvancer — never an ad-hoc config write. LiveConfig.set() calls
 * `assertStageWriteAuthorized()` on every write; a write to the stage path that does
 * NOT carry the module-private STAGE_WRITE_TOKEN is refused with `stage-write-not-permitted`.
 * StageAdvancer (and only its boot wiring) imports the token; a companion lint
 * (`lint-no-direct-stage-write.js`) forbids any other src file from importing it or
 * writing the path, so the guarantee holds at both runtime and review time.
 */

export const STAGE_CONFIG_PATH = 'multiMachine.sessionPool.stage';

/** Capability token. Module-private value; StageAdvancer's boot wiring passes it. */
export const STAGE_WRITE_TOKEN: unique symbol = Symbol('instar.sessionPool.stageWrite');

export class StageWriteNotPermittedError extends Error {
  readonly code = 'stage-write-not-permitted';
  constructor() {
    super(
      'Direct write to multiMachine.sessionPool.stage is not permitted — the rollout ' +
      'stage is StageAdvancer-write-only (gated on the prior stage\'s green E2E). ' +
      'Route the change through StageAdvancer.advanceTo()/reconcile().',
    );
    this.name = 'StageWriteNotPermittedError';
  }
}

/** Throw unless a write to the stage path carries the capability token. No-op for any other path. */
export function assertStageWriteAuthorized(dotPath: string, token?: symbol): void {
  if (dotPath !== STAGE_CONFIG_PATH) return;
  if (token !== STAGE_WRITE_TOKEN) throw new StageWriteNotPermittedError();
}
