/** Real runtime-generated configuration disclosure survives the shipped app's summary decoder. */
import { afterAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import { bootTrustAppServer, cleanupTrustAppServers, DISCLOSURE, DHASH } from '../helpers/trustAppServer.js';

afterAll(async () => { await cleanupTrustAppServers('tests/e2e/app-approval-disclosure-alive.test.ts'); });

describe('App approval disclosure E2E', () => {
  it('renders a long real configuration proposal whole before its exact device approval applies it', async () => {
    const s = await bootTrustAppServer('approval-disclosure-e2e-');
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
    const decoded = (row.summary as string[]).slice(0, 40).map(line => [...new Intl.Segmenter('en', { granularity: 'grapheme' }).segment(line)].slice(0, 400).map(part => part.segment).join(''));
    expect(decoded).toEqual(row.summary);
    expect(decoded.join('')).toBe(original.summary.join('\n'));
    expect(decoded.join('')).toContain('"notes"');
    expect(decoded.join('')).toContain('"files"');
    const outcome = await mac.act({ action: 'approve-widening', target: row.requestId, proposalHash: row.proposalHash }, `/mobile/trust/requests/${row.requestId}/approve`,
      { proposalHash: row.proposalHash }, `approve-widening ${row.requestId} ${row.proposalHash}`);
    expect(outcome.status, JSON.stringify(outcome.body)).toBe(200);
    expect(outcome.body.status).toBe('applied');
    const actual = JSON.parse(fs.readFileSync(path.join(s.stateDir, 'config.json'), 'utf8'));
    expect(actual.externalOperations).toEqual(patch.externalOperations);
  });
});
