/**
 * SEC-135 (docs/specs/sec135-approval-link-guess-bound.md §1): the sign-in page's public PIN limits,
 * exposed to routes as one hook on the route context. The implementation lives in the AgentServer
 * constructor, beside sign-in, so sign-in, step-up and the confirm page share the same counters.
 *
 * These are rate controls, never identity: a marker or a local connection only decides which
 * allowance an answer is charged to. The PIN is the only proof of who answers.
 */
import type { Request } from 'express';

/** Which allowance an answer is charged to. Names a path, never a person. */
export type PublicPinPath = 'public' | 'marker' | 'local';

export interface PublicPinContext {
  /** The normalized source key ('' when the caller cannot be attributed). */
  ip: string;
  /** The verified remembered-browser marker id, or null. */
  markerId: string | null;
  /** The machine itself (own loopback host). */
  isLocalDirect: boolean;
  /** The machine itself, with no marker: charged to the local budget. */
  localUnmarked: boolean;
}

export type PublicPinVerdict =
  | { ok: true; path: PublicPinPath; aggregateFull: boolean }
  | { ok: false; reason: 'insecure-connection' }
  /** No PIN can be compared right now (none configured, or the owner credential is unreadable). Nothing is counted. */
  | { ok: false; reason: 'unavailable' }
  /** No candidate was sent. Admission passed; nothing is compared or counted. */
  | { ok: false; reason: 'missing'; path: PublicPinPath }
  | { ok: false; reason: 'wrong-pin' | 'paused'; path: PublicPinPath; retryAfterSeconds: number; aggregateFull: boolean };

export interface PublicPinHook {
  context(req: Request): PublicPinContext;
  /**
   * One synchronous verifier: insecure-connection refusal, then class budget + per-request key
   * admission, the constant-time compare against the current PIN, and one-write charging. No await
   * between admission, compare and charge.
   */
  verify(req: Request, candidate: unknown, opts: { requestKey: string; alertKey?: string }): PublicPinVerdict;
}

/** Wrong guesses allowed per approval-link request key per store window (piece 1c). */
export const PUBLIC_PIN_REQUEST_MAX = 5;
