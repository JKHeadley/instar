/**
 * Re-offers through the routes (docs/specs/recommended-services.md, rollout step 4, reason 1): the switch keeps
 * everything dark; a recorded problem after a no is sent once by a machine that can reach the person, pending
 * before and offered from the message id; a refused send is resumed after the wait; a machine that can't reach
 * the person records but never sends; and the choice never changes.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import type { MachineKeyLookup, MachineSigner } from '../../src/core/AppRecordSignatures.js';
import { RecommendedServicesLedger } from '../../src/recommended/RecommendedServicesLedger.js';
import { readRestoreMarker, writeRestoreMarker } from '../../src/core/restoreMarker.js';
import { updateSetupState } from '../../src/recommended/setupState.js';
import { OFFER_RESEND_AFTER_MS, registerRecommendedServiceRoutes, type RecommendedServiceRouteDeps, type RecommendedServiceRoutesHandle } from '../../src/server/recommendedServiceRoutes.js';

const { privateKey } = crypto.generateKeyPairSync('ed25519');
const signer: MachineSigner = {
  machineId: () => 'm_a', signerKeyHash: () => 'h',
  sign: (p: string) => ({ machineId: 'm_a', signerKeyHash: 'h', sig: crypto.sign(null, Buffer.from(p), privateKey).toString('base64') }) as ReturnType<MachineSigner['sign']>,
};
const VOICE = 'voice-transcription';

describe('recommended services: re-offers after a real problem', () => {
  let dir: string;
  let ledger: RecommendedServicesLedger;
  let clock: number;
  let sent: Array<{ text: string; buttons: Array<{ text: string; data: string }> }>;
  let sendResult: () => string | number | null;
  let tick: (() => Promise<void>) | null;
  let enabled: boolean;
  let reach: boolean;
  let handle: RecommendedServiceRoutesHandle;

  const build = (over: Partial<RecommendedServiceRouteDeps> = {}) => {
    const router = express.Router();
    handle = registerRecommendedServiceRoutes(router, {
      ledger: () => ledger, stateDir: dir, owner: () => '42', now: () => clock,
      recordApproval: () => undefined, openCommitment: () => 'c1', finishCommitment: () => undefined, withdrawCommitment: () => undefined,
      startSetup: async (service) => ({ sessionName: `s-${service}`, topicId: 9 }),
      stopSetup: () => true, isSetupRunning: () => false, notifyStuck: async () => true, clearStuck: () => undefined, tellOwner: () => undefined,
      writeSecret: () => undefined, readSecret: () => null, port: 0,
      checkPin: () => true, checkConfirmPin: () => true,
      canReachOwner: () => reach,
      offersEnabled: () => false,
      reoffersEnabled: () => enabled,
      sendOfferList: async (text, buttons) => { sent.push({ text, buttons }); return sendResult(); },
      linkBase: () => 'http://10.0.0.5:4042',
      onReady: (reconcile) => { tick = reconcile; },
      tailscaleStatus: async () => ({ kind: 'missing' as const }),
      ...over,
    });
  };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rec-reoffers-'));
    clock = Date.parse('2026-11-20T12:00:00Z');
    ledger = new RecommendedServicesLedger({ stateDir: dir, signer, keyLookup: (() => ({ status: 'unknown' })) as unknown as MachineKeyLookup, now: () => new Date(clock) });
    sent = []; sendResult = () => 901; tick = null; enabled = true; reach = true;
  });
  afterEach(() => SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/integration/recommended-services-reoffers.test.ts' }));

  const refuse = () => { ledger.recordNo({ service: VOICE, shutdown: 'none', reason: 'cost', origin: 'first-offer' }); clock += 1000; };

  it('switched off, a problem records nothing and sends nothing', async () => {
    enabled = false;
    build();
    refuse();
    handle.recordProblem('voice-unreadable', 'telegram');
    await tick!();
    expect(ledger.reofferRows()).toEqual([]);
    expect(sent).toEqual([]);
  });

  it('a problem after a no is sent once, pending before and offered from the message id, and the no stands', async () => {
    build();
    refuse();
    handle.recordProblem('voice-unreadable', 'telegram');
    handle.recordProblem('voice-unreadable', 'telegram');
    expect(ledger.reofferRows('42').filter((r) => r.state === 'event')).toHaveLength(1);
    await tick!();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.buttons).toEqual([]);
    expect(sent[0]!.text).toContain("couldn't turn into text");
    expect(sent[0]!.text).toContain('/dashboard/service-yes?service=voice-transcription');
    const rows = ledger.reofferRows('42');
    expect(rows.map((r) => r.state)).toEqual(['event', 'pending', 'offered']);
    expect(rows[2]!.messageId).toBe('901');
    expect(ledger.effective(VOICE).choice).toBe('no');
    clock += OFFER_RESEND_AFTER_MS * 30;
    await tick!();
    expect(sent).toHaveLength(1);
  });

  it('a refused send stays reserved and is resumed after the wait, not before, with one reservation', async () => {
    build();
    refuse();
    handle.recordProblem('voice-unreadable', 'app');
    sendResult = () => null;
    await tick!();
    await tick!();
    expect(sent).toHaveLength(1);
    clock += OFFER_RESEND_AFTER_MS;
    sendResult = () => 902;
    await tick!();
    expect(sent).toHaveLength(2);
    expect(ledger.reofferRows('42').filter((r) => r.state === 'pending')).toHaveLength(1);
    expect(ledger.reofferRows('42').find((r) => r.state === 'offered')?.messageId).toBe('902');
  });

  it('a machine that cannot reach the person records the problem but never sends', async () => {
    reach = false;
    build();
    refuse();
    handle.recordProblem('voice-unreadable', 'whatsapp');
    await tick!();
    expect(sent).toEqual([]);
    expect(ledger.reofferRows('42').map((r) => r.state)).toEqual(['event']);
  });

  it('an unknown kind, or a ledger that throws, never reaches the caller', async () => {
    build();
    refuse();
    expect(() => handle.recordProblem('made-up', 'x')).not.toThrow();
    expect(ledger.reofferRows()).toEqual([]);
    ledger.recordReofferEvent = () => { throw new Error('disk full'); };
    expect(() => handle.recordProblem('voice-unreadable', 'telegram')).not.toThrow();
  });

  describe('secret-lost: a boot check over the loaded config', () => {
    const noVault = () => { ledger.recordNo({ service: 'bitwarden', shutdown: 'none', reason: 'not-needed', origin: 'first-offer' }); clock += 1000; };

    it('a missing secret after a no on Bitwarden is asked about once, with its own words, checked once per start', async () => {
      let reads = 0;
      build({ unresolvedSecrets: () => { reads += 1; return ['messaging.0.config.token']; } });
      noVault();
      await tick!();
      await tick!();
      expect(reads).toBe(1);
      expect(sent).toHaveLength(1);
      expect(sent[0]!.text).toContain('no vault holding a copy');
      expect(sent[0]!.text).toContain('/dashboard/service-yes?service=bitwarden');
      expect(sent[0]!.text).not.toContain('messaging.0');
      expect(ledger.reofferRows('42')[0]).toMatchObject({ kind: 'secret-lost', service: 'bitwarden', evidenceRef: 'boot' });
      expect(ledger.effective('bitwarden').choice).toBe('no');
    });

    it('nothing missing, the switch off, or a vault already chosen: nothing is recorded', async () => {
      build({ unresolvedSecrets: () => [] });
      noVault();
      await tick!();
      expect(ledger.reofferRows()).toEqual([]);
      enabled = false;
      build({ unresolvedSecrets: () => ['authToken'] });
      await tick!();
      expect(ledger.reofferRows()).toEqual([]);
    });

    it('a check that throws is reported, never reaches the tick, and sends nothing', async () => {
      build({ unresolvedSecrets: () => { throw new Error('unreadable'); } });
      noVault();
      await expect(tick!()).resolves.toBeUndefined();
      expect(ledger.reofferRows()).toEqual([]);
      expect(sent).toEqual([]);
    });
  });

  describe('state-loss-risk: a restore from a local snapshot with no copy off this machine', () => {
    const noBackup = () => { ledger.recordNo({ service: 'github-state-backup', shutdown: 'none', reason: 'privacy', origin: 'first-offer' }); clock += 1000; };

    it('after a no on GitHub backup, a restore marker re-offers it once and is cleared', async () => {
      writeRestoreMarker(dir, 'snap-1', () => new Date(clock));
      build({ otherMachineCount: () => 0 });
      noBackup();
      await tick!();
      expect(readRestoreMarker(dir)).toBeNull();
      expect(sent).toHaveLength(1);
      expect(sent[0]!.text).toContain('restored from a snapshot kept on this same machine');
      expect(sent[0]!.text).toContain('/dashboard/service-yes?service=github-state-backup');
      expect(ledger.reofferRows('42')[0]).toMatchObject({ kind: 'state-loss-risk', service: 'github-state-backup', evidenceRef: 'restore' });
      expect(ledger.effective('github-state-backup').choice).toBe('no');
    });

    it('another machine, or a verified GitHub backup, is a copy: nothing is recorded, and the marker is still cleared', async () => {
      writeRestoreMarker(dir, 'snap-1', () => new Date(clock));
      build({ otherMachineCount: () => 1 });
      noBackup();
      await tick!();
      expect(readRestoreMarker(dir)).toBeNull();
      expect(ledger.reofferRows()).toEqual([]);
      writeRestoreMarker(dir, 'snap-2', () => new Date(clock));
      updateSetupState(dir, 'github-state-backup', { verified: { at: new Date(clock).toISOString(), result: 'pass', detail: 'ok' } });
      build({ otherMachineCount: () => 0 });
      await tick!();
      expect(ledger.reofferRows()).toEqual([]);
    });

    it('with the switch off the marker is cleared and nothing recorded, so turning it on later digs up nothing', async () => {
      enabled = false;
      writeRestoreMarker(dir, 'snap-1', () => new Date(clock));
      build({ otherMachineCount: () => 0 });
      noBackup();
      await tick!();
      expect(readRestoreMarker(dir)).toBeNull();
      enabled = true;
      build({ otherMachineCount: () => 0 });
      await tick!();
      expect(ledger.reofferRows()).toEqual([]);
    });

    it('a marker older than 30 days, or none at all, records nothing', async () => {
      writeRestoreMarker(dir, 'snap-1', () => new Date(clock - 31 * 24 * 60 * 60_000));
      build({ otherMachineCount: () => 0 });
      noBackup();
      await tick!();
      expect(ledger.reofferRows()).toEqual([]);
      build({ otherMachineCount: () => 0 });
      await tick!();
      expect(ledger.reofferRows()).toEqual([]);
    });
  });

  describe('address-repeatedly-down: outages the tunnel gave up on', () => {
    const no = (service: string) => { ledger.recordNo({ service, shutdown: 'none', reason: 'not-needed', origin: 'first-offer' }); clock += 1000; };

    it('three in a day re-offer Tailscale once; two do not; the count survives a restart', async () => {
      build();
      no('tailscale');
      handle.recordAddressOutage();
      clock += 60_000;
      handle.recordAddressOutage();
      expect(ledger.reofferRows()).toEqual([]);
      build(); // a restart: the count is on disk
      clock += 60_000;
      handle.recordAddressOutage();
      await tick!();
      expect(sent).toHaveLength(1);
      expect(sent[0]!.text).toContain('web address went down three times');
      expect(sent[0]!.text).toContain('service=tailscale');
      expect(ledger.effective('tailscale').choice).toBe('no');
    });

    it('outages spread over more than a day are not a problem', () => {
      build();
      no('tailscale');
      for (let i = 0; i < 3; i++) { handle.recordAddressOutage(); clock += 13 * 60 * 60_000; }
      expect(ledger.reofferRows()).toEqual([]);
    });

    it('with Tailscale already a yes, the problem re-offers Cloudflare instead', async () => {
      build();
      ledger.recordYes({ service: 'tailscale', origin: 'person-asked', offerTextHash: 'h', grantMachine: 'm_a', principal: '42' });
      no('cloudflare-domain');
      for (let i = 0; i < 3; i++) handle.recordAddressOutage();
      expect(ledger.reofferRows('42')[0]).toMatchObject({ kind: 'address-repeatedly-down', service: 'cloudflare-domain' });
    });

    it('switched off, outages are not even counted', () => {
      enabled = false;
      build();
      no('tailscale');
      for (let i = 0; i < 5; i++) handle.recordAddressOutage();
      expect(fs.existsSync(path.join(dir, 'state', 'recommended-service-setup', 'address-outages.json'))).toBe(false);
    });
  });
});
