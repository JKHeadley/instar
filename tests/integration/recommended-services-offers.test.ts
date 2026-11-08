/**
 * The first list through the routes (docs/specs/recommended-services.md, Offers): sent once, only when every
 * precondition holds, written pending before and offered after the platform's message id; the buttons under it;
 * the switch; and what the list route says about it.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import type { MachineKeyLookup, MachineSigner } from '../../src/core/AppRecordSignatures.js';
import { RecommendedServicesLedger } from '../../src/recommended/RecommendedServicesLedger.js';
import { markNewAgent, recordDeliveredFirstResult } from '../../src/recommended/offerPrerequisites.js';
import { OFFER_RESEND_AFTER_MS, registerRecommendedServiceRoutes, type OfferTapHandler, type RecommendedServiceRouteDeps } from '../../src/server/recommendedServiceRoutes.js';
import { RECOMMENDED_SERVICE_CATALOG, isServiceAvailable } from '../../src/recommended/catalog.js';
import { readSetupStates } from '../../src/recommended/setupState.js';
import { loadCapturedFixture } from '../helpers/loadCapturedFixture.js';

const tailscaleSignedIn = loadCapturedFixture('tailscale-status', 'status-full');

const { privateKey } = crypto.generateKeyPairSync('ed25519');
const signer: MachineSigner = {
  machineId: () => 'm_a', signerKeyHash: () => 'h',
  sign: (p: string) => ({ machineId: 'm_a', signerKeyHash: 'h', sig: crypto.sign(null, Buffer.from(p), privateKey).toString('base64') }) as ReturnType<MachineSigner['sign']>,
};

describe('recommended services: the first list', () => {
  let dir: string;
  let ledger: RecommendedServicesLedger;
  let clock: number;
  let sent: Array<{ text: string; buttons: Array<{ text: string; data: string }> }>;
  let sendResult: () => string | number | null;
  let tick: (() => Promise<void>) | null;
  let tapHandler: OfferTapHandler | null;
  let started: string[];
  let enabled: boolean;
  let reach: boolean;
  let owner: string | null;
  let linkBase: string | null;

  const build = (over: Partial<RecommendedServiceRouteDeps> = {}) => {
    const a = express();
    a.use(express.json());
    const router = express.Router();
    registerRecommendedServiceRoutes(router, {
      ledger: () => ledger, stateDir: dir, owner: () => owner, now: () => clock,
      recordApproval: () => undefined, openCommitment: () => 'c1', finishCommitment: () => undefined, withdrawCommitment: () => undefined,
      startSetup: async (service) => { started.push(service); return { sessionName: `s-${service}`, topicId: 9 }; },
      stopSetup: () => true, isSetupRunning: () => false, notifyStuck: async () => true, clearStuck: () => undefined, tellOwner: () => undefined,
      writeSecret: () => undefined, readSecret: () => null, port: 0,
      checkPin: () => true, checkConfirmPin: () => true,
      canReachOwner: () => reach,
      offersEnabled: () => enabled,
      sendOfferList: async (text, buttons) => { sent.push({ text, buttons }); return sendResult(); },
      linkBase: () => linkBase,
      registerOfferTapHandler: (h) => { tapHandler = h; },
      onReady: (reconcile) => { tick = reconcile; },
      // Every recipe's check says "not here", so nothing reads as in use and no setup actually starts a session.
      tailscaleStatus: async () => ({ kind: 'missing' as const }),
      ...over,
    });
    a.use(router);
    return a;
  };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rec-offers-'));
    ledger = new RecommendedServicesLedger({ stateDir: dir, signer, keyLookup: (() => ({ status: 'unknown' })) as unknown as MachineKeyLookup, now: () => new Date(clock) });
    clock = Date.parse('2026-11-07T12:00:00Z');
    sent = []; sendResult = () => 777; tick = null; tapHandler = null; started = []; enabled = true; reach = true; owner = '42'; linkBase = 'http://10.0.0.5:4042';
  });
  afterEach(() => SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/integration/recommended-services-offers.test.ts' }));

  const ready = () => { markNewAgent(dir); recordDeliveredFirstResult(dir, 'telegram', 41); };
  const available = RECOMMENDED_SERVICE_CATALOG.filter(isServiceAvailable).map((r) => r.id);

  it('sends one list once every precondition holds, writes pending before and offered after the message id, and never again', async () => {
    const app = build();
    let res = await request(app).get('/recommended-services');
    expect(res.body.offersLive).toBe(false);
    await tick!();
    expect(sent).toEqual([]);
    ready();
    res = await request(app).get('/recommended-services');
    expect(res.body.offersLive).toBe(true);
    await tick!();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.buttons.map((b) => b.text)).toEqual(available.map((id) => `No to ${RECOMMENDED_SERVICE_CATALOG.find((r) => r.id === id)!.name}`));
    for (const id of available) {
      expect(ledger.offerState(id, '42')).toBe('offered');
      expect(ledger.offerRows('42').find((r) => r.service === id && r.state === 'offered')?.messageId).toBe('777');
      expect(ledger.offerRows('42').some((r) => r.service === id && r.state === 'pending')).toBe(true);
    }
    res = await request(app).get('/recommended-services');
    expect(res.body.services.filter((s: { offered: boolean }) => s.offered).map((s: { service: string }) => s.service)).toEqual(available);
    // A week later, nothing new is available, so nothing is sent; a later-available service would join the next list.
    clock += 8 * 24 * 60 * 60_000;
    await tick!();
    await tick!();
    expect(sent).toHaveLength(1);
  });

  it('a refused send leaves the rows pending and the list is resumed after the wait, not before', async () => {
    const app = build();
    ready();
    sendResult = () => null;
    await tick!();
    expect(sent).toHaveLength(1);
    expect(ledger.offerState(available[0]!, '42')).toBe('pending');
    expect((await request(app).get('/recommended-services')).body.services.find((s: { service: string }) => s.service === available[0]).offered).toBe(false);
    await tick!();
    expect(sent).toHaveLength(1);
    clock += OFFER_RESEND_AFTER_MS;
    sendResult = () => 778;
    await tick!();
    expect(sent).toHaveLength(2);
    expect(ledger.offerState(available[0]!, '42')).toBe('offered');
    // The same list id throughout: one list, delivered on the second try.
    expect(new Set(ledger.offerRows('42').map((r) => r.listId)).size).toBe(1);
  });

  it('two overlapping ticks send one list, not two', async () => {
    let release: (v: number) => void = () => undefined;
    build({ sendOfferList: async (text, buttons) => { sent.push({ text, buttons }); return new Promise<number>((r) => { release = r; }); } });
    ready();
    const first = tick!();
    await new Promise((r) => setTimeout(r, 20));
    await tick!();
    release(901);
    await first;
    expect(sent).toHaveLength(1);
    expect(new Set(ledger.offerRows('42').map((r) => r.listId)).size).toBe(1);
  });

  it('a no on the page or the plain route spends the list buttons for that service too', async () => {
    const app = build();
    ready();
    await tick!();
    const noJev = sent[0]!.buttons.find((b) => b.text === 'No to Jev (TypeSafe)')!.data.slice(5);
    const no = await request(app).post('/recommended-services/jev/no').set('X-Instar-Request', '1').send({ pin: '1', reason: 'cost' });
    expect(no.status).toBe(200);
    expect(await tapHandler!({ action: 'no', nonce: noJev, fromIsOwner: true })).toContain('used or has expired');
  });

  it('the switch, the reach, the owner and the first result each hold the list back; nothing is written', async () => {
    build();
    ready();
    enabled = false;
    await tick!();
    enabled = true; reach = false;
    await tick!();
    reach = true; owner = null;
    await tick!();
    expect(sent).toEqual([]);
    expect(ledger.offerRows()).toEqual([]);
    owner = '42';
    await tick!();
    expect(sent).toHaveLength(1);
  });

  it('a decided or in-use service is left out of the list', async () => {
    build({ tailscaleStatus: async () => ({ kind: 'ok' as const, stdout: tailscaleSignedIn }) });
    ready();
    ledger.recordNo({ service: 'jev', reason: 'cost', shutdown: 'none', origin: 'owner-surface' });
    await tick!();
    expect(sent).toHaveLength(1);
    const names = sent[0]!.buttons.map((b) => b.text);
    expect(names).not.toContain('No to Jev (TypeSafe)');
    expect(names).not.toContain('No to Tailscale');
    expect(readSetupStates(dir).tailscale?.inUse).toBe(true);
    expect(ledger.offerState('tailscale', '42')).toBe('none');
  });

  it('a no tap records a no from the offer, spends the button, and is bounded; a yes tap is owner-only and for an address service only', async () => {
    build();
    ready();
    linkBase = null;
    await tick!();
    const buttons = sent[0]!.buttons;
    const noJev = buttons.find((b) => b.text === 'No to Jev (TypeSafe)')!.data.slice(5);
    const yesTailscale = buttons.find((b) => b.text === 'Yes to Tailscale')!.data.slice(5);
    expect(buttons.find((b) => b.text === 'Yes to Jev (TypeSafe)')).toBeUndefined();
    expect(await tapHandler!({ action: 'no', nonce: noJev, fromIsOwner: false })).toContain('No to Jev');
    expect(ledger.effective('jev')).toMatchObject({ choice: 'no', origin: 'first-offer', shutdown: 'none' });
    expect(await tapHandler!({ action: 'no', nonce: noJev, fromIsOwner: true })).toContain('used or has expired');
    expect(await tapHandler!({ action: 'no', nonce: 'f'.repeat(32), fromIsOwner: true })).toContain('used or has expired');
    // The wrong action for a nonce is refused too.
    expect(await tapHandler!({ action: 'no', nonce: yesTailscale, fromIsOwner: true })).toContain('used or has expired');
    expect(await tapHandler!({ action: 'yes', nonce: yesTailscale, fromIsOwner: false })).toBe('Only the owner can say yes.');
    expect(ledger.effective('tailscale').choice).toBe('unset');
    expect(await tapHandler!({ action: 'yes', nonce: yesTailscale, fromIsOwner: true })).toContain('Yes to Tailscale');
    expect(ledger.effective('tailscale')).toMatchObject({ choice: 'yes', origin: 'first-offer' });
    expect(ledger.activeGrant('tailscale', 'm_a')?.principal).toBe('42');
    await new Promise((r) => setTimeout(r, 20));
    expect(started).toEqual(['tailscale']);
    expect(await tapHandler!({ action: 'yes', nonce: yesTailscale, fromIsOwner: true })).toContain('used or has expired');
  });

  it('a yes through the page still works the same way after the list, and spends the list buttons for that service', async () => {
    const app = build();
    ready();
    await tick!();
    const noBitwarden = sent[0]!.buttons.find((b) => b.text === 'No to Bitwarden')!.data.slice(5);
    const page = await request(app).get('/recommended-services/bitwarden/confirm');
    expect(page.status).toBe(200);
    const yes = await request(app).post('/recommended-services/bitwarden/confirm').set('X-Instar-Request', '1').send({ token: page.body.token, pin: '1', answer: 'yes' });
    expect(yes.status).toBe(200);
    expect(yes.body).toMatchObject({ choice: 'yes', origin: 'first-offer' });
    expect(await tapHandler!({ action: 'no', nonce: noBitwarden, fromIsOwner: true })).toContain('used or has expired');
    expect(ledger.effective('bitwarden').choice).toBe('yes');
  });
});
