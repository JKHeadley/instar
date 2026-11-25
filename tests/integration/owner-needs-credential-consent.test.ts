import express, { type Request } from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { canonicalString, ReplayGuard, verifyDeviceRequest } from '../../src/core/MobileDeviceKeys.js';
import { createOwnerNeedsCredentialConsent, type CredentialRequestBinding } from '../../src/server/ownerNeedsCredentialConsent.js';
import { SecretDrop, type CreateSecretRequestOptions } from '../../src/server/SecretDrop.js';
import { makeDevice } from '../helpers/mobileDevice.js';

const HOST = 'credential-fixture.example.test';
const PATH = '/fixture/credential/ask-1';
const REQUEST_ID = 'ask-1';
const OWNER_DEVICE = 'fixture-owner-device';
const TEAM_DEVICE = 'fixture-team-device';
const VALUE = 'sample value for the disposable test';
const drops: SecretDrop[] = [];

afterEach(() => {
  for (const drop of drops.splice(0)) drop.shutdown();
  vi.restoreAllMocks();
});

function setup(options: Partial<CreateSecretRequestOptions> = {}) {
  const drop = new SecretDrop('Disposable Needs You agent');
  drops.push(drop);
  const mint = () => drop.create({ label: 'Sample credential', mintAuth: 'owner-phone', ...options }).token;
  const token = mint();
  const presentation = { title: 'Enter sample credential', why: 'The test workflow needs one value.', detail: null };
  let binding: CredentialRequestBinding | null = { ownerId: 'fixture-owner', revision: 1, dropToken: token, presentation };
  let ownerActive = true;
  const owner = makeDevice(), team = makeDevice();
  const admitted = new WeakMap<Request, string>();
  const replay = new ReplayGuard();
  const adapter = createOwnerNeedsCredentialConsent({
    drop, bindingFor: id => id === REQUEST_ID ? binding : null,
    signedOwnerFor: req => admitted.get(req) === OWNER_DEVICE && ownerActive ? { id: 'fixture-owner' } : null,
  });

  const app = express();
  app.use(express.json({ limit: '16kb', verify: (req, _res, raw) => { Object.assign(req, { fixtureRaw: raw }); } }));
  app.use((req, res, next) => {
    const result = verifyDeviceRequest({
      deviceId: req.get('X-Instar-Device'), time: req.get('X-Instar-Device-Time'), sig: req.get('X-Instar-Device-Sig'),
      method: req.method, pathWithQuery: req.originalUrl, rawBody: (req as Request & { fixtureRaw?: Buffer }).fixtureRaw,
    }, id => {
      if (id === OWNER_DEVICE && ownerActive) return { publicKey: owner.publicKey, host: HOST, status: 'active' };
      if (id === TEAM_DEVICE) return { publicKey: team.publicKey, host: HOST, status: 'active' };
      return null;
    }, new Set(['active']), replay);
    if (!result.ok) { res.status(401).json({ error: 'device authorization required' }); return; }
    admitted.set(req, result.deviceId);
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
  app.get(PATH + '/card', (req, res) => {
    const candidate = adapter.candidate(req, REQUEST_ID);
    const action = candidate?.actions[0];
    if (!action || !candidate.verifiesCurrentOwnerRequest(action)) { res.sendStatus(404); return; }
    res.json({ action, ...candidate.presentation });
  });
  app.get(PATH, (req, res) => {
    const disclosure = adapter.disclose(req, REQUEST_ID);
    if (!disclosure) { res.sendStatus(404); return; }
    res.json(disclosure);
  });
  app.post('/fixture/credential/:requestId', (req, res) => {
    const { disclosureId, value, ...extra } = req.body ?? {};
    if (Object.keys(extra).length) { res.sendStatus(400); return; }
    const outcome = adapter.submit(req, REQUEST_ID, disclosureId, value);
    res.status(outcome === 'applied' ? 200 : outcome === 'invalid' ? 400 : 409).json({ outcome });
  });

  let sequence = 0;
  function signed(method: 'GET' | 'POST', path: string, body?: unknown, deviceId = OWNER_DEVICE) {
    const raw = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const time = String(Date.now() + ++sequence);
    const device = deviceId === OWNER_DEVICE ? owner : team;
    const sig = device.sign(canonicalString(deviceId, HOST, method, path, time, raw));
    return (wireBody = body) => {
      const call = (method === 'GET' ? request(app).get(path) : request(app).post(path))
        .set('X-Instar-Device', deviceId).set('X-Instar-Device-Time', time).set('X-Instar-Device-Sig', sig);
      return wireBody === undefined ? call : call.set('Content-Type', 'application/json').send(JSON.stringify(wireBody));
    };
  }
  return { app, drop, token, signed, presentation,
    replace: () => { const replacement = mint(); binding = { ownerId: 'fixture-owner', revision: 2, dropToken: replacement, presentation }; return replacement; },
    reassign: () => { binding = { ownerId: 'other-owner', revision: 2, dropToken: token, presentation }; },
    restore: () => { binding = { ownerId: 'fixture-owner', revision: 3, dropToken: token, presentation }; },
    revoke: () => { ownerActive = false; },
  };
}

describe('disposable signed Needs You credential consent', () => {
  it('publishes only the opaque action, then submits the fixture value once under the signed owner', async () => {
    const { drop, token, signed, presentation } = setup();
    const card = await signed('GET', PATH + '/card')().expect(200);
    expect(card.body).toEqual({ action: { kind: 'credential', requestId: REQUEST_ID }, ...presentation });
    const shown = await signed('GET', PATH)().expect(200);
    expect(shown.body).toMatchObject({ requestId: REQUEST_ID, ...presentation, inputLabel: 'Credential value' });
    expect(shown.body.disclosureId).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(shown.body)).not.toContain(token);
    const body = { disclosureId: shown.body.disclosureId, value: VALUE };
    const post = signed('POST', PATH, body);
    await post().expect(200, { outcome: 'applied' });
    await post().expect(401);
    await signed('POST', PATH, body)().expect(409, { outcome: 'stale' });
    expect(drop.getPending(token)).toBeNull();
    expect(drop.peekReceived(token)?.values).toEqual({ secret: VALUE });
  });

  it('refuses an unsigned, non-owner or body-tampered submission without consuming the request', async () => {
    const { app, drop, token, signed } = setup();
    const shown = await signed('GET', PATH)().expect(200);
    const body = { disclosureId: shown.body.disclosureId, value: VALUE };
    await request(app).post(PATH).send(body).expect(401);
    await signed('GET', PATH + '/card', undefined, TEAM_DEVICE)().expect(404);
    await signed('POST', PATH, body, TEAM_DEVICE)().expect(409);
    await signed('POST', PATH, body)({ ...body, value: 'changed fixture text' }).expect(401);
    await signed('POST', '/fixture/credential/another-request', body)().expect(400);
    expect(drop.getPending(token)).not.toBeNull();
    expect(drop.peekReceived(token)).toBeNull();
  });

  it.each(['replace', 'reassign', 'restore', 'revoke', 'expire'] as const)('refuses when the disclosed request changes: %s', async change => {
    const env = setup();
    const shown = await env.signed('GET', PATH)().expect(200);
    let replacement: string | undefined;
    if (change === 'replace') replacement = env.replace();
    else if (change === 'restore') { env.reassign(); env.restore(); }
    else if (change === 'expire') vi.spyOn(Date, 'now').mockReturnValue(env.drop.getPending(env.token)!.expiresAt + 1);
    else env[change]();
    const body = { disclosureId: shown.body.disclosureId, value: VALUE };
    await env.signed('POST', PATH, body)().expect(change === 'revoke' ? 401 : 409);
    expect(env.drop.peekReceived(env.token)).toBeNull();
    if (change !== 'expire') expect(env.drop.getPending(env.token)).not.toBeNull();
    if (replacement) {
      expect(env.drop.getPending(replacement)).not.toBeNull();
      expect(env.drop.peekReceived(replacement)).toBeNull();
    }
  });

  it.each([
    { mintAuth: 'none' },
    { browserHost: 'example.test' },
    { senderVerification: { senderPubKeyHex: 'aa'.repeat(32) } },
    { fields: [{ name: 'one', label: 'One' }, { name: 'two', label: 'Two' }] },
  ] satisfies Partial<CreateSecretRequestOptions>[])('suppresses requests outside the disposable one-field scope', async options => {
    const { drop, token, signed } = setup(options);
    await signed('GET', PATH + '/card')().expect(404);
    await signed('GET', PATH)().expect(404);
    expect(drop.getPending(token)).not.toBeNull();
    expect(drop.peekReceived(token)).toBeNull();
  });
});
