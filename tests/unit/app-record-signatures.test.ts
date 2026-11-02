/**
 * Signed records (docs/specs/mobile-native-conversations.md §4.6, increment 2):
 * verifyRecordedOrigin's five verdicts with each check on both sides, the text check's two
 * alternatives, key lifetime judged by the machine's receivedAt (phone clock 50 s slow), a
 * receipt reused on a different path, and the real signing-key history: an old receipt still
 * verified after the machine's key rotates, and `unknown` when that history is unreadable.
 */
import { describe, it, expect, afterAll } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  verifyRecordedOrigin, signReceipt, signRedaction, signerKeyHashOf, deviceKeyHashOf, identityKeyLookup, loadMachineSigner,
  type LedgerKey, type MachineKeyLookup, type MachineSigner, type StoredDeviceOrigin, type VerifiableRecord,
} from '../../src/core/AppRecordSignatures.js';
import { canonicalString } from '../../src/core/MobileDeviceKeys.js';
import { generateSigningKeyPair, pemToBase64, sign as edSign, MachineIdentityManager } from '../../src/core/MachineIdentity.js';
import { makeDevice } from '../helpers/mobileDevice.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/unit/app-record-signatures.test.ts' }); });

const HOST = 'echo.example.dev';
const KEY = '2f0c8a3e-1b2c-4d5e-8f90-123456789abc';
const OTHER = '9e8d7c6b-5a49-4382-a716-0f1e2d3c4b5a';
const DEVICE_ID = 'dev-0001-aaaa';

function fakeMachine(machineId = 'm_alpha') {
  const kp = generateSigningKeyPair();
  const hash = signerKeyHashOf(kp.publicKey);
  const signer: MachineSigner = {
    machineId: () => machineId,
    signerKeyHash: () => hash,
    sign: (payload) => ({ machineId, signerKeyHash: hash, sig: edSign(payload, kp.privateKey) }),
  };
  const lookup: MachineKeyLookup = (mid, h) => (mid === machineId && h === hash ? { status: 'ok', publicKeyPem: kp.publicKey } : { status: 'unknown' });
  return { signer, lookup, kp };
}

const T0 = Date.parse('2026-10-31T12:00:00.000Z');

function build(opts: {
  dev?: ReturnType<typeof makeDevice>; machine?: ReturnType<typeof fakeMachine>; text?: string; key?: string; receivedMs?: number;
  phoneMs?: number; redact?: string[]; storedText?: string;
} = {}) {
  const dev = opts.dev ?? makeDevice();
  const machine = opts.machine ?? fakeMachine();
  const key = opts.key ?? KEY;
  const text = opts.text ?? 'What is on for Saturday?';
  const raw = Buffer.from(JSON.stringify({ text, requestId: `${T0}-abc` }));
  const p = `/mobile/chat/app/${key}`;
  const receivedMs = opts.receivedMs ?? T0 + 5_000;
  const time = String(opts.phoneMs ?? receivedMs);
  const sig = dev.sign(canonicalString(DEVICE_ID, HOST, 'POST', p, time, raw));
  const bodySha256 = crypto.createHash('sha256').update(raw).digest('hex');
  const receivedAt = new Date(receivedMs).toISOString();
  const storedText = opts.storedText ?? text;
  const base = { kind: 'device-signed' as const, v: 1 as const, deviceId: DEVICE_ID, keyHash: deviceKeyHashOf(dev.publicKey), publicKey: dev.publicKey, host: HOST, method: 'POST', pathWithQuery: p, timeMs: time, bodySha256, sig };
  const origin: StoredDeviceOrigin = opts.redact
    ? { ...base, redaction: signRedaction(machine.signer, bodySha256, storedText, opts.redact) }
    : { ...base, bodyB64: raw.toString('base64') };
  const record: VerifiableRecord = { conversationKey: key, text: storedText, origin, receivedAt, receipt: signReceipt(machine.signer, base, receivedAt) };
  const entry: LedgerKey = { keyHash: base.keyHash, publicKey: dev.publicKey, deviceId: DEVICE_ID, host: HOST, approvedVia: 'telegram-dm', activatedAt: new Date(T0).toISOString(), revokedAt: null };
  const ledger = new Map([[`${base.keyHash}|${DEVICE_ID}`, entry]]);
  return { record, ledger, entry, machine, dev, raw };
}

describe('verifyRecordedOrigin — the five verdicts', () => {
  it('verified when every check passes; none without an origin', () => {
    const b = build();
    expect(verifyRecordedOrigin(b.record, b.ledger, b.machine.lookup)).toBe('verified');
    expect(verifyRecordedOrigin({ conversationKey: KEY, text: 'typed in Telegram' }, b.ledger, b.machine.lookup)).toBe('none');
  });

  it('unknown when the ledger cannot be read, has no row for the key, or the receipt key is not in the history', () => {
    const b = build();
    expect(verifyRecordedOrigin(b.record, null, b.machine.lookup)).toBe('unknown');
    expect(verifyRecordedOrigin(b.record, new Map(), b.machine.lookup)).toBe('unknown');
    expect(verifyRecordedOrigin(b.record, b.ledger, () => ({ status: 'unknown' }))).toBe('unknown');
    expect(verifyRecordedOrigin(b.record, b.ledger, () => { throw new Error('history unreadable'); })).toBe('unknown');
    const { receipt: _r, ...noReceipt } = b.record;
    expect(verifyRecordedOrigin(noReceipt, b.ledger, b.machine.lookup)).toBe('unknown');
  });

  it('failed for each device-side check that fails', () => {
    const b = build();
    const v = (rec: VerifiableRecord, ledger = b.ledger) => verifyRecordedOrigin(rec, ledger, b.machine.lookup);
    const o = b.record.origin!;
    expect(v({ ...b.record, origin: { ...o, publicKey: makeDevice().publicKey } })).toBe('failed');           // publicKey differs from the ledger
    // A device id this machine has no row for (under a key it knows) is "not known here yet" — unknown, never verified.
    expect(v({ ...b.record, origin: { ...o, deviceId: 'dev-9999-zzzz' } })).toBe('unknown');
    expect(v(b.record, new Map([[`${o.keyHash}|${DEVICE_ID}`, { ...b.entry, deviceId: 'dev-9999-zzzz' }]]))).toBe('failed'); // the pairing's row disagrees on deviceId
    expect(v({ ...b.record, origin: { ...o, host: 'evil.example.dev' } })).toBe('failed');                     // host differs
    expect(v({ ...b.record, origin: { ...o, sig: b.dev.sign('something else') } })).toBe('failed');            // signature does not verify
    const highS = b.dev.sign(canonicalString(DEVICE_ID, HOST, 'POST', o.pathWithQuery, o.timeMs, b.raw), true);
    expect(v({ ...b.record, origin: { ...o, sig: highS } })).toBe('failed');                                   // strict DER low-S
    expect(v({ ...b.record, text: 'What is on for Sunday?' })).toBe('failed');                                // stored text tampered
    expect(v({ ...b.record, origin: { ...o, bodyB64: Buffer.from('{"text":"x"}').toString('base64') } })).toBe('failed'); // body ≠ its hash
    expect(v({ ...b.record, conversationKey: OTHER })).toBe('failed');                                         // path names another conversation
    expect(v({ ...b.record, receivedAt: new Date(T0 - 1_000).toISOString() })).toBe('failed');                 // before activation (and receipt mismatch)
    expect(v(b.record, new Map([[`${o.keyHash}|${DEVICE_ID}`, { ...b.entry, revokedAt: new Date(T0 + 1_000).toISOString() }]]))).toBe('failed'); // after revocation
    expect(v(b.record, new Map([[`${o.keyHash}|${DEVICE_ID}`, { ...b.entry, revokedAt: new Date(T0 + 5_000).toISOString() }]]))).toBe('failed'); // [activatedAt, revokedAt): at revokedAt is out
    const { bodyB64: _b, ...noBody } = o;
    expect(v({ ...b.record, origin: noBody })).toBe('failed');                                                 // neither text alternative
  });

  it('failed when the receipt signature does not verify under the known key', () => {
    const b = build();
    expect(verifyRecordedOrigin({ ...b.record, receipt: { ...b.record.receipt!, sig: Buffer.alloc(64).toString('base64') } }, b.ledger, b.machine.lookup)).toBe('failed');
  });

  it('failed when |timeMs − receivedAt| exceeds 60 s; verified just inside it', () => {
    const late = build({ receivedMs: T0 + 100_000, phoneMs: T0 + 100_000 - 61_000 });
    expect(verifyRecordedOrigin(late.record, late.ledger, late.machine.lookup)).toBe('failed');
    const ok = build({ receivedMs: T0 + 100_000, phoneMs: T0 + 100_000 - 59_000 });
    expect(verifyRecordedOrigin(ok.record, ok.ledger, ok.machine.lookup)).toBe('verified');
  });

  it('judges key lifetime by receivedAt: a phone clock 50 s slow is not marked failed', () => {
    // Accepted 10 s after activation by a phone whose clock reads 40 s BEFORE activation.
    const early = build({ receivedMs: T0 + 10_000, phoneMs: T0 + 10_000 - 50_000 });
    expect(verifyRecordedOrigin(early.record, early.ledger, early.machine.lookup)).toBe('verified');
    // Accepted 5 s after revocation with a phone clock that still reads before it: failed.
    const revokedAt = new Date(T0 + 100_000).toISOString();
    const after = build({ receivedMs: T0 + 105_000, phoneMs: T0 + 105_000 - 50_000 });
    expect(verifyRecordedOrigin(after.record, new Map([[`${after.entry.keyHash}|${DEVICE_ID}`, { ...after.entry, revokedAt }]]), after.machine.lookup)).toBe('failed');
    // Accepted 5 s before revocation, phone 50 s slow: verified.
    const before = build({ receivedMs: T0 + 95_000, phoneMs: T0 + 95_000 - 50_000 });
    expect(verifyRecordedOrigin(before.record, new Map([[`${before.entry.keyHash}|${DEVICE_ID}`, { ...before.entry, revokedAt }]]), before.machine.lookup)).toBe('verified');
  });

  it('fails a receipt reused on a different path', () => {
    const dev = makeDevice();
    const machine = fakeMachine();
    const a = build({ dev, machine, key: KEY });
    const b = build({ dev, machine, key: OTHER });
    // The phone genuinely signed B, but the record carries A's receipt.
    expect(verifyRecordedOrigin({ ...b.record, receipt: a.record.receipt }, b.ledger, machine.lookup)).toBe('failed');
    expect(verifyRecordedOrigin(b.record, b.ledger, machine.lookup)).toBe('verified');
  });

  it('the text check: exact, or redacted with a valid attestation; an invalid attestation fails', () => {
    const r = build({ text: 'pair with tlinv1:abc.def please', storedText: 'pair with [pairing invite removed] please', redact: ['pairing-invite'] });
    expect(r.record.origin!.bodyB64).toBeUndefined();
    expect(verifyRecordedOrigin(r.record, r.ledger, r.machine.lookup)).toBe('redacted');
    // Attestation over different stored text.
    expect(verifyRecordedOrigin({ ...r.record, text: 'pair with something else' }, r.ledger, r.machine.lookup)).toBe('failed');
    // Attestation with the wrong kinds.
    const o = r.record.origin!;
    expect(verifyRecordedOrigin({ ...r.record, origin: { ...o, redaction: { ...o.redaction!, kinds: ['desktop-code'] } } }, r.ledger, r.machine.lookup)).toBe('failed');
    // A redaction no machine signed reads unknown, never verified.
    expect(verifyRecordedOrigin({ ...r.record, origin: { ...o, redaction: { kinds: ['pairing-invite'], machineId: 'unsigned' } } }, r.ledger, r.machine.lookup)).toBe('unknown');
  });
});

describe('the attributable signing-key history (IdentityStore)', () => {
  async function machineDir() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'app-sig-'));
    dirs.push(dir);
    const mgr = new MachineIdentityManager(dir);
    await mgr.generateIdentity({ name: 'test machine' });
    return { dir, mgr };
  }

  it('an old receipt stays verified after the signing machine rotates its key', async () => {
    const { dir, mgr } = await machineDir();
    const signer = loadMachineSigner(dir)!;
    const lookup = identityKeyLookup(dir);
    const nowMs = Date.now();
    const b = build({ machine: { signer, lookup, kp: null as never }, receivedMs: nowMs - 60_000, phoneMs: nowMs - 60_000 });
    b.ledger.get(`${b.entry.keyHash}|${DEVICE_ID}`)!.activatedAt = new Date(nowMs - 3_600_000).toISOString();
    expect(verifyRecordedOrigin(b.record, b.ledger, lookup)).toBe('verified');
    const before = signer.signerKeyHash();
    mgr.rotateLocalKeys('test rotation');
    expect(signer.signerKeyHash()).not.toBe(before);
    expect(signerKeyHashOf(mgr.loadIdentity().signingPublicKey)).toBe(signer.signerKeyHash());
    // A fresh lookup (no cache) still finds the retired key for a receipt signed before rotation.
    expect(verifyRecordedOrigin(b.record, b.ledger, identityKeyLookup(dir))).toBe('verified');
  });

  it('unknown, never failed, when the history cannot be read', async () => {
    const { dir } = await machineDir();
    const signer = loadMachineSigner(dir)!;
    const nowMs = Date.now();
    const b = build({ machine: { signer, lookup: identityKeyLookup(dir), kp: null as never }, receivedMs: nowMs, phoneMs: nowMs });
    b.ledger.get(`${b.entry.keyHash}|${DEVICE_ID}`)!.activatedAt = new Date(nowMs - 3_600_000).toISOString();
    fs.mkdirSync(path.join(dir, 'state'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'state', 'identity-epochs.json'), '{not json');
    expect(verifyRecordedOrigin(b.record, b.ledger, identityKeyLookup(dir))).toBe('unknown');
  });

  it('a machine with no identity has no signer', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'app-sig-none-'));
    dirs.push(dir);
    expect(loadMachineSigner(dir)).toBeNull();
  });

  it('signerKeyHashOf agrees for PEM and base64 forms of the same key', () => {
    const kp = generateSigningKeyPair();
    expect(signerKeyHashOf(kp.publicKey)).toBe(signerKeyHashOf(pemToBase64(kp.publicKey)));
  });
});
