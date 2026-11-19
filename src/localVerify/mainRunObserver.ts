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

// ── The run machine's borrowed-helper seam (docs/specs/local-verify-borrowed-slices-count.md, F) ──
//
// The same rule as above: LocalVerifyService imports these TYPES ONLY. The implementation
// (BorrowedRunMachine.ts) holds the practice record, the asking rate, the baseline results and the
// loopback proxy; the service tells it when a verify starts and ends and hands it what a green
// `main` verify counted. Every call is made inside try/catch and nothing it starts is awaited by a
// verify, so it can change no run, no record and no timing.

/** One verify starting on this machine, as the server's own record holds it. */
export interface BorrowedVerifyStart {
  /** The verify's attempt token (what its child proves itself with on the loopback proxy). */
  token: string;
  kind: 'main' | 'waiting';
  pr: number;
  baseSha: string;
  headSha: string;
  startedAt: number;
}

export interface BorrowedVerifyEnd {
  token: string;
  /** A record was written for this verify. */
  recorded: boolean;
  outcome: 'success' | 'failure' | 'error' | null;
  cancelled: boolean;
}

/** What a green `main` verify counted, per test file (the baseline results). */
export interface BorrowedGreenMain {
  commit: string;
  finishedAt: string;
  machineId: string;
  /** file → [passed, failed, skipped, to-do, digest]; parsed strictly by the receiver. */
  fileCounts: unknown;
}

/** Facts of the HTTP request a route passes on (never trusted beyond what they are). */
export interface BorrowedRouteFacts {
  cfConnectingIp?: string | string[] | undefined;
  forwardedFor?: string | string[] | undefined;
  remoteAddress?: string | undefined;
}

export interface BorrowedHttpAnswer { status: number; body: unknown }

/** What this run machine adds to its peer status for the coordinator. */
export interface BorrowedPeerStatusExtras {
  /** This machine's helper events, newest last, with ids (the coordinator tells each once). */
  helperEvents?: unknown[];
  /** This machine has a helper configured: it wants the coordinator's baseline results. */
  wantsBaseline?: true;
  /** The machine ids of this machine's configured helpers (a peer record's `borrowed.helper` must be one). */
  helpers?: string[];
}

export interface BorrowedRunSeam {
  onVerifyStart(e: BorrowedVerifyStart): void;
  onVerifyEnd(e: BorrowedVerifyEnd): void;
  /** True when a `main` verify's per-file counts are wanted (this machine or a peer has a helper). */
  wantsMainFileCounts(): boolean;
  /** Coordinator: a green `main` verify (its own or an imported peer's) with its per-file counts. */
  onGreenMain(e: BorrowedGreenMain): void;
  peerStatusExtras(): BorrowedPeerStatusExtras;
  /** Coordinator: what a peer's status answer carried. */
  onPeerStatus(peer: { machineId: string; url: string }, extras: BorrowedPeerStatusExtras): void;
  /** Whether `helper` is a configured helper of this machine (or, with `peerMachineId`, of that peer as it last reported). */
  knownHelper(helper: string, peerMachineId?: string): boolean;
  tick(): void;
  info(): unknown;
  /** `POST /local-verify/borrowed-proxy` (loopback only, the verify's attempt token). */
  proxy(token: string | undefined, body: unknown, route: BorrowedRouteFacts): Promise<BorrowedHttpAnswer>;
  /** `POST /local-verify/borrowed/decision`. */
  decide(body: unknown): BorrowedHttpAnswer;
  /** `POST /local-verify/borrowed/dry-run`. */
  dryRun(body: unknown): BorrowedHttpAnswer;
  /** `POST /local-verify/helper-here`. */
  helperHere(body: unknown, route: BorrowedRouteFacts): BorrowedHttpAnswer;
  /** Peer side: `POST /local-verify/peer-baseline` from the coordinator. */
  acceptPeerBaseline(body: unknown, lease: { holdsLease: boolean; holderMachineId: string | null }): BorrowedHttpAnswer;
}
