/**
 * The first list of recommended services (docs/specs/recommended-services.md, Offers): offer rows in the
 * signed ledger, which rows a list holds, the words and buttons, and the durable single-use taps.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import type { MachineKeyLookup, MachineSigner } from '../../src/core/AppRecordSignatures.js';
import { OFFER_LIST_EVERY_MS, OFFER_PENDING_TTL_MS, RecommendedServicesLedger, foldChoice, validateRow } from '../../src/recommended/RecommendedServicesLedger.js';
import { RECOMMENDED_SERVICE_CATALOG, isServiceAvailable } from '../../src/recommended/catalog.js';
import { OFFER_TAP_RE, OFFER_TAP_TTL_MS, offerCandidates, renderOfferList } from '../../src/recommended/offerList.js';
import { OFFER_NO_TAPS_PER_HOUR, OfferTapStore } from '../../src/recommended/offerTaps.js';

const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
const pem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
const signerFor = (machine: string): MachineSigner => ({
  machineId: () => machine, signerKeyHash: () => 'h',
  sign: (p: string) => ({ machineId: machine, signerKeyHash: 'h', sig: crypto.sign(null, Buffer.from(p), privateKey).toString('base64') }) as ReturnType<MachineSigner['sign']>,
});
const lookup: MachineKeyLookup = () => ({ status: 'ok', publicKeyPem: pem }) as ReturnType<MachineKeyLookup>;

describe('offer rows in the ledger', () => {
  let dir: string;
  let clock: number;
  const make = (machine = 'm_a') => new RecommendedServicesLedger({ stateDir: dir, signer: signerFor(machine), keyLookup: lookup, now: () => new Date(clock) });
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rec-offers-')); clock = Date.parse('2026-11-07T00:00:00Z'); });
  afterEach(() => SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/recommended-services-offers.test.ts' }));

  it('a service is none, then pending, then offered, and never offered twice', () => {
    const l = make();
    expect(l.offerState('tailscale', '42')).toBe('none');
    l.recordOfferPending({ service: 'tailscale', owner: '42', listId: 'a'.repeat(32) });
    expect(l.offerState('tailscale', '42')).toBe('pending');
    expect(l.pendingOffers('42').map((r) => r.service)).toEqual(['tailscale']);
    expect(l.offerState('tailscale', '7')).toBe('none');
    l.recordOfferDelivered({ service: 'tailscale', owner: '42', listId: 'a'.repeat(32), messageId: 101 });
    expect(l.offerState('tailscale', '42')).toBe('offered');
    expect(l.pendingOffers('42')).toEqual([]);
    expect(l.lastListAt('42')).toBe(clock);
    // Another machine reading the same rows reaches the same answer.
    expect(make('m_b').offerState('tailscale', '42')).toBe('offered');
  });

  it('a pending offer is released after a week, so a list that never went out is not a list', () => {
    const l = make();
    l.recordOfferPending({ service: 'jev', owner: '42', listId: 'b'.repeat(32) });
    expect(l.offerState('jev', '42', clock + OFFER_PENDING_TTL_MS - 1)).toBe('pending');
    expect(l.offerState('jev', '42', clock + OFFER_PENDING_TTL_MS)).toBe('none');
    expect(l.pendingOffers('42', clock + OFFER_PENDING_TTL_MS)).toEqual([]);
    expect(OFFER_LIST_EVERY_MS).toBe(7 * 24 * 60 * 60_000);
  });

  it('offer rows never touch the choice fold, and validation is exact', () => {
    const l = make();
    l.recordOfferDelivered({ service: 'jev', owner: '42', listId: 'c'.repeat(32), messageId: 5 });
    expect(foldChoice('jev', l.all()).choice).toBe('unset');
    const row = l.offerRows()[0]!;
    expect(validateRow(row)).toMatchObject({ type: 'offer', state: 'offered', messageId: '5', origin: 'first-offer' });
    expect(validateRow({ ...row, state: 'offered', messageId: undefined })).toBeNull();
    expect(validateRow({ ...row, origin: 'change' })).toBeNull();
    expect(validateRow({ ...row, listId: 'short' })).toBeNull();
    expect(validateRow({ ...row, owner: '' })).toBeNull();
    // A peer's row lands through the same door as a choice.
    const peer = make('m_b');
    expect(peer.ingestReplicated(JSON.parse(JSON.stringify(row)))).toBe('duplicate');
    SafeFsExecutor.safeRmSync(path.join(dir, 'state'), { recursive: true, force: true, operation: 'tests/unit/recommended-services-offers.test.ts' });
    const fresh = make('m_c');
    expect(fresh.ingestReplicated(JSON.parse(JSON.stringify(row)))).toBe('added');
    expect(fresh.offerState('jev', '42')).toBe('offered');
  });
});

describe('which rows a list holds', () => {
  const rows = RECOMMENDED_SERVICE_CATALOG;
  const unset = (service: string) => ({ service, choice: 'unset' as const, origin: null, shutdown: 'none' as const, reason: null, legacyDeclined: false, at: null });

  it('available, undecided, never offered, not in use, no legacy decline', () => {
    const picked = offerCandidates(rows, (row) => ({ choice: unset(row.id), offer: 'none', inUse: false }));
    expect(picked.map((r) => r.id)).toEqual(rows.filter(isServiceAvailable).map((r) => r.id));
    expect(picked.length).toBeGreaterThan(0);
    expect(offerCandidates(rows, (row) => ({ choice: { ...unset(row.id), choice: 'no' }, offer: 'none', inUse: false }))).toEqual([]);
    expect(offerCandidates(rows, (row) => ({ choice: { ...unset(row.id), legacyDeclined: true }, offer: 'none', inUse: false }))).toEqual([]);
    expect(offerCandidates(rows, (row) => ({ choice: unset(row.id), offer: 'offered', inUse: false }))).toEqual([]);
    expect(offerCandidates(rows, (row) => ({ choice: unset(row.id), offer: 'pending', inUse: false }))).toEqual([]);
    expect(offerCandidates(rows, (row) => ({ choice: unset(row.id), offer: 'none', inUse: true }))).toEqual([]);
  });

  it('the words carry benefit, what leaves, cost, account, the backup, and the confirm link; a no button per row', () => {
    const picked = rows.filter(isServiceAvailable);
    const out = renderOfferList(picked, { listId: 'd'.repeat(32), linkBase: 'http://192.168.1.2:4042', hasAddress: true, now: 1 });
    for (const row of picked) {
      expect(out.text).toContain(row.name);
      expect(out.text).toContain(row.benefit);
      expect(out.text).toContain(row.dataLeaves);
      expect(out.text).toContain(row.cost);
      expect(out.text).toContain(`http://192.168.1.2:4042/dashboard/service-yes?service=${row.id}`);
    }
    expect(out.text).toContain('Nothing happens until you say yes');
    expect(out.text).toContain('Not answering is fine too');
    expect(out.buttons.map((b) => b.text)).toEqual(picked.map((r) => `No to ${r.name}`));
    expect(out.buttons.every((b) => OFFER_TAP_RE.test(b.data) && b.data.startsWith('rs:n:'))).toBe(true);
    expect(out.taps.every((t) => t.action === 'no' && t.listId === 'd'.repeat(32) && t.expiresAt === 1 + OFFER_TAP_TTL_MS)).toBe(true);
    // The message never carries a command, a file path or a secret name.
    expect(out.text).not.toMatch(/curl|\.json|\$AUTH|token/i);
  });

  it('with no address, only an address service gets a yes button, and the page is not pretended', () => {
    const picked = rows.filter(isServiceAvailable);
    const out = renderOfferList(picked, { listId: 'e'.repeat(32), linkBase: null, hasAddress: false, now: 1 });
    const yesButtons = out.buttons.filter((b) => b.data.startsWith('rs:y:'));
    expect(yesButtons.map((b) => b.text)).toEqual(picked.filter((r) => r.wayIn).map((r) => `Yes to ${r.name}`));
    expect(yesButtons.length).toBeGreaterThan(0);
    expect(out.text).not.toContain('/dashboard/service-yes');
    expect(out.text).toContain('the button below');
    expect(out.text).toContain('once you have an address for me');
    expect(out.taps.filter((t) => t.action === 'yes').every((t) => picked.find((r) => r.id === t.service)?.wayIn)).toBe(true);
  });
});

describe('offer taps', () => {
  let dir: string;
  let clock: number;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rec-taps-')); clock = 1_000_000; });
  afterEach(() => SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/recommended-services-offers.test.ts' }));
  const store = () => new OfferTapStore({ stateDir: dir, now: () => clock });
  const tap = (nonce: string, service = 'jev', action: 'no' | 'yes' = 'no') => ({ nonce, service, action, listId: 'f'.repeat(32), expiresAt: clock + 1000 });

  it('a tap is spent once, survives a new store (a restart), and expires', () => {
    store().add([tap('n1'), tap('n2', 'tailscale', 'yes')]);
    expect(store().peek('n1')?.service).toBe('jev');
    expect(store().consume('n1')?.action).toBe('no');
    expect(store().consume('n1')).toBeNull();
    expect(store().peek('n2')?.action).toBe('yes');
    clock += 1001;
    expect(store().peek('n2')).toBeNull();
  });

  it('a choice elsewhere spends every tap for that service, and no taps are bounded per hour', () => {
    store().add([tap('a', 'jev'), tap('b', 'jev'), tap('c', 'tailscale')]);
    store().invalidateService('jev');
    expect(store().peek('a')).toBeNull();
    expect(store().peek('c')).not.toBeNull();
    const s = store();
    for (let i = 0; i < OFFER_NO_TAPS_PER_HOUR; i += 1) expect(s.admitNo()).toBe(true);
    expect(s.admitNo()).toBe(false);
    clock += 60 * 60_000 + 1;
    expect(store().admitNo()).toBe(true);
  });
});
