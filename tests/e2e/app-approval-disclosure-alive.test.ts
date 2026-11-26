/** Real runtime-generated configuration disclosure survives the shipped app's summary decoder. */
import { afterAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import type { Server } from 'node:http';
import { SecretStore } from '../../src/core/SecretStore.js';
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
    const s = await bootTrustAppServer('needs-production-provider-e2e-', undefined, null, undefined, 'default');
    const listener = s.app.listen(0, '127.0.0.1');
    listeners.push(listener);
    if (!listener.listening) await new Promise<void>(resolve => listener.once('listening', resolve));
    s.config.port = (listener.address() as { port: number }).port;
    await s.bearer(request(s.app).get('/needs/canary')).expect(503, { error: 'needs-canary-off' });
    const mac = await s.pair({ local: true, name: 'Board policy test Mac' });
    const needs = () => mac.signed('GET', '/mobile/needs').set('X-Instar-Needs-Contract', 'in-place-v1');
    expect((await needs().expect(200)).body).toMatchObject({ schemaVersion: 2, items: [] });

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

  it('counts a pending private-chat approval for its signed owner without disclosing a native action', async () => {
    const s = await bootTrustAppServer('needs-chat-provider-e2e-', undefined, {
      getOwnerUserId: () => 777,
      sendOwnerDirect: async () => ({ messageId: 123 }),
    }, undefined, true);
    const listener = s.app.listen(0, '127.0.0.1');
    listeners.push(listener);
    if (!listener.listening) await new Promise<void>(resolve => listener.once('listening', resolve));
    s.config.port = (listener.address() as { port: number }).port;
    await s.runtime.store.write('acceptance', {
      acceptanceId: 'fixture-chat', principal: 'owner', adapter: 'telegram', accountId: '777',
      acceptedAt: new Date().toISOString(), messageId: '100',
    });
    const proposed = await s.bearer(request(s.app).post('/trust/requests'))
      .send({ change: { kind: 'trust-grant', service: 'gmail', operation: 'write', level: 'autonomous' } }).expect(202);
    expect(proposed.body.via).toBe('chat');
    const mac = await s.pair({ local: true, name: 'Paired owner' });
    const legacy = await mac.signed('GET', '/mobile/needs').expect(426);
    expect(legacy.body).toEqual({ error: 'needs-client-update-required', detail: expect.any(String) });
    const owner = await mac.signed('GET', '/mobile/needs').set('X-Instar-Needs-Contract', 'in-place-v1').expect(200);
    expect(owner.body).toMatchObject({ schemaVersion: 2, items: [], couldNotCheckApprovalCount: 1, complete: false });
    expect(JSON.stringify(owner.body)).not.toContain(proposed.body.requestId);
    expect(s.runtime.store.request(proposed.body.requestId)).toMatchObject({ status: 'open', adapter: 'telegram' });
  });

  it('binds an explicitly addressed secret request only to a current native owner device', async () => {
    const s = await bootTrustAppServer('needs-credential-mint-e2e-');
    const mac = await s.pair({ local: true, name: 'Credential test Mac' });
    const mint = (body: Record<string, unknown>) => s.bearer(request(s.app).post('/secrets/request')).send({ label: 'Fixture key', ...body });
    const ordinary = await mint({});
    expect(ordinary.status, ordinary.body.error).toBe(201);
    expect(ordinary.body).not.toHaveProperty('needsRequestId');
    await mint({ needsOwnerDeviceId: 'unknown' }).expect(404);
    await mint({ needsOwnerDeviceId: mac.id, browserHost: 'example.test' }).expect(400);
    await mint({ needsOwnerDeviceId: mac.id, topicId: 42 }).expect(400);
    await mint({ needsOwnerDeviceId: mac.id, fields: [{ name: 'api key', label: 'Key' }] }).expect(400);
    const bound = await mint({ needsOwnerDeviceId: mac.id });
    expect(bound.status, bound.body.error).toBe(201);
    expect(bound.body.needsRequestId).toMatch(/^cr-[a-f0-9]{32}$/);
    expect(bound.body.needsRequestId).not.toBe(bound.body.token);
    const pending = await s.bearer(request(s.app).get('/secrets/pending')).expect(200);
    expect(pending.body.pending).toHaveLength(2);
    expect(JSON.stringify(pending.body)).not.toContain(bound.body.needsRequestId);
    expect(s.server.mobilePairing!.devices.setPerson(mac.id, { userId: 'member', role: 'msp' })).not.toBeNull();
    await mint({ needsOwnerDeviceId: mac.id }).expect(404);
    expect(s.server.mobilePairing!.devices.revoke(mac.id)).toBe(true);
    await mint({ needsOwnerDeviceId: mac.id }).expect(404);
  });

  it('lists, discloses and consumes a credential only for its signed native owner', async () => {
    const s = await bootTrustAppServer('needs-credential-submit-e2e-', undefined, null, undefined, 'default');
    s.config.secrets = { forceFileKey: true };
    const listener = s.app.listen(0, '127.0.0.1');
    listeners.push(listener);
    if (!listener.listening) await new Promise<void>(resolve => listener.once('listening', resolve));
    s.config.port = (listener.address() as { port: number }).port;
    const owner = await s.pair({ local: true, name: 'Assigned Mac' });
    const other = await s.pair({ local: true, name: 'Other Mac' });
    const minted = await s.bearer(request(s.app).post('/secrets/request')).send({
      label: 'Fixture credential', description: 'Connect the fixture service.', needsOwnerDeviceId: owner.id,
    }).expect(201);
    const requestId: string = minted.body.needsRequestId;
    const path = `/mobile/needs/credentials/${requestId}`;
    const list = (device: typeof owner) => device.signed('GET', '/mobile/needs').set('X-Instar-Needs-Contract', 'in-place-v1');
    const card = (await list(owner).expect(200)).body.items;
    expect(card).toEqual([expect.objectContaining({ ownerAction: 'credential', action: { kind: 'credential', requestId } })]);
    expect(JSON.stringify(card)).not.toContain(minted.body.token);
    expect((await list(other).expect(200)).body.items).toEqual([]);
    await other.signed('GET', path).expect(404);
    const disclosure = await owner.signed('GET', path).expect(200);
    expect(disclosure.body).toMatchObject({ requestId, disclosureId: expect.any(String), title: 'Fixture credential', why: 'Connect the fixture service.', detail: expect.stringContaining('trust-app') });
    expect(JSON.stringify(disclosure.body)).not.toContain(minted.body.token);
    const submit = { disclosureId: disclosure.body.disclosureId, value: 'disposable test credential' };
    await other.signed('POST', path, submit).expect(409);
    await owner.signed('POST', path, { ...submit, disclosureId: '0'.repeat(64) }).expect(409);
    s.config.secrets.persistDrops = false;
    await owner.signed('POST', path, submit).expect(503, { outcome: 'unavailable' });
    s.config.secrets.persistDrops = true;
    const failStorage = vi.spyOn(SecretStore.prototype, 'set').mockImplementationOnce(() => { throw new Error('fixture disk unavailable'); });
    try {
      await owner.signed('POST', path, submit).expect(503, { outcome: 'unavailable' });
    } finally {
      failStorage.mockRestore();
    }
    expect((await list(owner).expect(200)).body.items).toHaveLength(1);
    const failSync = vi.spyOn(SecretStore.prototype, 'syncDurably').mockImplementationOnce(() => { throw new Error('fixture sync unavailable'); });
    try {
      await owner.signed('POST', path, submit).expect(503, { outcome: 'unavailable' });
    } finally {
      failSync.mockRestore();
    }
    const privateLink = `/secrets/drop/${minted.body.token}`;
    const legacyForm = await request(s.app).get(privateLink).expect(200);
    const csrf = legacyForm.text.match(/name="_csrf" value="([^"]+)"/)?.[1];
    expect(csrf).toBeTruthy();
    await request(s.app).post(privateLink).send({ _csrf: csrf, secret: 'different fixture value' }).expect(503);
    await s.bearer(request(s.app).post(`/secrets/retrieve/${minted.body.token}?consume=true`)).expect(409);
    await owner.signed('POST', path, { ...submit, value: 'different fixture value' }).expect(503, { outcome: 'unavailable' });
    await owner.signed('POST', path, submit).expect(200, { outcome: 'applied' });
    await owner.signed('POST', path, submit).expect(409);
    expect((await list(owner).expect(200)).body.items).toEqual([]);
    const stored = new SecretStore({ stateDir: s.stateDir, forceFileKey: true }).get(
      `secretDrops.${minted.body.token}`,
    );
    expect(stored).toMatchObject({ values: { secret: submit.value } });
    const replaced = await s.bearer(request(s.app).post('/secrets/request')).send({
      label: 'Another fixture credential', needsOwnerDeviceId: owner.id,
    }).expect(201);
    const replacedPath = `/mobile/needs/credentials/${replaced.body.needsRequestId}`;
    const reviewed = await owner.signed('GET', replacedPath).expect(200);
    const devices = s.server.mobilePairing!.devices;
    expect(devices.setPerson(owner.id, { userId: 'member', role: 'msp' })).not.toBeNull();
    expect(devices.setPerson(owner.id, { userId: null, role: 'owner' })).not.toBeNull();
    await owner.signed('POST', replacedPath, { ...submit, disclosureId: reviewed.body.disclosureId }).expect(409);
    expect((await list(owner).expect(200)).body.items).toEqual([]);
    expect((await s.bearer(request(s.app).get('/secrets/pending')).expect(200)).body.pending).toHaveLength(1);
    const abandoned = await s.bearer(request(s.app).post('/secrets/request')).send({
      label: 'Canceled fixture credential', needsOwnerDeviceId: owner.id,
    }).expect(201);
    const abandonedPath = `/mobile/needs/credentials/${abandoned.body.needsRequestId}`;
    const abandonedDisclosure = await owner.signed('GET', abandonedPath).expect(200);
    const syncFailure = vi.spyOn(SecretStore.prototype, 'syncDurably').mockImplementationOnce(() => { throw new Error('fixture sync unavailable'); });
    try {
      await owner.signed('POST', abandonedPath, { ...submit, disclosureId: abandonedDisclosure.body.disclosureId }).expect(503);
    } finally {
      syncFailure.mockRestore();
    }
    await s.bearer(request(s.app).delete(`/secrets/pending/${abandoned.body.token}`)).expect(200);
    await s.bearer(request(s.app).post(`/secrets/retrieve/${abandoned.body.token}?consume=true`)).expect(409);
  });

});
