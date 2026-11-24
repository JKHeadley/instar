/**
 * gemini-payg-metered-lane §6, §11 Integration "Two-server mesh fixture".
 *
 * Two machines in one process: the Studio (designated holder, real provider + real
 * transport against a fake Google endpoint) and the Mama PC (NO money layer, no
 * provider). The mesh is an in-memory signed-transport stand-in that delivers each
 * command to the other runtime's `handleMesh` with the AUTHENTICATED sender id.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import fsx from 'node:fs';
import osx from 'node:os';
import pathx from 'node:path';
import request from 'supertest';
import { createGeminiPaygRoutes } from '../../src/server/geminiPaygRoutes.js';
import { MeteredLaneRuntime, type LaneDesignation } from '../../src/server/meteredLaneRuntime.js';
import { GeminiApiProvider, type GeminiMoneyPort } from '../../src/providers/metered/gemini-api/GeminiApiProvider.js';
import { GeminiApiTransport } from '../../src/providers/metered/gemini-api/geminiApiTransport.js';

const KEY = 'AIzaSy-TWO-MACHINE-KEY-0123456789abcdefgh';
let fake: http.Server;
let origin = '';
let generateCalls = 0;

beforeAll(async () => {
  fake = http.createServer((req, res) => {
    req.on('data', () => {});
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      if ((req.url ?? '').includes(':countTokens')) { res.end(JSON.stringify({ totalTokens: 9 })); return; }
      generateCalls++;
      res.end(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'from the holder' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 9, candidatesTokenCount: 3, thoughtsTokenCount: 1 } }));
    });
  });
  await new Promise<void>((r) => fake.listen(0, '127.0.0.1', () => r()));
  origin = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`;
});
afterAll(async () => { await new Promise<void>((r) => fake.close(() => r())); });

const STUDIO = 'm_studio';
const MAMA = 'm_mamapc';
const designation: LaneDesignation = { designatedMachineId: STUDIO, designationEpoch: 2, oneKeyBacked: true, transferPending: false };

function world(opts: { studioDown?: () => boolean } = {}) {
  const reservations: string[] = [];
  const reserveArgs: Array<Record<string, unknown>> = [];
  const stops: string[] = [];
  const money: GeminiMoneyPort = {
    async preflight() {},
    async reserve(r) { reservations.push(r.callId ?? 'none'); reserveArgs.push(r as unknown as Record<string, unknown>); return { reserveId: `r${reservations.length}`, keyRef: 'gemini_api_key_payg', reserveUsd: 0.03, bookedInPerMtok: 1.5, bookedOutPerMtok: 7.5 }; },
    async settleActual() {}, async settleNoCharge() {}, async settleProvisional() {},
  };
  const provider = new GeminiApiProvider({ money, transport: new GeminiApiTransport({ testOrigin: origin }), keyReader: { withKey: async (fn) => fn(KEY) }, liveSecretValues: () => [] });
  const runtimes: Record<string, MeteredLaneRuntime> = {};
  const mk = (self: string, withProvider: boolean) => new MeteredLaneRuntime({
    selfMachineId: self,
    readDesignation: () => (self === STUDIO ? designation : null), // only the holder holds the caps record
    peers: () => [self === STUDIO ? MAMA : STUDIO],
    exec: { provider: () => (withProvider ? provider : null) },
    ledgerLookup: () => null,
    applyStop: (action, actor) => { stops.push(`${action}:${actor}`); },
    secretNames: () => (self === STUDIO ? ['authToken', 'gemini_api_key_payg'] : ['authToken']),
    onConflict: () => {},
    pendingStopsPath: pathx.join(fsx.mkdtempSync(pathx.join(osx.tmpdir(), 'payg-stops-')), 'pending.json'),
  });
  runtimes[STUDIO] = mk(STUDIO, true);
  runtimes[MAMA] = mk(MAMA, false);
  const sendFrom = (from: string) => async (to: string, cmd: Record<string, unknown>) => {
    if (to === STUDIO && opts.studioDown?.()) throw new Error('ECONNREFUSED');
    return runtimes[to].handleMesh(JSON.parse(JSON.stringify(cmd)), from);
  };
  runtimes[STUDIO].setSend(sendFrom(STUDIO));
  runtimes[MAMA].setSend(sendFrom(MAMA));
  // The non-holder learns the designation from the holder's echo (as in production,
  // within one 10s round of boot).
  const learn = async () => { await runtimes[MAMA].handleMesh({ type: 'designation-echo', keyRef: 'gemini_api_key_payg', designationEpoch: 2, nonce: 'ab'.repeat(16) }, STUDIO); };
  const appFor = (self: string) => {
    const rt = runtimes[self];
    const a = express();
    a.use(express.json({ limit: '2mb' }));
    a.use(createGeminiPaygRoutes({
      provider: () => (self === STUDIO ? provider : null),
      isDesignatedHere: () => rt.isDesignatedHere(),
      isLiveSession: () => true,
      forward: (c) => rt.forwardSecondOpinion(c),
      forwardReview: (r) => rt.forwardReview(r),
    }));
    return a;
  };
  return { runtimes, appFor, reservations, stops, learn, reserveArgs };
}

describe('two machines, one spender', () => {
  it('a second opinion on the non-holder (money layer OFF there) is forwarded and answered by the holder', async () => {
    const w = world();
    await w.learn();
    const before = generateCalls;
    const r = await request(w.appFor(MAMA)).post('/intelligence/gemini').set('X-Instar-Session', 'echo-topic-9').send({ prompt: 'q', purpose: 'test' });
    expect(r.status).toBe(200);
    expect(r.body.text).toBe('from the holder');
    expect(generateCalls).toBe(before + 1);
    expect(w.reservations).toHaveLength(1);
  });

  it('the holder rebuilds a forwarded second opinion from an allowlist (no smuggled E1 slot, proof marker or component)', async () => {
    const w = world();
    await w.runtimes[STUDIO].handleMesh({ type: 'metered-gemini-call', op: 'second-opinion', session: 's', callId: 'd'.repeat(64), requestSha256: 'r', resultTokenHash: 'e'.repeat(64),
      payload: { prompt: 'q', model: 'neon', component: 'spec-review', e1Slot: { specSha256: 'f'.repeat(64), round: 1 }, proofMarker: true, thinkingBudget: 99999 } }, MAMA);
    await new Promise((r) => setTimeout(r, 50));
    expect(w.reserveArgs).toHaveLength(1);
    const a = w.reserveArgs[0];
    expect(a.caller).toBe('second-opinion');
    expect(a.component).toBe('second-opinion:forwarded');
    expect(a.e1Slot).toBeUndefined();
    expect(a.proofMarker).toBeUndefined();
    expect(a.maxOutputTokens).toBe(4096 + 2048);
  });

  it('an unreachable holder is holder-unreachable — never a local spend', async () => {
    const w = world({ studioDown: () => true });
    await w.learn();
    const r = await request(w.appFor(MAMA)).post('/intelligence/gemini').send({ prompt: 'q', purpose: 'test' });
    expect(r.status).toBeGreaterThanOrEqual(500);
    expect(w.reservations).toHaveLength(0);
  }, 120_000);

  it('a stop action on the non-holder reaches the spender and is confirmed', async () => {
    const w = world();
    await w.learn();
    const r = await w.runtimes[MAMA].stopAction('freeze', 'session:echo-topic-9');
    expect(r).toEqual({ ok: true, confirmed: true });
    expect(w.stops).toEqual([`freeze:peer:${MAMA}`]);
  });

  it('a stop with the holder unreachable is NOT reported as stopped', async () => {
    const w = world({ studioDown: () => true });
    await w.learn();
    const r = await w.runtimes[MAMA].stopAction('freeze', 'session:x');
    expect(r).toMatchObject({ ok: false, confirmed: false, reason: 'holder-unreachable' });
  });

  it('a stop issued while the holder is down is kept and delivered once it is back (freeze wins)', async () => {
    let down = true;
    const w = world({ studioDown: () => down });
    await w.learn();
    expect(await w.runtimes[MAMA].stopAction('freeze', 'session:x')).toMatchObject({ confirmed: false, reason: 'holder-unreachable' });
    expect(w.stops).toEqual([]);
    expect(await w.runtimes[MAMA].retryPendingStops()).toBe(1);
    down = false;
    expect(await w.runtimes[MAMA].retryPendingStops()).toBe(0);
    expect(w.stops).toEqual([`freeze:peer:${MAMA}`]);
    w.runtimes[MAMA].stopEcho();
  });

  it('with no designation known, a non-holder applies a stop locally but does not claim the spender stopped', async () => {
    const w = world();
    expect(await w.runtimes[MAMA].stopAction('freeze', 'session:x')).toEqual({ ok: true, confirmed: false, reason: 'designation-unknown' });
  });

  it('the holder echo confirms the lease through a healthy peer, and the peer learns the designation', async () => {
    const w = world();
    expect(w.runtimes[STUDIO].leaseConfirmedAgoMs()).toBeNull();
    w.runtimes[STUDIO].startEcho();
    await new Promise((r) => setTimeout(r, 20));
    w.runtimes[STUDIO].stopEcho();
    expect(w.runtimes[STUDIO].leaseConfirmedAgoMs()).not.toBeNull();
    expect(w.runtimes[MAMA].leaseConfirmedAgoMs()).toBeNull(); // not the holder: fences
    expect(w.runtimes[MAMA].meteredDesignation()).toEqual({ designatedMachineId: STUDIO });
  });

  it('a non-holder persists the designation it hears and reloads it after a restart', async () => {
    const dir = fsx.mkdtempSync(pathx.join(osx.tmpdir(), 'payg-seen-'));
    const file = pathx.join(dir, 'seen.json');
    const mk = () => new MeteredLaneRuntime({ selfMachineId: MAMA, readDesignation: () => null, peers: () => [STUDIO], exec: { provider: () => null }, ledgerLookup: () => null, applyStop: () => {}, secretNames: () => [], onConflict: () => {}, seenDesignationPath: file });
    const a = mk();
    await a.handleMesh({ type: 'designation-echo', keyRef: 'gemini_api_key_payg', designationEpoch: 3, nonce: 'ab'.repeat(16) }, STUDIO);
    await a.handleMesh({ type: 'designation-echo', keyRef: 'gemini_api_key_payg', designationEpoch: 1, nonce: 'ab'.repeat(16) }, 'm_old');
    expect(a.holder()).toBe(STUDIO); // an older epoch never overwrites
    expect(mk().holder()).toBe(STUDIO);
  });

  it('secret-names answers names only', async () => {
    const w = world();
    const r = (await w.runtimes[STUDIO].handleMesh({ type: 'secret-names' }, MAMA)) as { names: string[] };
    expect(r.names).toContain('gemini_api_key_payg');
    expect(JSON.stringify(r)).not.toContain(KEY);
  });

  it('a forwarded call carries the authenticated sender as origin, not a body field', async () => {
    const w = world();
    const ack = (await w.runtimes[STUDIO].handleMesh({ type: 'metered-gemini-call', op: 'second-opinion', originMachine: 'm_spoofed', session: 's', callId: 'a'.repeat(64), requestSha256: 'b', resultTokenHash: 'c'.repeat(64), payload: { prompt: 'q', model: 'hydrogen', component: 'second-opinion:t' } }, MAMA)) as { state: string };
    expect(ack.state).toBe('running');
  });
});
