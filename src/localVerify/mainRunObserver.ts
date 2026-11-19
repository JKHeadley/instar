/**
 * A passive observer of this machine's own `main` verifies (docs/specs/local-verify-borrowed-unit-slices.md, F).
 *
 * LocalVerifyService imports this module for TYPES ONLY, so the borrowed-machine shadow client is
 * never part of the verifier's code (the verifierVersion import graph skips type-only imports) and
 * nothing it computes can reach a verdict. Both callbacks return void: the service calls them
 * inside try/catch and never awaits anything they start. Comparison happens only after the run's
 * record is written (`onMainRunEnd` is called after completeMain).
 */

export interface MainRunStart {
  headSha: string;
  /** The run's attempt token (unique per run). */
  runToken: string;
  startedAt: number;
}

export interface MainRunEnd {
  headSha: string;
  runToken: string;
  /** A main record was written for this run (false: cancelled, crashed before a record, re-queued). */
  recorded: boolean;
  outcome: 'success' | 'failure' | 'error' | null;
  cancelled: boolean;
}

export interface MainRunObserver {
  onMainRunStart(e: MainRunStart): void;
  onMainRunEnd(e: MainRunEnd): void;
  /** Read-only summary for `GET /local-verify` (the borrowed mode, helpers, last shadow summaries). */
  info?(): unknown;
}
