/**
 * The device-key ledger (docs/specs/mobile-native-conversations.md §4.6, §4.8): ledger/registry
 * reconciliation after a crash between the two writes, for activation and for revocation (both
 * directions); backfill idempotency; replicated-row signature acceptance and rejection; and the
 * merged view verification reads.
 */
import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MobileDeviceKeyLedger, validateLedgerRow, type LedgerRow } from '../../src/core/MobileDeviceKeyLedger.js';
import { DeviceRegistry } from '../../src/core/MobileDeviceKeys.js';
import { deviceKeyHashOf, signerKeyHashOf, ledgerRowPayload, type MachineKeyLookup, type MachineSigner } from '../../src/core/AppRecordSignatures.js';
import { generateSigningKeyPair, sign as edSign } from '../../src/core/MachineIdentity.js';
import { ledgerRowFromReplicatedData, deviceKeyLedgerRecordStoreSchema, deriveDeviceKeyLedgerRecordKey } from '../../src/core/MobileDeviceKeyLedgerReplicatedStore.js';
import { makeDevice } from '../helpers/mobileDevice.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/unit/mobile-device-key-ledger.test.ts' }); });

function machine(machineId: string) {
  const kp = generateSigningKeyPair();
  const hash = signerKeyHashOf(kp.publicKey);
  const signer: MachineSigner = {
    machineId: () => machineId, signerKeyHash: () => hash,
    sign: (payload) => ({ machineId, signerKeyHash: hash, sig: edSign(payload, kp.privateKey) }),
  };
  return { machineId, signer, hash, kp };
}

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dkl-'));
  dirs.push(dir);
  const a = machine('m_alpha');
  const b = machine('m_beta');
  const known = new Map([[a.machineId, a], [b.machineId, b]]);
  const lookup: MachineKeyLookup = (mid, h) => {
    const m = known.get(mid);
    return m && m.hash === h ? { status: 'ok', publicKeyPem: m.kp.publicKey } : { status: 'unknown' };
  };
  const ledger = new MobileDeviceKeyLedger({ stateDir: dir, signer: a.signer, keyLookup: lookup });
  const registry = new DeviceRegistry(dir);
  const pair = (host = 'echo.example.dev') => {
    const dev = makeDevice();
    const c = registry.createPending({ deviceName: 'iPhone', label: null, publicKey: dev.publicKey, host });
    if (!c.ok) throw new Error('pending');
    return { dev, id: c.device.id, keyHash: deviceKeyHashOf(dev.publicKey) };
  };
  return { dir, a, b, lookup, ledger, registry, pair };
}

describe('MobileDeviceKeyLedger — write order and boot reconciliation', () => {
  it('backfills a pre-existing active device (telegram-dm, its approval time) and is idempotent', () => {
    const s = setup();
    const p = s.pair();
    s.registry.applyConfirm(p.id, { ok: true }); // approved before the ledger existed
    const r1 = s.ledger.reconcile(s.registry);
    expect(r1.backfilledActivations).toBe(1);
    const row = s.ledger.rows().find((x) => x.keyHash === p.keyHash)!;
    expect(row).toMatchObject({ type: 'activation', approvedVia: 'telegram-dm', deviceId: p.id, activatedAt: s.registry.get(p.id)!.approvedAt });
    const before = fs.readFileSync(s.ledger.file, 'utf8');
    expect(s.ledger.reconcile(s.registry)).toEqual({ backfilledActivations: 0, backfilledRevocations: 0, completedRevocations: 0 });
    expect(fs.readFileSync(s.ledger.file, 'utf8')).toBe(before);
    expect(s.ledger.view()!.get(`${p.keyHash}|${p.id}`)).toMatchObject({ activatedAt: row.activatedAt, revokedAt: null });
  });

  it('activation: a crash after the ledger row and before the registry is harmless (the key never became active)', () => {
    const s = setup();
    const p = s.pair();
    const d = s.registry.get(p.id)!;
    s.ledger.recordActivation(d, 'telegram-dm', new Date().toISOString()); // ledger first … crash
    expect(s.ledger.reconcile(s.registry)).toEqual({ backfilledActivations: 0, backfilledRevocations: 0, completedRevocations: 0 });
    expect(s.registry.get(p.id)!.status).toBe('pending');
    // The retry writes no second row and activates the registry.
    expect(s.ledger.recordActivation(d, 'telegram-dm', new Date().toISOString())).toBeNull();
    s.registry.applyConfirm(p.id, { ok: true, approvedVia: 'telegram-dm' });
    expect(s.ledger.rows().filter((r) => r.type === 'activation')).toHaveLength(1);
  });

  it('revocation: a ledger row whose device is still active completes the revocation in the registry', () => {
    const s = setup();
    const p = s.pair();
    s.registry.applyConfirm(p.id, { ok: true });
    s.ledger.reconcile(s.registry);
    const revokedAt = '2026-10-31T12:34:56.000Z';
    s.ledger.recordRevocation(s.registry.get(p.id)!, revokedAt); // ledger first … crash before the registry
    expect(s.registry.get(p.id)!.status).toBe('active');
    expect(s.ledger.reconcile(s.registry).completedRevocations).toBe(1);
    expect(s.registry.get(p.id)).toMatchObject({ status: 'revoked', revokedAt });
    expect(s.ledger.view()!.get(`${p.keyHash}|${p.id}`)!.revokedAt).toBe(revokedAt);
  });

  it('revocation: a registry revocation with no ledger row is backfilled with the registry revokedAt', () => {
    const s = setup();
    const p = s.pair();
    s.registry.applyConfirm(p.id, { ok: true });
    s.ledger.reconcile(s.registry);
    s.registry.revoke(p.id); // the ledger write failed (or predates the ledger)
    const r = s.ledger.reconcile(s.registry);
    expect(r.backfilledRevocations).toBe(1);
    expect(s.ledger.view()!.get(`${p.keyHash}|${p.id}`)!.revokedAt).toBe(s.registry.get(p.id)!.revokedAt);
    expect(s.ledger.reconcile(s.registry).backfilledRevocations).toBe(0);
  });

  it('a device revoked before the ledger existed gets both rows from the backfill', () => {
    const s = setup();
    const p = s.pair();
    s.registry.applyConfirm(p.id, { ok: true });
    s.registry.revoke(p.id);
    expect(s.ledger.reconcile(s.registry)).toMatchObject({ backfilledActivations: 1, backfilledRevocations: 1 });
    expect(s.ledger.view()!.get(`${p.keyHash}|${p.id}`)!.revokedAt).toBe(s.registry.get(p.id)!.revokedAt);
  });

  it('each local row is signed by this machine and names its key', () => {
    const s = setup();
    const p = s.pair();
    s.registry.applyConfirm(p.id, { ok: true });
    s.ledger.reconcile(s.registry);
    const row = s.ledger.rows()[0]!;
    expect(row.machineId).toBe('m_alpha');
    expect(row.signerKeyHash).toBe(s.a.hash);
  });
});

describe('MobileDeviceKeyLedger — replicated rows', () => {
  function peerRow(s: ReturnType<typeof setup>, signer = s.b.signer): LedgerRow {
    const dev = makeDevice();
    const body: Record<string, unknown> = {
      type: 'activation', keyHash: deviceKeyHashOf(dev.publicKey), publicKey: dev.publicKey, deviceId: 'peer-dev-0001', host: 'echo.example.dev',
      approvedVia: 'telegram-dm', activatedAt: '2026-10-31T10:00:00.000Z', machineId: signer.machineId(), signerKeyHash: signer.signerKeyHash(),
    };
    return { ...body, sig: signer.sign(ledgerRowPayload(body)).sig } as unknown as LedgerRow;
  }

  it('accepts a row that verifies under the pinned key of the machine it names; a repeat is a duplicate', () => {
    const s = setup();
    const row = peerRow(s);
    expect(s.ledger.ingestReplicated(row)).toBe('accepted');
    expect(s.ledger.ingestReplicated(row)).toBe('duplicate');
    expect(s.ledger.view()!.get(`${row.keyHash}|peer-dev-0001`)).toMatchObject({ deviceId: 'peer-dev-0001' });
  });

  it('rejects a tampered row, a row claiming another machine, an unknown machine, and a malformed row', () => {
    const s = setup();
    const row = peerRow(s);
    expect(s.ledger.ingestReplicated({ ...row, deviceId: 'someone-else' })).toBe('bad-signature');
    // Signed by beta but claiming to be alpha's row.
    expect(s.ledger.ingestReplicated({ ...row, machineId: 'm_alpha', signerKeyHash: s.a.hash })).toBe('bad-signature');
    const stranger = machine('m_gamma');
    expect(s.ledger.ingestReplicated(peerRow(s, stranger.signer))).toBe('unverifiable');
    expect(s.ledger.ingestReplicated({ ...row, keyHash: 'f'.repeat(64) })).toBe('invalid'); // keyHash ≠ sha256(publicKey)
    expect(s.ledger.ingestReplicated({ type: 'grant', keyHash: row.keyHash })).toBe('invalid');
    expect(s.ledger.rows()).toHaveLength(0);
  });

  it('the replicated-store schema round-trips a row and drops unknown fields', () => {
    const s = setup();
    const row = peerRow(s);
    const wire = deviceKeyLedgerRecordStoreSchema.validate({ ...row, extra: 'x' }, {} as never);
    expect(wire).toEqual(row);
    expect(ledgerRowFromReplicatedData(wire!)).toEqual(row);
    expect(validateLedgerRow({ ...row, activatedAt: 'not a date' })).toBeNull();
  });

  it('an unreadable ledger reads as null (verdict unknown), never as empty', () => {
    const s = setup();
    fs.mkdirSync(s.ledger.file); // a directory where the file should be
    expect(s.ledger.view()).toBeNull();
  });

  it('one key paired under two device ids keeps separate lifetimes, and the old pairing never revokes the new one', () => {
    const s = setup();
    const dev = makeDevice();
    const oldId = 'old-device-0001';
    // The old pairing (e.g. on another machine, or pruned here): activated and revoked in the ledger.
    s.ledger.recordActivation({ id: oldId, publicKey: dev.publicKey, host: 'echo.example.dev' }, 'telegram-dm', '2026-10-01T00:00:00.000Z');
    s.ledger.recordRevocation({ id: oldId, publicKey: dev.publicKey }, '2026-10-02T00:00:00.000Z');
    // The same key paired again here under a new device id.
    const c = s.registry.createPending({ deviceName: 'iPhone', label: null, publicKey: dev.publicKey, host: 'echo.example.dev' });
    if (!c.ok) throw new Error('pending');
    s.registry.applyConfirm(c.device.id, { ok: true });
    const r = s.ledger.reconcile(s.registry);
    expect(r).toMatchObject({ backfilledActivations: 1, completedRevocations: 0 });
    expect(s.registry.get(c.device.id)!.status).toBe('active');
    const keyHash = deviceKeyHashOf(dev.publicKey);
    const view = s.ledger.view()!;
    expect(view.get(`${keyHash}|${oldId}`)!.revokedAt).toBe('2026-10-02T00:00:00.000Z');
    expect(view.get(`${keyHash}|${c.device.id}`)!.revokedAt).toBeNull();
  });

  it('replication keeps both pairings of one key: separate record keys, both land on a peer', () => {
    const s = setup();
    const dev = makeDevice();
    s.ledger.recordActivation({ id: 'pairing-a-0001', publicKey: dev.publicKey, host: 'echo.example.dev' }, 'telegram-dm', '2026-10-01T00:00:00.000Z');
    s.ledger.recordRevocation({ id: 'pairing-a-0001', publicKey: dev.publicKey }, '2026-10-02T00:00:00.000Z');
    s.ledger.recordActivation({ id: 'pairing-b-0001', publicKey: dev.publicKey, host: 'echo.example.dev' }, 'telegram-dm', '2026-10-03T00:00:00.000Z');
    const rows = s.ledger.rows();
    expect(rows).toHaveLength(3);
    expect(new Set(rows.map((r) => deriveDeviceKeyLedgerRecordKey(r))).size).toBe(3);
    // A peer (beta) whose lookup knows alpha's key ingests all three.
    const peerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dkl-peer-'));
    dirs.push(peerDir);
    const peer = new MobileDeviceKeyLedger({ stateDir: peerDir, signer: s.b.signer, keyLookup: s.lookup });
    expect(rows.map((r) => peer.ingestReplicated(r))).toEqual(['accepted', 'accepted', 'accepted']);
    const keyHash = deviceKeyHashOf(dev.publicKey);
    const view = peer.view()!;
    expect(view.get(`${keyHash}|pairing-a-0001`)!.revokedAt).toBe('2026-10-02T00:00:00.000Z');
    expect(view.get(`${keyHash}|pairing-b-0001`)).toMatchObject({ activatedAt: '2026-10-03T00:00:00.000Z', revokedAt: null });
  });
});

