/**
 * After a yes the agent owns setup until the recipe's own check passes
 * (docs/specs/recommended-services.md, The agent owns setup). Both sides of each decision.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { RecommendedServicesLedger } from '../../src/recommended/RecommendedServicesLedger.js';
import { RECOMMENDED_SERVICE_CATALOG, isServiceAvailable, type CatalogRow } from '../../src/recommended/catalog.js';
import { SETUP_RECIPES, catalogWithProving } from '../../src/recommended/recipes.js';
import { holdAllSetups, holdSetupForSession, readSetupStates, updateSetupState } from '../../src/recommended/setupState.js';
import { registerRecommendedServiceRoutes } from '../../src/server/recommendedServiceRoutes.js';
import type { MachineKeyLookup, MachineSigner } from '../../src/core/AppRecordSignatures.js';

const { privateKey } = crypto.generateKeyPairSync('ed25519');
const signer: MachineSigner = {
  machineId: () => 'm_a', signerKeyHash: () => 'h',
  sign: (p: string) => ({ machineId: 'm_a', signerKeyHash: 'h', sig: crypto.sign(null, Buffer.from(p), privateKey).toString('base64') }) as ReturnType<MachineSigner['sign']>,
};
const PROVEN: CatalogRow = { ...RECOMMENDED_SERVICE_CATALOG.find((r) => r.id === 'jev')!, setupRecipe: 'jev-v1' };
const VERIFY = '/recommended-services/jev/verify';

describe('recommended services setup', () => {
  let dir: string;
  let ledger: RecommendedServicesLedger;
  let start: ReturnType<typeof vi.fn>;
  let finish: ReturnType<typeof vi.fn>;
  let withdraw: ReturnType<typeof vi.fn>;
  let stop: ReturnType<typeof vi.fn>;
  let stuck: ReturnType<typeof vi.fn>;
  let cleared: ReturnType<typeof vi.fn>;
  let told: ReturnType<typeof vi.fn>;
  let secret: string | null;
  let answer: { ok: boolean; status: number } | Error;
  let reconcile: () => Promise<void>;
  let running: string[];
  let topicSession: string | null;
  let now: number;
  let reach: boolean;
  let otherRoute: boolean;
  let rows: CatalogRow[];

  const app = () => {
    const a = express();
    a.use(express.text({ type: 'text/plain' }));
    a.use(express.json());
    const router = express.Router();
    registerRecommendedServiceRoutes(router, {
      ledger: () => ledger, stateDir: dir, owner: () => '42', catalog: rows, port: 4040, now: () => now,
      checkPin: () => true, checkConfirmPin: () => true, recordApproval: () => undefined,
      openCommitment: () => 'CMT-1', finishCommitment: finish, withdrawCommitment: withdraw, startSetup: start, stopSetup: stop,
      sessionForTopic: () => topicSession,
      isSetupRunning: (id) => running.includes(id), notifyStuck: stuck, clearStuck: cleared, tellOwner: told,
      readSecret: () => secret, writeSecret: (_n, v) => { secret = v; }, deleteSecret: () => { secret = null; },
      canReachOwner: () => reach, otherRouteWorks: async () => otherRoute,
      fetch: (async () => { if (answer instanceof Error) throw answer; return answer; }) as unknown as typeof fetch,
      onReady: (r) => { reconcile = r; },
    });
    a.use(router);
    return a;
  };
  const say = async (a: express.Express, what: 'yes' | 'no') => {
    const { body } = await request(a).get('/recommended-services/jev/confirm');
    return request(a).post('/recommended-services/jev/confirm').set('X-Instar-Request', '1').send({ token: body.token, pin: '1', answer: what });
  };
  const verify = (a: express.Express) => request(a).post(VERIFY).set('X-Instar-Request', '1').send({});
  const started = () => vi.waitFor(() => expect(readSetupStates(dir).jev?.sessionName).toBe('sess-1'));
  const settle = () => new Promise((r) => setTimeout(r, 15));

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'rec-setup-'));
    ledger = new RecommendedServicesLedger({ stateDir: dir, signer, keyLookup: (() => ({ status: 'unknown' })) as unknown as MachineKeyLookup });
    running = [];
    topicSession = null;
    start = vi.fn(async () => { running.push('sess-1'); return { sessionName: 'sess-1', topicId: 7 }; });
    finish = vi.fn(); withdraw = vi.fn(); stuck = vi.fn(async () => true); cleared = vi.fn(); told = vi.fn();
    stop = vi.fn(() => { running = []; return true; });
    secret = null; answer = { ok: true, status: 200 }; now = Date.parse('2026-11-04T12:00:00Z');
    reach = true; otherRoute = true; rows = [PROVEN];
  });
  afterEach(() => SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/integration/recommended-services-setup.test.ts' }));

  it('a yes starts a session in its own topic, with the whole job in its brief', async () => {
    await say(app(), 'yes');
    await started();
    const [service, name, brief] = start.mock.calls[0];
    expect(service).toBe('jev');
    expect(name).toContain('Jev');
    expect(brief).toContain('Secret Drop');
    expect(brief).toContain('grantedHere');
    expect(brief).toContain('http://localhost:4040/recommended-services/jev/verify');
    expect(brief).toContain('recommended-services/jev/key');
    expect(readSetupStates(dir).jev.topicId).toBe(7);
  });

  it('a key already held passes without any session, and is marked, so it can never count as proof', async () => {
    secret = 'old-key';
    await say(app(), 'yes');
    await vi.waitFor(() => expect(readSetupStates(dir).jev?.verified?.result).toBe('pass'));
    expect(start).not.toHaveBeenCalled();
    expect(readSetupStates(dir).jev.alreadyHeld).toBe(true);
    expect(finish).toHaveBeenCalledWith('CMT-1');
    expect(told).toHaveBeenCalledTimes(1);
    expect((await request(app()).get('/recommended-services')).body.services[0]).toMatchObject({ alreadyHeld: true });
  });

  it('a key held during an outage starts nothing and costs nothing', async () => {
    secret = 'old-key';
    answer = new Error('down');
    const a = app();
    await say(a, 'yes');
    await settle();
    expect(start).not.toHaveBeenCalled();
    expect(readSetupStates(dir).jev?.attempts).toBeUndefined();
    answer = { ok: true, status: 200 };
    await reconcile();
    expect(readSetupStates(dir).jev.verified?.result).toBe('pass');
  });

  it('a failed start leaves the yes standing', async () => {
    start.mockRejectedValue(new Error('no capacity'));
    expect((await say(app(), 'yes')).body.choice).toBe('yes');
    await vi.waitFor(() => expect(start).toHaveBeenCalled());
    expect(ledger.activeGrant('jev', 'm_a')).not.toBeNull();
  });

  it('a no while the session is still starting stops it when it arrives', async () => {
    let release: (v: { sessionName: string; topicId: number }) => void = () => undefined;
    start.mockImplementation(() => new Promise((r) => { release = r; }));
    const a = app();
    await say(a, 'yes');
    await vi.waitFor(() => expect(start).toHaveBeenCalled());
    await say(a, 'no');
    running = ['sess-1'];
    release({ sessionName: 'sess-1', topicId: 7 });
    await vi.waitFor(() => expect(stop).toHaveBeenCalledWith('sess-1'));
    expect(readSetupStates(dir).jev.sessionName).toBeUndefined();
  });

  it('verify passes only on the provider accepting the key, and only then closes the promise', async () => {
    const a = app();
    await say(a, 'yes');
    await started();
    expect((await verify(a)).body.result).toBe('fail');
    secret = 'a-key';
    answer = { ok: false, status: 401 };
    expect((await verify(a)).body.result).toBe('fail');
    answer = { ok: false, status: 503 };
    expect((await verify(a)).body.result).toBe('unknown');
    answer = new Error('down');
    expect((await verify(a)).body.result).toBe('unknown');
    expect(finish).not.toHaveBeenCalled();
    answer = { ok: true, status: 200 };
    expect((await verify(a)).body.result).toBe('pass');
    expect(finish).toHaveBeenCalledWith('CMT-1');
    expect(readSetupStates(dir).jev.alreadyHeld).toBeUndefined();
    expect((await request(a).get('/recommended-services')).body.services[0].verified.result).toBe('pass');
  });

  it('an outage never takes a pass away', async () => {
    const a = app();
    await say(a, 'yes');
    await started();
    secret = 'a-key';
    await verify(a);
    answer = new Error('down');
    expect((await verify(a)).body.result).toBe('unknown');
    expect(readSetupStates(dir).jev.verified?.result).toBe('pass');
  });

  it('a refused key does take a pass away', async () => {
    const a = app();
    await say(a, 'yes');
    await started();
    secret = 'a-key';
    await verify(a);
    answer = { ok: false, status: 401 };
    await verify(a);
    expect(readSetupStates(dir).jev.verified?.result).toBe('fail');
  });

  it('a failing check answers instead of hanging', async () => {
    const a = app();
    await say(a, 'yes');
    await started();
    const broken = express();
    broken.use(express.json());
    const router = express.Router();
    registerRecommendedServiceRoutes(router, {
      ledger: () => ledger, stateDir: dir, owner: () => '42', catalog: [PROVEN], port: 1, checkPin: () => true, checkConfirmPin: () => true,
      recordApproval: () => undefined, openCommitment: () => null, finishCommitment: finish, withdrawCommitment: withdraw, startSetup: start, stopSetup: stop,
      isSetupRunning: () => true, notifyStuck: stuck, clearStuck: cleared, tellOwner: told, writeSecret: () => undefined,
      readSecret: () => { throw new Error('vault locked'); },
    });
    broken.use(router);
    expect((await verify(broken)).status).toBe(503);
  });

  it('never puts a key in what it reports or saves', async () => {
    const a = app();
    await say(a, 'yes');
    await started();
    const stored = await request(a).post('/recommended-services/jev/key').set('X-Instar-Request', '1').type('text/plain').send('a-key');
    expect(JSON.stringify(stored.body)).not.toContain('a-key');
    const res = await verify(a);
    expect(JSON.stringify(res.body)).not.toContain('a-key');
    expect(fs.readFileSync(path.join(dir, 'state', 'recommended-service-setup', 'setup.json'), 'utf8')).not.toContain('a-key');
  });

  describe('storing the key', () => {
    const put = (a: express.Express, value: string) => request(a).post('/recommended-services/jev/key').set('X-Instar-Request', '1').type('text/plain').send(value);

    it('stores the recipe’s one secret', async () => {
      const a = app();
      await say(a, 'yes');
      await started();
      expect((await put(a, ' a-key ')).body.stored).toBe(true);
      expect(secret).toBe('a-key');
    });

    it('never replaces a key already held', async () => {
      const a = app();
      await say(a, 'yes');
      await started();
      secret = 'live-key';
      expect((await put(a, 'new-key')).body.error).toBe('already-held');
      expect(secret).toBe('live-key');
    });

    it('setup can correct its own key until it passes, and never after', async () => {
      const a = app();
      await say(a, 'yes');
      await started();
      await put(a, 'typo-key');
      expect((await put(a, 'right-key')).body.stored).toBe(true);
      expect(secret).toBe('right-key');
      await verify(a);
      expect((await put(a, 'another')).body.error).toBe('already-held');
    });

    it('a yes after a no can replace the key setup stored, and still never one that was already here', async () => {
      const a = app();
      await say(a, 'yes');
      await started();
      await put(a, 'first-key');
      await verify(a);
      await say(a, 'no');
      answer = { ok: false, status: 401 };
      await say(a, 'yes');
      expect((await put(a, 'second-key')).body.stored).toBe(true);
      expect(secret).toBe('second-key');
    });

    it('a key that was here before setup stays protected through a no and a yes', async () => {
      const a = app();
      secret = 'live-key';
      answer = { ok: false, status: 401 };
      await say(a, 'yes');
      await say(a, 'no');
      await say(a, 'yes');
      expect((await put(a, 'new-key')).body.error).toBe('already-held');
      expect(secret).toBe('live-key');
    });

    it('needs a yes on this machine, a real value and the header', async () => {
      const a = app();
      expect((await put(a, 'k')).body.error).toBe('not-granted-here');
      await say(a, 'yes');
      await started();
      expect((await put(a, '')).status).toBe(400);
      expect((await put(a, 'two\nlines')).status).toBe(400);
      expect((await put(a, 'has space')).status).toBe(400);
      expect((await request(a).post('/recommended-services/jev/key').send({ value: 'k' })).status).toBe(403);
      expect((await request(a).post('/recommended-services/jev/key').set('X-Instar-Request', '1').send({ value: 'k' })).status).toBe(400);
      expect(secret).toBeNull();
    });
  });

  it('verify is refused with no yes on this machine, and after a no', async () => {
    const a = app();
    expect((await verify(a)).body.error).toBe('not-granted-here');
    await say(a, 'yes');
    await started();
    await say(a, 'no');
    expect((await verify(a)).body.error).toBe('not-granted-here');
    expect(readSetupStates(dir).jev?.verified).toBeUndefined();
  });

  it('needs the request header', async () => {
    const a = app();
    await say(a, 'yes');
    expect((await request(a).post(VERIFY).send({})).status).toBe(403);
  });

  it('a no through the plain route ends setup too', async () => {
    const a = app();
    await say(a, 'yes');
    await started();
    await request(a).post('/recommended-services/jev/no').set('X-Instar-Request', '1').send({});
    expect(stop).toHaveBeenCalledWith('sess-1');
    expect(withdraw).toHaveBeenCalledWith('CMT-1', expect.any(String));
  });

  it('a session that refuses to stop is remembered, so the next check tries again', async () => {
    const a = app();
    await say(a, 'yes');
    await started();
    stop.mockReturnValueOnce(false);
    await say(a, 'no');
    expect(readSetupStates(dir).jev.sessionName).toBe('sess-1');
    await reconcile();
    expect(stop).toHaveBeenCalledTimes(2);
    expect(readSetupStates(dir).jev.sessionName).toBeUndefined();
  });

  it('a yes after a no starts clean, with no old pass hiding a dead session', async () => {
    const a = app();
    await say(a, 'yes');
    await started();
    secret = 'a-key';
    await verify(a);
    await say(a, 'no');
    secret = null;
    expect(readSetupStates(dir).jev.verified).toBeUndefined();
    await say(a, 'yes');
    await vi.waitFor(() => expect(start).toHaveBeenCalledTimes(2));
  });

  describe('the regular check', () => {
    const later = (minutes: number) => { now += minutes * 60_000; };
    const updateStarts = (attempts: number) => updateSetupState(dir, 'jev', { attempts, exhausted: undefined, dormant: undefined, sessionName: undefined, lastAttemptAt: new Date(now - 1000).toISOString() });

    it('does not start a second copy of a session still running', async () => {
      await say(app(), 'yes');
      await started();
      app();
      later(60);
      await reconcile();
      expect(start).toHaveBeenCalledTimes(1);
    });

    it('restarts a session that died quickly, waiting longer each time, then gives one notice and stops', async () => {
      await say(app(), 'yes');
      await started();
      running = [];
      start.mockImplementation(async () => ({ sessionName: 'sess-1', topicId: 7 }));
      app();
      await reconcile();
      expect(start).toHaveBeenCalledTimes(1);
      later(5);
      await reconcile();
      expect(start).toHaveBeenCalledTimes(2);
      expect(start.mock.calls[1][3]).toBe(7);
      later(5);
      await reconcile();
      expect(start).toHaveBeenCalledTimes(2);
      later(5);
      await reconcile();
      expect(start).toHaveBeenCalledTimes(3);
      later(5);
      await reconcile();
      await reconcile();
      expect(start).toHaveBeenCalledTimes(3);
      expect(stuck).toHaveBeenCalledTimes(1);
      expect((await request(app()).get('/recommended-services')).body.services[0].stalled).toBe(true);
    });

    it('a person stopping the session keeps it stopped, and only that session', async () => {
      await say(app(), 'yes');
      await started();
      holdSetupForSession(dir, 'some-other-session');
      expect(readSetupStates(dir).jev.held).toBeUndefined();
      running = [];
      holdSetupForSession(dir, 'sess-1');
      for (let i = 0; i < 4; i += 1) { later(10); await reconcile(); }
      expect(start).toHaveBeenCalledTimes(1);
      expect(stuck).not.toHaveBeenCalled();
      expect((await request(app()).get('/recommended-services')).body.services[0].held).toBe(true);
    });

    it('a session whose person said not now can hold itself, and a new yes starts it again', async () => {
      await say(app(), 'yes');
      await started();
      const refused = await request(app()).post('/recommended-services/jev/hold').send({});
      expect(refused.status).toBe(403);
      expect(readSetupStates(dir).jev.held).toBeUndefined();
      const held = await request(app()).post('/recommended-services/jev/hold').set('X-Instar-Request', '1').send({});
      expect(held.body.held).toBe(true);
      running = [];
      later(10);
      await reconcile();
      expect(start).toHaveBeenCalledTimes(1);
      await say(app(), 'yes');
      await vi.waitFor(() => expect(start).toHaveBeenCalledTimes(2));
      await vi.waitFor(() => expect(readSetupStates(dir).jev.held).toBeUndefined());
    });

    it('a new yes lifts a hold while the session is still open', async () => {
      await say(app(), 'yes');
      await started();
      holdSetupForSession(dir, 'sess-1');
      await say(app(), 'yes');
      await vi.waitFor(() => expect(readSetupStates(dir).jev.held).toBeUndefined());
      expect(start).toHaveBeenCalledTimes(1);
    });

    it('a session a reply brought back under a new name is not started twice, and a no still stops it', async () => {
      await say(app(), 'yes');
      await started();
      holdSetupForSession(dir, 'sess-1');
      running = ['reply-name'];
      topicSession = 'reply-name';
      await say(app(), 'yes');
      await vi.waitFor(() => expect(readSetupStates(dir).jev.sessionName).toBe('reply-name'));
      await settle();
      expect(start).toHaveBeenCalledTimes(1);
      await say(app(), 'no');
      expect(stop).toHaveBeenCalledWith('reply-name');
    });

    it('after a no, a reply in that conversation is left alone', async () => {
      await say(app(), 'yes');
      await started();
      await say(app(), 'no');
      stop.mockClear();
      topicSession = 'reply-name';
      running = ['reply-name'];
      app();
      await reconcile();
      expect(stop).not.toHaveBeenCalled();
      expect(readSetupStates(dir).jev.sessionName).toBeUndefined();
    });

    it('a stop finds a session under its new name through the topic', async () => {
      await say(app(), 'yes');
      await started();
      holdSetupForSession(dir, 'reply-name', 7);
      expect(readSetupStates(dir).jev.held).toBe(true);
    });

    it('a repeat yes after a hold gets its restarts back', async () => {
      await say(app(), 'yes');
      await started();
      updateSetupState(dir, 'jev', { attempts: 3 });
      holdSetupForSession(dir, 'sess-1');
      running = [];
      await say(app(), 'yes');
      await vi.waitFor(() => expect(start).toHaveBeenCalledTimes(2));
      await vi.waitFor(() => expect(readSetupStates(dir).jev.attempts).toBe(1));
    });

    it('stopping everything holds a setup waiting to restart, but leaves a passed one alone', async () => {
      await say(app(), 'yes');
      await started();
      running = [];
      updateSetupState(dir, 'other', { verified: { at: 'x', result: 'pass', detail: 'ok' } });
      holdAllSetups(dir);
      expect(readSetupStates(dir).jev.held).toBe(true);
      expect(readSetupStates(dir).other.held).toBeUndefined();
    });

    it('a pass clears a hold, with or without an open promise', async () => {
      await say(app(), 'yes');
      await started();
      updateSetupState(dir, 'jev', { commitmentId: undefined });
      holdSetupForSession(dir, 'sess-1');
      secret = 'a-key';
      await verify(app());
      expect(readSetupStates(dir).jev.held).toBeUndefined();
    });

    it('the four named stop paths call the hold', () => {
      const source = (f: string) => fs.readFileSync(path.join(process.cwd(), f), 'utf8');
      const server = source('src/commands/server.ts');
      expect(server.slice(server.indexOf('telegram.onSentinelKillSession ='), server.indexOf('telegram.onSentinelKillSession =') + 200)).toContain('holdSetupForSession');
      const slack = server.indexOf("'🛑 Emergency stop — all sessions killed.'");
      expect(slack).toBeGreaterThan(0);
      expect(server.slice(server.lastIndexOf("classification.category === 'emergency-stop'", slack), slack)).toContain('holdAllSetups');
      const agentServer = source('src/server/AgentServer.ts');
      expect(agentServer.slice(agentServer.indexOf('killAllSessions: () => {'), agentServer.indexOf('killAllSessions: () => {') + 200)).toContain('holdAllSetups');
      const routes = source('src/server/routes.ts');
      const del = routes.indexOf("router.delete('/sessions/:id'");
      expect(routes.slice(del, routes.indexOf('Remote Session Close', del))).toContain('holdSetupForSession');
    });

    it('tries the notice again if it did not go out', async () => {
      await say(app(), 'yes');
      await started();
      running = [];
      start.mockImplementation(async () => ({ sessionName: 'sess-1', topicId: 7 }));
      app();
      for (let i = 0; i < 4; i += 1) { later(10); await reconcile(); }
      stuck.mockClear();
      stuck.mockResolvedValueOnce(false);
      updateStarts(3);
      await reconcile();
      expect(stuck).toHaveBeenCalledTimes(1);
      await reconcile();
      expect(stuck).toHaveBeenCalledTimes(2);
      await reconcile();
      expect(stuck).toHaveBeenCalledTimes(2);
    });

    it('a session that ran a long while is not a failure, and stays down without using a start', async () => {
      await say(app(), 'yes');
      await started();
      running = [];
      app();
      later(5 * 60);
      await reconcile();
      expect(start).toHaveBeenCalledTimes(1);
      expect(stuck).not.toHaveBeenCalled();
      expect(readSetupStates(dir).jev.dormant).toBe(true);
      later(60);
      await reconcile();
      expect(start).toHaveBeenCalledTimes(1);
    });

    it('a pass or a no clears the stopped notice', async () => {
      const a = app();
      await say(a, 'yes');
      await started();
      secret = 'a-key';
      await verify(a);
      expect(cleared).toHaveBeenCalledWith('jev');
    });

    it('does not restart a service already verified', async () => {
      const a = app();
      await say(a, 'yes');
      await started();
      secret = 'a-key';
      await verify(a);
      running = [];
      later(60);
      await reconcile();
      expect(start).toHaveBeenCalledTimes(1);
    });

    it('a no that arrived from another machine stops the work', async () => {
      await say(app(), 'yes');
      await started();
      ledger.recordNo({ service: 'jev', shutdown: 'none', reason: 'none', origin: 'owner-surface' });
      await reconcile();
      expect(stop).toHaveBeenCalledWith('sess-1');
      expect(withdraw).toHaveBeenCalledWith('CMT-1', expect.any(String));
      later(60);
      await reconcile();
      expect(start).toHaveBeenCalledTimes(1);
    });

    it('a service whose recipe was withdrawn still stops on a no', async () => {
      await say(app(), 'yes');
      await started();
      ledger.recordNo({ service: 'jev', shutdown: 'none', reason: 'none', origin: 'owner-surface' });
      await reconcile();
      expect(readSetupStates(dir).jev.sessionName).toBeUndefined();
    });

    it('never starts anything with no yes', async () => {
      app();
      await reconcile();
      expect(start).not.toHaveBeenCalled();
    });
  });

  describe('a machine that cannot message the person', () => {
    it('refuses a yes without spending the page, and takes it once it can', async () => {
      const a = app();
      reach = false;
      const page = await request(a).get('/recommended-services/jev/confirm');
      expect(page.status).toBe(200);
      expect(page.body.canSetUp).toBe(false);
      const yes = await request(a).post('/recommended-services/jev/confirm').set('X-Instar-Request', '1').send({ token: page.body.token, pin: '1', answer: 'yes' });
      expect(yes.status).toBe(409);
      expect(yes.body.error).toBe('cannot-reach-you');
      expect(ledger.effective('jev').choice).toBe('unset');
      expect(start).not.toHaveBeenCalled();
      reach = true;
      const again = await request(a).post('/recommended-services/jev/confirm').set('X-Instar-Request', '1').send({ token: page.body.token, pin: '1', answer: 'yes' });
      expect(again.status).toBe(200);
      expect(again.body.choice).toBe('yes');
      await started();
    });

    it('still takes a no there, since a no needs nobody told', async () => {
      const a = app();
      reach = false;
      const res = await say(a, 'no');
      expect(res.status).toBe(200);
      expect(ledger.effective('jev').choice).toBe('no');
    });

    it('lets a restart wait, costing no attempt, and restarts once it can reach them again', async () => {
      const a = app();
      await say(a, 'yes');
      await started();
      running = [];
      reach = false;
      now += 6 * 60_000;
      await reconcile();
      expect(start).toHaveBeenCalledTimes(1);
      expect(readSetupStates(dir).jev?.attempts).toBe(1);
      reach = true;
      await reconcile();
      expect(start).toHaveBeenCalledTimes(2);
    });
  });

  describe('a confirmed no that switches the service off', () => {
    const storeKey = (a: express.Express, value: string) => request(a).post('/recommended-services/jev/key').set('X-Instar-Request', '1').type('text/plain').send(value);
    // The session stores the key through the key route and reports the pass, so this machine's record says setup did it.
    const working = async (a: express.Express) => {
      await say(a, 'yes');
      await started();
      expect((await storeKey(a, 'k')).status).toBe(200);
      expect((await verify(a)).body.result).toBe('pass');
      expect(readSetupStates(dir).jev).toMatchObject({ keyStoredBySetup: true });
      expect(readSetupStates(dir).jev?.signedInBySetup).toBeUndefined();
      const page = await request(a).get('/recommended-services/jev/confirm');
      expect(page.body.workingHere).toBe(true);
      expect(page.body.switchOffHere).toBe(true);
      return page.body.token as string;
    };
    const sayNo = (a: express.Express, token: string, shutdown: unknown) =>
      request(a).post('/recommended-services/jev/confirm').set('X-Instar-Request', '1').send({ token, pin: '1', answer: 'no', reason: 'not-needed', shutdown });
    const stopped = () => vi.waitFor(() => expect(readSetupStates(dir).jev?.stopped).toBeTruthy());

    it('removes the key this machine uses, records it, and tells the person what that means', async () => {
      const a = app();
      const token = await working(a);
      const res = await sayNo(a, token, true);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ choice: 'no', shutdown: 'authorized', switchingOff: true });
      await stopped();
      expect(secret).toBeNull();
      const state = readSetupStates(dir).jev!;
      expect(state.verified).toBeUndefined();
      expect(state.keyStoredBySetup).toBeUndefined();
      expect(told.mock.calls.map((c) => c[0]).some((t: string) => /switched off on this machine/.test(t))).toBe(true);
      const list = await request(a).get('/recommended-services');
      const jev = list.body.services.find((s: { service: string }) => s.service === 'jev');
      expect(jev.stopped.detail).toMatch(/switched off/);
      expect(jev.switchingOff).toBe(false);
      expect(jev.verified).toBeNull();
    });

    it('a plain no leaves a working service on, exactly as the page says', async () => {
      const a = app();
      const token = await working(a);
      const res = await sayNo(a, token, false);
      expect(res.body).toMatchObject({ choice: 'no', shutdown: 'none', switchingOff: false });
      await settle();
      expect(secret).toBe('k');
      expect(readSetupStates(dir).jev?.stopped).toBeUndefined();
      await reconcile();
      expect(secret).toBe('k');
    });

    it('refuses a switch-off that is not a plain yes or no', async () => {
      const a = app();
      const token = await working(a);
      expect((await sayNo(a, token, 'yes')).status).toBe(400);
      expect(ledger.effective('jev').choice).toBe('yes');
    });

    it('a service the person had before setup is theirs: the page offers no switch-off, and a switch-off leaves it', async () => {
      secret = 'k';
      const a = app();
      await say(a, 'yes');
      await vi.waitFor(() => expect(readSetupStates(dir).jev?.alreadyHeld).toBe(true));
      expect(start).not.toHaveBeenCalled();
      const page = await request(a).get('/recommended-services/jev/confirm');
      expect(page.body).toMatchObject({ workingHere: true, switchOffHere: false });
      await sayNo(a, page.body.token, true);
      await stopped();
      expect(secret).toBe('k');
      expect(told.mock.calls.map((c) => c[0]).some((t: string) => /yours before I set anything up/.test(t))).toBe(true);
    });

    it('a key the person had, refused at the yes and accepted later, is never counted as setup\'s own', async () => {
      // The check before setup saw a key here that TypeSafe refused, so setup ran; the key route then refused to replace it.
      secret = 'k';
      answer = { ok: false, status: 401 };
      const a = app();
      await say(a, 'yes');
      await started();
      expect(readSetupStates(dir).jev?.alreadyHeld).toBeUndefined();
      expect(readSetupStates(dir).jev?.absentBeforeSetup).toBeUndefined();
      expect((await storeKey(a, 'mine')).status).toBe(409);
      answer = { ok: true, status: 200 };
      expect((await verify(a)).body.result).toBe('pass');
      expect(readSetupStates(dir).jev?.keyStoredBySetup).toBeUndefined();
      const page = await request(a).get('/recommended-services/jev/confirm');
      expect(page.body).toMatchObject({ workingHere: true, switchOffHere: false });
      await sayNo(a, page.body.token, true);
      await stopped();
      expect(secret).toBe('k');
      expect(told.mock.calls.map((c) => c[0]).some((t: string) => /yours before I set anything up/.test(t))).toBe(true);
    });

    it('switched off, set up again, switched off again: the record starts over with the new yes', async () => {
      const a = app();
      const token = await working(a);
      await sayNo(a, token, true);
      await stopped();
      expect(secret).toBeNull();
      start.mockClear();
      await say(a, 'yes');
      await vi.waitFor(() => expect(start).toHaveBeenCalledTimes(1));
      expect(readSetupStates(dir).jev?.stopped).toBeUndefined();
      expect((await storeKey(a, 'k2')).status).toBe(200);
      expect((await verify(a)).body.result).toBe('pass');
      const page = await request(a).get('/recommended-services/jev/confirm');
      expect(page.body).toMatchObject({ workingHere: true, switchOffHere: true });
      const list = await request(a).get('/recommended-services');
      expect(list.body.services.find((s: { service: string }) => s.service === 'jev')).toMatchObject({ stopped: null, switchingOff: false });
      await sayNo(a, page.body.token, true);
      await stopped();
      expect(secret).toBeNull();
    });

    it('a service that is not a way in never waits on another route', async () => {
      const a = app();
      const token = await working(a);
      otherRoute = false;
      await sayNo(a, token, true);
      await stopped();
      expect(secret).toBeNull();
      expect(told.mock.calls.map((c) => c[0]).some((t: string) => /only way I can reach you/.test(t))).toBe(false);
    });

    it('a way in waits while it may be the only route, says so once, and the regular check finishes it and tells them', async () => {
      rows = [{ ...PROVEN, wayIn: true }];
      const a = app();
      const token = await working(a);
      otherRoute = false;
      await sayNo(a, token, true);
      await vi.waitFor(() => expect(readSetupStates(dir).jev?.stopRequestedAt).toBeTruthy());
      expect(secret).toBe('k');
      expect(told.mock.calls.map((c) => c[0]).filter((t: string) => /stays on for now/.test(t))).toHaveLength(1);
      await reconcile();
      expect(secret).toBe('k');
      expect(told.mock.calls.map((c) => c[0]).filter((t: string) => /stays on for now/.test(t))).toHaveLength(1);
      const list = await request(a).get('/recommended-services');
      expect(list.body.services.find((s: { service: string }) => s.service === 'jev').switchingOff).toBe(true);
      otherRoute = true;
      await reconcile();
      expect(secret).toBeNull();
      expect(readSetupStates(dir).jev?.stopped).toBeTruthy();
      expect(readSetupStates(dir).jev?.stopRequestedAt).toBeUndefined();
      // The promise "I'll tell you" is kept, even though the no had already cleared what was working here.
      expect(told.mock.calls.map((c) => c[0]).filter((t: string) => /switched off on this machine/.test(t))).toHaveLength(1);
    });

    it('obeys a switch-off that arrives from another machine', async () => {
      const a = app();
      await working(a);
      ledger.recordNo({ service: 'jev', shutdown: 'authorized', reason: 'none', origin: 'owner-surface' });
      await reconcile();
      expect(secret).toBeNull();
      expect(readSetupStates(dir).jev?.stopped).toBeTruthy();
      await reconcile();
      expect(told.mock.calls.map((c) => c[0]).filter((t: string) => /switched off on this machine/.test(t))).toHaveLength(1);
    });

    it('the plain no route switches off too, when asked', async () => {
      const a = app();
      await working(a);
      const res = await request(a).post('/recommended-services/jev/no').set('X-Instar-Request', '1').send({ pin: '1', shutdown: true });
      expect(res.body).toMatchObject({ choice: 'no', shutdown: 'authorized', switchingOff: true });
      await stopped();
      expect(secret).toBeNull();
    });

    it('a machine that never had the service records the switch-off quietly', async () => {
      const a = app();
      await say(a, 'yes');
      await started();
      const page = await request(a).get('/recommended-services/jev/confirm');
      expect(page.body.workingHere).toBeFalsy();
      await sayNo(a, page.body.token, true);
      await stopped();
      expect(told.mock.calls.map((c) => c[0]).some((t: string) => /switch/.test(t))).toBe(false);
    });
  });

  describe('which agents can reach a recipe', () => {
    it('the proven recipes by default, plus only the recipes it names', () => {
      const proven = ['tailscale', 'jev'];
      expect(catalogWithProving(undefined, () => true).filter(isServiceAvailable).map((r) => r.id)).toEqual(proven);
      expect(catalogWithProving([], () => true).filter(isServiceAvailable).map((r) => r.id)).toEqual(proven);
      expect(catalogWithProving(['made-up'], () => true).filter(isServiceAvailable).map((r) => r.id)).toEqual(proven);
      expect(catalogWithProving(['jev-v1'], () => true).filter(isServiceAvailable).map((r) => r.id)).toEqual(proven);
    });

    it('a fleet agent ignores the list, whatever its config says, and keeps the proven ones', () => {
      expect(catalogWithProving(['jev-v1', 'made-up'], () => false).filter(isServiceAvailable).map((r) => r.id)).toEqual(['tailscale', 'jev']);
    });

    it('every recipe names a real service, and its brief gives the person no task', () => {
      for (const recipe of SETUP_RECIPES) {
        expect(RECOMMENDED_SERVICE_CATALOG.some((r) => r.id === recipe.service), recipe.id).toBe(true);
        const brief = recipe.brief({ port: 1 });
        expect(brief).toContain('They never open a browser');
        // Each of these was something a real session did, or nearly did, in the first live run.
        expect(brief).toContain('never a shared one');
        expect(brief).toContain('disposable or temporary email');
        expect(brief).toContain('Close any browser window');
        expect(brief).not.toMatch(/ask (the person|them) to (open|go|visit|sign|run|paste|get|fetch)/i);
      }
    });
  });
});
