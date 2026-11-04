/**
 * A yes needs a verified surface (docs/specs/recommended-services.md, Yes): a single-use token bound
 * to owner, service, machine and text, plus the PIN. Both sides of each boundary.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { RecommendedServicesLedger } from '../../src/recommended/RecommendedServicesLedger.js';
import { RECOMMENDED_SERVICE_CATALOG, offerTextHash, type CatalogRow } from '../../src/recommended/catalog.js';
import { CONFIRM_TOKEN_TTL_MS, MAX_MINTS_PER_MINUTE, confirmTokensFile } from '../../src/recommended/confirmTokens.js';
import { registerRecommendedServiceRoutes } from '../../src/server/recommendedServiceRoutes.js';
import { authMiddleware } from '../../src/server/middleware.js';
import type { MachineKeyLookup, MachineSigner } from '../../src/core/AppRecordSignatures.js';

const { privateKey } = crypto.generateKeyPairSync('ed25519');
const signerFor = (id: string): MachineSigner => ({
  machineId: () => id, signerKeyHash: () => 'h',
  sign: (p: string) => ({ machineId: id, signerKeyHash: 'h', sig: crypto.sign(null, Buffer.from(p), privateKey).toString('base64') }) as ReturnType<MachineSigner['sign']>,
});
const PROVEN: CatalogRow = { ...RECOMMENDED_SERVICE_CATALOG.find((r) => r.id === 'jev')!, setupRecipe: 'jev-v1' };
const PATH = '/recommended-services/jev/confirm';

describe('recommended services confirm', () => {
  let dir: string;
  let ledger: RecommendedServicesLedger;
  let owner: string | null;
  let now: number;
  let catalog: CatalogRow[];
  let approvals: string[][];
  let commitments: string[];
  let approvalThrows: boolean;
  let pinChecks: number;

  const app = () => {
    const a = express();
    a.use(express.json());
    const router = express.Router();
    registerRecommendedServiceRoutes(router, {
      ledger: () => ledger, stateDir: dir, owner: () => owner, catalog, now: () => now,
      checkPin: (req, res) => {
        if ((req.body as { pin?: string }).pin === '1234') return true;
        res.status(403).json({ error: 'pin' });
        return false;
      },
      checkConfirmPin: (req, res) => {
        pinChecks += 1;
        if ((req.body as { pin?: string }).pin === '1234') return true;
        res.status(403).json({ error: 'pin' });
        return false;
      },
      recordApproval: (subject, ref) => { if (approvalThrows) throw new Error('disk'); approvals.push([subject, ref]); },
      openCommitment: (_name, service) => { commitments.push(service); },
    });
    a.use(router);
    return a;
  };
  const shared = { app: null as express.Express | null };
  // The rate limit lives in the router's store, so this one test keeps a single app.
  const app2 = () => (shared.app ??= app());
  const open = async () => (await request(app()).get(PATH)).body.token as string;
  const confirm = (token: string, pin = '1234') => request(app()).post(PATH).set('X-Instar-Request', '1').send({ token, pin, answer: 'yes' });
  const decline = (token: string, reason?: string, pin = '1234') => request(app()).post(PATH).set('X-Instar-Request', '1').send({ token, pin, answer: 'no', reason });

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'rec-confirm-'));
    ledger = new RecommendedServicesLedger({ stateDir: dir, signer: signerFor('m_a'), keyLookup: (() => ({ status: 'unknown' })) as unknown as MachineKeyLookup });
    owner = '42'; now = 1_000_000; catalog = [PROVEN]; approvals = []; commitments = []; approvalThrows = false; pinChecks = 0; shared.app = null;
  });
  afterEach(() => SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/integration/recommended-services-confirm.test.ts' }));

  it('a real yes saves the choice, the grant, the approval and the commitment', async () => {
    const res = await confirm(await open());
    expect(res.status).toBe(200);
    expect(res.body.choice).toBe('yes');
    const grant = ledger.activeGrant('jev', 'm_a')!;
    expect(grant).toMatchObject({ grantMachine: 'm_a', principal: '42', origin: 'person-asked' });
    expect(approvals).toEqual([['recommended-service:jev', grant.eventId]]);
    expect(commitments).toEqual(['jev']);
  });

  it('a service with no proven setup gets no token and no yes', async () => {
    catalog = [RECOMMENDED_SERVICE_CATALOG.find((r) => r.id === 'jev')!];
    const page = await request(app()).get(PATH);
    expect(page.status).toBe(409);
    expect(page.body.error).toBe('not-available');
    expect(page.body.token).toBeUndefined();
    expect((await confirm('anything')).status).toBe(409);
    expect(pinChecks).toBe(0);
    expect(ledger.effective('jev').choice).toBe('unset');
  });

  it('a recipe withdrawn after the page opened refuses the yes', async () => {
    const token = await open();
    catalog = [{ ...PROVEN, setupRecipe: null }];
    expect((await confirm(token)).body.error).toBe('not-available');
    expect(ledger.effective('jev').choice).toBe('unset');
  });

  it('an answer must be stated: leaving it out never creates a yes', async () => {
    const res = await request(app()).post(PATH).set('X-Instar-Request', '1').send({ token: await open(), pin: '1234' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid-answer');
    expect(ledger.effective('jev').choice).toBe('unset');
  });

  it('a PIN is never looked at without an available service and a live token, so nobody can test guesses', async () => {
    expect((await confirm('forged', '0000')).body.error).toBe('token-refused');
    catalog = [{ ...PROVEN, setupRecipe: null }];
    expect((await confirm('forged', '0000')).body.error).toBe('not-available');
    expect(pinChecks).toBe(0);
  });

  it('a no made on another machine voids a page opened before it', async () => {
    const token = await open();
    const other = new RecommendedServicesLedger({ stateDir: `${dir}/b`, signer: signerFor('m_b'), keyLookup: (() => ({ status: 'unknown' })) as unknown as MachineKeyLookup });
    const no = other.recordNo({ service: 'jev', shutdown: 'none', reason: 'none', origin: 'owner-surface' });
    fs.mkdirSync(path.join(dir, 'state', 'recommended-services'), { recursive: true });
    fs.appendFileSync(path.join(dir, 'state', 'recommended-services', 'ledger.jsonl'), `${JSON.stringify(no)}\n`);
    ledger = new RecommendedServicesLedger({ stateDir: dir, signer: signerFor('m_a'), keyLookup: (() => ({ status: 'unknown' })) as unknown as MachineKeyLookup });
    const res = await confirm(token);
    expect(res.body.error).toBe('no-since-open');
    expect(ledger.effective('jev').choice).toBe('no');
    expect((await confirm(await open())).body.choice).toBe('yes');
  });

  it('a second tab does not write a second yes, approval or commitment', async () => {
    const [a, b] = [await open(), await open()];
    expect((await confirm(a)).status).toBe(200);
    expect((await confirm(b)).status).toBe(200);
    expect(ledger.all()).toHaveLength(1);
    expect(approvals).toHaveLength(1);
    expect(commitments).toHaveLength(1);
  });

  it('a yes to changed text is a fresh consent, not a repeat of the old one', async () => {
    await confirm(await open());
    catalog = [{ ...PROVEN, cost: 'A new price.' }];
    expect((await confirm(await open())).status).toBe(200);
    expect(ledger.all().filter((r) => r.type === 'choice' && r.choice === 'yes')).toHaveLength(2);
    expect(approvals).toHaveLength(2);
    expect(ledger.activeGrant('jev', 'm_a')!.offerTextHash).not.toBe(ledger.all()[0].type === 'choice' ? ledger.all()[0].offerTextHash : '');
  });

  it('a new owner’s yes gets its own row', async () => {
    await confirm(await open());
    owner = '99';
    await confirm(await open());
    expect(ledger.activeGrant('jev', 'm_a')!.principal).toBe('99');
  });

  describe('a no from the page', () => {
    it('saves the no and its reason, and gives no grant, approval or commitment', async () => {
      const res = await decline(await open(), 'cost');
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ choice: 'no', reason: 'cost', shutdown: 'none' });
      expect(ledger.activeGrant('jev', 'm_a')).toBeNull();
      expect(approvals).toEqual([]);
      expect(commitments).toEqual([]);
    });

    it('keeps what they declined, and closes every other open page', async () => {
      const [a, b] = [await open(), await open()];
      await decline(a);
      const row = ledger.all()[0];
      expect(row.type === 'choice' && row.offerTextHash).toBe(offerTextHash(PROVEN));
      expect(row.type === 'choice' && row.origin).toBe('owner-surface');
      expect((await decline(b)).body.error).toBe('token-refused');
      expect(ledger.all()).toHaveLength(1);
    });

    it('voids a grant already given', async () => {
      await confirm(await open());
      expect(ledger.activeGrant('jev', 'm_a')).not.toBeNull();
      await decline(await open());
      expect(ledger.activeGrant('jev', 'm_a')).toBeNull();
      expect(ledger.effective('jev').choice).toBe('no');
    });

    it('still lands when the text changed, because refusing it would keep what they declined', async () => {
      const token = await open();
      catalog = [{ ...PROVEN, cost: 'A new price.' }];
      expect((await decline(token)).body.choice).toBe('no');
    });

    it('needs the PIN and a live token, and spends the token', async () => {
      const token = await open();
      expect((await decline(token, 'none', '0000')).status).toBe(403);
      expect(ledger.effective('jev').choice).toBe('unset');
      expect((await decline('forged')).body.error).toBe('token-refused');
      expect((await decline(token)).status).toBe(200);
      expect((await decline(token)).body.error).toBe('token-refused');
    });

    it('refuses a made-up reason or answer before reading the PIN', async () => {
      const token = await open();
      expect((await decline(token, 'because')).status).toBe(400);
      expect((await request(app()).post(PATH).set('X-Instar-Request', '1').send({ token, pin: '1234', answer: 'maybe' })).status).toBe(400);
      expect(pinChecks).toBe(0);
    });

    it('a page opened before a recipe was withdrawn can still say no', async () => {
      const token = await open();
      catalog = [{ ...PROVEN, setupRecipe: null }];
      expect((await decline(token)).body.choice).toBe('no');
    });
  });

  it('the list says whether this machine holds a grant, not just whether a yes exists', async () => {
    const read = async () => (await request(app()).get('/recommended-services')).body.services[0];
    expect((await read()).grantedHere).toBe(false);
    await confirm(await open());
    expect((await read()).grantedHere).toBe(true);
    await decline(await open());
    expect((await read()).grantedHere).toBe(false);
    await confirm(await open());
    expect((await read()).grantedHere).toBe(true);
  });

  it('a no cancels a grant even when a yes follows for another machine', async () => {
    await confirm(await open());
    await decline(await open());
    ledger.recordYes({ service: 'jev', origin: 'person-asked', offerTextHash: 'h', grantMachine: 'm_b', principal: '42' });
    const row = (await request(app()).get('/recommended-services')).body.services[0];
    expect(row.choice).toBe('yes');
    expect(row.grantedHere).toBe(false);
  });

  it('opening the page faster than a person could is refused and writes nothing', async () => {
    for (let i = 0; i < MAX_MINTS_PER_MINUTE; i += 1) expect((await request(app2()).get(PATH)).status).toBe(200);
    const before = fs.readFileSync(confirmTokensFile(dir), 'utf8');
    const res = await request(app2()).get(PATH);
    expect(res.status).toBe(429);
    expect(res.body.error).toBe('too-many-pages');
    expect(res.body.token).toBeUndefined();
    expect(fs.readFileSync(confirmTokensFile(dir), 'utf8')).toBe(before);
    now += 60_001;
    expect((await request(app2()).get(PATH)).status).toBe(200);
  });

  it('no owner means no token', async () => {
    owner = null;
    expect((await request(app()).get(PATH)).body.error).toBe('no-owner');
  });

  it('a wrong PIN changes nothing and does not spend the token', async () => {
    const token = await open();
    expect((await confirm(token, '0000')).status).toBe(403);
    expect(ledger.effective('jev').choice).toBe('unset');
    expect((await confirm(token)).status).toBe(200);
  });

  it('needs the request header', async () => {
    const res = await request(app()).post(PATH).send({ token: await open(), pin: '1234', answer: 'yes' });
    expect(res.status).toBe(403);
    expect(ledger.effective('jev').choice).toBe('unset');
  });

  it('a token works once', async () => {
    const token = await open();
    expect((await confirm(token)).status).toBe(200);
    const again = await confirm(token);
    expect(again.status).toBe(409);
    expect(again.body.error).toBe('token-refused');
    expect(ledger.all()).toHaveLength(1);
  });

  it('a forged, expired or other service’s token is refused', async () => {
    expect((await confirm('forged')).body.error).toBe('token-refused');
    const token = await open();
    now += CONFIRM_TOKEN_TTL_MS + 1;
    expect((await confirm(token)).body.error).toBe('token-refused');
    now = 1_000_000;
    catalog = [PROVEN, { ...PROVEN, id: 'tailscale' }];
    const other = await open();
    const res = await request(app()).post('/recommended-services/tailscale/confirm').set('X-Instar-Request', '1').send({ token: other, pin: '1234', answer: 'yes' });
    expect(res.body.error).toBe('token-refused');
  });

  it('changed text, a changed owner or another machine refuses, and nothing is saved', async () => {
    let token = await open();
    catalog = [{ ...PROVEN, cost: 'A new price.' }];
    expect((await confirm(token)).body.error).toBe('text-changed');
    catalog = [PROVEN];
    token = await open();
    owner = '99';
    expect((await confirm(token)).body.error).toBe('wrong-owner');
    owner = '42';
    token = await open();
    ledger = new RecommendedServicesLedger({ stateDir: dir, signer: signerFor('m_b'), keyLookup: (() => ({ status: 'unknown' })) as unknown as MachineKeyLookup });
    expect((await confirm(token)).body.error).toBe('wrong-machine');
    expect(ledger.effective('jev').choice).toBe('unset');
  });

  it('a no voids open pages, and a confirmed yes replaces the no', async () => {
    const token = await open();
    await request(app()).post('/recommended-services/jev/no').set('X-Instar-Request', '1').send({ pin: '1234' });
    expect((await confirm(token)).body.error).toBe('token-refused');
    expect((await confirm(await open())).body.choice).toBe('yes');
    expect(ledger.activeGrant('jev', 'm_a')).not.toBeNull();
  });

  it('a no after a yes voids the grant', async () => {
    await confirm(await open());
    now += 1000;
    await new Promise((r) => setTimeout(r, 5));
    await request(app()).post('/recommended-services/jev/no').set('X-Instar-Request', '1').send({ pin: '1234' });
    expect(ledger.activeGrant('jev', 'm_a')).toBeNull();
  });

  it('a failed record never undoes the yes', async () => {
    approvalThrows = true;
    const res = await confirm(await open());
    expect(res.status).toBe(200);
    expect(ledger.effective('jev').choice).toBe('yes');
    expect(commitments).toEqual(['jev']);
  });

  it('stores only a hash of the token, readable by the owner alone', async () => {
    const token = await open();
    const file = confirmTokensFile(dir);
    expect(fs.readFileSync(file, 'utf8')).not.toContain(token);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it('opening a page again and again does not grow the file past its cap', async () => {
    for (let i = 0; i < 60; i += 1) { now += 3_000; await open(); }
    expect(JSON.parse(fs.readFileSync(confirmTokensFile(dir), 'utf8'))).toHaveLength(50);
  });

  describe('auth exemption', () => {
    const gated = () => {
      const a = express();
      a.use(express.json());
      a.use(authMiddleware('secret'));
      a.use((_req, res) => { res.status(200).json({ reached: true }); });
      return a;
    };

    it('reaches the handler without a token only on the exact confirm path', async () => {
      expect((await request(gated()).get(PATH)).body.reached).toBe(true);
      expect((await request(gated()).post(PATH).send({})).body.reached).toBe(true);
    });

    it('does not open anything else', async () => {
      const a = gated();
      expect((await request(a).get('/recommended-services')).status).toBe(401);
      expect((await request(a).post('/recommended-services/jev/no').send({})).status).toBe(401);
      expect((await request(a).get('/recommended-services/jev/confirm/x')).status).toBe(401);
      expect((await request(a).delete(PATH)).status).toBe(401);
      expect((await request(a).get('/recommended-services/../config/confirm')).status).toBe(401);
    });
  });
});
