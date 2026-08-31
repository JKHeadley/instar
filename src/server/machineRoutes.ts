/**
 * Multi-machine API routes.
 *
 * Endpoints for inter-machine communication:
 *   POST /api/heartbeat          — Receive heartbeat from another machine
 *   POST /api/pair               — Handle pairing requests
 *   POST /api/handoff/challenge  — Generate challenge for handoff
 *   POST /api/handoff/request    — Request role handoff
 *   POST /api/secrets/challenge  — Generate challenge for secret sync
 *   POST /api/secrets/sync       — Receive encrypted secrets
 *   POST /api/sync/state         — Sync operational state
 *
 * All endpoints (except /api/pair) require machine-to-machine authentication.
 *
 * Part of Phases 4-5 of the multi-machine spec.
 */

import { Router } from 'express';
import { sealIdentityForJoiner, readAgentIdentityForHandover } from '../core/AgentIdentityHandover.js';
import crypto from 'node:crypto';
import { sign, verify } from '../core/MachineIdentity.js';
import type { MachineIdentityManager } from '../core/MachineIdentity.js';
import type { HeartbeatManager, Heartbeat } from '../core/HeartbeatManager.js';
import type { SecurityLog } from '../core/SecurityLog.js';
import type { MachineAuthContext, MachineAuthDeps } from './machineAuth.js';
import { machineAuthMiddleware, ChallengeStore, signLeaseAck } from './machineAuth.js';
import type { MessageRouter } from '../messaging/MessageRouter.js';
import { PairingSessionStore } from '../core/PairingSessionStore.js';
import { validatePairingCode } from '../core/PairingProtocol.js';
import type { PairingSession } from '../core/PairingProtocol.js';
import type { IdentityReannounceService, ReannounceEvaluationContext } from '../core/IdentityReannounce.js';
import { encryptForSync } from '../core/SecretStore.js';
import { IdentityStore, IdentityStoreRefusal } from '../core/IdentityStore.js';
import { identityRecoveryBearerResponseMessage } from '../core/IdentityRecoveryBearer.js';
import { identityProjectionBatchMessage } from '../core/IdentityProjectionEnvelope.js';
import { identityPropagationReceiptMessage, type IdentityPropagationReceiptUnsigned } from '../core/IdentityPropagationReceipt.js';
import { recoveryRootDelegationHash, signingAckDelegationHash } from '../core/MachineOperatorDelegation.js';
export { identityRecoveryBearerResponseMessage } from '../core/IdentityRecoveryBearer.js';

// ── Types ──────────────────────────────────────────────────────────

export interface MachineRouteContext {
  /** Machine identity manager */
  identityManager: MachineIdentityManager;
  /** Heartbeat manager for coordination */
  heartbeatManager: HeartbeatManager;
  /** Security log */
  securityLog: SecurityLog;
  /** Machine auth dependencies (for middleware) */
  authDeps: MachineAuthDeps;
  /** This machine's ID */
  localMachineId: string;
  /** This machine's signing private key (PEM) */
  localSigningKeyPem: string;
  /**
   * Agent state dir + agent name, for the agent-identity handover on pairing
   * (docs/specs/agent-identity-continuity-on-expansion.md §1). Optional so an
   * embedder that omits them simply hands over nothing and the joiner fails
   * loudly — never mints.
   */
  stateDir?: string;
  agentName?: string;
  /** Callback when this machine should demote to standby */
  onDemote?: () => void;
  /** Callback when this machine should promote to awake */
  onPromote?: () => void;
  /** Callback to get current handoff readiness */
  onHandoffRequest?: () => Promise<{ ready: boolean; state?: unknown }>;
  /** Message router for cross-machine message relay */
  messageRouter?: MessageRouter | null;
  /**
   * Callback when a peer broadcasts its fenced lease over the wire (spec §6).
   * Feeds the HttpLeaseTransport's recordObserved so the LeaseCoordinator can
   * fold the low-latency copy into its effective-epoch view.
   *
   * multi-transport-mesh-comms — returns the receiver's RESULTING effective-view
   * epoch SYNCHRONOUSLY (the fold is an in-memory epoch-CAS + signature verify),
   * so the route can return a freshness-bound accept-ack proving it folded the
   * caller's CURRENT lease (Decision 9). A void/undefined return (un-upgraded
   * lifecycle) ⇒ no ack is signed (the caller falls back to a 2xx, back-compat).
   */
  onLeaseReceived?: (lease: unknown, fromMachineId: string) => number | void;
  /**
   * Callback to serve this machine's current effective-view lease for an active
   * PULL (`POST /api/lease/pull`, Cross-Machine Coherence). Returns the signed
   * effective-view `LeaseRecord` (which may name a THIRD machine as holder —
   * re-served) or null when this machine has no lease. The puller re-verifies via
   * `FencedLease.acceptTunnelLease`, so re-serving a third-party lease is safe.
   */
  onLeasePullRequest?: () => unknown | null;
  /**
   * Callback when the holder streams an encrypted live-tail flush over the wire
   * (spec §8 G3b/c). The server lifecycle decrypts it with this machine's X25519
   * private key, then applies it to the LiveTailBuffer (sequence-deduped). Throws
   * if decryption/auth fails (the route turns that into a 400 rejection). Returns
   * the apply outcome for observability.
   */
  onLiveTailReceived?: (
    flush: { topic: string; seq: number; enc: unknown; redactionVersion?: number },
    fromMachineId: string,
  ) => { applied: boolean; reason: string } | void;
  /**
   * Callback when the INCOMING machine POSTs its verified-ack during a planned
   * handoff (spec §8 G3d). Delivers the echo to the outgoing machine's
   * HandoffWireTransport.recordAck so the pending awaitAck resolves.
   */
  onHandoffAck?: (ack: unknown, fromMachineId: string) => void;
  /**
   * Callback when the OUTGOING machine POSTs the explicit yield signal (spec §8
   * G3e). Triggers the incoming machine's lease-CAS acquisition — the ONLY path
   * by which the incoming attempts to take the lease in a planned handoff.
   */
  onHandoffYield?: (fromMachineId: string) => void;
  /**
   * Callback when the OUTGOING machine POSTs the begin signal that opens a planned
   * handoff (spec §8 G3d). Carries the outgoing's flush manifest (tailSeq +
   * ingressPosition + threadHistoryHash + the active topic) so the incoming machine
   * can echo it in its caught-up ack. Delivers to the incoming's HandoffReceiver.
   */
  onHandoffBegin?: (manifest: unknown, fromMachineId: string) => void;
  /**
   * Callback when a peer propagates a `reply_committed` marker (spec §8 G3a,
   * cross-machine exactly-once). Applies it to this machine's MessageProcessingLedger
   * via applyRemoteReplyMarker so a post-handoff redelivery of that event is deduped.
   */
  onReplyMarker?: (marker: unknown, fromMachineId: string) => void;
  /**
   * mesh-endpoint-http-propagation — records a peer's advertised mesh endpoints (carried
   * inside the signed lease RPC body) into THIS machine's registry. Bound to the
   * AUTHENTICATED sender (`auth.machineId`), gated by `meshTransport`, validated +
   * idempotent. Absent ⇒ recording is a strict no-op (the lease handling is unchanged).
   */
  peerEndpointRecorder?: import('../core/PeerEndpointRecorder.js').PeerEndpointRecorder;
  /**
   * mesh-endpoint-http-propagation — this machine's OWN validated self-endpoints, served
   * in the `/api/lease/pull` RESPONSE so the PULLER (which dials us) learns our fast
   * ropes. Absent / returns undefined ⇒ the field is omitted (un-upgraded behavior).
   */
  getSelfMeshEndpoints?: () => import('../core/types.js').MeshEndpoint[] | undefined;
  /** Bearer-authenticated recovery protocol. Mounted before the ordinary bearer
   * middleware because the rest of this router uses machine authentication. */
  identityReannounce?: IdentityReannounceService;
  /** Agent-wide recovery-route bearer established by the pairing transcript.
   * Ordinary per-machine API auth tokens are deliberately not accepted here. */
  getIdentityRecoveryBearerToken?: () => string | undefined;
  establishPeerRecoveryRoot?: (identity: import('../core/types.js').MachineIdentity, fromMachineId: string, operatorDelegation: unknown) => 'rotated' | 'already-current' | 'would-rotate';
  acknowledgePeerIdentityRotation?: (machineId: string, keyEpoch: number, fromMachineId: string, operatorDelegation: unknown) => boolean | 'acknowledged' | 'already-acknowledged' | 'would-acknowledge' | 'unknown';
  resolveIdentityReannounceContext?: (
    proposed: import('../core/types.js').MachineIdentity,
    req: import('express').Request,
  ) => ReannounceEvaluationContext | Promise<ReannounceEvaluationContext>;
}

// ── Route Factory ──────────────────────────────────────────────────

export function createMachineRoutes(ctx: MachineRouteContext): Router {
  const router = Router();
  const authMiddleware = machineAuthMiddleware(ctx.authDeps);
  const handoffChallenges = new ChallengeStore();
  const secretChallenges = new ChallengeStore();
  // Code-authenticated pool join: the active pairing session (written by
  // `instar pair`) is the shared secret that authorizes a non-interactive join.
  const pairingStore = new PairingSessionStore(ctx.identityManager.baseDir);

  const hasBearer = (req: import('express').Request): boolean => {
    const expected = ctx.getIdentityRecoveryBearerToken?.();
    const header = req.headers.authorization;
    if (!expected || typeof header !== 'string' || !header.startsWith('Bearer ')) return false;
    const supplied = header.slice(7);
    const left = Buffer.from(supplied);
    const right = Buffer.from(expected);
    return left.length === right.length && crypto.timingSafeEqual(left, right);
  };

  // These are recovery-only bearer routes. They do not enroll machines and the
  // body cannot supply any acceptance context: corroboration is resolved from
  // this peer's own durable evidence and live pool view.
  router.post('/api/identity/reannounce/challenge', (req, res) => {
    if (!hasBearer(req)) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    if (!ctx.identityReannounce) {
      res.status(503).json({ error: 'Identity re-announce is not enabled' });
      return;
    }
    const proposed = req.body?.machineIdentity;
    if (!proposed || typeof proposed.machineId !== 'string' || typeof proposed.signingPublicKey !== 'string'
      || typeof proposed.encryptionPublicKey !== 'string') {
      res.status(400).json({ error: 'Malformed machineIdentity' });
      return;
    }
    try {
      const sourceKey = req.socket.remoteAddress || 'unknown';
      const challenge = ctx.identityReannounce.issueChallenge(proposed, sourceKey);
      ctx.securityLog.append({ event: 'identity_reannounce_challenge_issued', machineId: proposed.machineId, ip: sourceKey });
      res.json(challenge);
    } catch (err) {
      const code = err instanceof Error && 'code' in err ? String((err as { code: unknown }).code) : 'challenge-refused';
      res.status(code === 'challenge-rate-limited' ? 429 : 403).json({ error: code });
    }
  });

  router.get('/api/identity/projection/by-machine/:machineId', (req, res) => {
    if (!hasBearer(req)) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    if (!ctx.identityReannounce) {
      res.status(503).json({ error: 'Identity re-announce is not enabled' });
      return;
    }
    try {
      const nonce = typeof req.query.nonce === 'string' ? req.query.nonce : '';
      if (!/^[a-f0-9]{64}$/i.test(nonce)) {
        res.status(400).json({ error: 'projection-nonce-required' });
        return;
      }
      const projection = ctx.identityReannounce.identityProjection(req.params.machineId);
      if (!projection) {
        res.status(404).json({ error: 'identity-not-found' });
        return;
      }
      const responderMachineId = ctx.localMachineId;
      const signature = sign(
        `instar-identity-projection-v1|${nonce}|${responderMachineId}|${JSON.stringify(projection)}`,
        ctx.localSigningKeyPem,
      );
      res.json({ projection, responderMachineId, nonce, signature });
    } catch (err) {
      const code = err instanceof Error && 'code' in err ? String((err as { code: unknown }).code) : 'projection-refused';
      res.status(400).json({ error: code });
    }
  });

  router.get('/api/identity/projections', (req, res) => {
    if (!hasBearer(req)) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    if (!ctx.identityReannounce) {
      res.status(503).json({ error: 'Identity re-announce is not enabled' });
      return;
    }
    const nonce = typeof req.query.nonce === 'string' ? req.query.nonce : '';
    if (!/^[a-f0-9]{64}$/i.test(nonce)) {
      res.status(400).json({ error: 'projection-nonce-required' });
      return;
    }
    const projections = ctx.identityReannounce.identityProjections();
    const responderMachineId = ctx.localMachineId;
    const signature = sign(
      identityProjectionBatchMessage(nonce, responderMachineId, projections),
      ctx.localSigningKeyPem,
    );
    res.json({ projections, responderMachineId, nonce, signature });
  });

  router.post('/api/identity/reannounce/claim', async (req, res) => {
    if (!hasBearer(req)) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    if (!ctx.identityReannounce) {
      res.status(503).json({ error: 'Identity re-announce is not enabled' });
      return;
    }
    const claim = req.body?.claim ?? req.body;
    if (!claim || typeof claim.challengeId !== 'string' || typeof claim.possessionSignature !== 'string') {
      res.status(400).json({ error: 'Malformed identity claim' });
      return;
    }
    const proposed = ctx.identityReannounce.challengeProposed(claim.challengeId);
    if (!proposed) {
      res.status(403).json({ outcome: 'refused', reason: 'challenge-unknown' });
      return;
    }
    const failClosed: ReannounceEvaluationContext = {
      sourceVerifiedUnderIncumbent: false,
      recoveryAgreement: 'unverifiable',
      signingAgreement: 'divergent',
      governorAllowed: false,
      unackedAcceptedRotation: true,
    };
    const evidence = ctx.resolveIdentityReannounceContext
      ? await Promise.resolve(ctx.resolveIdentityReannounceContext(proposed, req)).catch(() => failClosed)
      : failClosed;
    const result = ctx.identityReannounce.evaluate(claim, evidence);
    const status = result.outcome === 'refused' ? 403 : result.outcome.includes('quarantine') ? 202 : 200;
    res.status(status).json(result);
  });

  // ── POST /api/lease — Receive a peer's fenced lease over the wire (spec §6) ──
  // The low-latency authoritative copy. Auth-verified; the lease holder must
  // match the authenticated machine (a peer cannot broadcast a lease naming a
  // third machine). Fed to the HttpLeaseTransport via onLeaseReceived; FencedLease
  // re-verifies the Ed25519 signature + epoch floor + nonce before trusting it.

  router.post('/api/lease', authMiddleware, (req, res) => {
    const { machineAuth } = req as any;
    const auth = machineAuth as MachineAuthContext;
    const lease = (req.body && (req.body as any).lease) as { holder?: string } | undefined;
    if (!lease || typeof lease.holder !== 'string') {
      res.status(400).json({ error: 'Invalid lease payload' });
      return;
    }
    if (lease.holder !== auth.machineId) {
      ctx.securityLog.append({
        event: 'lease_holder_mismatch',
        machineId: auth.machineId,
        detail: `Lease holder ${lease.holder} != authenticated ${auth.machineId}`,
      });
      res.status(403).json({ error: 'Lease holder does not match authenticated machine' });
      return;
    }
    // mesh-endpoint-http-propagation — record the authenticated SENDER's advertised
    // endpoints (carried inside this signed body). Bound to `auth.machineId` (the
    // holder-match above already proved the sender owns the lease it broadcasts). The
    // recorder is gated/validating/idempotent — a strict no-op when meshTransport is off.
    ctx.peerEndpointRecorder?.record(auth.machineId, (req.body as { endpoints?: unknown }).endpoints);
    const observedEpoch = ctx.onLeaseReceived?.(lease, auth.machineId);
    // multi-transport-mesh-comms — freshness-bound accept-ack (Decision 9): when
    // the caller supplied a challenge `reqNonce` AND the fold returned a concrete
    // epoch, sign an ack proving WE folded THIS request's lease. Durable persist
    // (if any) is the fold callback's own async concern — off this response path.
    const reqNonce = (req.body && (req.body as { reqNonce?: unknown }).reqNonce);
    if (typeof reqNonce === 'string' && reqNonce.length > 0 && typeof observedEpoch === 'number') {
      const ack = { machineId: ctx.localMachineId, reqNonce, observedEpoch };
      const sig = signLeaseAck(ack, ctx.localSigningKeyPem);
      res.json({ ok: true, ack, sig });
      return;
    }
    res.json({ ok: true });
  });

  // ── POST /api/lease/pull — Serve this machine's effective-view lease (active PULL) ──
  // The READ-side counterpart of POST /api/lease (Cross-Machine Coherence): a peer
  // (typically a standby) ASKS for our current lease instead of only waiting to be
  // pushed to, so a quiet or one-way network cannot blind it. Auth-verified via a
  // signed empty body (machine-auth is body-hash based). Returns the responder's
  // effective-view lease — which MAY name a third machine as holder (re-served); the
  // puller re-verifies via FencedLease.acceptTunnelLease, so there is NO
  // holder==responder guard here (that guard is push-only).
  router.post('/api/lease/pull', authMiddleware, (req, res) => {
    const { machineAuth } = req as any;
    const auth = machineAuth as MachineAuthContext;
    // mesh-endpoint-http-propagation — record the authenticated PULLER's advertised
    // endpoints (carried inside this signed body), bound to `auth.machineId`. There is
    // no holder-match on the pull path, but machine-auth proves WHO the puller is, so
    // binding to the authenticated sender is sound. Gated/validating/idempotent no-op.
    ctx.peerEndpointRecorder?.record(auth.machineId, (req.body as { endpoints?: unknown }).endpoints);
    // Our OWN self-endpoints to serve back in the RESPONSE so the puller learns our
    // fast ropes (the live-bug direction). Omit the field when we have none.
    const selfEndpoints = ctx.getSelfMeshEndpoints?.();
    const selfEndpointsField =
      Array.isArray(selfEndpoints) && selfEndpoints.length > 0 ? { endpoints: selfEndpoints } : undefined;
    const lease = ctx.onLeasePullRequest ? ctx.onLeasePullRequest() : null;
    // multi-transport-mesh-comms — identity accept-ack on the pull path (Decision 9):
    // prove to the puller that WE are the expected peer answering THIS request, so a
    // LAN-collision stranger or black-hole proxy returning 200 cannot be counted
    // reachable. The pull does NOT confirm an epoch (the puller reads our lease, it
    // does not fold its own), so the ack carries observedEpoch = our served epoch
    // (advisory) and is verified by identity + freshness only.
    const reqNonce = (req.body && (req.body as { reqNonce?: unknown }).reqNonce);
    if (typeof reqNonce === 'string' && reqNonce.length > 0) {
      const servedEpoch = lease && typeof (lease as { epoch?: unknown }).epoch === 'number' ? (lease as { epoch: number }).epoch : -1;
      const ack = { machineId: ctx.localMachineId, reqNonce, observedEpoch: servedEpoch };
      const sig = signLeaseAck(ack, ctx.localSigningKeyPem);
      res.json({ lease: lease ?? null, ack, sig, ...selfEndpointsField });
      return;
    }
    res.json({ lease: lease ?? null, ...selfEndpointsField });
  });

  // ── POST /api/live-tail — Receive an encrypted live-tail flush (spec §8 G3b/c) ──
  // The holder streams the redacted+encrypted live conversation tail to the
  // standby. Auth-verified (machineAuthMiddleware confirms the sender's identity
  // against the registry — an unverifiable peer is rejected BEFORE any content is
  // accepted, per §8 G3c). Decryption with this machine's X25519 private key and
  // the sequence-deduped applyFlush happen in onLiveTailReceived (server
  // lifecycle), which throws on a bad payload/auth → 400.

  router.post('/api/live-tail', authMiddleware, (req, res) => {
    const { machineAuth } = req as any;
    const auth = machineAuth as MachineAuthContext;
    const flush = (req.body && (req.body as any).flush) as
      | { topic?: string; seq?: number; enc?: unknown; redactionVersion?: number }
      | undefined;
    if (!flush || typeof flush.topic !== 'string' || typeof flush.seq !== 'number' || !flush.enc) {
      res.status(400).json({ error: 'Invalid live-tail flush payload' });
      return;
    }
    if (!ctx.onLiveTailReceived) {
      res.status(503).json({ error: 'Live-tail receiver not available' });
      return;
    }
    try {
      const result = ctx.onLiveTailReceived(
        { topic: flush.topic, seq: flush.seq, enc: flush.enc, redactionVersion: flush.redactionVersion },
        auth.machineId,
      );
      res.json({ ok: true, applied: result?.applied ?? null, reason: result?.reason ?? null });
    } catch (err) {
      ctx.securityLog.append({
        event: 'live_tail_rejected',
        machineId: auth.machineId,
        detail: err instanceof Error ? err.message : String(err),
      });
      res.status(400).json({ error: 'Live-tail flush rejected (decrypt/verify failed)' });
    }
  });

  // ── POST /api/heartbeat — Receive heartbeat from another machine ──

  router.post('/api/heartbeat', authMiddleware, (req, res) => {
    const { machineAuth } = req as any;
    const auth = machineAuth as MachineAuthContext;

    const incoming = req.body as Heartbeat;
    if (!incoming || !incoming.holder || !incoming.timestamp || !incoming.expiresAt) {
      res.status(400).json({ error: 'Invalid heartbeat payload' });
      return;
    }

    // Verify the heartbeat holder matches the authenticated machine
    if (incoming.holder !== auth.machineId) {
      ctx.securityLog.append({
        event: 'heartbeat_mismatch',
        machineId: auth.machineId,
        detail: `Heartbeat holder ${incoming.holder} != authenticated ${auth.machineId}`,
      });
      res.status(403).json({ error: 'Heartbeat holder does not match authenticated machine' });
      return;
    }

    const result = ctx.heartbeatManager.processIncomingHeartbeat(incoming);

    ctx.securityLog.append({
      event: 'heartbeat_received',
      machineId: auth.machineId,
      result,
    });

    if (result === 'demote') {
      // We should demote — the incoming heartbeat is newer
      ctx.onDemote?.();
      res.json({ status: 'acknowledged', action: 'we-demoted' });
    } else if (result === 'they-should-demote') {
      // Our heartbeat is newer — tell them to demote
      res.json({ status: 'conflict', action: 'you-should-demote' });
    } else {
      // ignore (from self or non-conflicting)
      res.json({ status: 'acknowledged', action: 'none' });
    }
  });

  // ── POST /api/pair — Handle pairing from a new machine ──────────
  // Note: This endpoint does NOT use machineAuth (new machine isn't registered yet).
  // Instead, it relies on the pairing code exchange for authentication.

  router.post('/api/pair', (req, res) => {
    const { pairingCode, machineIdentity, ephemeralPublicKey, advertisedUrl } = req.body ?? {};
    const ip = req.ip || req.socket.remoteAddress || 'unknown';

    if (!pairingCode || !machineIdentity || !ephemeralPublicKey) {
      res.status(400).json({ error: 'Missing required pairing fields' });
      return;
    }
    // Validate the joiner's identity shape before we'd ever persist it.
    if (
      typeof machineIdentity.machineId !== 'string' ||
      !/^[A-Za-z0-9_-]{1,64}$/.test(machineIdentity.machineId) ||
      typeof machineIdentity.signingPublicKey !== 'string' ||
      typeof machineIdentity.encryptionPublicKey !== 'string'
    ) {
      res.status(400).json({ error: 'Malformed machineIdentity' });
      return;
    }

    // ── Code-authenticated, non-interactive pool join ────────────────
    // The pairing code (a short-lived, single-use, attempt-capped shared secret
    // written by `instar pair` and carried over the TLS tunnel) IS the auth — no
    // human SAS step (operator's "Proceed with A" trust-model decision). A joiner
    // can only ever register as STANDBY; it can never claim the awake role here.
    const stored = pairingStore.load();
    if (!stored) {
      ctx.securityLog.append({
        event: 'pairing_rejected',
        machineId: machineIdentity.machineId,
        machineName: machineIdentity.name,
        reason: 'no-active-session',
        ip,
      });
      res.status(403).json({ error: 'No active pairing session. Run `instar pair` on the awake machine.' });
      return;
    }

    const result = validatePairingCode(stored as unknown as PairingSession, String(pairingCode));
    // Persist the mutated session (failedAttempts increments accumulate across
    // requests so the attempt cap actually throttles brute force).
    pairingStore.save(stored);
    if (!result.valid) {
      ctx.securityLog.append({
        event: 'pairing_rejected',
        machineId: machineIdentity.machineId,
        machineName: machineIdentity.name,
        reason: result.reason ?? 'invalid-code',
        ip,
      });
      res.status(403).json({ error: result.reason ?? 'Invalid pairing code' });
      return;
    }

    // Code valid → register the joiner as standby, persist its public keys (so
    // MeshRpc can verify its signatures), record its advertised URL if it sent
    // one, and burn the code (single-use).
    const priorRegistry = ctx.identityManager.loadRegistry().machines?.[machineIdentity.machineId];
    const repairingRevokedPrincipal = Boolean(priorRegistry?.status === 'revoked' || priorRegistry?.revokedAt);
    let acceptedMachineIdentity = machineIdentity;
    if (repairingRevokedPrincipal) {
      if (!ctx.stateDir) {
        res.status(503).json({ error: 'identity-authority-unavailable' });
        return;
      }
      const authority = new IdentityStore({ stateDir: ctx.stateDir }).getEpoch(machineIdentity.machineId);
      // Epochs are receiver-derived. Claimant values are never authority, even
      // though a conforming fresh-pair client will normally propose the same
      // exact increments.
      acceptedMachineIdentity = {
        ...machineIdentity,
        keyEpoch: authority.keyEpoch + 1,
        recoveryEpoch: authority.recoveryEpoch + 1,
      };
    }
    try {
      ctx.identityManager.storeRemoteIdentity(acceptedMachineIdentity, {
        actor: 'pairing-trust',
        path: 'pair',
        acceptedBy: ctx.localMachineId,
        clearRevocation: true,
      });
    } catch (err) {
      if (repairingRevokedPrincipal && err instanceof IdentityStoreRefusal
        && ['signing-key-tombstoned', 'recovery-key-tombstoned', 'key-epoch-not-next', 'recovery-epoch-not-next',
          'key-epoch-without-rotation', 'recovery-epoch-without-rotation'].includes(err.code)) {
        res.status(409).json({ error: 'fresh-pairing-identity-required' });
        return;
      }
      res.status(409).json({ error: err instanceof IdentityStoreRefusal ? err.code : 'pairing-identity-refused' });
      return;
    }
    // IdentityStore clears a sticky revocation only after the replacement
    // identity is durable. Register second so a legitimate fresh pair updates
    // role/metadata instead of hitting registerMachine's revocation guard.
    ctx.identityManager.registerMachine(acceptedMachineIdentity, 'standby');
    if (typeof advertisedUrl === 'string' && /^https?:\/\/\S+$/.test(advertisedUrl)) {
      try {
        ctx.identityManager.updateMachineUrl(machineIdentity.machineId, advertisedUrl.trim().replace(/\/+$/, ''));
      } catch { /* entry was just registered; best-effort */ }
    }
    stored.consumed = true;
    pairingStore.save(stored);

    ctx.securityLog.append({
      event: 'pairing_completed',
      machineId: machineIdentity.machineId,
      machineName: machineIdentity.name,
      ip,
    });

    // Return this machine's identity so the joiner can register us as awake.
    const localIdentity = ctx.identityManager.loadIdentity();

    // ── Carry the AGENT identity to the joiner ────────────────────────────────────
    // Spec: docs/specs/agent-identity-continuity-on-expansion.md §1.
    //
    // Without this the joiner finds no agent identity and (post-guard) refuses to mint,
    // so the join fails — and pre-guard it minted one, silently splitting the agent in
    // two. `ephemeralPublicKey` has always arrived here and was validated and unused;
    // this is what it was for.
    //
    // Sealed to that key, bound to a transcript the joiner re-checks against what it
    // sent. A refusal is NAMED and the field is simply absent — never a partial or
    // fabricated envelope, because the joiner must be able to tell "not provided" from
    // "provided and wrong".
    let agentIdentityEnvelope: unknown;
    try {
      const agentIdentity = ctx.stateDir ? readAgentIdentityForHandover(ctx.stateDir) : null;
      if (agentIdentity) {
        const sealed = sealIdentityForJoiner({
          payload: agentIdentity.payload,
          identityFingerprint: agentIdentity.fingerprint,
          transcript: {
            pairingSessionId: String(stored.code),
            joinerMachineId: machineIdentity.machineId,
            joinerEncryptionPublicKey: String(ephemeralPublicKey),
            agentName: ctx.agentName ?? '',
            expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
          },
        });
        if (sealed.ok) agentIdentityEnvelope = sealed.envelope;
        else console.warn(`[pair] agent-identity handover refused: ${sealed.refusal}`);
      } else {
        // No agent identity to hand over is a REAL state on a machine that never had
        // one. Logged rather than silent, because the joiner will refuse to mint and
        // the operator deserves to know which end lacked it.
        console.warn('[pair] no agent identity on this machine to hand over');
      }
    } catch (err) {
      // @silent-fallback-ok: pairing the MACHINE must still succeed even if the agent
      // identity cannot be sealed — the joiner then fails loudly with a named reason
      // rather than minting, which is the safe direction.
      console.warn('[pair] agent-identity handover failed (non-fatal):', err);
    }

    res.json({
      status: 'paired',
      machineIdentity: localIdentity,
      ...(ctx.getIdentityRecoveryBearerToken?.() ? { identityRecoveryBearerToken: ctx.getIdentityRecoveryBearerToken!() } : {}),
      ...(agentIdentityEnvelope ? { agentIdentityEnvelope } : {}),
      message: 'Paired.',
    });
  });

  // Existing pools created before the recovery channel can converge without a
  // human re-pair. The caller is authenticated by its incumbent machine key;
  // the token is encrypted to that machine's registered X25519 public key, so
  // an HTTP LAN observer cannot learn it.
  router.post('/api/identity/recovery-channel/pull', authMiddleware, (req, res) => {
    const auth = (req as any).machineAuth as MachineAuthContext;
    const requestNonce = req.body?.requestNonce;
    if (typeof requestNonce !== 'string' || !/^[a-f0-9]{64}$/i.test(requestNonce)) {
      res.status(400).json({ error: 'request-nonce-required' });
      return;
    }
    const token = ctx.getIdentityRecoveryBearerToken?.();
    if (!token) {
      res.status(503).json({ error: 'recovery-channel-not-established' });
      return;
    }
    const recipient = ctx.identityManager.loadRemoteIdentity(auth.machineId);
    if (!recipient?.encryptionPublicKey) {
      res.status(403).json({ error: 'recipient-encryption-key-unavailable' });
      return;
    }
    const encrypted = encryptForSync({ identityRecoveryBearerToken: token }, recipient.encryptionPublicKey);
    const encryptedWire = JSON.stringify(encrypted);
    const responderMachineId = ctx.localMachineId;
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const signature = sign(identityRecoveryBearerResponseMessage({
      responderMachineId,
      recipientMachineId: auth.machineId,
      requestNonce,
      tokenHash,
      encrypted: encryptedWire,
    }), ctx.localSigningKeyPem);
    res.json({
      encrypted: encryptedWire,
      responderMachineId,
      recipientMachineId: auth.machineId,
      requestNonce,
      tokenHash,
      signature,
    });
  });

  // A dashboard-PIN action on the subject machine is delegated over that
  // machine's incumbent signed channel. The receiver still applies the root
  // through IdentityStore's pairing-trust-only first-establishment invariant.
  router.post('/api/identity/recovery-root/establish', authMiddleware, (req, res) => {
    const auth = (req as any).machineAuth as MachineAuthContext;
    const machineIdentity = req.body?.machineIdentity as import('../core/types.js').MachineIdentity | undefined;
    if (!machineIdentity || machineIdentity.machineId !== auth.machineId) {
      res.status(403).json({ error: 'recovery-root-subject-mismatch' });
      return;
    }
    if (!req.body?.operatorDelegation) {
      res.status(403).json({ error: 'operator-delegation-required' });
      return;
    }
    const requestNonce = req.body?.requestNonce;
    if (typeof requestNonce !== 'string' || !/^[a-f0-9]{64}$/i.test(requestNonce)) {
      res.status(400).json({ error: 'request-nonce-required' });
      return;
    }
    if (!ctx.establishPeerRecoveryRoot) {
      res.status(503).json({ error: 'recovery-root-establishment-unavailable' });
      return;
    }
    try {
      const outcome = ctx.establishPeerRecoveryRoot(machineIdentity, auth.machineId, req.body.operatorDelegation);
      const unsigned: IdentityPropagationReceiptUnsigned = {
        version: 1,
        action: 'recovery-root',
        responderMachineId: ctx.localMachineId,
        requesterMachineId: auth.machineId,
        requestNonce,
        subjectMachineId: machineIdentity.machineId,
        epoch: machineIdentity.recoveryEpoch ?? 0,
        contentHash: recoveryRootDelegationHash(machineIdentity),
        status: outcome,
      };
      res.json({ ...unsigned, signature: sign(identityPropagationReceiptMessage(unsigned), ctx.localSigningKeyPem) });
    } catch (err) {
      const message = err instanceof Error ? err.message : '';
      const forbidden = message.startsWith('operator-delegation-') || message === 'recovery-root-first-establishment-requires-pairing';
      res.status(forbidden ? 403 : 409).json({ error: err instanceof IdentityStoreRefusal ? err.code : message || 'recovery-root-establishment-refused' });
    }
  });

  router.post('/api/identity/reannounce/ack', authMiddleware, (req, res) => {
    const auth = (req as any).machineAuth as MachineAuthContext;
    const machineId = req.body?.machineId;
    const keyEpoch = Number(req.body?.keyEpoch);
    if (typeof machineId !== 'string' || !Number.isSafeInteger(keyEpoch)) {
      res.status(400).json({ error: 'machineId-and-keyEpoch-required' });
      return;
    }
    if (!req.body?.operatorDelegation) {
      res.status(403).json({ error: 'operator-delegation-required' });
      return;
    }
    const requestNonce = req.body?.requestNonce;
    if (typeof requestNonce !== 'string' || !/^[a-f0-9]{64}$/i.test(requestNonce)) {
      res.status(400).json({ error: 'request-nonce-required' });
      return;
    }
    if (!ctx.acknowledgePeerIdentityRotation) {
      res.status(503).json({ error: 'identity-rotation-ack-unavailable' });
      return;
    }
    try {
      const outcome = ctx.acknowledgePeerIdentityRotation(machineId, keyEpoch, auth.machineId, req.body.operatorDelegation);
      const status = outcome === true || outcome === 'acknowledged'
        ? 'acknowledged'
        : outcome === 'already-acknowledged' ? 'already-acknowledged'
          : outcome === 'would-acknowledge' ? 'would-acknowledge' : 'unknown';
      if (status === 'unknown') {
        res.status(409).json({ error: 'identity-acknowledgement-refused' });
        return;
      }
      const unsigned: IdentityPropagationReceiptUnsigned = {
        version: 1,
        action: 'signing-ack',
        responderMachineId: ctx.localMachineId,
        requesterMachineId: auth.machineId,
        requestNonce,
        subjectMachineId: machineId,
        epoch: keyEpoch,
        contentHash: signingAckDelegationHash(machineId, keyEpoch),
        status,
      };
      res.json({ ...unsigned, signature: sign(identityPropagationReceiptMessage(unsigned), ctx.localSigningKeyPem) });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'operator-delegation-invalid';
      res.status(message.startsWith('operator-delegation-') ? 403 : 409).json({ error: message });
    }
  });

  // ── POST /api/handoff/begin — Outgoing machine opens a planned handoff (§8 G3d) ──
  // Carries the outgoing's flush manifest (tailSeq + ingressPosition +
  // threadHistoryHash + the active topic). The incoming machine stores it and
  // builds its caught-up ack by echoing tailSeq/ingressPosition and recomputing
  // the thread-history hash from its own synced state. No manifest → no handoff.

  router.post('/api/handoff/begin', authMiddleware, (req, res) => {
    const { machineAuth } = req as any;
    const auth = machineAuth as MachineAuthContext;
    const manifest = (req.body && (req.body as any).manifest) as
      | { tailSeq?: number; ingressPosition?: unknown; threadHistoryHash?: string; topic?: unknown }
      | undefined;
    if (
      !manifest ||
      typeof manifest.tailSeq !== 'number' ||
      !manifest.ingressPosition ||
      typeof manifest.threadHistoryHash !== 'string'
    ) {
      res.status(400).json({ error: 'Invalid handoff begin manifest' });
      return;
    }
    if (!ctx.onHandoffBegin) {
      res.status(503).json({ error: 'Handoff begin receiver not available' });
      return;
    }
    ctx.onHandoffBegin(manifest, auth.machineId);
    res.json({ ok: true });
  });

  // ── POST /api/message-marker — Cross-machine reply_committed marker (§8 G3a) ──
  // The lease holder propagates "this inbound event was answered" to the standby
  // so that AFTER a handoff/failover the newly-awake machine's ledger already
  // knows, and a provider redelivery of the same event is deduped (the cross-
  // machine half of exactly-once). Carries no conversation content. No receiver
  // wired (exactly-once off) → 503.

  router.post('/api/message-marker', authMiddleware, (req, res) => {
    const { machineAuth } = req as any;
    const auth = machineAuth as MachineAuthContext;
    const marker = (req.body && (req.body as any).marker) as
      | { dedupeKey?: string; platform?: string; replyIdempotencyKey?: string; epoch?: number; topic?: unknown }
      | undefined;
    if (
      !marker ||
      typeof marker.dedupeKey !== 'string' ||
      typeof marker.platform !== 'string' ||
      typeof marker.replyIdempotencyKey !== 'string' ||
      typeof marker.epoch !== 'number'
    ) {
      res.status(400).json({ error: 'Invalid reply marker payload' });
      return;
    }
    if (!ctx.onReplyMarker) {
      res.status(503).json({ error: 'Reply-marker receiver not available' });
      return;
    }
    ctx.onReplyMarker(marker, auth.machineId);
    res.json({ ok: true });
  });

  // ── POST /api/handoff/ack — Incoming machine's verified "caught up" ack (§8 G3d) ──
  // The incoming machine echoes the live-tail sequence, the ingress position it
  // will resume from, and a hash of the thread history it loaded. The outgoing
  // machine verifies this echo matches what it flushed BEFORE yielding the lease.

  router.post('/api/handoff/ack', authMiddleware, (req, res) => {
    const { machineAuth } = req as any;
    const auth = machineAuth as MachineAuthContext;
    const ack = (req.body && (req.body as any).ack) as
      | { tailSeq?: number; ingressPosition?: unknown; threadHistoryHash?: string }
      | undefined;
    if (!ack || typeof ack.tailSeq !== 'number' || !ack.ingressPosition || typeof ack.threadHistoryHash !== 'string') {
      res.status(400).json({ error: 'Invalid handoff ack payload' });
      return;
    }
    if (!ctx.onHandoffAck) {
      res.status(503).json({ error: 'Handoff ack receiver not available' });
      return;
    }
    ctx.onHandoffAck(ack, auth.machineId);
    res.json({ ok: true });
  });

  // ── POST /api/handoff/yield — Outgoing machine's explicit yield signal (§8 G3e) ──
  // Sent ONLY after a verified ack + passing validation. This is the sole trigger
  // for the incoming machine's lease-CAS acquisition; without it the incoming
  // never attempts the lease, so there is no two-holders-same-epoch window.

  router.post('/api/handoff/yield', authMiddleware, (req, res) => {
    const { machineAuth } = req as any;
    const auth = machineAuth as MachineAuthContext;
    if (!ctx.onHandoffYield) {
      res.status(503).json({ error: 'Handoff yield receiver not available' });
      return;
    }
    ctx.onHandoffYield(auth.machineId);
    res.json({ ok: true });
  });

  // ── POST /api/handoff/challenge — Generate challenge for handoff ──

  router.post('/api/handoff/challenge', authMiddleware, (req, res) => {
    const challenge = handoffChallenges.generate();
    res.json({
      challenge: challenge.challenge,
      expiresAt: challenge.expiresAt,
    });
  });

  // ── POST /api/handoff/request — Request role handoff ──────────────

  router.post('/api/handoff/request', authMiddleware, async (req, res) => {
    const { machineAuth } = req as any;
    const auth = machineAuth as MachineAuthContext;
    const { challenge, challengeSignature } = req.body;

    // 1. Verify challenge
    if (!challenge || !challengeSignature) {
      res.status(400).json({ error: 'Missing challenge or signature' });
      return;
    }

    if (!handoffChallenges.consume(challenge)) {
      res.status(403).json({ error: 'Invalid, expired, or already-used challenge' });
      return;
    }

    // 2. Verify challenge signature
    // The sender signs: challenge + sender_machine_id + receiver_machine_id + SHA256(body-without-challenge-fields)
    const bodyForHash = { ...req.body };
    delete bodyForHash.challenge;
    delete bodyForHash.challengeSignature;
    const bodyHash = crypto.createHash('sha256')
      .update(JSON.stringify(bodyForHash))
      .digest('hex');
    const challengeMessage = `${challenge}|${auth.machineId}|${ctx.localMachineId}|${bodyHash}`;

    const publicKeyPem = ctx.identityManager.getSigningPublicKeyPem(auth.machineId);
    if (!publicKeyPem) {
      res.status(403).json({ error: 'Machine public key not found' });
      return;
    }

    try {
      const valid = verify(challengeMessage, challengeSignature, publicKeyPem);
      if (!valid) {
        ctx.securityLog.append({
          event: 'handoff_challenge_failed',
          machineId: auth.machineId,
        });
        res.status(403).json({ error: 'Invalid challenge signature' });
        return;
      }
    } catch {
      res.status(403).json({ error: 'Challenge verification failed' });
      return;
    }

    ctx.securityLog.append({
      event: 'handoff_requested',
      machineId: auth.machineId,
      machineName: ctx.identityManager.loadRemoteIdentity(auth.machineId)?.name ?? auth.machineId,
    });

    // 3. Prepare for handoff — stop services and sync state
    try {
      const handoffResult = await ctx.onHandoffRequest?.();

      if (!handoffResult?.ready) {
        res.json({
          status: 'not-ready',
          message: 'This machine is not ready to hand off. Try again shortly.',
        });
        return;
      }

      // Update registry: demote self to standby
      ctx.identityManager.updateRole(ctx.localMachineId, 'standby');
      ctx.identityManager.updateRole(auth.machineId, 'awake');

      ctx.securityLog.append({
        event: 'handoff_completed',
        machineId: auth.machineId,
        from: ctx.localMachineId,
      });

      ctx.onDemote?.();

      res.json({
        status: 'handed-off',
        state: handoffResult.state,
        message: 'Handoff complete. You are now the awake machine.',
      });
    } catch (err) {
      ctx.securityLog.append({
        event: 'handoff_failed',
        machineId: auth.machineId,
        error: err instanceof Error ? err.message : String(err),
      });
      res.status(500).json({ error: 'Handoff failed' });
    }
  });

  // ── POST /api/secrets/challenge — Generate challenge for secret sync ──

  router.post('/api/secrets/challenge', authMiddleware, (req, res) => {
    const challenge = secretChallenges.generate();
    res.json({
      challenge: challenge.challenge,
      expiresAt: challenge.expiresAt,
    });
  });

  // ── POST /api/secrets/sync — Receive encrypted secrets ──────────

  router.post('/api/secrets/sync', authMiddleware, (req, res) => {
    const { machineAuth } = req as any;
    const auth = machineAuth as MachineAuthContext;
    const { challenge, challengeSignature, ephemeralPublicKey, ciphertext, nonce, tag } = req.body;

    // 1. Verify challenge (same pattern as handoff)
    if (!challenge || !challengeSignature) {
      res.status(400).json({ error: 'Missing challenge or signature' });
      return;
    }

    if (!secretChallenges.consume(challenge)) {
      res.status(403).json({ error: 'Invalid, expired, or already-used challenge' });
      return;
    }

    // 2. Verify challenge signature
    const bodyForHash = { ...req.body };
    delete bodyForHash.challenge;
    delete bodyForHash.challengeSignature;
    const bodyHash = crypto.createHash('sha256')
      .update(JSON.stringify(bodyForHash))
      .digest('hex');
    const challengeMessage = `${challenge}|${auth.machineId}|${ctx.localMachineId}|${bodyHash}`;

    const publicKeyPem = ctx.identityManager.getSigningPublicKeyPem(auth.machineId);
    if (!publicKeyPem) {
      res.status(403).json({ error: 'Machine public key not found' });
      return;
    }

    try {
      const valid = verify(challengeMessage, challengeSignature, publicKeyPem);
      if (!valid) {
        ctx.securityLog.append({
          event: 'secret_sync_challenge_failed',
          machineId: auth.machineId,
        });
        res.status(403).json({ error: 'Invalid challenge signature' });
        return;
      }
    } catch {
      res.status(403).json({ error: 'Challenge verification failed' });
      return;
    }

    // 3. Validate encrypted payload
    if (!ephemeralPublicKey || !ciphertext || !nonce || !tag) {
      res.status(400).json({ error: 'Missing encryption payload fields' });
      return;
    }

    ctx.securityLog.append({
      event: 'secret_sync_received',
      machineId: auth.machineId,
    });

    // Decryption is handled by the caller (the server lifecycle code).
    // This route just validates auth + challenge and returns the encrypted payload
    // for the server to decrypt with its own private key.
    res.json({
      status: 'received',
      message: 'Encrypted secrets received. Decryption will be handled locally.',
    });
  });

  // ── POST /api/sync/state — Sync operational state ──────────────

  router.post('/api/sync/state', authMiddleware, (req, res) => {
    const { machineAuth } = req as any;
    const auth = machineAuth as MachineAuthContext;
    const { type, data, timestamp } = req.body;

    if (!type || !data) {
      res.status(400).json({ error: 'Missing sync type or data' });
      return;
    }

    const validTypes = ['jobs', 'sessions', 'logs'];
    if (!validTypes.includes(type)) {
      res.status(400).json({ error: `Invalid sync type: ${type}. Valid: ${validTypes.join(', ')}` });
      return;
    }

    ctx.securityLog.append({
      event: 'state_sync_received',
      machineId: auth.machineId,
      syncType: type,
    });

    // State sync application is handled by the server lifecycle code.
    // This route validates auth and returns acknowledgment.
    res.json({
      status: 'received',
      type,
      timestamp: new Date().toISOString(),
    });
  });

  // ── POST /api/messages/relay-machine — Cross-machine message relay ──
  // Protected by Machine-HMAC (5-header scheme). Envelope carries Ed25519 signature
  // verified by the MessageRouter.relay() method.

  router.post('/api/messages/relay-machine', authMiddleware, async (req, res) => {
    if (!ctx.messageRouter) {
      res.status(503).json({ error: 'Messaging not available' });
      return;
    }
    try {
      const envelope = req.body;
      if (!envelope?.message?.id) {
        res.status(400).json({ error: 'Invalid envelope' });
        return;
      }

      // Ed25519 signature verification happens inside relay() for source='machine'
      const accepted = await ctx.messageRouter.relay(envelope, 'machine');
      if (accepted) {
        res.json({ ok: true });
      } else {
        res.status(409).json({ error: 'Relay rejected (loop, duplicate, or invalid signature)' });
      }
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Relay failed' });
    }
  });

  return router;
}
