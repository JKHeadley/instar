import { createHmac, timingSafeEqual } from 'node:crypto';
import type { FeedbackDrainService, FeedbackDrainTickResult } from './FeedbackDrainService.js';
import type { FeedbackDrainStore } from './FeedbackDrainStore.js';

export interface DrainTickProxyEnvelope {
  version: 1;
  senderMachineId: string;
  targetMachineId: string;
  agentId: string;
  nonce: string;
  issuedAt: number;
  expiresAt: number;
  hopCount: 1;
  action: 'feedback-drain-tick';
  signature: string;
}

export interface DrainTickGatewayResult {
  status: 202 | 403 | 409 | 503;
  body: { runId?: string; accepted?: boolean; reason?: string; error?: string; proxied?: boolean };
}

export interface FeedbackDrainTickProxyOptions {
  selfMachineId: string;
  ownerMachineId: () => string | null;
  isCanonicalOwner: () => boolean;
  service: FeedbackDrainService;
  store: FeedbackDrainStore;
  signingKey: string | Buffer;
  /** Multi-machine production uses the machine's Ed25519 identity. The HMAC
   * fallback is for single-machine mode and deterministic isolated tests only. */
  signEnvelope?: (payload: string) => string;
  verifyEnvelope?: (senderMachineId: string, payload: string, signature: string) => boolean;
  transport?: (targetMachineId: string, envelope: DrainTickProxyEnvelope) => Promise<DrainTickGatewayResult>;
  clock?: () => number;
  nonceTtlMs?: number;
}

const ID_RE = /^[A-Za-z0-9._:-]{1,200}$/;
const NONCE_RE = /^[A-Za-z0-9._:-]{16,128}$/;

export function resolveFeedbackDrainOwnerMachineId(
  configuredOwner: string | undefined,
  selfMachineId: string,
  multiMachineMode: boolean,
): string | null {
  if (configuredOwner !== undefined) return ID_RE.test(configuredOwner) ? configuredOwner : null;
  return multiMachineMode ? null : selfMachineId;
}

function payload(envelope: Omit<DrainTickProxyEnvelope, 'signature'>): string {
  return JSON.stringify([
    envelope.version,
    envelope.senderMachineId,
    envelope.targetMachineId,
    envelope.agentId,
    envelope.nonce,
    envelope.issuedAt,
    envelope.expiresAt,
    envelope.hopCount,
    envelope.action,
  ]);
}

export function drainTickProxyEnvelopePayload(envelope: Omit<DrainTickProxyEnvelope, 'signature'>): string {
  return payload(envelope);
}

export function signDrainTickProxyEnvelope(
  input: Omit<DrainTickProxyEnvelope, 'version' | 'hopCount' | 'action' | 'signature'>,
  signingKey: string | Buffer,
): DrainTickProxyEnvelope {
  const unsigned = { version: 1, ...input, hopCount: 1, action: 'feedback-drain-tick' } as const;
  return { ...unsigned, signature: createHmac('sha256', signingKey).update(payload(unsigned)).digest('hex') };
}

export function verifyDrainTickProxyEnvelope(
  envelope: DrainTickProxyEnvelope,
  input: { selfMachineId: string; signingKey: string | Buffer; now: number; maxTtlMs: number },
): { ok: true } | { ok: false; reason: string } {
  if (!envelope || envelope.version !== 1 || envelope.action !== 'feedback-drain-tick') return { ok: false, reason: 'proxy-envelope-version-or-action-invalid' };
  if (envelope.hopCount !== 1) return { ok: false, reason: 'proxy-hop-count-must-equal-one' };
  if (!ID_RE.test(envelope.senderMachineId) || !ID_RE.test(envelope.targetMachineId) || !ID_RE.test(envelope.agentId) || !NONCE_RE.test(envelope.nonce)) {
    return { ok: false, reason: 'proxy-envelope-identity-or-nonce-invalid' };
  }
  if (envelope.senderMachineId === envelope.targetMachineId || envelope.targetMachineId !== input.selfMachineId) {
    return { ok: false, reason: 'proxy-target-binding-invalid' };
  }
  if (!Number.isSafeInteger(envelope.issuedAt) || !Number.isSafeInteger(envelope.expiresAt) || envelope.expiresAt <= input.now || envelope.issuedAt > input.now + 5_000 || envelope.issuedAt > envelope.expiresAt || envelope.expiresAt - envelope.issuedAt > input.maxTtlMs) {
    return { ok: false, reason: 'proxy-envelope-expired-or-window-invalid' };
  }
  const { signature, ...unsigned } = envelope;
  const expected = createHmac('sha256', input.signingKey).update(payload(unsigned)).digest();
  let observed: Buffer;
  try { observed = Buffer.from(signature, 'hex'); } catch { return { ok: false, reason: 'proxy-signature-invalid' }; }
  if (observed.length !== expected.length || !timingSafeEqual(observed, expected)) return { ok: false, reason: 'proxy-signature-invalid' };
  return { ok: true };
}

export class FeedbackDrainTickProxy {
  private readonly now: () => number;
  private readonly ttlMs: number;

  constructor(private readonly opts: FeedbackDrainTickProxyOptions) {
    this.now = opts.clock ?? Date.now;
    this.ttlMs = Math.max(1_000, Math.min(120_000, opts.nonceTtlMs ?? 30_000));
  }

  async request(input: { agentId: string; nonce: string }): Promise<DrainTickGatewayResult> {
    if (!ID_RE.test(input.agentId) || !NONCE_RE.test(input.nonce)) return { status: 403, body: { error: 'bounded agent identity and request nonce required' } };
    const owner = this.opts.ownerMachineId();
    if (!owner || !ID_RE.test(owner)) return { status: 503, body: { error: 'feedback drain owner unavailable', reason: 'owner-unavailable' } };
    if (owner === this.opts.selfMachineId) return this.acceptOwned(input.agentId, input.nonce, false);
    if (!this.opts.transport) return { status: 503, body: { error: 'feedback drain owner unavailable', reason: 'owner-unavailable' } };
    const issuedAt = this.now();
    let envelope = signDrainTickProxyEnvelope({
      senderMachineId: this.opts.selfMachineId,
      targetMachineId: owner,
      agentId: input.agentId,
      nonce: input.nonce,
      issuedAt,
      expiresAt: issuedAt + this.ttlMs,
    }, this.opts.signingKey);
    if (this.opts.signEnvelope) {
      const { signature: _hmac, ...unsigned } = envelope;
      envelope = { ...unsigned, signature: this.opts.signEnvelope(payload(unsigned)) };
    }
    try {
      const result = await this.opts.transport(owner, envelope);
      return { ...result, body: { ...result.body, proxied: true } };
    } catch {
      return { status: 503, body: { error: 'feedback drain owner unavailable', reason: 'owner-unavailable', proxied: true } };
    }
  }

  async receive(envelope: DrainTickProxyEnvelope): Promise<DrainTickGatewayResult> {
    const owner = this.opts.ownerMachineId();
    if (owner !== this.opts.selfMachineId || !this.opts.isCanonicalOwner()) {
      return { status: 409, body: { error: 'proxy target is not canonical owner', reason: 'not-canonical-owner' } };
    }
    const verified = this.verify(envelope);
    if (!verified.ok) return { status: 403, body: { error: verified.reason } };
    const replayKey = `drain-proxy:${envelope.senderMachineId}:${envelope.targetMachineId}:${envelope.agentId}`;
    if (!this.opts.store.admitRequestNonce(replayKey, envelope.nonce, { now: this.now(), ttlMs: envelope.expiresAt - this.now() })) {
      return { status: 409, body: { error: 'proxy request nonce replayed', reason: 'replay' } };
    }
    return this.acceptOwned(envelope.agentId, envelope.nonce, true, true);
  }

  private verify(envelope: DrainTickProxyEnvelope): { ok: true } | { ok: false; reason: string } {
    const structural = verifyDrainTickProxyEnvelope(envelope, {
      selfMachineId: this.opts.selfMachineId,
      signingKey: this.opts.signingKey,
      now: this.now(),
      maxTtlMs: this.ttlMs,
    });
    if (!this.opts.verifyEnvelope) return structural;
    // The shared-key result is deliberately ignored when an identity verifier
    // is configured; structural checks are repeated without granting the HMAC
    // shared by peers authority to impersonate a sender machine.
    if (!envelope || envelope.version !== 1 || envelope.action !== 'feedback-drain-tick' || envelope.hopCount !== 1) return { ok: false, reason: 'proxy-envelope-structure-invalid' };
    if (!ID_RE.test(envelope.senderMachineId) || !ID_RE.test(envelope.targetMachineId) || !ID_RE.test(envelope.agentId) || !NONCE_RE.test(envelope.nonce)) return { ok: false, reason: 'proxy-envelope-identity-or-nonce-invalid' };
    if (envelope.senderMachineId === envelope.targetMachineId || envelope.targetMachineId !== this.opts.selfMachineId) return { ok: false, reason: 'proxy-target-binding-invalid' };
    const now = this.now();
    if (!Number.isSafeInteger(envelope.issuedAt) || !Number.isSafeInteger(envelope.expiresAt) || envelope.expiresAt <= now || envelope.issuedAt > now + 5_000 || envelope.issuedAt > envelope.expiresAt || envelope.expiresAt - envelope.issuedAt > this.ttlMs) return { ok: false, reason: 'proxy-envelope-expired-or-window-invalid' };
    const { signature, ...unsigned } = envelope;
    return this.opts.verifyEnvelope(envelope.senderMachineId, payload(unsigned), signature)
      ? { ok: true }
      : { ok: false, reason: 'proxy-machine-signature-invalid' };
  }

  private acceptOwned(agentId: string, nonce: string, proxied: boolean, replayAlreadyAdmitted = false): DrainTickGatewayResult {
    if (!this.opts.isCanonicalOwner()) return { status: 409, body: { error: 'not canonical owner', reason: 'not-canonical-owner', proxied } };
    if (!this.opts.service.canAgentMutateReadiness(agentId)) return { status: 403, body: { error: 'current registered readiness agent required', proxied } };
    if (!replayAlreadyAdmitted && !this.opts.store.admitRequestNonce(agentId, nonce, { now: this.now(), ttlMs: this.ttlMs })) {
      return { status: 409, body: { error: 'request nonce replayed', reason: 'replay', proxied } };
    }
    const accepted = this.opts.service.acceptTick();
    if (accepted.result?.reason === 'not-canonical-owner' || accepted.result?.reason === 'invalid-owner-epoch') {
      return { status: 409, body: { error: accepted.result.reason, runId: accepted.runId, proxied } };
    }
    return { status: 202, body: { runId: accepted.runId, accepted: accepted.accepted, reason: accepted.result?.reason, proxied } };
  }
}
