/**
 * MeshRpc — the signed, recipient-bound machine-to-machine command layer for the
 * Multi-Machine Session Pool (spec §L0). A thin request/response envelope over the
 * existing authenticated HTTP/tunnel channel carrying a small command set:
 * place / claim / release / transfer / capacity-report / session-status /
 * secret-share.
 *
 * This module is PURE LOGIC — the canonical envelope, the 5-step receipt
 * verification, and the per-command RBAC gate. Crypto (Ed25519 sign/verify), the
 * nonce store, the peer registry, and the router/ownership reads are injected as
 * seams so the dangerous parts (recipient-binding, replay, authorization) are
 * unit-testable with in-memory fakes. The HTTP transport + production wiring sit
 * on top and call these functions.
 *
 * Two independent gates protect every command (spec §L0 Invariant):
 *   (a) verifyEnvelope — WHO sent it: a valid Ed25519 signature from a registered
 *       peer of the same agent, cryptographically bound to THIS recipient, fresh
 *       (unseen nonce) and timely (timestamp within tolerance).
 *   (b) checkCommandRBAC — whether they MAY issue it: the per-command role check
 *       (place/transfer → router; claim → placement-target or failover-router;
 *       release → owner or failover-router; reports/secret-share → any peer).
 * The CAS (§L3) is the final correctness fence; these gates refuse an
 * unauthorized command at the door, before any state read/write.
 */

export type MachineId = string;

export type MeshCommand =
  | { type: 'place'; session: string; machine: MachineId }
  | { type: 'claim'; session: string; epoch: number; failover?: boolean }
  | { type: 'release'; session: string; epoch: number; failover?: boolean }
  | { type: 'transfer'; session: string; target: MachineId }
  | { type: 'deliverMessage'; session: string; messageId: string; payload: unknown; ownershipEpoch: number }
  | { type: 'capacity-report' }
  | { type: 'session-status'; session?: string }
  | { type: 'secret-share'; encrypted: string };

export interface MeshEnvelope {
  sender: MachineId;
  recipient: MachineId;
  command: MeshCommand;
  epoch: number;
  nonce: string;
  timestamp: number; // wall-clock ms
  signature: string;
}

/** The canonical bytes the signature covers — field-ordered, recipient included. */
export function canonicalizeEnvelope(
  e: Pick<MeshEnvelope, 'sender' | 'recipient' | 'command' | 'epoch' | 'nonce' | 'timestamp'>,
): string {
  return JSON.stringify([e.sender, e.recipient, e.command, e.epoch, e.nonce, e.timestamp]);
}

/** Build + sign an outgoing command envelope naming THIS sender + the recipient. */
export function signEnvelope(
  parts: { sender: MachineId; recipient: MachineId; command: MeshCommand; epoch: number; nonce: string; timestamp: number },
  sign: (canonical: string) => string,
): MeshEnvelope {
  return { ...parts, signature: sign(canonicalizeEnvelope(parts)) };
}

export type VerifyReason =
  | 'ok'
  | 'wrong-recipient'
  | 'signature-invalid'
  | 'unknown-sender'
  | 'replayed-nonce'
  | 'stale-timestamp';

export interface VerifyEnvelopeDeps {
  /** This machine's id — the envelope's `recipient` MUST equal it. */
  selfMachineId: MachineId;
  /** Verify the Ed25519 signature over `canonical` against `sender`'s REGISTERED key. */
  verify: (canonical: string, signature: string, sender: MachineId) => boolean;
  /** Is `sender` a registered peer machine of THIS agent? */
  isRegisteredPeer: (sender: MachineId) => boolean;
  /** Has this nonce been seen for `sender` (replay guard, NonceStore-backed)? */
  seenNonce: (sender: MachineId, nonce: string) => boolean;
  /** Wall clock (injectable). */
  now: () => number;
  /** Max |now - timestamp| (ms). Default 30000. */
  clockToleranceMs?: number;
}

/**
 * The 5-step receipt verification (spec §L0), evaluated IN ORDER. Pure: it does
 * NOT record the nonce — the caller records it ONLY on a fully-accepted command
 * (after RBAC), so a rejected command never burns a nonce.
 */
export function verifyEnvelope(env: MeshEnvelope, deps: VerifyEnvelopeDeps): { ok: boolean; reason: VerifyReason } {
  const tol = deps.clockToleranceMs ?? 30000;
  // (1) recipient-bound: a command signed for A cannot be replayed to C.
  if (env.recipient !== deps.selfMachineId) return { ok: false, reason: 'wrong-recipient' };
  // (2) signature valid for the claimed sender's registered key.
  if (!deps.verify(canonicalizeEnvelope(env), env.signature, env.sender)) return { ok: false, reason: 'signature-invalid' };
  // (3) sender is a registered peer of this agent.
  if (!deps.isRegisteredPeer(env.sender)) return { ok: false, reason: 'unknown-sender' };
  // (4) nonce unseen (replay guard).
  if (deps.seenNonce(env.sender, env.nonce)) return { ok: false, reason: 'replayed-nonce' };
  // (5) timestamp within tolerance.
  if (Math.abs(deps.now() - env.timestamp) > tol) return { ok: false, reason: 'stale-timestamp' };
  return { ok: true, reason: 'ok' };
}

export type RbacReason =
  | 'ok'
  | 'not-router'
  | 'claim-unauthorized'
  | 'release-unauthorized';

export interface RbacDeps {
  /** The machine currently holding the router lease (verify-on-read, §L1), or null. */
  routerHolder: () => MachineId | null;
  /** The current owner machine of a session, or null. */
  ownerOf: (session: string) => MachineId | null;
  /** The machine the router last assigned (via place/transfer) for a session, or null. */
  placementTargetOf: (session: string) => MachineId | null;
}

/**
 * Per-command authorization gate (spec §L0). A valid signature proves WHO; this
 * proves they MAY. Runs BEFORE any state read/write. `sender` is the verified
 * envelope sender; `command` is its command.
 */
export function checkCommandRBAC(command: MeshCommand, sender: MachineId, deps: RbacDeps): { ok: boolean; reason: RbacReason } {
  const isRouter = deps.routerHolder() === sender;
  switch (command.type) {
    case 'place':
    case 'transfer':
    case 'deliverMessage':
      // Router-only (the router forwards inbound messages to the session owner — §L4).
      return isRouter ? { ok: true, reason: 'ok' } : { ok: false, reason: 'not-router' };
    case 'claim': {
      // The router's assigned target for this session, OR the router on a failover re-place.
      if (deps.placementTargetOf(command.session) === sender) return { ok: true, reason: 'ok' };
      if (isRouter && command.failover === true) return { ok: true, reason: 'ok' };
      return { ok: false, reason: 'claim-unauthorized' };
    }
    case 'release': {
      // The current owner, OR the router during a fenced failover.
      if (deps.ownerOf(command.session) === sender) return { ok: true, reason: 'ok' };
      if (isRouter && command.failover === true) return { ok: true, reason: 'ok' };
      return { ok: false, reason: 'release-unauthorized' };
    }
    case 'capacity-report':
    case 'session-status':
    case 'secret-share':
      // Read/observe class (or e2e-encrypted) — any registered peer (already
      // proven a registered peer by verifyEnvelope).
      return { ok: true, reason: 'ok' };
    default:
      return { ok: false, reason: 'claim-unauthorized' };
  }
}

/**
 * Full acceptance gate: verify (who) THEN RBAC (may). Returns the first failure's
 * reason. The caller records the nonce ONLY when this returns ok (so a rejected
 * command never consumes a nonce). Convenience over verifyEnvelope + checkCommandRBAC.
 */
export function acceptEnvelope(
  env: MeshEnvelope,
  verifyDeps: VerifyEnvelopeDeps,
  rbacDeps: RbacDeps,
): { ok: boolean; reason: VerifyReason | RbacReason } {
  const v = verifyEnvelope(env, verifyDeps);
  if (!v.ok) return v;
  return checkCommandRBAC(env.command, env.sender, rbacDeps);
}

// ── Dispatcher (transport-agnostic: the receive side of MeshRpc) ──────

/** A handler for one command type. Receives the (already-authorized) command, the
 *  verified sender, and the full envelope (for nonce/epoch/timestamp, e.g. the
 *  per-session ownership CAS uses `env.nonce`). */
export type MeshCommandHandler = (command: MeshCommand, sender: MachineId, env: MeshEnvelope) => Promise<unknown> | unknown;

export interface MeshRpcDispatcherDeps {
  verify: VerifyEnvelopeDeps;
  rbac: RbacDeps;
  /** Record a nonce as seen (NonceStore-backed) — called ONLY on full accept. */
  recordNonce: (sender: MachineId, nonce: string) => void;
  /** Per-command handlers. A missing handler → `no-handler` (the command is verified+authorized but unimplemented on this layer). */
  handlers: Partial<Record<MeshCommand['type'], MeshCommandHandler>>;
  /** Audit sink for rejections (SecurityLog). Optional. */
  onReject?: (env: MeshEnvelope, reason: string) => void;
  logger?: (msg: string) => void;
}

export type DispatchResult =
  | { ok: true; result: unknown }
  | { ok: false; reason: VerifyReason | RbacReason | 'no-handler'; status: number };

/** HTTP status for each rejection reason — auth failures 401/403, freshness 409, unimplemented 501. */
function statusForReason(reason: string): number {
  switch (reason) {
    case 'wrong-recipient':
    case 'signature-invalid':
    case 'unknown-sender':
      return 401;
    case 'not-router':
    case 'claim-unauthorized':
    case 'release-unauthorized':
      return 403;
    case 'replayed-nonce':
    case 'stale-timestamp':
      return 409;
    case 'no-handler':
      return 501;
    default:
      return 400;
  }
}

/**
 * The receive side of MeshRpc — transport-agnostic (the HTTP route, or a tunnel
 * carrier, calls `dispatch(envelope)`). Runs the two gates (verify THEN rbac),
 * records the nonce ONLY on full accept (a rejected command never burns a nonce),
 * audits rejections, then routes to the registered handler. Returns a result +
 * an HTTP status so any transport can map it.
 */
export class MeshRpcDispatcher {
  private readonly d: MeshRpcDispatcherDeps;
  constructor(deps: MeshRpcDispatcherDeps) {
    this.d = deps;
  }

  async dispatch(env: MeshEnvelope): Promise<DispatchResult> {
    const accept = acceptEnvelope(env, this.d.verify, this.d.rbac);
    if (!accept.ok) {
      this.d.onReject?.(env, accept.reason);
      this.d.logger?.(`[mesh-rpc] rejected ${env.command?.type} from ${env.sender}: ${accept.reason}`);
      return { ok: false, reason: accept.reason, status: statusForReason(accept.reason) };
    }
    // Accepted — burn the nonce so an immediate replay is caught.
    this.d.recordNonce(env.sender, env.nonce);
    const handler = this.d.handlers[env.command.type];
    if (!handler) {
      return { ok: false, reason: 'no-handler', status: statusForReason('no-handler') };
    }
    const result = await handler(env.command, env.sender, env);
    return { ok: true, result };
  }
}
