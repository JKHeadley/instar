/**
 * Every reader of a device key, decided (docs/specs/dashboard-conversations-browser-device.md §4.1),
 * and the browser marker in the device-key ledger (§4.3).
 *
 * The ratchet: a browser record keeps its key in `browserPublicKey`, never `publicKey`, so a new
 * direct `.publicKey` read of a device record would silently treat a browser as "no key". Every
 * such read must go through `deviceKeyOf`, or be one of the deliberate sites listed here.
 */
import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MobileDeviceKeyLedger, validateLedgerRow } from '../../src/core/MobileDeviceKeyLedger.js';
import { ledgerRowFromReplicatedData } from '../../src/core/MobileDeviceKeyLedgerReplicatedStore.js';
import { deviceKeyOf, keyHashOf, type DeviceRecord } from '../../src/core/MobileDeviceKeys.js';
import { signerKeyHashOf, type MachineKeyLookup, type MachineSigner } from '../../src/core/AppRecordSignatures.js';
import { generateSigningKeyPair, sign as edSign } from '../../src/core/MachineIdentity.js';
import { makeDevice } from '../helpers/mobileDevice.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const ROOT = path.resolve(__dirname, '../..');

/** Deliberate direct reads: `file` + a substring of the line. Anything else fails the ratchet. */
const ALLOWED: ReadonlyArray<[string, string]> = [
  // deviceKeyOf itself, and the duplicate-key helper reading all three key fields.
  ['src/core/MobileDeviceKeys.ts', "d.client === 'browser' ? d.browserPublicKey : d.publicKey"],
  ['src/core/MobileDeviceKeys.ts', '[d.publicKey, d.browserPublicKey, d.presenceKey]'],
  // verifyDeviceRequest reads its lookup's result (already deviceKeyOf), not a record.
  ['src/core/MobileDeviceKeys.ts', 'parseDevicePublicKey(dev.publicKey)'],
  // Fails closed on purpose for a browser: owner-phone checks (§4.1 table).
  ['src/server/mobileConsoleTicket.ts', "!d.publicKey || d.client === 'browser'"],
  ['src/server/mobileConsoleTicket.ts', 'deviceKeyHashOf(d.publicKey), d.id'],
  ['src/server/mobileConsoleTicket.ts', 'samePublicKey(key, d.publicKey)'],
  // Team routes: fail closed on purpose (§4.1 table).
  ['src/server/teamRoutes.ts', '!dev?.publicKey'],
  ['src/server/teamRoutes.ts', 'deviceKeyHashOf(dev.publicKey)'],
  // A phone redeemed a link (browsers redeem none), and the phone branch of waitingPhones.
  ['src/server/mobilePairingRoutes.ts', "publicKey: device.publicKey ?? ''"],
  ['src/server/mobilePairingRoutes.ts', ': !!d.publicKey));'],
];

function sourceFiles(): string[] {
  const out: string[] = [];
  for (const dir of ['src/server', 'src/core']) {
    for (const f of fs.readdirSync(path.join(ROOT, dir))) {
      if (!f.endsWith('.ts')) continue;
      if (dir === 'src/server' && !/^(mobile|team|routes|AgentServer)/.test(f)) continue;
      if (dir === 'src/core' && !/^(MobileDevice|AppConversation|AppRecord|appConversation|appInbound)/.test(f)) continue;
      out.push(`${dir}/${f}`);
    }
  }
  return out;
}

describe('the device-key reader ratchet (§4.1)', () => {
  it('no direct .publicKey read of a device record outside deviceKeyOf and the deliberate sites', () => {
    const offenders: string[] = [];
    const re = /\b(d|dev|device|existing|rec|requester|approver|current|other|record|row\.device)\??\.publicKey\b/;
    for (const file of sourceFiles()) {
      const lines = fs.readFileSync(path.join(ROOT, file), 'utf-8').split('\n');
      lines.forEach((line, i) => {
        if (!re.test(line)) return;
        if (ALLOWED.some(([f, snippet]) => f === file && line.includes(snippet))) return;
        offenders.push(`${file}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(offenders).toEqual([]);
  });

  it('deviceKeyOf: a phone reads publicKey, a browser reads browserPublicKey and never publicKey', () => {
    expect(deviceKeyOf({ publicKey: 'P' } as DeviceRecord)).toBe('P');
    expect(deviceKeyOf({ client: 'browser', browserPublicKey: 'B' } as DeviceRecord)).toBe('B');
    expect(deviceKeyOf({ client: 'browser', publicKey: 'P' } as DeviceRecord)).toBeUndefined();
  });
});

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/unit/browser-device-readers.test.ts' }); });
function ledger() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-ledger-'));
  dirs.push(dir);
  const kp = generateSigningKeyPair();
  const hash = signerKeyHashOf(kp.publicKey);
  const signer: MachineSigner = { machineId: () => 'm_a', signerKeyHash: () => hash, sign: (p) => ({ machineId: 'm_a', signerKeyHash: hash, sig: edSign(p, kp.privateKey) }) };
  const keyLookup: MachineKeyLookup = (m, h) => (m === 'm_a' && h === hash ? { status: 'ok', publicKeyPem: kp.publicKey } : { status: 'unknown' });
  return { dir, signer, keyLookup, ledger: new MobileDeviceKeyLedger({ stateDir: dir, signer, keyLookup }) };
}

describe('the browser marker in the device-key ledger (§4.3)', () => {
  const browser = (dev = makeDevice()) => ({ id: 'browser-device-0001', client: 'browser' as const, browserPublicKey: dev.publicKey, host: 'echo.example.dev' });

  it('a row whose client is anything but browser is invalid; a browser row is kept with it', () => {
    const a = ledger();
    const row = a.ledger.recordActivation(browser(), 'telegram-dm', new Date().toISOString())! as unknown as Record<string, unknown>;
    expect(validateLedgerRow(row)).toMatchObject({ client: 'browser' });
    expect(validateLedgerRow({ ...row, client: 'phone' })).toBeNull();
  });

  it('the replicated store keeps client, so a row passes between two machines on this version', () => {
    const a = ledger();
    const b = ledger();
    const row = a.ledger.recordActivation(browser(), 'telegram-dm', new Date().toISOString())! as unknown as Record<string, unknown>;
    const viaStore = ledgerRowFromReplicatedData(row);
    expect(viaStore).toMatchObject({ client: 'browser' });
    // B knows A's key (one pool).
    const bLedger = new MobileDeviceKeyLedger({ stateDir: b.dir, signer: b.signer, keyLookup: a.keyLookup });
    expect(bLedger.ingestReplicated(viaStore)).toBe('accepted');
    expect(bLedger.view()!.get(`${row.keyHash}|${row.deviceId}`)?.client).toBe('browser');
  });

  it('an older machine (which drops the unknown field) rejects the row as bad-signature; after upgrading it accepts the stored raw row', () => {
    const a = ledger();
    const old = new MobileDeviceKeyLedger({ stateDir: ledger().dir, signer: a.signer, keyLookup: a.keyLookup });
    const row = a.ledger.recordActivation(browser(), 'telegram-dm', new Date().toISOString())! as unknown as Record<string, unknown>;
    const { client: _dropped, ...asOldReadsIt } = row;
    expect(old.ingestReplicated(asOldReadsIt)).toBe('bad-signature');
    // The older machine's journal kept the raw entry; the upgraded boot read hands it over again.
    expect(old.ingestReplicated(ledgerRowFromReplicatedData(row))).toBe('accepted');
  });

  it('reconciliation backfills a browser activation row with client', () => {
    const a = ledger();
    const dev = makeDevice();
    const regDevices = [{ ...browser(dev), status: 'active', deviceName: 'B', label: null, pairedAt: new Date().toISOString(), approvedAt: new Date().toISOString(), approvedVia: 'telegram-dm' }];
    const registry = { list: () => regDevices, revoke: () => true } as never;
    expect(a.ledger.reconcile(registry).backfilledActivations).toBe(1);
    expect(a.ledger.view()!.get(`${keyHashOf(dev.publicKey)}|browser-device-0001`)?.client).toBe('browser');
  });
});
