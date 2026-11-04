import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { RecommendedServicesLedger, foldChoice, validateRow, recommendedServicesDir, type LedgerRow } from '../../src/recommended/RecommendedServicesLedger.js';
import { importLegacyDeclines, isRetiredLegacyOffer } from '../../src/recommended/legacyDeclines.js';
import { buildRecommendedServiceRecordData, recommendedServiceStoreSchema } from '../../src/recommended/RecommendedServicesReplicatedStore.js';
import type { MachineKeyLookup, MachineSigner } from '../../src/core/AppRecordSignatures.js';

const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
const pem = publicKey.export({ type: 'spki', format: 'pem' }).toString();

function signerFor(machine: string): MachineSigner {
  return {
    machineId: () => machine,
    signerKeyHash: () => 'hash-1',
    sign: (payload: string) => ({
      machineId: machine, signerKeyHash: 'hash-1',
      sig: crypto.sign(null, Buffer.from(payload), privateKey).toString('base64'),
    }) as ReturnType<MachineSigner['sign']>,
  };
}
const lookup: MachineKeyLookup = () => ({ status: 'ok', publicKeyPem: pem }) as ReturnType<MachineKeyLookup>;

describe('recommended services ledger', () => {
  let dir: string;
  let clock: number;
  const make = (machine = 'm_a', keyLookup = lookup) => new RecommendedServicesLedger({
    stateDir: dir, signer: signerFor(machine), keyLookup, now: () => new Date(clock += 1000),
  });

  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rec-services-')); clock = Date.parse('2026-11-04T00:00:00Z'); });
  afterEach(() => SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/recommended-services-ledger.test.ts' }));

  it('starts unset', () => {
    expect(make().effective('tailscale').choice).toBe('unset');
  });

  it('a no holds, with its reason, and a no alone authorizes no shutdown', () => {
    const l = make();
    l.recordNo({ service: 'tailscale', shutdown: 'none', reason: 'cost', origin: 'first-offer' });
    expect(l.effective('tailscale')).toMatchObject({ choice: 'no', reason: 'cost', shutdown: 'none' });
    l.recordNo({ service: 'github-state-backup', shutdown: 'authorized', reason: 'privacy', origin: 'owner-surface' });
    expect(l.effective('github-state-backup').shutdown).toBe('authorized');
  });

  it('a yes replaces only the nos standing when it was confirmed', () => {
    const l = make();
    l.recordNo({ service: 'tailscale', shutdown: 'none', reason: 'none', origin: 'first-offer' });
    const yes = l.recordYes({ service: 'tailscale', origin: 'person-asked', offerTextHash: 'h' });
    expect(l.effective('tailscale').choice).toBe('yes');
    l.recordNo({ service: 'tailscale', shutdown: 'none', reason: 'none', origin: 'cool-off' });
    expect(l.effective('tailscale').choice).toBe('no');
    expect(yes.supersedes).toHaveLength(1);
  });

  it('a delayed yes with a newer clock cannot undo a no it never saw', () => {
    const a = make('m_a');
    const no = a.recordNo({ service: 'tailscale', shutdown: 'none', reason: 'none', origin: 'first-offer' });
    const skewedYes = { ...a.recordYes({ service: 'email', origin: 'first-offer', offerTextHash: 'h' }), service: 'tailscale', at: '2099-01-01T00:00:00.000Z', supersedes: [] } as LedgerRow;
    expect(foldChoice('tailscale', [no, skewedYes]).choice).toBe('no');
  });

  it('every machine folds to the same answer, in any order', () => {
    const a = make('m_a');
    const n = a.recordNo({ service: 'jev', shutdown: 'none', reason: 'none', origin: 'first-offer' });
    const y = a.recordYes({ service: 'jev', origin: 'person-asked', offerTextHash: 'h' });
    const n2 = a.recordNo({ service: 'jev', shutdown: 'none', reason: 'cost', origin: 'change' });
    const orders = [[n, y, n2], [n2, y, n], [y, n2, n]];
    for (const o of orders) expect(foldChoice('jev', o)).toEqual(foldChoice('jev', orders[0]));
  });

  it('survives a restart', () => {
    make().recordNo({ service: 'email', shutdown: 'none', reason: 'not-needed', origin: 'first-offer' });
    expect(make().effective('email')).toMatchObject({ choice: 'no', reason: 'not-needed' });
  });

  it('skips a torn line and keeps the rest', () => {
    make().recordNo({ service: 'email', shutdown: 'none', reason: 'none', origin: 'first-offer' });
    fs.appendFileSync(path.join(recommendedServicesDir(dir), 'ledger.jsonl'), '{"torn":');
    expect(make().effective('email').choice).toBe('no');
  });

  it('accepts a peer row that verifies, once', () => {
    const peerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rec-services-peer-'));
    const peer = new RecommendedServicesLedger({ stateDir: peerDir, signer: signerFor('m_b'), keyLookup: lookup });
    const row = peer.recordNo({ service: 'jev', shutdown: 'none', reason: 'none', origin: 'first-offer' });
    const l = make();
    expect(l.ingestReplicated(row)).toBe('added');
    expect(l.ingestReplicated(row)).toBe('duplicate');
    expect(l.effective('jev').choice).toBe('no');
    SafeFsExecutor.safeRmSync(peerDir, { recursive: true, force: true, operation: 'tests/unit/recommended-services-ledger.test.ts' });
  });

  it('refuses a tampered row and holds one it cannot verify', () => {
    const peerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rec-services-peer-'));
    const peer = new RecommendedServicesLedger({ stateDir: peerDir, signer: signerFor('m_b'), keyLookup: lookup });
    const row = peer.recordNo({ service: 'jev', shutdown: 'none', reason: 'none', origin: 'first-offer' });
    const l = make();
    expect(l.ingestReplicated({ ...row, choice: 'yes' })).toBe('bad-signature');
    expect(l.effective('jev').choice).toBe('unset');
    const unknown = make('m_a', (() => ({ status: 'unknown' })) as unknown as MachineKeyLookup);
    const other = { ...row, eventId: 'a'.repeat(32) };
    expect(unknown.ingestReplicated(other)).toBe('unverifiable');
    SafeFsExecutor.safeRmSync(peerDir, { recursive: true, force: true, operation: 'tests/unit/recommended-services-ledger.test.ts' });
  });

  it('rejects malformed rows, including free-text reasons', () => {
    const l = make();
    const row = l.recordNo({ service: 'jev', shutdown: 'none', reason: 'none', origin: 'first-offer' });
    expect(validateRow({ ...row, reason: 'I just dislike them' })).toBeNull();
    expect(validateRow({ ...row, service: '../etc' })).toBeNull();
    expect(validateRow({ ...row, origin: 'whatever' })).toBeNull();
    expect(validateRow({ ...row, sig: '' })).toBeNull();
    expect(validateRow(null)).toBeNull();
  });

  it('sends each new row to replication, and the store schema accepts it', () => {
    const l = make();
    const sent: LedgerRow[] = [];
    l.setReplicationHook((r) => sent.push(r));
    const row = l.recordNo({ service: 'jev', shutdown: 'none', reason: 'none', origin: 'first-offer' });
    expect(sent).toEqual([row]);
    expect(l.isReplicating()).toBe(false);
    l.setReplicating(true);
    expect(l.isReplicating()).toBe(true);
    const data = buildRecommendedServiceRecordData(row)({ physical: 1, logical: 0, node: 'm_a' }, 'm_a');
    expect(recommendedServiceStoreSchema.validate(data!, { countDroppedField: () => {} } as never)).toEqual({ row });
    expect(recommendedServiceStoreSchema.validate({ row: { nope: true } }, { countDroppedField: () => {} } as never)).toBeNull();
  });

  describe('legacy declines', () => {
    it('imports each old decline once, and only declines', () => {
      const l = make();
      const states: Record<string, string> = { 'cloudflare-tunnel': 'declined', 'git-backup': 'enabled' };
      expect(importLegacyDeclines(l, (id) => states[id] ?? null)).toBe(1);
      expect(importLegacyDeclines(l, (id) => states[id] ?? null)).toBe(0);
      expect(l.effective('cloudflare-domain').legacyDeclined).toBe(true);
      expect(l.effective('github-state-backup').legacyDeclined).toBe(false);
    });

    it('never counts as a no, never authorizes a shutdown, and never beats a yes', () => {
      const l = make();
      importLegacyDeclines(l, () => 'declined');
      expect(l.effective('github-state-backup')).toMatchObject({ choice: 'unset', shutdown: 'none', legacyDeclined: true });
      l.recordYes({ service: 'github-state-backup', origin: 'person-asked', offerTextHash: 'h' });
      expect(l.effective('github-state-backup').choice).toBe('yes');
    });

    it('retires exactly the two mapped offers', () => {
      expect(isRetiredLegacyOffer('git-backup')).toBe(true);
      expect(isRetiredLegacyOffer('cloudflare-tunnel')).toBe(true);
      expect(isRetiredLegacyOffer('dispatches')).toBe(false);
      expect(isRetiredLegacyOffer('constructor')).toBe(false);
    });
  });
});
