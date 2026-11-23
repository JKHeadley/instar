/** Native disclosure limits are enforced on the signed HTTP consumer, before request consumption. */
import { afterAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { proofSubject } from '../../src/core/trustJourney/AccountPathService.js';
import { proposalHashOf } from '../../src/core/TrustRaiseGuard.js';
import type { TrustChange } from '../../src/core/trustJourney/TrustJourneyStore.js';
import { bootTrustAppServer, cleanupTrustAppServers, DISCLOSURE, DHASH } from '../helpers/trustAppServer.js';

afterAll(async () => { await cleanupTrustAppServers('tests/integration/app-approval-disclosure-routes.test.ts'); });

describe('App disclosure boundaries over signed HTTP', () => {
  it('lists an oversized persisted request honestly and refuses its valid signed approval without consuming it', async () => {
    const s = await bootTrustAppServer('approval-disclosure-int-');
    const mac = await s.pair({ local: true, name: 'Disclosure integration Mac' });
    const accepted = await mac.act({ action: 'accept-device', target: mac.id, keyFingerprint: mac.fp, disclosureHash: DHASH }, '/mobile/trust/device-acceptance',
      { keyFingerprint: mac.fp, disclosureHash: DHASH, disclosure: DISCLOSURE, keyPolicy: 'biometryCurrentSet' }, `accept-device ${mac.id} ${mac.fp} ${DHASH}`);
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
    // Legacy persisted evidence can outlive a server's display contract. Seed that actual boundary;
    // fresh publication already refuses it and cannot produce this historical fixture itself.
    const change: TrustChange = { kind: 'trust-grant', service: 'calendar-' + 'x'.repeat(16_001), operation: 'write', level: 'autonomous' };
    const proposalHash = proposalHashOf(proofSubject(change));
    const requestId = `tr-${proposalHash.slice(0, 12)}-LEGACY`;
    const expiresAt = new Date(Date.now() + 7 * 86_400_000).toISOString();
    // The authoritative change is oversized even if a replicated record claims a harmless summary.
    const rawSummary = ['A harmless stored description'];
    expect((await s.runtime.store.write('request', { requestId, code: 'LEGACY', proposalHash, principal: 'owner', adapter: 'device', approverPlatformId: '',
      expiresAt, status: 'open', change, summary: rawSummary, cardMessageId: '', cardChatId: '' }, 'persisted-oversized-request')).ok).toBe(true);
    const listed = await mac.signed('GET', '/mobile/trust/requests');
    expect(listed.status, JSON.stringify(listed.body)).toBe(200);
    const row = listed.body.requests.find((r: { requestId: string }) => r.requestId === requestId);
    expect(row).toMatchObject({ requestId, status: 'open', proposalHash, expiresAt });
    expect(row.summary.join(' ')).toContain('too large to show whole');
    expect(row.summary.join(' ')).not.toContain(rawSummary[0]);
    expect(row.code).toBeUndefined();
    const refused = await mac.act({ action: 'approve-widening', target: requestId, proposalHash }, `/mobile/trust/requests/${requestId}/approve`,
      { proposalHash }, `approve-widening ${requestId} ${proposalHash}`);
    expect(refused.status, JSON.stringify(refused.body)).toBe(403);
    expect(refused.body).toMatchObject({ error: 'disclosure-too-large', status: 'refused' });
    expect(s.runtime.store.consumptionOf(requestId)).toBeNull();
    expect(s.runtime.store.requestConsumedOrPending(requestId)).toBe(false);
    expect(s.trust.getTrustLevel(change.service, 'write').level).not.toBe('autonomous');
    const after = await mac.signed('GET', '/mobile/trust/requests');
    expect(after.status).toBe(200);
    expect(after.body.requests.find((r: { requestId: string }) => r.requestId === requestId)).toMatchObject({ status: 'open', expiresAt });
    expect(s.runtime.store.request(requestId)?.summary).toEqual(rawSummary);
    // The route still exposes the pending state to the agent, without approval codes.
    const bearer = await s.bearer(request(s.app).get('/trust/requests'));
    expect(bearer.body.requests.find((r: { requestId: string }) => r.requestId === requestId)).toMatchObject({ status: 'open', expiresAt });
    expect(bearer.body.requests.find((r: { requestId: string }) => r.requestId === requestId).code).toBeUndefined();
  });
});
