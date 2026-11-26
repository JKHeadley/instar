/** Real runtime-generated configuration disclosure survives the shipped app's summary decoder. */
import { afterAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import { createServer, type Server } from 'node:http';
import { LocalAttentionItems } from '../../src/core/LocalAttentionItems.js';
import { ownerNeedsTrustApprovalCandidate } from '../../src/server/ownerNeedsTrustApproval.js';
import { bootTrustAppServer, cleanupTrustAppServers, DISCLOSURE, DHASH } from '../helpers/trustAppServer.js';

const listeners: Server[] = [];
afterAll(async () => {
  await Promise.all(listeners.map(server => new Promise<void>(resolve => server.close(() => resolve()))));
  await cleanupTrustAppServers('tests/e2e/app-approval-disclosure-alive.test.ts');
});

describe('App approval disclosure E2E', () => {
  it('renders a long real configuration proposal whole before its exact device approval applies it', async () => {
    let source: { requestId: string; proposalHash: string } | null = null;
    const s = await bootTrustAppServer('approval-disclosure-e2e-', undefined, null, runtime => (item, req) =>
      item.title === 'Trust approval fixture' && source ? ownerNeedsTrustApprovalCandidate(runtime.service, req, source) : null,
    );
    const listener = s.app.listen(0, '127.0.0.1');
    listeners.push(listener);
    if (!listener.listening) await new Promise<void>(resolve => listener.once('listening', resolve));
    s.config.port = (listener.address() as { port: number }).port;
    const attention = new LocalAttentionItems(s.stateDir);
    expect(attention.raise({ id: 'trust-approval-fixture', title: 'Trust approval fixture', category: 'desktop', priority: 'HIGH', source: 'agent', summary: 'A disposable request.' })).toBe(true);
    const mac = await s.pair({ local: true, name: 'Disclosure test Mac' });
    const accepted = await mac.act({ action: 'accept-device', target: mac.id, keyFingerprint: mac.fp, disclosureHash: DHASH }, '/mobile/trust/device-acceptance',
      { keyFingerprint: mac.fp, disclosureHash: DHASH, disclosure: DISCLOSURE, keyPolicy: 'biometryCurrentSet' }, `accept-device ${mac.id} ${mac.fp} ${DHASH}`);
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
    const services = Object.fromEntries(['calendar', 'email', 'documents', 'tasks', 'contacts', 'messages', 'notes', 'files'].map(name => [name, { permissions: ['read', 'write', 'modify', 'delete'], requireApproval: ['delete'] }]));
    const patch = { externalOperations: { enabled: false, services } };
    const opened = await s.bearer(request(s.app).post('/trust/requests')).send({ change: { kind: 'config-patch', patch } });
    expect(opened.status, JSON.stringify(opened.body)).toBe(202);
    expect(opened.body.via).toBe('device');
    const original = s.runtime.store.request(opened.body.requestId)!;
    expect(original.summary.some(line => Array.from(line).length > 400)).toBe(true);
    const listed = await mac.signed('GET', '/mobile/trust/requests');
    expect(listed.status, JSON.stringify(listed.body)).toBe(200);
    const row = listed.body.requests.find((r: { requestId: string }) => r.requestId === opened.body.requestId);
    const approval = s.runtime.service.openDeviceApprovalDisclosure(mac.id, row.requestId);
    expect(approval).toEqual({ requestId: row.requestId, proposalHash: row.proposalHash, summary: row.summary });
    expect(s.runtime.service.openDeviceApprovalDisclosure('different-device', row.requestId)).toBeNull();
    source = { requestId: row.requestId, proposalHash: 'wrong' };
    const needs = () => mac.signed('GET', '/mobile/needs').set('X-Instar-Needs-Contract', 'in-place-v1');
    expect((await needs().expect(200)).body.items).toEqual([]);
    source = { requestId: row.requestId, proposalHash: row.proposalHash };
    expect((await needs().expect(200)).body.items).toEqual([expect.objectContaining({
      title: 'Review a trust change', action: { kind: 'approval', requestId: row.requestId },
    })]);
    const decoded = (row.summary as string[]).slice(0, 40).map(line => [...new Intl.Segmenter('en', { granularity: 'grapheme' }).segment(line)].slice(0, 400).map(part => part.segment).join(''));
    expect(decoded).toEqual(row.summary);
    expect(decoded.join('')).toBe(original.summary.join('\n'));
    expect(decoded.join('')).toContain('"notes"');
    expect(decoded.join('')).toContain('"files"');
    const outcome = await mac.act({ action: 'approve-widening', target: row.requestId, proposalHash: row.proposalHash }, `/mobile/trust/requests/${row.requestId}/approve`,
      { proposalHash: row.proposalHash }, `approve-widening ${row.requestId} ${row.proposalHash}`);
    expect(outcome.status, JSON.stringify(outcome.body)).toBe(200);
    expect(outcome.body.status).toBe('applied');
    expect((await needs().expect(200)).body.items).toEqual([]);
    expect(s.runtime.service.openDeviceApprovalDisclosure(mac.id, row.requestId)).toBeNull();
    const actual = JSON.parse(fs.readFileSync(path.join(s.stateDir, 'config.json'), 'utf8'));
    expect(actual.externalOperations).toEqual(patch.externalOperations);
  });
  it('uses the configured server provider for a signed board-policy request across device approval enrollment', async () => {
    const s = await bootTrustAppServer('needs-production-provider-e2e-', undefined, null, undefined, true);
    const accountIds = ['sagemind-dawn', 'sagemind-adriana'];
    const accountReads = new Map<string, object>([
      ['/subscription-pool?scope=pool', {
        enabled: true,
        accounts: accountIds.map((id, index) => ({
          id, nickname: ['Dawn test account', 'Adriana test account'][index], framework: 'claude-code',
          status: 'needs-reauth', loginCheck: 'ok', machineId: 'm_mini', machineNickname: 'Mac Mini',
        })),
      }],
      ['/subscription-relogin?scope=pool', {
        episodes: accountIds.map(accountId => ({
          id: `repair-${accountId}`, accountId, state: 'suggested', mode: 'approval', machineId: 'm_mini',
        })),
      }],
    ]);
    const listener = createServer((req, res) => {
      const fixture = accountReads.get(req.url ?? '');
      if (!fixture) { s.app(req, res); return; }
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(fixture));
    }).listen(0, '127.0.0.1');
    listeners.push(listener);
    if (!listener.listening) await new Promise<void>(resolve => listener.once('listening', resolve));
    s.config.port = (listener.address() as { port: number }).port;
    await s.bearer(request(s.app).get('/needs/canary')).expect(503, { error: 'needs-canary-off' });
    const mac = await s.pair({ local: true, name: 'Board policy test Mac' });
    const needs = () => mac.signed('GET', '/mobile/needs').set('X-Instar-Needs-Contract', 'in-place-v1');
    expect((await needs().expect(200)).body).toMatchObject({ schemaVersion: 2, items: [], divertedCount: 2 });

    const proposed = await s.bearer(request(s.app).post('/trust/requests'))
      .send({ change: { kind: 'board-policy', policy: 'outward-only' } }).expect(202);
    expect(proposed.body.status).toBe('awaiting-acceptance');
    expect((await needs().expect(200)).body).toMatchObject({ items: [], couldNotCheckApprovalCount: 1 });

    const accepted = await mac.act({ action: 'accept-device', target: mac.id, keyFingerprint: mac.fp, disclosureHash: DHASH }, '/mobile/trust/device-acceptance',
      { keyFingerprint: mac.fp, disclosureHash: DHASH, disclosure: DISCLOSURE, keyPolicy: 'biometryCurrentSet' }, `accept-device ${mac.id} ${mac.fp} ${DHASH}`);
    expect(accepted.status).toBe(200);
    const result = await needs().expect(200);
    expect(result.body.items).toEqual([expect.objectContaining({
      source: 'trust-requests', ownerAction: 'approve', action: { kind: 'approval', requestId: proposed.body.requestId },
    })]);
    const settings = await s.bearer(request(s.app).post('/trust/requests'))
      .send({ change: { kind: 'config-patch', patch: { externalOperations: { enabled: false } } } }).expect(202);
    expect((await needs().expect(200)).body.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: { kind: 'approval', requestId: proposed.body.requestId } }),
      expect.objectContaining({ action: { kind: 'approval', requestId: settings.body.requestId } }),
    ]));

    s.config.mobilePairing!.trustApproval = { enabled: false };
    expect((await needs().expect(200)).body).toMatchObject({ items: [], couldNotCheckApprovalCount: 2 });
  });

});
