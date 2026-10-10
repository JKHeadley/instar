/**
 * AgentIdentityAdoption — a paired machine with NO agent identity ADOPTS it from its siblings;
 * it never mints one.
 *
 * Spec: docs/specs/a2a-single-agent-identity.md §1.2 (verbs, lock, audit), §1.3 (acceptance:
 * `reachable-agree`, pinned by local memory, else refuse), §Watchers (an Eternal Sentinel).
 * Constitution: "Cross-Machine Coherence — One Agent, Robust Under Degraded Conditions";
 * "Verify the State, Not Its Symbol"; "Self-Heal Before Notify".
 *
 * Three layers live here, each pure over injected deps so the decision is testable without
 * a mesh:
 *   1. SERVING — the `agent-identity-observe` / `agent-identity-request` handlers a sibling
 *      runs. The observe answer is read from the ON-DISK file through the single reader (never
 *      the in-process cache), signed by the responder's registry-pinned machine key over
 *      `{fingerprint, requesterNonce}`. The request handler serves typed refusals, reads the
 *      requester's own observe answer back first (the one void-check it can do), rate-limits
 *      one share per requester per 10 min, and seals the identity with `encryptForSync` to the
 *      requester's REGISTRY encryption key — a key named in the body is never used.
 *   2. ACCEPTANCE — `decideAdoption` (§1.3): adopt only when every REACHABLE active sibling
 *      that answered `provisioned` with a VERIFIED signature published the same fingerprint;
 *      at least ONE witness when this machine remembers its own address (and the value must
 *      equal it), TWO when it does not. `openAdoptionEnvelope` verifies the signed envelope,
 *      the sealed key hashing (routing formula) to the value, and the private↔public
 *      correspondence IN MEMORY before anything is written.
 *   3. THE LOOP — `AgentIdentityAdoptionLoop`, a declared Eternal Sentinel: observe every
 *      30 s backing off to a 5-min floor after 1 h, one request per 10 min, one in flight,
 *      escalate ONCE (after 4 consecutive fleet refusals or 120 s), keep healing, resolve on
 *      success. Idempotent: a second install of the same fingerprint is a no-op.
 *
 * @self-action-controller: agent-identity-adoption
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fingerprintOf } from './AgentIdentityHandover.js';
import { decodeKey32, derivePublicKey, readIdentityKeyFile, writeFileAtomicOwnerOnly } from '../identity/IdentityKeyFile.js';
import { withIdentityLock, IdentityLockedError } from './AgentIdentityLock.js';
import { IdentityFileInvalidError } from '../identity/IdentityKeyFile.js';
import { readLastKnownFingerprint } from '../threadline/client/IdentityManager.js';
import type { AgentIdentityAudit } from './AgentIdentityAudit.js';

// ── Wire shapes ─────────────────────────────────────────────────────────────

export type IdentityPostureState = 'provisioned' | 'not-provisioned';

export interface ObserveCommand {
  type: 'agent-identity-observe';
  agentName: string;
  requesterNonce: string;
}

export interface ObserveResponse {
  fingerprint: string | null;
  state: IdentityPostureState;
  requesterNonce: string;
  responderMachineId: string;
  sig: string;
}

export interface RequestCommand {
  type: 'agent-identity-request';
  agentName: string;
  expectedFingerprint: string;
  requesterNonce: string;
}

export type RequestRefusal =
  | 'not-registered'
  | 'no-usable-identity'
  | 'fingerprint-mismatch'
  | 'requester-publishes-identity'
  | 'requester-unobservable'
  | 'agent-mismatch'
  | 'rate-limited';

export interface RequestGrant {
  ok: true;
  sealed: SealedAgentIdentity;
  fingerprint: string;
  requesterNonce: string;
  responderMachineId: string;
  adoptedFrom: { machineId: string; at: string };
  sig: string;
}

/**
 * A typed serving refusal, SIGNED over `{reason, requesterNonce}` exactly like a grant
 * (§1.2): an unsigned or mis-signed refusal counts as `unreachable`, so a LAN peer cannot
 * spoof a refusal to stall or steer adoption.
 */
export interface RequestRefusalResponse {
  ok: false;
  refusal: RequestRefusal;
  retryAfterMs?: number;
  requesterNonce: string;
  responderMachineId: string;
  sig: string;
}

export type RequestResponse = RequestGrant | RequestRefusalResponse;

/** Canonical bytes a refusal signature covers. */
export function canonicalRefusal(r: Omit<RequestRefusalResponse, 'sig' | 'ok' | 'retryAfterMs'>): string {
  return JSON.stringify(['agent-identity-request-refusal', r.responderMachineId, r.refusal, r.requesterNonce]);
}

/** What the sealed payload carries. */
export interface AdoptionPayload {
  identity: { publicKey: string; privateKey: string; createdAt: string };
}

/** Canonical bytes the observe signature covers. */
export function canonicalObserve(r: Omit<ObserveResponse, 'sig'>): string {
  return JSON.stringify(['agent-identity-observe', r.responderMachineId, r.fingerprint, r.state, r.requesterNonce]);
}

/** Canonical bytes the request-grant signature covers (the sealed blob by digest). */
export function canonicalGrant(r: Omit<RequestGrant, 'sig' | 'ok'>): string {
  const sealedDigest = crypto.createHash('sha256').update(JSON.stringify(r.sealed)).digest('hex');
  return JSON.stringify(['agent-identity-request', r.responderMachineId, r.fingerprint, r.requesterNonce, r.adoptedFrom.machineId, r.adoptedFrom.at, sealedDigest]);
}

// ── AAD-bound sealing (its own HKDF domain; never `encryptForSync`) ────────
//
// `encryptForSync` is forbidden for credential-class payloads (SecretStore.ts: it cannot carry
// an AAD binding, and a blob sealed with it would be interchangeable with a secret-sync blob).
// This pair derives its AES key under a SEPARATE HKDF info string (domain separation) and binds
// `{verb, requesterMachineId, requesterNonce, fingerprint}` into AES-256-GCM via AAD, failing
// CLOSED on any mismatch — a captured grant cannot be replayed to another requester, under
// another nonce, or for another fingerprint.

const AGENT_IDENTITY_HKDF_INFO = 'instar-agent-identity-v1';
const X25519_SPKI_PREFIX = Buffer.from('302a300506032b656e032100', 'hex');

export interface AgentIdentityAAD {
  verb: 'agent-identity-request';
  requesterMachineId: string;
  requesterNonce: string;
  fingerprint: string;
}

export interface SealedAgentIdentity {
  ephemeralPublicKey: string;
  iv: string;
  ciphertext: string;
  tag: string;
  aad: AgentIdentityAAD;
}

const AAD_FIELDS: ReadonlyArray<keyof AgentIdentityAAD> = ['verb', 'requesterMachineId', 'requesterNonce', 'fingerprint'];

function canonicalAAD(aad: AgentIdentityAAD | null | undefined): Buffer {
  if (!aad || typeof aad !== 'object') throw new Error('agent-identity AAD missing (fail-closed)');
  for (const f of AAD_FIELDS) {
    if (typeof aad[f] !== 'string' || aad[f].length === 0) throw new Error(`agent-identity AAD field "${f}" must be a non-empty string (fail-closed)`);
  }
  if (aad.verb !== 'agent-identity-request') throw new Error('agent-identity AAD verb mismatch (fail-closed)');
  const extra = Object.keys(aad).filter((k) => !AAD_FIELDS.includes(k as keyof AgentIdentityAAD));
  if (extra.length) throw new Error(`agent-identity AAD has unexpected field(s): ${extra.join(', ')} (fail-closed)`);
  return Buffer.from(`${AGENT_IDENTITY_HKDF_INFO}|${AAD_FIELDS.map((f) => `${f}=${aad[f]}`).join('\x1f')}`, 'utf-8');
}

function x25519PublicKeyObject(raw: Buffer): crypto.KeyObject {
  const spki = raw.length === 32 ? Buffer.concat([X25519_SPKI_PREFIX, raw]) : raw;
  return crypto.createPublicKey({ key: spki, format: 'der', type: 'spki' });
}

/** Seal `payload` to the requester's REGISTRY X25519 key (base64 raw or SPKI), AAD-bound. */
export function sealAgentIdentity(payload: AdoptionPayload, recipientPublicKeyBase64: string, aad: AgentIdentityAAD): SealedAgentIdentity {
  const aadBytes = canonicalAAD(aad);
  const ephemeral = crypto.generateKeyPairSync('x25519');
  const ephemeralSpki = ephemeral.publicKey.export({ type: 'spki', format: 'der' });
  const ephemeralRaw = Buffer.from(ephemeralSpki.subarray(ephemeralSpki.length - 32));
  const recipient = x25519PublicKeyObject(Buffer.from(recipientPublicKeyBase64, 'base64'));
  const shared = crypto.diffieHellman({ privateKey: ephemeral.privateKey, publicKey: recipient });
  const key = crypto.hkdfSync('sha256', shared, ephemeralRaw, AGENT_IDENTITY_HKDF_INFO, 32);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', Buffer.from(key), iv);
  cipher.setAAD(aadBytes);
  const ct = Buffer.concat([cipher.update(Buffer.from(JSON.stringify(payload), 'utf-8')), cipher.final()]);
  return {
    ephemeralPublicKey: ephemeralRaw.toString('base64'),
    iv: iv.toString('base64'),
    ciphertext: ct.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    aad: { ...aad },
  };
}

/** Open a sealed identity with this machine's X25519 private key; the AAD must equal `expectedAad` exactly. */
export function openSealedAgentIdentity(sealed: SealedAgentIdentity, ownPrivateKey: crypto.KeyObject, expectedAad: AgentIdentityAAD): AdoptionPayload {
  const expected = canonicalAAD(expectedAad);
  const carried = canonicalAAD(sealed?.aad);
  if (!expected.equals(carried)) throw new Error('agent-identity AAD mismatch (fail-closed)');
  const ephemeralRaw = Buffer.from(sealed.ephemeralPublicKey, 'base64');
  const shared = crypto.diffieHellman({ privateKey: ownPrivateKey, publicKey: x25519PublicKeyObject(ephemeralRaw) });
  const key = crypto.hkdfSync('sha256', shared, ephemeralRaw, AGENT_IDENTITY_HKDF_INFO, 32);
  const decipher = crypto.createDecipheriv('aes-256-gcm', Buffer.from(key), Buffer.from(sealed.iv, 'base64'));
  decipher.setAAD(expected);
  decipher.setAuthTag(Buffer.from(sealed.tag, 'base64'));
  const pt = Buffer.concat([decipher.update(Buffer.from(sealed.ciphertext, 'base64')), decipher.final()]);
  return JSON.parse(pt.toString('utf-8')) as AdoptionPayload;
}

// ── Disk read through the single reader (never the cache) ──────────────────

export type OnDiskIdentityPosture =
  | { state: 'provisioned'; fingerprint: string; path: string }
  | { state: 'not-provisioned' }
  /** A file is PRESENT at the canonical path but unusable (invalid or encrypted) — adoption never writes over it. */
  | { state: 'invalid'; path: string; reason: string };

/**
 * The on-disk posture: provisioned (a usable key at either path), not-provisioned (no file at
 * either path), or `invalid` (a present-but-unloadable file). The loop refuses
 * `identity-file-invalid` every round in the last case and names the CLI lever.
 */
export function readAgentIdentityPosture(stateDir: string): OnDiskIdentityPosture {
  const usable = readAgentIdentityOnDisk(stateDir);
  if (usable) return { state: 'provisioned', fingerprint: usable.fingerprint, path: usable.path };
  for (const rel of ['identity.json', path.join('threadline', 'identity.json')]) {
    const full = path.join(stateDir, rel);
    if (!fs.existsSync(full)) continue;
    let reason = 'present but unusable';
    try {
      const loaded = readIdentityKeyFile(full, { repair: false });
      if (loaded?.encrypted) reason = 'encrypted (locked) private key';
      else if (loaded && !loaded.privateKey) reason = 'no private key in file';
    } catch (err) {
      reason = err instanceof IdentityFileInvalidError ? err.reason : err instanceof Error ? err.message : String(err);
    }
    return { state: 'invalid', path: full, reason };
  }
  return { state: 'not-provisioned' };
}

/**
 * This machine's agent identity as it is ON DISK right now: canonical first, legacy second,
 * through the validating single reader. `null` = not provisioned. A file moved aside by the
 * CLI on a running server reads as not-provisioned immediately — the rule §1.2 and §2.2 share.
 */
export function readAgentIdentityOnDisk(stateDir: string): { publicKey: Buffer; privateKey: Buffer; createdAt: string; fingerprint: string; path: string } | null {
  for (const rel of ['identity.json', path.join('threadline', 'identity.json')]) {
    try {
      const full = path.join(stateDir, rel);
      const loaded = readIdentityKeyFile(full, { repair: false });
      if (!loaded || loaded.encrypted || !loaded.privateKey) continue;
      return {
        publicKey: loaded.publicKey,
        privateKey: loaded.privateKey,
        createdAt: typeof loaded.raw.createdAt === 'string' ? loaded.raw.createdAt : '',
        fingerprint: fingerprintOf(loaded.publicKey.toString('base64')),
        path: full,
      };
    } catch {
      // @silent-fallback-ok — an invalid key file at one path is a typed posture (`invalid`, surfaced by readAgentIdentityPosture + the adoption item), not a silent degrade; the next path is tried.
      // An invalid file is not a usable identity; the next location is tried. (Both invalid →
      // not-provisioned; the CLI's `adopt` moves a present-but-invalid file aside.)
    }
  }
  return null;
}

// ── 1. SERVING side ────────────────────────────────────────────────────────

export interface AgentIdentityServingDeps {
  stateDir: string;
  agentName: string;
  selfMachineId: string;
  /** Sign canonical bytes with THIS machine's registry-pinned Ed25519 key. */
  sign: (canonical: string) => string;
  /** Is `machineId` a registered ACTIVE sibling? */
  isMachineActive: (machineId: string) => boolean;
  /** The requester's X25519 encryption public key (base64) FROM THE REGISTRY, or null. */
  registryEncryptionPublicKey: (machineId: string) => string | null;
  /**
   * Read the requester's OWN observe answer back (the one void-check the server can do).
   * Resolves null when the requester cannot be observed (unreachable / no handler / bad sig).
   */
  observeRequester: (machineId: string) => Promise<{ state: IdentityPostureState; fingerprint: string | null } | null>;
  now?: () => number;
  audit?: AgentIdentityAudit;
  /** One share per requester per this many ms. Default 10 min. */
  shareIntervalMs?: number;
}

export class AgentIdentityServer {
  private readonly lastShareAt = new Map<string, number>();
  /** Last observe answer served per requester — the audit records TRANSITIONS, not every round. */
  private readonly lastObserveAnswer = new Map<string, string>();
  constructor(private readonly d: AgentIdentityServingDeps) {}

  /** `agent-identity-observe` — answer from DISK, signed. Never refuses (a null is an answer). */
  observe(cmd: ObserveCommand, sender: string): ObserveResponse {
    const onDisk = cmd.agentName === this.d.agentName ? readAgentIdentityOnDisk(this.d.stateDir) : null;
    const body = {
      fingerprint: onDisk?.fingerprint ?? null,
      state: (onDisk ? 'provisioned' : 'not-provisioned') as IdentityPostureState,
      requesterNonce: String(cmd.requesterNonce ?? ''),
      responderMachineId: this.d.selfMachineId,
    };
    const answerKey = `${body.state}:${body.fingerprint ?? ''}`;
    if (this.lastObserveAnswer.get(sender) !== answerKey) {
      this.lastObserveAnswer.set(sender, answerKey);
      this.d.audit?.append('adoption-observe', { role: 'responder', requester: sender, state: body.state, fingerprint: body.fingerprint });
    }
    return { ...body, sig: this.d.sign(canonicalObserve(body)) };
  }

  /** `agent-identity-request` — serve the sealed identity, or a typed refusal. */
  async request(cmd: RequestCommand, sender: string): Promise<RequestResponse> {
    const requesterNonce = String(cmd.requesterNonce ?? '');
    const refuse = (refusal: RequestRefusal, extra: Record<string, unknown> = {}): RequestResponse => {
      this.d.audit?.append('identity-serve-refused', { requester: sender, refusal, expectedFingerprint: cmd.expectedFingerprint, ...extra });
      const body = { refusal, requesterNonce, responderMachineId: this.d.selfMachineId };
      return { ok: false, ...body, ...(typeof extra.retryAfterMs === 'number' ? { retryAfterMs: extra.retryAfterMs } : {}), sig: this.d.sign(canonicalRefusal(body)) };
    };
    if (cmd.agentName !== this.d.agentName) return refuse('agent-mismatch');
    if (!this.d.isMachineActive(sender)) return refuse('not-registered');
    const recipientKey = this.d.registryEncryptionPublicKey(sender);
    if (!recipientKey) return refuse('not-registered', { detail: 'no registry encryption key for requester' });

    const now = (this.d.now ?? Date.now)();
    const interval = this.d.shareIntervalMs ?? 10 * 60_000;
    const last = this.lastShareAt.get(sender);
    if (last !== undefined && now - last < interval) return refuse('rate-limited', { retryAfterMs: interval - (now - last) });

    const onDisk = readAgentIdentityOnDisk(this.d.stateDir);
    if (!onDisk) return refuse('no-usable-identity');
    if (onDisk.fingerprint !== cmd.expectedFingerprint) return refuse('fingerprint-mismatch', { served: onDisk.fingerprint });

    // The void-check: a requester that PUBLISHES an identity is not filling a void.
    const theirs = await this.d.observeRequester(sender);
    if (!theirs) return refuse('requester-unobservable');
    if (theirs.state === 'provisioned') return refuse('requester-publishes-identity', { theirs: theirs.fingerprint });

    const payload: AdoptionPayload = {
      identity: {
        publicKey: onDisk.publicKey.toString('base64'),
        privateKey: onDisk.privateKey.toString('base64'),
        createdAt: onDisk.createdAt || new Date(0).toISOString(),
      },
    };
    let sealed: SealedAgentIdentity;
    try {
      sealed = sealAgentIdentity(payload, recipientKey, { verb: 'agent-identity-request', requesterMachineId: sender, requesterNonce, fingerprint: onDisk.fingerprint });
    } catch {
      return refuse('not-registered', { detail: 'requester registry key unusable' });
    }
    const grant = {
      sealed,
      fingerprint: onDisk.fingerprint,
      requesterNonce,
      responderMachineId: this.d.selfMachineId,
      adoptedFrom: { machineId: this.d.selfMachineId, at: new Date(now).toISOString() },
    };
    this.lastShareAt.set(sender, now);
    this.d.audit?.append('identity-served', { requester: sender, fingerprint: onDisk.fingerprint });
    return { ok: true, ...grant, sig: this.d.sign(canonicalGrant(grant)) };
  }
}

// ── 2. ACCEPTANCE (requester side) ─────────────────────────────────────────

export type ObservationState = 'provisioned' | 'not-provisioned' | 'unreachable';
export type UnreachableReason = 'no-handler' | 'bad-signature' | 'nonce-mismatch' | 'transport' | 'malformed';

export interface AdoptionObservation {
  machineId: string;
  nickname?: string;
  state: ObservationState;
  fingerprint: string | null;
  reason?: UnreachableReason;
}

/**
 * Verify one sibling's observe answer. A verified answer is an observation; anything else is
 * `unreachable` with a named reason — it never counts as agreement OR disagreement.
 */
export function verifyObserveResponse(
  raw: unknown,
  expected: { machineId: string; requesterNonce: string; nickname?: string },
  verifySig: (machineId: string, canonical: string, sig: string) => boolean,
): AdoptionObservation {
  const base = { machineId: expected.machineId, nickname: expected.nickname };
  const r = raw as Partial<ObserveResponse> | null;
  if (!r || typeof r !== 'object' || typeof r.sig !== 'string' || typeof r.state !== 'string') {
    return { ...base, state: 'unreachable', fingerprint: null, reason: 'malformed' };
  }
  if (r.requesterNonce !== expected.requesterNonce) return { ...base, state: 'unreachable', fingerprint: null, reason: 'nonce-mismatch' };
  if (r.responderMachineId !== expected.machineId) return { ...base, state: 'unreachable', fingerprint: null, reason: 'bad-signature' };
  const fingerprint = typeof r.fingerprint === 'string' && /^[0-9a-f]{32}$/.test(r.fingerprint) ? r.fingerprint : null;
  const state: IdentityPostureState = r.state === 'provisioned' ? 'provisioned' : 'not-provisioned';
  const canonical = canonicalObserve({ fingerprint, state, requesterNonce: expected.requesterNonce, responderMachineId: expected.machineId });
  if (!verifySig(expected.machineId, canonical, r.sig)) return { ...base, state: 'unreachable', fingerprint: null, reason: 'bad-signature' };
  if (state === 'provisioned' && !fingerprint) return { ...base, state: 'unreachable', fingerprint: null, reason: 'malformed' };
  return { ...base, state, fingerprint: state === 'provisioned' ? fingerprint : null };
}

export type AdoptionMode = 'one-witness+pin' | 'two-witnesses';
export type AdoptionRefusal = 'cannot-tell' | 'single-witness' | 'disagree' | 'last-known-mismatch' | 'revoked-only';

export type AdoptionDecision =
  | { ok: true; fingerprint: string; mode: AdoptionMode; witnesses: string[]; observed: { k: number; n: number } }
  | { ok: false; reason: AdoptionRefusal; observed: { k: number; n: number }; detail: string; values?: Record<string, string[]> };

/**
 * §1.3 — `reachable-agree`, pinned by local memory, else refuse. Pure.
 *
 * `observations` are the ACTIVE siblings' verified answers (revoked rows are excluded by the
 * caller and passed as `revokedCount` so a fleet of only revoked siblings is named).
 */
export function decideAdoption(input: {
  observations: AdoptionObservation[];
  lastKnownFingerprint: string | null;
  revokedCount?: number;
}): AdoptionDecision {
  const n = input.observations.length;
  const witnesses = input.observations.filter((o): o is AdoptionObservation & { fingerprint: string } => o.state === 'provisioned' && typeof o.fingerprint === 'string');
  const k = input.observations.filter((o) => o.state !== 'unreachable').length;
  const observed = { k, n };
  const values: Record<string, string[]> = {};
  for (const w of witnesses) (values[w.fingerprint] ??= []).push(w.nickname ?? w.machineId);
  const distinct = Object.keys(values);

  if (distinct.length > 1) {
    return { ok: false, reason: 'disagree', observed, values, detail: `reachable siblings publish ${distinct.length} different identities` };
  }
  if (witnesses.length === 0) {
    if (n === 0 && (input.revokedCount ?? 0) > 0) {
      return { ok: false, reason: 'revoked-only', observed, detail: `the only siblings on record are revoked (${input.revokedCount}); nothing to adopt from` };
    }
    return { ok: false, reason: 'cannot-tell', observed, detail: k === 0 ? 'no sibling reachable' : 'no reachable sibling publishes an identity' };
  }
  const fingerprint = distinct[0];
  if (input.lastKnownFingerprint) {
    if (input.lastKnownFingerprint !== fingerprint) {
      return {
        ok: false,
        reason: 'last-known-mismatch',
        observed,
        values,
        detail: `this machine's own memory (${input.lastKnownFingerprint}) disagrees with what its siblings publish (${fingerprint})`,
      };
    }
    return { ok: true, fingerprint, mode: 'one-witness+pin', witnesses: witnesses.map((w) => w.machineId), observed };
  }
  if (witnesses.length < 2) {
    return { ok: false, reason: 'single-witness', observed, values, detail: 'one witness and no local memory of this machine\'s own address; a second independent signed witness is required' };
  }
  return { ok: true, fingerprint, mode: 'two-witnesses', witnesses: witnesses.map((w) => w.machineId), observed };
}

export type EnvelopeRejection = 'refused' | 'unreachable' | 'bad-signature' | 'nonce-mismatch' | 'undecryptable' | 'key-not-hashing' | 'keypair-mismatch' | 'malformed';

/**
 * Open a `agent-identity-request` grant: signature, nonce, decrypt, the sealed public key
 * hashing (routing formula) to `expectedFingerprint`, and the private↔public correspondence
 * IN MEMORY. Nothing is written here.
 */
export function openAdoptionEnvelope(input: {
  response: unknown;
  responderMachineId: string;
  /** THIS machine's id — the AAD binds the grant to it. */
  selfMachineId: string;
  expectedFingerprint: string;
  requesterNonce: string;
  ownEncryptionPrivateKeyPem: string;
  verifySig: (machineId: string, canonical: string, sig: string) => boolean;
}): { ok: true; identity: { publicKey: Buffer; privateKey: Buffer; createdAt: string }; adoptedFrom: { machineId: string; at: string } } | { ok: false; rejection: EnvelopeRejection; refusal?: RequestRefusal; retryAfterMs?: number } {
  const r = input.response as Partial<RequestResponse> | null;
  if (!r || typeof r !== 'object') return { ok: false, rejection: 'malformed' };
  if ((r as { ok?: boolean }).ok === false) {
    // A refusal is signed over {reason, requesterNonce} exactly like a grant; an unsigned or
    // mis-signed refusal counts as UNREACHABLE (never as a refusal that steers adoption).
    const ref = r as Partial<RequestRefusalResponse>;
    if (typeof ref.refusal !== 'string' || typeof ref.sig !== 'string' || ref.requesterNonce !== input.requesterNonce || ref.responderMachineId !== input.responderMachineId) {
      return { ok: false, rejection: 'unreachable' };
    }
    const canonical = canonicalRefusal({ refusal: ref.refusal, requesterNonce: ref.requesterNonce, responderMachineId: ref.responderMachineId });
    if (!input.verifySig(input.responderMachineId, canonical, ref.sig)) return { ok: false, rejection: 'unreachable' };
    return { ok: false, rejection: 'refused', refusal: ref.refusal, ...(typeof ref.retryAfterMs === 'number' ? { retryAfterMs: ref.retryAfterMs } : {}) };
  }
  const g = r as Partial<RequestGrant>;
  if (!g.sealed || typeof g.sig !== 'string' || typeof g.fingerprint !== 'string' || !g.adoptedFrom) return { ok: false, rejection: 'malformed' };
  if (g.requesterNonce !== input.requesterNonce) return { ok: false, rejection: 'nonce-mismatch' };
  if (g.responderMachineId !== input.responderMachineId) return { ok: false, rejection: 'bad-signature' };
  const canonical = canonicalGrant({
    sealed: g.sealed,
    fingerprint: g.fingerprint,
    requesterNonce: g.requesterNonce,
    responderMachineId: g.responderMachineId,
    adoptedFrom: { machineId: String(g.adoptedFrom.machineId), at: String(g.adoptedFrom.at) },
  });
  if (!input.verifySig(input.responderMachineId, canonical, g.sig)) return { ok: false, rejection: 'bad-signature' };
  if (g.fingerprint !== input.expectedFingerprint) return { ok: false, rejection: 'key-not-hashing' };

  let opened: AdoptionPayload;
  try {
    opened = openSealedAgentIdentity(g.sealed, crypto.createPrivateKey(input.ownEncryptionPrivateKeyPem), {
      verb: 'agent-identity-request',
      requesterMachineId: input.selfMachineId,
      requesterNonce: input.requesterNonce,
      fingerprint: input.expectedFingerprint,
    });
  } catch {
    return { ok: false, rejection: 'undecryptable' };
  }
  const pubB64 = opened?.identity?.publicKey;
  const privB64 = opened?.identity?.privateKey;
  if (typeof pubB64 !== 'string' || typeof privB64 !== 'string') return { ok: false, rejection: 'undecryptable' };
  if (fingerprintOf(pubB64) !== input.expectedFingerprint) return { ok: false, rejection: 'key-not-hashing' };

  const pub = decodeKey32(pubB64);
  const priv = decodePrivateSeed(privB64);
  if (!pub || !priv) return { ok: false, rejection: 'keypair-mismatch' };
  try {
    if (!derivePublicKey(priv).equals(pub.key)) return { ok: false, rejection: 'keypair-mismatch' };
  } catch {
    // @silent-fallback-ok — a key that cannot be derived is the typed `keypair-mismatch` rejection the caller audits and names; nothing is written.
    return { ok: false, rejection: 'keypair-mismatch' };
  }
  return {
    ok: true,
    identity: { publicKey: pub.key, privateKey: priv, createdAt: typeof opened.identity.createdAt === 'string' ? opened.identity.createdAt : new Date(0).toISOString() },
    adoptedFrom: { machineId: String(g.adoptedFrom.machineId), at: String(g.adoptedFrom.at) },
  };
}

/** A 32-byte seed (base64/hex) or a PKCS8 DER (48 bytes, base64) — both yield the seed. */
function decodePrivateSeed(value: string): Buffer | null {
  const d = decodeKey32(value);
  if (d) return d.key;
  try {
    const buf = Buffer.from(value, 'base64');
    if (buf.length === 48) return Buffer.from(buf.subarray(-32));
  } catch {
    // @silent-fallback-ok — a value that is neither a 32-byte seed nor a PKCS8 DER decodes to null and the caller rejects `keypair-mismatch`.
  }
  return null;
}

// ── Install (void-fill only, under the lock) ───────────────────────────────

export type AdoptionProvenanceOrigin = 'adopted-from-sibling' | 'adopted-by-operator' | 'minted-by-operator-recovery';

export type InstallResult =
  | { ok: true; fingerprint: string; alreadyPresent: boolean }
  | { ok: false; reason: 'identity-present' | 'identity-locked' | 'write-failed'; detail?: string };

/**
 * Install an adopted identity — atomic, owner-only, under the identity lock, VOID-FILL ONLY.
 * A present file is never written over (`identity-present`), except when it already holds
 * this very key (then the install is an idempotent no-op). Replacement is §1.4's CLI.
 */
export function installAdoptedIdentity(input: {
  stateDir: string;
  identity: { publicKey: Buffer; privateKey: Buffer; createdAt: string };
  origin: AdoptionProvenanceOrigin;
  selfMachineId: string;
  adoptedFrom: { machineId: string; at: string } | null;
  producedBy?: string;
  lockDeps?: Parameters<typeof withIdentityLock>[2];
}): InstallResult {
  const target = path.join(input.stateDir, 'identity.json');
  const fingerprint = fingerprintOf(input.identity.publicKey.toString('base64'));
  try {
    return withIdentityLock(input.stateDir, () => {
      const existing = readAgentIdentityOnDisk(input.stateDir);
      if (existing) {
        return existing.fingerprint === fingerprint
          ? { ok: true as const, fingerprint, alreadyPresent: true }
          : { ok: false as const, reason: 'identity-present' as const, detail: `identity.json already holds ${existing.fingerprint}` };
      }
      if (fs.existsSync(target)) {
        // Present but unusable (invalid/encrypted): adoption fills a VOID only; the CLI
        // moves such a file aside deliberately. Never write over it here.
        return { ok: false as const, reason: 'identity-present' as const, detail: 'identity.json exists but is not a usable plaintext identity' };
      }
      const file = {
        version: 1,
        publicKey: input.identity.publicKey.toString('base64'),
        privateKey: input.identity.privateKey.toString('base64'),
        privateKeyEncryption: 'none',
        createdAt: input.identity.createdAt || new Date(0).toISOString(),
        provenance: {
          schemaVersion: 1,
          origin: input.origin,
          rootFingerprint: fingerprint,
          machineId: input.selfMachineId,
          createdAt: new Date().toISOString(),
          producedBy: input.producedBy ?? 'a2a-single-agent-identity',
          ...(input.adoptedFrom ? { adoptedFrom: input.adoptedFrom } : {}),
        },
      };
      try {
        writeFileAtomicOwnerOnly(target, JSON.stringify(file, null, 2) + '\n');
      } catch (err) {
        return { ok: false as const, reason: 'write-failed' as const, detail: err instanceof Error ? err.message : String(err) };
      }
      return { ok: true as const, fingerprint, alreadyPresent: false };
    }, input.lockDeps);
  } catch (err) {
    if (err instanceof IdentityLockedError) return { ok: false, reason: 'identity-locked', detail: err.message };
    return { ok: false, reason: 'write-failed', detail: err instanceof Error ? err.message : String(err) };
  }
}

// ── 3. THE LOOP (Eternal Sentinel) ────────────────────────────────────────

export interface AdoptionSibling {
  machineId: string;
  nickname?: string;
}

export interface AdoptionAttentionItem {
  id: string;
  title: string;
  body: string;
  priority: 'high' | 'medium' | 'critical';
}

export interface AgentIdentityAdoptionLoopDeps {
  stateDir: string;
  agentName: string;
  selfMachineId: string;
  /** The fleet-live kill switch (`agentIdentity.adoption.enabled`), read live. */
  enabled: () => boolean;
  /** Registered ACTIVE siblings (never self). */
  listActiveSiblings: () => AdoptionSibling[];
  /** Registered REVOKED sibling count (named in a refusal when they are the only siblings). */
  revokedSiblingCount?: () => number;
  /** Send `agent-identity-observe` to one sibling. Resolve the raw response, or a typed failure. */
  observe: (sibling: AdoptionSibling, cmd: ObserveCommand) => Promise<{ ok: true; result: unknown } | { ok: false; reason: 'no-handler' | 'transport' }>;
  /** Send `agent-identity-request` to one sibling. */
  request: (sibling: AdoptionSibling, cmd: RequestCommand) => Promise<{ ok: true; result: unknown } | { ok: false; reason: 'no-handler' | 'transport' }>;
  /** Verify a responder's signature against its REGISTRY-pinned key. */
  verifySig: (machineId: string, canonical: string, sig: string) => boolean;
  /** This machine's X25519 private key PEM (for decryptFromSync), or null when unavailable. */
  ownEncryptionPrivateKeyPem: () => string | null;
  /** The reload lever (§1.2) — runs after a successful install. */
  onInstalled: (fingerprint: string) => Promise<void> | void;
  raiseItem: (item: AdoptionAttentionItem) => void;
  resolveItem: (id: string) => void;
  audit?: AgentIdentityAudit;
  now?: () => number;
  mintNonce?: () => string;
  /** Cadence knobs (tests shrink them). */
  observeIntervalMs?: number; // default 30 s
  observeFloorMs?: number; // default 5 min
  backoffAfterMs?: number; // default 1 h
  requestIntervalMs?: number; // default 10 min
  escalateAfterMs?: number; // default 120 s
  escalateAfterRefusals?: number; // default 4
  heartbeatMs?: number; // default 1 h
}

export interface AdoptionLoopStatus {
  running: boolean;
  provisioned: boolean;
  lastDecision: AdoptionDecision | null;
  lastRefusal: string | null;
  consecutiveFleetRefusals: number;
  rounds: number;
  requests: number;
  installedFingerprint: string | null;
  escalated: boolean;
  adoptLoseCycles24h: number;
  lastRoundAt: string | null;
}

export class AgentIdentityAdoptionLoop {
  private timer: NodeJS.Timeout | null = null;
  private inFlight = false;
  private startedAt = 0;
  private lastRequestAt = Number.NEGATIVE_INFINITY;
  private lastHeartbeatAt = Number.NEGATIVE_INFINITY;
  private lastReason: string | null = null;
  private consecutiveFleetRefusals = 0;
  private escalated = false;
  private lastEscalatedReason: string | null = null;
  private rounds = 0;
  private requests = 0;
  private installedFingerprint: string | null = null;
  private lastDecision: AdoptionDecision | null = null;
  private lastRoundAt: number | null = null;
  private readonly loseCycleTimes: number[] = [];
  private requestedMachineRotation = 0;
  /** The latest observe round's verified observations (§1.1 lease rule reads `provisioned` here). */
  lastObservations: AdoptionObservation[] = [];

  constructor(private readonly d: AgentIdentityAdoptionLoopDeps) {}

  private now(): number {
    return (this.d.now ?? Date.now)();
  }

  get itemId(): string {
    return `agent-identity-missing:${this.d.agentName}:${this.d.selfMachineId}`;
  }

  /** The loop is only ever started on a machine that booted unprovisioned. */
  start(): void {
    if (this.timer) return;
    this.startedAt = this.now();
    this.d.audit?.append('posture-not-provisioned', { machineId: this.d.selfMachineId });
    const tick = () => {
      void this.runOnce().finally(() => {
        if (!this.timer) return;
        const elapsed = this.now() - this.startedAt;
        const base = this.d.observeIntervalMs ?? 30_000;
        const floor = this.d.observeFloorMs ?? 5 * 60_000;
        const after = this.d.backoffAfterMs ?? 60 * 60_000;
        const next = this.installedFingerprint ? floor : elapsed >= after ? floor : base;
        this.timer = setTimeout(tick, next);
        this.timer.unref?.();
      });
    };
    this.timer = setTimeout(tick, 0);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** Re-enter the unprovisioned posture after an installed identity disappeared. */
  noteIdentityLost(): void {
    if (this.installedFingerprint) {
      this.loseCycleTimes.push(this.now());
      this.d.audit?.append('identity-lost', { machineId: this.d.selfMachineId, fingerprint: this.installedFingerprint });
    }
    this.installedFingerprint = null;
    this.escalated = false;
    this.lastEscalatedReason = null;
    this.consecutiveFleetRefusals = 0;
    this.startedAt = this.now();
  }

  status(): AdoptionLoopStatus {
    const dayAgo = this.now() - 24 * 60 * 60_000;
    return {
      running: this.timer !== null,
      provisioned: this.installedFingerprint !== null,
      lastDecision: this.lastDecision,
      lastRefusal: this.lastReason,
      consecutiveFleetRefusals: this.consecutiveFleetRefusals,
      rounds: this.rounds,
      requests: this.requests,
      installedFingerprint: this.installedFingerprint,
      escalated: this.escalated,
      adoptLoseCycles24h: this.loseCycleTimes.filter((t) => t >= dayAgo).length,
      lastRoundAt: this.lastRoundAt === null ? null : new Date(this.lastRoundAt).toISOString(),
    };
  }

  /** One observe round (+ at most one request). Safe to call directly in tests. */
  async runOnce(): Promise<AdoptionDecision | null> {
    if (this.inFlight) return null;
    this.inFlight = true;
    try {
      return await this.round();
    } finally {
      this.inFlight = false;
    }
  }

  private async round(): Promise<AdoptionDecision | null> {
    this.rounds += 1;
    this.lastRoundAt = this.now();
    if (!this.d.enabled()) {
      this.transition('adoption-disabled', 'adoption is disabled by agentIdentity.adoption.enabled:false');
      this.maybeEscalate('adoption-disabled', 'adoption is switched off on this machine (agentIdentity.adoption.enabled:false)');
      return null;
    }
    // Already provisioned (installed by us, or by the CLI meanwhile)? Nothing to do.
    const posture = readAgentIdentityPosture(this.d.stateDir);
    if (posture.state === 'provisioned') {
      if (this.installedFingerprint !== posture.fingerprint) {
        this.installedFingerprint = posture.fingerprint;
        this.d.resolveItem(this.itemId);
      }
      return null;
    }
    if (this.installedFingerprint) this.noteIdentityLost();
    if (posture.state === 'invalid') {
      // A present-but-unloadable file: adoption never writes over it (§1.1). Refuse every
      // round with the named reason; the lever is the CLI, which moves the file aside.
      const detail = `${posture.path} is present but unusable (${posture.reason}); adoption never writes over a file`;
      this.transition('identity-file-invalid', detail);
      this.consecutiveFleetRefusals += 1;
      this.maybeEscalate('identity-file-invalid', `${detail}. Say yes and I will run \`instar identity adopt --from <sibling>\` on this machine, which moves the unusable file aside and installs the identity the siblings publish.`);
      this.heartbeat('identity-file-invalid');
      return null;
    }

    const siblings = this.d.listActiveSiblings();
    const nonce = (this.d.mintNonce ?? (() => crypto.randomBytes(12).toString('hex')))();
    const observations = await Promise.all(
      siblings.map(async (s): Promise<AdoptionObservation> => {
        let r: Awaited<ReturnType<AgentIdentityAdoptionLoopDeps['observe']>>;
        try {
          r = await this.d.observe(s, { type: 'agent-identity-observe', agentName: this.d.agentName, requesterNonce: nonce });
        } catch {
          r = { ok: false, reason: 'transport' };
        }
        if (!r.ok) return { machineId: s.machineId, nickname: s.nickname, state: 'unreachable', fingerprint: null, reason: r.reason };
        return verifyObserveResponse(r.result, { machineId: s.machineId, requesterNonce: nonce, nickname: s.nickname }, this.d.verifySig);
      }),
    );
    this.lastObservations = observations;
    const lastKnown = readLastKnownFingerprint(this.d.stateDir);
    const decision = decideAdoption({ observations, lastKnownFingerprint: lastKnown, revokedCount: this.d.revokedSiblingCount?.() ?? 0 });
    this.lastDecision = decision;

    if (!decision.ok) {
      const noHandler = observations.filter((o) => o.reason === 'no-handler').map((o) => o.nickname ?? o.machineId);
      this.transition(decision.reason, decision.detail, { observed: decision.observed, mode: null, noHandler });
      this.consecutiveFleetRefusals += 1;
      this.maybeEscalate(decision.reason, this.describeRefusal(decision, noHandler));
      this.heartbeat(decision.reason);
      return decision;
    }

    // One request per 10 min, one in flight (we are in flight), rotating on a typed refusal.
    const now = this.now();
    if (now - this.lastRequestAt < (this.d.requestIntervalMs ?? 10 * 60_000)) {
      this.heartbeat('request-paced');
      return decision;
    }
    const candidates = siblings.filter((s) => decision.witnesses.includes(s.machineId));
    if (candidates.length === 0) return decision;
    const target = candidates[this.requestedMachineRotation % candidates.length];
    this.lastRequestAt = now;
    this.requests += 1;
    const reqNonce = (this.d.mintNonce ?? (() => crypto.randomBytes(12).toString('hex')))();
    this.d.audit?.append('adoption-requested', { machineId: this.d.selfMachineId, from: target.machineId, fingerprint: decision.fingerprint, mode: decision.mode, observed: decision.observed });
    let resp: Awaited<ReturnType<AgentIdentityAdoptionLoopDeps['request']>>;
    try {
      resp = await this.d.request(target, { type: 'agent-identity-request', agentName: this.d.agentName, expectedFingerprint: decision.fingerprint, requesterNonce: reqNonce });
    } catch {
      resp = { ok: false, reason: 'transport' };
    }
    if (!resp.ok) {
      this.requestedMachineRotation += 1;
      this.transition(`request-${resp.reason}`, `request to ${target.nickname ?? target.machineId} failed: ${resp.reason}`);
      this.consecutiveFleetRefusals += 1;
      this.maybeEscalate(`request-${resp.reason}`, `the request to ${target.nickname ?? target.machineId} failed (${resp.reason === 'no-handler' ? `update ${target.nickname ?? target.machineId}` : 'transport error'})`);
      return decision;
    }
    const pem = this.d.ownEncryptionPrivateKeyPem();
    if (!pem) {
      this.transition('no-encryption-key', 'this machine has no X25519 encryption key to open the sealed identity');
      this.maybeEscalate('no-encryption-key', 'this machine has no encryption key to open a sealed identity (re-run `instar join`)');
      return decision;
    }
    const opened = openAdoptionEnvelope({
      response: resp.result,
      responderMachineId: target.machineId,
      selfMachineId: this.d.selfMachineId,
      expectedFingerprint: decision.fingerprint,
      requesterNonce: reqNonce,
      ownEncryptionPrivateKeyPem: pem,
      verifySig: this.d.verifySig,
    });
    if (!opened.ok) {
      this.requestedMachineRotation += 1;
      const reason = opened.rejection === 'refused' ? `refused:${opened.refusal ?? 'unknown'}` : opened.rejection;
      // A rate-limited refusal is pacing, not a fleet refusal (§Watchers brakes): honour the
      // responder's retryAfterMs so a restarted requester (whose in-memory pacing reset)
      // waits the server-side interval instead of re-asking on every boot.
      if (opened.rejection === 'refused' && opened.refusal === 'rate-limited') {
        if (typeof opened.retryAfterMs === 'number' && opened.retryAfterMs > 0) {
          this.lastRequestAt = now - (this.d.requestIntervalMs ?? 10 * 60_000) + opened.retryAfterMs;
        }
      } else this.consecutiveFleetRefusals += 1;
      this.transition(reason, `envelope from ${target.nickname ?? target.machineId} rejected: ${reason}`);
      this.maybeEscalate(reason, `${target.nickname ?? target.machineId} answered ${reason}`);
      return decision;
    }
    const installed = installAdoptedIdentity({
      stateDir: this.d.stateDir,
      identity: opened.identity,
      origin: 'adopted-from-sibling',
      selfMachineId: this.d.selfMachineId,
      adoptedFrom: opened.adoptedFrom,
    });
    if (!installed.ok) {
      this.transition(installed.reason, installed.detail ?? installed.reason);
      this.consecutiveFleetRefusals += 1;
      this.maybeEscalate(installed.reason, installed.detail ?? installed.reason);
      return decision;
    }
    this.installedFingerprint = installed.fingerprint;
    this.consecutiveFleetRefusals = 0;
    this.lastReason = null;
    this.d.audit?.append('adoption-installed', {
      machineId: this.d.selfMachineId,
      fingerprint: installed.fingerprint,
      from: target.machineId,
      mode: decision.mode,
      observed: decision.observed,
      alreadyPresent: installed.alreadyPresent,
    });
    this.d.resolveItem(this.itemId);
    this.escalated = false;
    this.lastEscalatedReason = null;
    this.d.raiseItem({
      id: `agent-identity-adopted:${this.d.agentName}:${this.d.selfMachineId}:${installed.fingerprint}`,
      title: `${this.d.agentName} adopted its agent identity on this machine`,
      priority: 'medium',
      body:
        `This machine had no agent identity and adopted the one its siblings publish (${installed.fingerprint.slice(0, 8)}…) ` +
        `from ${target.nickname ?? target.machineId}, mode ${decision.mode}, after observing ${decision.observed.k} of ${decision.observed.n} active siblings. ` +
        'This proves agreement among the machines I could reach, not correctness. A key copy is an event you should be able to see — nothing to do unless that machine should not have become me.',
    });
    this.d.audit?.append('adoption-resolved', { machineId: this.d.selfMachineId, fingerprint: installed.fingerprint });
    try {
      await this.d.onInstalled(installed.fingerprint);
    } catch (err) {
      this.d.audit?.append('identity-reloaded', { machineId: this.d.selfMachineId, ok: false, error: err instanceof Error ? err.message : String(err) });
    }
    return decision;
  }

  private describeRefusal(decision: Extract<AdoptionDecision, { ok: false }>, noHandler: string[]): string {
    const set = `${decision.observed.k} of ${decision.observed.n} active`;
    const update = noHandler.length ? ` Update ${noHandler.join(', ')} (older version, cannot answer).` : '';
    switch (decision.reason) {
      case 'last-known-mismatch':
        return `${decision.detail}. If THIS machine was the split one, the fix is to adopt from a sibling: say yes and I will run \`instar identity adopt --from <sibling>\` here. Observed ${set}.${update}`;
      case 'single-witness':
        return `Only one sibling is reachable and this machine has no memory of its own address, so I will not copy a key on one voice (single-witness). Wake a second machine, or if you know the one witness is right, say yes and I will run \`instar identity adopt --from <that machine>\` here. Observed ${set}.${update}`;
      case 'disagree':
        return `My reachable machines publish different identities (${Object.entries(decision.values ?? {}).map(([fp, m]) => `${m.join(', ')}: ${fp.slice(0, 8)}…`).join('; ')}); I will not pick one. Observed ${set}.${update}`;
      case 'revoked-only':
        return `${decision.detail}. If this is now a single-machine agent, say yes and I will run \`instar identity init --standalone --i-understand-peers-must-repin\` here. Observed ${set}.`;
      default:
        return `${decision.detail}. I keep retrying every few minutes. Observed ${set}.${update}`;
    }
  }

  private transition(reason: string, detail: string, extra: Record<string, unknown> = {}): void {
    if (reason === this.lastReason) return;
    this.lastReason = reason;
    this.d.audit?.append('adoption-refused', { machineId: this.d.selfMachineId, reason, detail, ...extra });
  }

  private heartbeat(reason: string): void {
    const every = this.d.heartbeatMs ?? 60 * 60_000;
    const now = this.now();
    if (now - this.lastHeartbeatAt < every) return;
    this.lastHeartbeatAt = now;
    this.d.audit?.append('adoption-heartbeat', { machineId: this.d.selfMachineId, reason, rounds: this.rounds, requests: this.requests });
  }

  private maybeEscalate(reason: string, detail: string): void {
    const byRefusals = this.consecutiveFleetRefusals >= (this.d.escalateAfterRefusals ?? 4);
    const byTime = this.now() - this.startedAt >= (this.d.escalateAfterMs ?? 120_000);
    if (!byRefusals && !byTime) return;
    const dayAgo = this.now() - 24 * 60 * 60_000;
    const flapping = this.loseCycleTimes.filter((t) => t >= dayAgo).length >= 3;
    const priority: AdoptionAttentionItem['priority'] = flapping ? 'critical' : 'high';
    // ONE item per machine (deduped by id). It is re-raised — same id, updated body — only
    // when the refusal REASON changes, so the open item always names the current reason.
    if (this.escalated && !flapping && this.lastEscalatedReason === reason) return;
    this.escalated = true;
    this.lastEscalatedReason = reason;
    this.d.audit?.append('adoption-escalated', { machineId: this.d.selfMachineId, reason, priority, consecutiveFleetRefusals: this.consecutiveFleetRefusals });
    this.d.raiseItem({
      id: this.itemId,
      title: `${this.d.agentName} has no agent identity on this machine`,
      priority,
      body:
        `This machine is paired but holds no agent identity, so it stays off the agent network and never serves (identity-not-provisioned). ` +
        `Reason: ${detail}` +
        (flapping ? ' This machine has adopted and lost its identity three times in 24 h — something keeps removing the file.' : '') +
        ' I keep trying to adopt it from a sibling; this clears itself the moment that works.',
    });
  }
}
