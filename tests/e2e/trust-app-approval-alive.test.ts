/**
 * Tier-3 E2E (feature is alive) for docs/specs/app-trust-approval.md, Acceptance §3: on the
 * production paths, a real AgentServer with the trust journey store riding a real CoherenceJournal
 * through the replicated emitter (the sink server.ts uses wherever the journal runs), and a device
 * paired through the real redeem/confirm path. Wiring integrity: the four routes are on the device
 * allowlist (not 403 device-not-allowed), mounted (not 404) and live (not 503 trust-approvals-unavailable),
 * and the routes.ts wiring bound the paired-device registry into the account path (a device-only
 * request is created, not no-approver). The approval raises the setting, the records are durable in
 * the journal, and a restarted runtime keeps the proven raise.
 */
import { describe, it, expect, afterAll } from 'vitest';
import request from 'supertest';
import { CoherenceJournal } from '../../src/core/CoherenceJournal.js';
import { ReplicatedKindRegistry } from '../../src/core/ReplicatedRecordEnvelope.js';
import { ReplicatedRecordEmitter } from '../../src/core/ReplicatedRecordEmitter.js';
import { ReplicatedPeerStreamReader } from '../../src/core/ReplicatedPeerStreamReader.js';
import { HybridLogicalClock } from '../../src/core/HybridLogicalClock.js';
import { createTrustJourneyRuntime, journalSink } from '../../src/core/trustJourney/TrustJourneyRuntime.js';
import { TRUST_GRANT_KIND_REGISTRATION, TRUST_JOURNEY_STORE_KEY, TrustJourneyStore, type TrustRecordSink } from '../../src/core/trustJourney/TrustJourneyStore.js';
import { boundAgentServerBase } from '../helpers/boundAgentServerBase.js';
import { bootTrustAppServer, cleanupTrustAppServers, DISCLOSURE, DHASH } from '../helpers/trustAppServer.js';

afterAll(async () => { await cleanupTrustAppServers('tests/e2e/trust-app-approval-alive.test.ts'); });

function journalRig(stateDir: string): { journal: CoherenceJournal; sink: TrustRecordSink } {
  const reg = new ReplicatedKindRegistry(); reg.register(TRUST_GRANT_KIND_REGISTRATION);
  const journal = new CoherenceJournal({ stateDir, machineId: 'm1', flushIntervalMs: 1_000_000 } as never);
  journal.open(); journal.setReplicatedKindRegistry(reg);
  let t = Date.parse('2026-11-17T08:00:00Z');
  const emitter = new ReplicatedRecordEmitter({ journal, clock: new HybridLogicalClock({ node: 'm1', now: () => (t += 1000) }), registry: reg, origin: 'm1', stores: () => ({ [TRUST_JOURNEY_STORE_KEY]: { enabled: true } }), loadWitness: () => undefined });
  const streams = new ReplicatedPeerStreamReader({ stateDir, registry: reg, selfMachineId: 'm1', autoRebuild: false });
  const sink = journalSink({
    emit: (k, b) => { const r = emitter.emit(TRUST_JOURNEY_STORE_KEY, k, b as never); journal.flush(); return { outcome: r.outcome, ...(r.seq !== undefined ? { seq: r.seq } : {}) }; },
    awaitDurable: async () => { journal.flush(); },
    loadUnion: () => {
      journal.flush();
      const out: Array<{ recordKey: string; data: Record<string, unknown> }> = [];
      for (const byOrigin of streams.loadAllOriginRecords(TRUST_JOURNEY_STORE_KEY).values()) for (const r of byOrigin) out.push({ recordKey: r.envelope.recordKey, data: { ...r.data } });
      return out;
    },
  });
  return { journal, sink };
}

describe('App trust approval E2E (feature is alive)', () => {
  it('boots the mobile challenge route with first-phone enrollment unavailable by default', async () => {
    const s = await bootTrustAppServer('first-phone-challenge-e2e-');
    await s.server.start();
    const phone = await s.pair({ local: false, name: 'Disposable first phone' });
    const challenge = await phone.signed('POST', '/mobile/permissions/challenge', {
      action: 'first-phone-enrollment-v1',
      target: '01234567-89ab-4cde-8fab-012345678901',
      proposalHash: 'a'.repeat(64),
      disclosureHash: DHASH,
    });
    expect(challenge.status).toBe(503);
    expect(challenge.body).toEqual({ error: 'first-phone-enrollment-unavailable' });
    const submit = await phone.signed('POST', '/mobile/trust/first-phone-enrollment', {
      target: '01234567-89ab-4cde-8fab-012345678901',
      proposalHash: 'a'.repeat(64),
      disclosureHash: DHASH,
    });
    expect(submit.status).toBe(503);
    expect(submit.body).toEqual({ error: 'first-phone-enrollment-unavailable' });
  });

  it('a configured but unopened Telegram chat never blocks an app setup request and exact signed approval', async () => {
    let sends = 0;
    const s = await bootTrustAppServer('app-first-e2e-', undefined, { getOwnerUserId: () => 777, sendOwnerDirect: async () => { sends++; return null; } });
    await s.server.start();
    // Needs-you reads this real listener over loopback; port zero is only the bind request.
    s.config.port = Number(new URL(boundAgentServerBase(s.server)).port);
    const mac = await s.pair({ local: true, name: 'App-first Mac' });
    const opened = await s.bearer(request(s.app).post('/trust/requests')).send({ change: { kind: 'trust-grant', service: 'gmail', operation: 'write', level: 'autonomous' } });
    expect(opened.status, JSON.stringify(opened.body)).toBe(202);
    expect(opened.body).toMatchObject({ status: 'awaiting-acceptance', via: 'device' });
    expect(opened.body.code).toBeUndefined();
    expect(sends).toBe(0);
    const waiting = (await mac.signed('GET', '/mobile/trust/requests')).body;
    expect(waiting.approvalDelivery.state).toBe('setup');
    const row = waiting.requests.find((r: { requestId: string }) => r.requestId === opened.body.requestId);
    expect(row.status).toBe('open');
    const needs = await s.bearer(request(s.app).get('/needs'));
    expect(needs.status, JSON.stringify(needs.body)).toBe(200);
    expect(needs.body.items.some((i: { source: string }) => i.source === 'trust-requests'), JSON.stringify(needs.body)).toBe(true);
    const acc = await mac.act({ action: 'accept-device', target: mac.id, keyFingerprint: mac.fp, disclosureHash: DHASH }, '/mobile/trust/device-acceptance',
      { keyFingerprint: mac.fp, disclosureHash: DHASH, disclosure: DISCLOSURE, keyPolicy: 'biometryCurrentSet' }, `accept-device ${mac.id} ${mac.fp} ${DHASH}`);
    expect(acc.status, JSON.stringify(acc.body)).toBe(200);
    const same = await s.bearer(request(s.app).post('/trust/requests')).send({ change: { kind: 'trust-grant', service: 'gmail', operation: 'write', level: 'autonomous' } });
    expect(same.body).toMatchObject({ requestId: row.requestId, status: 'sent', via: 'device', expiresAt: row.expiresAt });
    const ok = await mac.act({ action: 'approve-widening', target: row.requestId, proposalHash: row.proposalHash }, `/mobile/trust/requests/${row.requestId}/approve`, { proposalHash: row.proposalHash }, `approve-widening ${row.requestId} ${row.proposalHash}`);
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.status).toBe('applied');
    expect(s.trust.getTrustLevel('gmail', 'write').level).toBe('autonomous');
    expect(sends).toBe(0);
  });

  it('the routes are alive on the production path, an app-only agent approves a raise, and it survives a restart', async () => {
    // The journal rig needs the state dir before the server exists: build the server on a deferred sink.
    let rig: ReturnType<typeof journalRig> | null = null;
    const lazySink: TrustRecordSink = {
      description: 'journal (e2e)',
      append: (k, r) => rig!.sink.append(k, r),
      loadAll: () => (rig ? rig.sink.loadAll() : []),
    };
    const s = await bootTrustAppServer('trust-app-e2e-', lazySink);
    rig = journalRig(s.stateDir);
    await s.server.start();
    try {
      const mac = await s.pair({ local: true, name: 'E2E Mac' });

      // Alive: on the allowlist, mounted and live (never 403 device-not-allowed, 404 or 503).
      const list = await mac.signed('GET', '/mobile/trust/requests');
      expect(list.status, JSON.stringify(list.body)).toBe(200);
      expect(list.body.holder).toBe(true);
      const withdrawProbe = await mac.signed('POST', '/mobile/trust/device-acceptance/withdraw', {});
      expect(withdrawProbe.status, JSON.stringify(withdrawProbe.body)).toBe(200);
      const approveProbe = await mac.signed('POST', '/mobile/trust/requests/tr-0123456789ab-ABC123/approve', { proposalHash: 'a'.repeat(64) });
      expect(approveProbe.status).toBe(401); // reached the presence check: the route is mounted, gated and live
      expect(approveProbe.body.error).toBe('challenge-invalid');

      // The device records its acceptance (the routes.ts wiring bound the device registry into the service).
      const acc = await mac.act({ action: 'accept-device', target: mac.id, keyFingerprint: mac.fp, disclosureHash: DHASH }, '/mobile/trust/device-acceptance',
        { keyFingerprint: mac.fp, disclosureHash: DHASH, disclosure: DISCLOSURE, keyPolicy: 'biometryCurrentSet' }, `accept-device ${mac.id} ${mac.fp} ${DHASH}`);
      expect(acc.status, JSON.stringify(acc.body)).toBe(200);
      const opened = await s.bearer(request(s.app).post('/trust/requests')).send({ change: { kind: 'trust-grant', service: 'gmail', operation: 'write', level: 'autonomous' } });
      expect(opened.status, JSON.stringify(opened.body)).toBe(202);
      expect(opened.body.via).toBe('device');
      const row = (await mac.signed('GET', '/mobile/trust/requests')).body.requests.find((r: { requestId: string }) => r.requestId === opened.body.requestId);
      const ok = await mac.act({ action: 'approve-widening', target: row.requestId, proposalHash: row.proposalHash }, `/mobile/trust/requests/${row.requestId}/approve`, { proposalHash: row.proposalHash }, `approve-widening ${row.requestId} ${row.proposalHash}`);
      expect(ok.status, JSON.stringify(ok.body)).toBe(200);
      expect(ok.body.status).toBe('applied');
      expect(s.trust.getTrustLevel('gmail', 'write').level).toBe('autonomous');

      // Durable in the journal: a fresh store over it sees the acceptance, the consumption and the outcome.
      rig.journal.flush();
      const fresh = new TrustJourneyStore(rig.sink);
      expect(fresh.deviceAcceptance(mac.id)).toMatchObject({ via: 'local-install', disclosureHash: DHASH });
      expect(fresh.consumptionOf(row.requestId)).toMatchObject({ kind: 'accepted-device', deviceId: mac.id });
      expect(fresh.applyOutcome(row.requestId)).toMatchObject({ outcome: 'applied' });

      // A restart over the same journal keeps the proven raise.
      const restarted = createTrustJourneyRuntime({
        stateDir: s.stateDir, configPath: `${s.stateDir}/config.json`, runtimeConfig: {}, installationId: 'trust-app', sink: rig.sink,
        adaptiveTrust: s.trust, autonomyManager: null, trustRecovery: null, telegram: null, slack: null, slackOwnerUserId: () => null, holdsLease: () => true,
      });
      expect(await restarted.checkAtLoad()).toEqual([]);
      expect(s.trust.getTrustLevel('gmail', 'write').level).toBe('autonomous');
    } finally {
      rig?.journal.close();
    }
  });
});
