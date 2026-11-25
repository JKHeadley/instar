/**
 * What a helper accepts (docs/specs/local-verify-borrowed-unit-slices.md, C). The request checks
 * are exact; any unknown value means refuse (invariant, basis: irreversible-consequence: running
 * code on a personal machine cannot be undone).
 *
 * This module holds the transport-level checks (route, signature, pinned requester, expiry,
 * single use). The commit and file checks need GitHub and the tree and live in HelperService.
 * Pure.
 */
import type { Arrival } from '../../core/requestArrival.js';
import { verifyMachineSignature, type MachineKeyLookup } from '../../core/AppRecordSignatures.js';
import { HELPER_LIMITS, isSig, requestPayload, type HelperRefusal, type SignedHelperRequest } from './helperProtocol.js';

export interface RouteFacts {
  /** The `cf-connecting-ip` header, present when the request came through the Cloudflare tunnel. */
  cfConnectingIp?: string | string[] | undefined;
  /** The listener receiving the request and the address to which its socket was bound. */
  arrival?: Arrival;
  listenerAddress?: string | undefined;
}

const LOOPBACK = /^(?:127\.|::1$|::ffff:127\.)/;

/**
 * Served only on the Tailscale or LAN interface: never through the tunnel (its connector reaches
 * the server on loopback, with `cf-connecting-ip`). `allowLoopback` exists for the on-host test
 * suites only; production wiring never sets it (tests/unit/localVerify/helper/helperWiring.test.ts).
 */
export function routeRefusal(f: RouteFacts, opts: { allowLoopback?: boolean } = {}): 'tunnel' | null {
  if (f.arrival === 'same-network') return 'tunnel';
  if (f.cfConnectingIp !== undefined && f.cfConnectingIp !== '') return 'tunnel';
  if (!opts.allowLoopback && typeof f.listenerAddress === 'string' && LOOPBACK.test(f.listenerAddress)) return 'tunnel';
  return null;
}

export interface SignedRequestCtx {
  /** This helper's own machine id: a request signed for another helper is refused. */
  selfMachineId: string;
  /** The one pinned run machine (spec F "Pairing"): a request from any other machine is refused. */
  pinnedRequester: string;
  keyLookup: MachineKeyLookup;
  now: number;
  seen: { has(attemptId: string): boolean };
}

/** Why a signed request is refused before anything else is looked at, or null. */
export function signedRequestRefusal(req: SignedHelperRequest, ctx: SignedRequestCtx): HelperRefusal | null {
  if (!isSig(req.sig)) return 'unsigned';
  if (req.sig.machineId !== req.requesterMachineId || req.requesterMachineId !== ctx.pinnedRequester) return 'requester-not-pinned';
  const v = verifyMachineSignature(ctx.keyLookup, req.sig, requestPayload(req), ctx.now);
  if (v === 'unknown') return 'signature-unknown-key';
  if (v === 'bad') return 'signature-bad';
  // At most 60 s of life after signing, 30 s tolerated each way for clock difference.
  if (ctx.now > req.expiresAt + HELPER_LIMITS.clockToleranceMs) return 'expired';
  if (req.expiresAt - ctx.now > HELPER_LIMITS.requestMaxLifetimeMs + HELPER_LIMITS.clockToleranceMs) return 'expired';
  if (req.helperMachineId !== ctx.selfMachineId) return 'wrong-helper';
  if (ctx.seen.has(req.attemptId)) return 'replayed';
  return null;
}
