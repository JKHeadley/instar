/**
 * Signed records for app-sent messages (docs/specs/mobile-native-conversations.md §4.6).
 *
 * Two kinds of signature meet here:
 *   - the PHONE's P-256 signature over its request (mobile-device-keys §2.3), stored with the
 *     exact bytes it covers (or, when an authority token was removed, only their hash);
 *   - this MACHINE's Ed25519 identity-key signature (the same key and `sign`/`verify` primitive
 *     the mesh uses, MachineIdentity.ts) over a receipt, a redaction attestation, or a
 *     device-key ledger row. Every machine signature records `signerKeyHash`, so a record stays
 *     checkable after the machine's key rotates: verification looks the key up in the
 *     attributable signing-key history (IdentityStore.signingKeyHistory, the store behind
 *     GET /identity-changes). History that cannot be read, or that does not name the key, makes
 *     the verdict `unknown`, never `failed`.
 *
 * `verifyRecordedOrigin` returns exactly one of five verdicts: none / unknown / failed /
 * verified / redacted. It is pure: the ledger view and the machine-key lookup are passed in.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import { MachineIdentityManager, pemToBase64, sign as edSign, verify as edVerify } from './MachineIdentity.js';
import { IdentityStore } from './IdentityStore.js';
import { DEVICE_SIG_VERSION, DEVICE_TIME_WINDOW_MS, isStrictLowSDer, parseDevicePublicKey } from './MobileDeviceKeys.js';
import { isAppConversationKey } from './appConversationText.js';

export type OriginVerdict = 'none' | 'unknown' | 'failed' | 'verified' | 'redacted';

/** A machine signature as stored on a record. */
export interface MachineSignature { machineId: string; signerKeyHash: string; sig: string }

export interface SignedMachinePayload extends MachineSignature {}

/** This machine's identity signer. `sign` reads the identity fresh, so a key rotation is picked up. */
export interface MachineSigner {
  machineId(): string;
  /** The hash of the key `sign` would use right now. */
  signerKeyHash(): string;
  sign(payload: string): SignedMachinePayload;
}

/** Resolve the public key a machine signed with: by machine and key hash, at a signing time. */
export type MachineKeyLookup = (machineId: string, signerKeyHash: string, atMs: number) =>
  | { status: 'ok'; publicKeyPem: string }
  | { status: 'unknown' };

export const sha256Hex = (data: Buffer | string): string => crypto.createHash('sha256').update(data).digest('hex');

/** The key hash of a machine signing key (base64 SPKI or PEM): sha256 over the key bytes, hex. */
export function signerKeyHashOf(publicKey: string): string {
  return sha256Hex(Buffer.from(pemToBase64(publicKey), 'base64'));
}

/** The key hash of a device key (base64url raw P-256 point): sha256 over the key bytes, hex. */
export function deviceKeyHashOf(publicKeyB64url: string): string {
  return sha256Hex(Buffer.from(publicKeyB64url, 'base64url'));
}

function toPem(publicKey: string): string {
  if (publicKey.startsWith('-----BEGIN PUBLIC KEY-----')) return publicKey;
  return `-----BEGIN PUBLIC KEY-----\n${publicKey.match(/.{1,64}/g)?.join('\n') ?? publicKey}\n-----END PUBLIC KEY-----\n`;
}

/** The phone's canonical request string with the body given by its hash (mobile-device-keys §2.3). */
export function canonicalStringFromHash(deviceId: string, host: string, method: string, pathWithQuery: string, timeMs: string, bodySha256: string): string {
  return `${DEVICE_SIG_VERSION}\n${deviceId}\n${host.toLowerCase()}\n${method.toUpperCase()}\n${pathWithQuery}\n${timeMs}\n${bodySha256}`;
}

// ── Machine-signed payloads (domain separated) ─────────────────────────────────────────

export function receiptPayload(canonicalSha256: string, receivedAt: string, machineId: string): string {
  return `instar-app-receipt-v1\n${canonicalSha256}\n${receivedAt}\n${machineId}`;
}

export function redactionPayload(bodySha256: string, storedTextSha256: string, kinds: ReadonlyArray<string>): string {
  return `instar-app-redaction-v1\n${bodySha256}\n${storedTextSha256}\n${[...kinds].sort().join(',')}`;
}

/** A device-key ledger row's signed bytes: every field but the signature, keys sorted. */
export function ledgerRowPayload(row: Readonly<Record<string, unknown>>): string {
  const keys = Object.keys(row).filter((k) => k !== 'sig').sort();
  const obj: Record<string, unknown> = {};
  for (const k of keys) obj[k] = row[k];
  return `instar-device-key-ledger-v1\n${JSON.stringify(obj)}`;
}

/** Verify one machine signature: `ok`, `bad` (the key is known and the signature is wrong), or `unknown`. */
export function verifyMachineSignature(lookup: MachineKeyLookup, sig: MachineSignature, payload: string, atMs: number): 'ok' | 'bad' | 'unknown' {
  let key: ReturnType<MachineKeyLookup>;
  try { key = lookup(sig.machineId, sig.signerKeyHash, atMs); } catch { return 'unknown'; } // @silent-fallback-ok — unreadable history is "couldn't check", never a failure
  if (key.status !== 'ok') return 'unknown';
  try { return edVerify(payload, sig.sig, key.publicKeyPem) ? 'ok' : 'bad'; } catch { return 'bad'; } // @silent-fallback-ok — a malformed signature under a known key is a failed check
}

// ── Production signer and key lookup (this machine's identity) ─────────────────────────

/**
 * This machine's signer, or null when the machine has no identity (every agent gets one at
 * `instar init`; a missing one means no receipts can be signed and verdicts read `unknown`).
 */
export function loadMachineSigner(stateDir: string): MachineSigner | null {
  const mgr = new MachineIdentityManager(stateDir);
  if (!mgr.hasIdentity()) return null;
  return {
    machineId: () => mgr.loadIdentity().machineId,
    signerKeyHash: () => signerKeyHashOf(mgr.loadIdentity().signingPublicKey),
    sign(payload: string): SignedMachinePayload {
      const identity = mgr.loadIdentity();
      return { machineId: identity.machineId, signerKeyHash: signerKeyHashOf(identity.signingPublicKey), sig: edSign(payload, mgr.loadSigningKey()) };
    },
  };
}

/**
 * The key a machine held, from the attributable signing-key history (local identity for this
 * machine, the pinned identity for a peer, plus every retained earlier epoch). A key valid only
 * after, or retired before, the signing time is not used (`unknown`): `validFrom` is the local
 * pinning time, which can postdate an honest old record, so it is never grounds for `failed`.
 */
export function identityKeyLookup(stateDir: string): MachineKeyLookup {
  const cache = new Map<string, { at: number; keys: Array<{ hash: string; pem: string; until: number | null }> }>();
  return (machineId, signerKeyHash, atMs) => {
    const now = Date.now();
    let entry = cache.get(machineId);
    if (!entry || now - entry.at > 30_000) {
      const history = new IdentityStore({ stateDir }).signingKeyHistory(machineId); // throws when unreadable
      entry = {
        at: now,
        keys: history.map((k) => {
          const until = [k.validUntil, k.revokedAt].map((v) => (v === null ? null : Date.parse(v))).filter((v): v is number => v !== null && Number.isFinite(v));
          return { hash: signerKeyHashOf(k.publicKey), pem: toPem(k.publicKey), until: until.length ? Math.min(...until) : null };
        }),
      };
      cache.set(machineId, entry);
    }
    const k = entry.keys.find((x) => x.hash === signerKeyHash);
    if (!k) return { status: 'unknown' };
    if (k.until !== null && Number.isFinite(atMs) && atMs >= k.until) return { status: 'unknown' };
    return { status: 'ok', publicKeyPem: k.pem };
  };
}

// ── The stored origin and its verification ─────────────────────────────────────────────

export interface StoredDeviceOrigin {
  kind: 'device-signed';
  v: 1;
  deviceId: string;
  keyHash: string;
  publicKey: string;
  host: string;
  method: string;
  pathWithQuery: string;
  timeMs: string;
  bodyB64?: string;
  bodySha256: string;
  sig: string;
  redaction?: { kinds: string[] } & Partial<MachineSignature>;
}

export interface VerifiableRecord {
  conversationKey: string;
  text: string;
  origin?: StoredDeviceOrigin;
  receivedAt?: string;
  receipt?: MachineSignature;
}

/** One key's ledger state, merged across rows. */
export interface LedgerKey {
  keyHash: string;
  publicKey: string;
  deviceId: string;
  host: string;
  approvedVia: string;
  activatedAt: string;
  revokedAt: string | null;
}

/** The ledger as a reader sees it, keyed by `ledgerViewKey(keyHash, deviceId)`; null means it could not be read. */
export type LedgerView = ReadonlyMap<string, LedgerKey> | null;

/** One phone key can (rarely) be paired under two device ids; each pairing has its own lifetime. */
export function ledgerViewKey(keyHash: string, deviceId: string): string { return `${keyHash}|${deviceId}`; }

/** The send path that names a conversation: `/mobile/chat/app/<uuid>` or `/mobile/chat/<topicId>`. */
export function sendPathFor(conversationKey: string): string | null {
  if (isAppConversationKey(conversationKey)) return `/mobile/chat/app/${conversationKey}`;
  const tg = /^telegram:(\d+)$/.exec(conversationKey);
  if (tg) return `/mobile/chat/${tg[1]}`;
  return null;
}

/** Build the receipt for an accepted request (signed by this machine). */
export function signReceipt(signer: MachineSigner, origin: Pick<StoredDeviceOrigin, 'deviceId' | 'host' | 'method' | 'pathWithQuery' | 'timeMs' | 'bodySha256'>, receivedAt: string): MachineSignature {
  const canonical = canonicalStringFromHash(origin.deviceId, origin.host, origin.method, origin.pathWithQuery, origin.timeMs, origin.bodySha256);
  const machineId = signer.machineId();
  return signer.sign(receiptPayload(sha256Hex(canonical), receivedAt, machineId));
}

/** Build the redaction attestation (signed by this machine) over what was kept. */
export function signRedaction(signer: MachineSigner, bodySha256: string, storedText: string, kinds: string[]): { kinds: string[] } & MachineSignature {
  return { kinds: [...kinds], ...signer.sign(redactionPayload(bodySha256, sha256Hex(storedText), kinds)) };
}

/**
 * The five-verdict check of §4.6. Device-side checks are decisive (`failed`); a machine
 * signature whose key cannot be found in the history makes the verdict `unknown`.
 */
export function verifyRecordedOrigin(record: VerifiableRecord, ledger: LedgerView, machineKey: MachineKeyLookup): OriginVerdict {
  const o = record.origin;
  if (!o) return 'none';
  if (!ledger) return 'unknown';
  // No row for this pairing (key + device id) on this machine yet — including a key known here only
  // under another device id, which replication lag makes normal — reads `unknown`, never `failed`.
  const entry = ledger.get(ledgerViewKey(o.keyHash, o.deviceId));
  if (!entry) return 'unknown';

  // ── Device-side checks (any failure ⇒ failed) ──
  if (o.publicKey !== entry.publicKey) return 'failed';
  if (o.deviceId !== entry.deviceId || o.host.toLowerCase() !== entry.host.toLowerCase()) return 'failed';
  const key = parseDevicePublicKey(entry.publicKey);
  const sigBytes = typeof o.sig === 'string' && /^[A-Za-z0-9_-]+$/.test(o.sig) ? Buffer.from(o.sig, 'base64url') : null;
  if (!key || !sigBytes || !isStrictLowSDer(sigBytes)) return 'failed';
  const canonical = canonicalStringFromHash(o.deviceId, o.host, o.method, o.pathWithQuery, o.timeMs, o.bodySha256);
  let sigOk = false;
  try { sigOk = crypto.verify('sha256', Buffer.from(canonical), { key, dsaEncoding: 'der' }, sigBytes); } catch { sigOk = false; } // @silent-fallback-ok — an unverifiable signature is a failed check
  if (!sigOk) return 'failed';
  const expectedPath = sendPathFor(record.conversationKey);
  if (!expectedPath || o.method.toUpperCase() !== 'POST' || o.pathWithQuery !== expectedPath) return 'failed';
  const receivedMs = record.receivedAt ? Date.parse(record.receivedAt) : NaN;
  if (!Number.isFinite(receivedMs)) return 'failed';
  const activated = Date.parse(entry.activatedAt);
  const revoked = entry.revokedAt ? Date.parse(entry.revokedAt) : null;
  if (!Number.isFinite(activated) || receivedMs < activated || (revoked !== null && receivedMs >= revoked)) return 'failed';
  if (!/^\d{10,16}$/.test(o.timeMs) || Math.abs(Number(o.timeMs) - receivedMs) > DEVICE_TIME_WINDOW_MS) return 'failed';

  // ── Text check: exact, or redacted with an attestation ──
  let mode: 'exact' | 'redacted';
  if (typeof o.bodyB64 === 'string') {
    const body = Buffer.from(o.bodyB64, 'base64');
    if (sha256Hex(body) !== o.bodySha256) return 'failed';
    let text: unknown;
    try { text = (JSON.parse(body.toString('utf8')) as { text?: unknown }).text; } catch { return 'failed'; } // @silent-fallback-ok — an unparseable signed body is a failed check
    // The send routes trim the signed text before storing it (1-4000 characters after trimming).
    if (typeof text !== 'string' || text.trim() !== record.text) return 'failed';
    mode = 'exact';
  } else if (o.redaction) {
    // A redaction with no machine attestation (a machine with no identity key) cannot be checked.
    if (typeof o.redaction.sig !== 'string' || typeof o.redaction.machineId !== 'string' || typeof o.redaction.signerKeyHash !== 'string') return 'unknown';
    mode = 'redacted';
  } else {
    return 'failed';
  }

  // ── Machine signatures (unknown key ⇒ unknown; a wrong signature under a known key ⇒ failed) ──
  if (!record.receipt) return 'unknown';
  const receipt = verifyMachineSignature(machineKey, record.receipt, receiptPayload(sha256Hex(canonical), record.receivedAt!, record.receipt.machineId), receivedMs);
  if (receipt === 'bad') return 'failed';
  let redaction: 'ok' | 'bad' | 'unknown' = 'ok';
  if (mode === 'redacted') {
    const r = o.redaction!;
    redaction = verifyMachineSignature(machineKey, { machineId: r.machineId!, signerKeyHash: r.signerKeyHash!, sig: r.sig! }, redactionPayload(o.bodySha256, sha256Hex(record.text), r.kinds), receivedMs);
    if (redaction === 'bad') return 'failed';
  }
  if (receipt === 'unknown' || redaction === 'unknown') return 'unknown';
  return mode === 'exact' ? 'verified' : 'redacted';
}

/** Read a JSONL file's lines (missing file ⇒ []). Throws when unreadable for another reason. */
export function readJsonlLines(file: string): string[] {
  let raw: string;
  try { raw = fs.readFileSync(file, 'utf8'); } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  return raw.split('\n').filter((l) => l.trim().length > 0);
}
