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
import crypto from 'node:crypto';
import { sign, verify } from '../core/MachineIdentity.js';
import type { MachineIdentityManager } from '../core/MachineIdentity.js';
import type { HeartbeatManager, Heartbeat } from '../core/HeartbeatManager.js';
import type { SecurityLog } from '../core/SecurityLog.js';
import type { MachineAuthContext, MachineAuthDeps } from './machineAuth.js';
import { machineAuthMiddleware, ChallengeStore } from './machineAuth.js';
import type { MessageRouter } from '../messaging/MessageRouter.js';

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
   */
  onLeaseReceived?: (lease: unknown, fromMachineId: string) => void;
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
}

// ── Route Factory ──────────────────────────────────────────────────

export function createMachineRoutes(ctx: MachineRouteContext): Router {
  const router = Router();
  const authMiddleware = machineAuthMiddleware(ctx.authDeps);
  const handoffChallenges = new ChallengeStore();
  const secretChallenges = new ChallengeStore();

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
    ctx.onLeaseReceived?.(lease, auth.machineId);
    res.json({ ok: true });
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
    const { pairingCode, machineIdentity, ephemeralPublicKey } = req.body;

    if (!pairingCode || !machineIdentity || !ephemeralPublicKey) {
      res.status(400).json({ error: 'Missing required pairing fields' });
      return;
    }

    // Pairing validation is handled by the caller (CLI command).
    // This endpoint just receives the request and signals the pairing flow.
    // The actual pairing code comparison and SAS verification happen interactively.

    ctx.securityLog.append({
      event: 'pairing_request',
      machineId: machineIdentity.machineId,
      machineName: machineIdentity.name,
      ip: req.ip || req.socket.remoteAddress || 'unknown',
    });

    // Return this machine's identity and an ephemeral key for the ECDH exchange
    const localIdentity = ctx.identityManager.loadIdentity();

    res.json({
      status: 'pending',
      machineIdentity: localIdentity,
      message: 'Pairing request received. Verify the SAS on both machines.',
    });
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
