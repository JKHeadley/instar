/**
 * Tier-2 integration (docs/specs/app-trust-approval.md, Acceptance §2) on a real AgentServer: an
 * agent with no Telegram or Slack owner chat and no device acceptance proposes a raise and gets
 * `no-approver`. The Mac the app paired locally records its acceptance with a presence signature;
 * the same proposal is then recorded for the device and listed on GET /mobile/trust/requests. A
 * presence-signed approval applies the raise (the trust level changes); a second approval of the same
 * request is refused, and the bearer token approves nothing.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { describe, it, expect, afterAll } from 'vitest';
import request from 'supertest';
import { bootTrustAppServer, cleanupTrustAppServers, DISCLOSURE, DHASH } from '../helpers/trustAppServer.js';

afterAll(async () => { await cleanupTrustAppServers('tests/integration/trust-app-approval-routes.test.ts'); });

describe('Approving a trust raise from the app (real AgentServer)', () => {
  it('no-approver, then the device accepts, the request is listed, approved once, and the raise applies', async () => {
    const s = await bootTrustAppServer('trust-app-int-');
    const change = { kind: 'trust-grant', service: 'gmail', operation: 'write', level: 'autonomous' };
    const first = await s.bearer(request(s.app).post('/trust/requests')).send({ change });
    expect(first.status).toBe(409);
    expect(first.body.status).toBe('no-approver');
    expect(first.body.message).toContain('Changes to approve');

    const mac = await s.pair({ local: true, name: 'Justin\'s Mac' });
    const accLine = `accept-device ${mac.id} ${mac.fp} ${DHASH}`;
    const acc = await mac.act({ action: 'accept-device', target: mac.id, keyFingerprint: mac.fp, disclosureHash: DHASH }, '/mobile/trust/device-acceptance',
      { keyFingerprint: mac.fp, disclosureHash: DHASH, disclosure: DISCLOSURE, keyPolicy: 'biometryCurrentSet' }, accLine);
    expect(acc.status, JSON.stringify(acc.body)).toBe(200);
    expect(acc.body).toMatchObject({ status: 'recorded', via: 'local-install' });

    const second = await s.bearer(request(s.app).post('/trust/requests')).send({ change });
    expect(second.status, JSON.stringify(second.body)).toBe(202);
    expect(second.body).toMatchObject({ status: 'sent', via: 'device' });
    expect(second.body.code).toBeUndefined();
    const requestId = second.body.requestId as string;

    const listed = await mac.signed('GET', '/mobile/trust/requests');
    expect(listed.status).toBe(200);
    const row = listed.body.requests.find((r: { requestId: string }) => r.requestId === requestId);
    expect(row).toMatchObject({ status: 'open', via: 'device' });
    expect(row.summary.join(' ')).toContain('gmail');

    // The bearer approves nothing.
    expect((await s.bearer(request(s.app).post(`/mobile/trust/requests/${requestId}/approve`)).send({ proposalHash: row.proposalHash })).status).toBe(403);
    expect(s.trust.getTrustLevel('gmail', 'write').level).not.toBe('autonomous');

    const line = `approve-widening ${requestId} ${row.proposalHash}`;
    const ok = await mac.act({ action: 'approve-widening', target: requestId, proposalHash: row.proposalHash }, `/mobile/trust/requests/${requestId}/approve`, { proposalHash: row.proposalHash }, line);
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.status).toBe('applied');
    expect(s.trust.getTrustLevel('gmail', 'write').level).toBe('autonomous');

    const again = await mac.act({ action: 'approve-widening', target: requestId, proposalHash: row.proposalHash }, `/mobile/trust/requests/${requestId}/approve`, { proposalHash: row.proposalHash }, line);
    expect(again.status).toBe(409);
    expect(again.body.error).toBe('already-approved');

    // The agent's own view carries the result and how it was approved.
    const mine = await s.bearer(request(s.app).get('/trust/requests'));
    const r = mine.body.requests.find((x: { requestId: string }) => x.requestId === requestId);
    expect(r).toMatchObject({ status: 'consumed', result: 'applied', adapter: 'device' });
    expect(r.disclosure).toContain('not independently verified');

    // Withdrawing (the agent's route, at the person's request) turns device approvals off again.
    const w = await s.bearer(request(s.app).post('/trust/acceptance/withdraw')).send({ adapter: 'device' });
    expect(w.body).toMatchObject({ withdrawn: true, count: 1 });
    const waiting = await s.bearer(request(s.app).post('/trust/requests')).send({ change: { ...change, service: 'calendar' } });
    expect(waiting.status).toBe(202);
    expect(waiting.body).toMatchObject({ status: 'awaiting-acceptance', via: 'device' });
    expect(waiting.body.code).toBeUndefined();
    const afterWithdrawal = await mac.signed('GET', '/mobile/trust/requests');
    const pending = afterWithdrawal.body.requests.find((x: { requestId: string }) => x.requestId === waiting.body.requestId);
    expect(pending).toMatchObject({ status: 'open', via: 'device' });
    const blockedLine = `approve-widening ${pending.requestId} ${pending.proposalHash}`;
    const blocked = await mac.act({ action: 'approve-widening', target: pending.requestId, proposalHash: pending.proposalHash }, `/mobile/trust/requests/${pending.requestId}/approve`, { proposalHash: pending.proposalHash }, blockedLine);
    expect(blocked.status).toBe(403);
    expect(blocked.body.error).toBe('acceptance-withdrawn');
    expect(s.trust.getTrustLevel('calendar', 'write').level).not.toBe('autonomous');
    const stillWaiting = await s.bearer(request(s.app).get('/trust/requests'));
    expect(stillWaiting.body.requests.find((x: { requestId: string }) => x.requestId === pending.requestId)).toMatchObject({ status: 'open' });
  });
});
