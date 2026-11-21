/**
 * gemini-payg-metered-lane §2 "Guarding E2", §11 Integration — POST /intelligence/gemini
 * through the real router, the real provider and the real transport, against a fake
 * Google endpoint served by a local HTTP server. The money port is an in-memory fake
 * here (the money layer's own suites cover caps); this file pins the route's guards,
 * the refusal-status mapping and the wire shape.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import fsMod from 'node:fs';
import os from 'node:os';
import pathMod from 'node:path';
import cryptoMod from 'node:crypto';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import request from 'supertest';
import { createGeminiPaygRoutes } from '../../src/server/geminiPaygRoutes.js';
import { GeminiApiProvider, GeminiApiRefusal, type GeminiMoneyPort } from '../../src/providers/metered/gemini-api/GeminiApiProvider.js';
import { GeminiApiTransport } from '../../src/providers/metered/gemini-api/geminiApiTransport.js';

const KEY = 'AIzaSy-INTEGRATION-KEY-0123456789abcdefgh';
let fake: http.Server;
let origin = '';
const seen: Array<{ path: string; key: string | undefined }> = [];

beforeAll(async () => {
  fake = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      seen.push({ path: req.url ?? '', key: req.headers['x-goog-api-key'] as string | undefined });
      res.setHeader('content-type', 'application/json');
      if ((req.url ?? '').includes(':countTokens')) { res.end(JSON.stringify({ totalTokens: 12 })); return; }
      res.end(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'second opinion text' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 4, thoughtsTokenCount: 6 } }));
    });
  });
  await new Promise<void>((r) => fake.listen(0, '127.0.0.1', () => r()));
  origin = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`;
});
afterAll(async () => { await new Promise<void>((r) => fake.close(() => r())); });

function money(state: { refuse?: string; settled: number }): GeminiMoneyPort {
  return {
    async preflight() { if (state.refuse) throw new GeminiApiRefusal(state.refuse, 'test'); },
    async reserve() { return { reserveId: 'r', keyRef: 'gemini_api_key_payg', reserveUsd: 0.04, bookedInPerMtok: 1.5, bookedOutPerMtok: 7.5 }; },
    async settleActual(_k, _r, usd) { state.settled += usd; },
    async settleNoCharge() {},
    async settleProvisional() {},
  };
}

function app(opts: { refuse?: string; provider?: boolean; designated?: boolean; state?: { settled: number; refuse?: string } }) {
  const state = opts.state ?? { settled: 0, refuse: opts.refuse };
  const provider = new GeminiApiProvider({
    money: money(state),
    transport: new GeminiApiTransport({ testOrigin: origin }),
    keyReader: { withKey: async (fn) => fn(KEY) },
    liveSecretValues: () => ['a-live-secret-value-123456'],
  });
  const a = express();
  a.use(express.json({ limit: '2mb' }));
  a.use(createGeminiPaygRoutes({
    provider: () => (opts.provider === false ? null : provider),
    isDesignatedHere: () => opts.designated !== false,
    isLiveSession: (n) => n === 'echo-topic-1',
  }));
  return { a, state };
}

describe('POST /intelligence/gemini', () => {
  it('200 with the answer, cost booked from usage, key only in the header', async () => {
    const { a, state } = app({});
    const r = await request(a).post('/intelligence/gemini').set('X-Instar-Session', 'echo-topic-1').send({ prompt: 'What do you think?', purpose: 'test' });
    expect(r.status).toBe(200);
    expect(r.body.text).toBe('second opinion text');
    expect(r.body.model).toBe('gemini-4-hydrogen');
    expect(state.settled).toBeCloseTo((12 / 1e6) * 1.5 + (10 / 1e6) * 7.5, 9);
    expect(seen.every((s) => s.key === KEY && !s.path.includes(KEY))).toBe(true);
    expect(JSON.stringify(r.body)).not.toContain(KEY);
  });

  it('Neon on request', async () => {
    const r = await request(app({}).a).post('/intelligence/gemini').send({ prompt: 'q', purpose: 'test', model: 'neon' });
    expect(r.body.model).toBe('gemini-4-neon');
  });

  it('403 from tunnel ingress (forwarding headers), 400 without purpose', async () => {
    const { a } = app({});
    expect((await request(a).post('/intelligence/gemini').set('X-Forwarded-For', '1.2.3.4').send({ prompt: 'q', purpose: 'x' })).status).toBe(403);
    expect((await request(a).post('/intelligence/gemini').send({ prompt: 'q' })).status).toBe(400);
  });

  it('maps money refusals to their own statuses (402 cap, 402 e2 share, 423 frozen)', async () => {
    for (const [reason, status] of [['cap-exceeded', 402], ['e2-share-exceeded', 402], ['frozen', 423], ['not-allowlisted', 403]] as const) {
      const r = await request(app({ refuse: reason }).a).post('/intelligence/gemini').send({ prompt: 'q', purpose: 'x' });
      expect(r.status).toBe(status);
      expect(r.body.reason).toBe(reason);
    }
  });

  it('503 money-layer-off when the provider is not built; 503 no-cap-slice off the designated machine', async () => {
    const off = await request(app({ provider: false }).a).post('/intelligence/gemini').send({ prompt: 'q', purpose: 'x' });
    expect(off.status).toBe(503);
    expect(off.body.reason).toBe('money-layer-off');
    const non = await request(app({ designated: false }).a).post('/intelligence/gemini').send({ prompt: 'q', purpose: 'x' });
    expect(non.status).toBe(503);
    expect(non.body.reason).toBe('no-cap-slice');
  });

  it('a prompt carrying a live secret is refused 422 and never reaches Google', async () => {
    const before = seen.length;
    const r = await request(app({}).a).post('/intelligence/gemini').send({ prompt: 'leak a-live-secret-value-123456', purpose: 'x' });
    expect(r.status).toBe(422);
    expect(r.body.reason).toBe('prompt-contains-live-secret');
    expect(seen.length).toBe(before);
  });
});

describe('POST /intelligence/gemini/review (E1)', () => {
  let home = '';
  let specAbs = '';
  const specText = '# Spec\n\nSee docs/ctx.md for context.\n';
  const ctxText = 'context document text\n';
  beforeAll(() => {
    home = fsMod.mkdtempSync(pathMod.join(os.tmpdir(), 'e1-home-'));
    const repo = pathMod.join(home, '.dev', 'wt-x');
    fsMod.mkdirSync(pathMod.join(repo, 'docs', 'specs'), { recursive: true });
    specAbs = pathMod.join(repo, 'docs', 'specs', 'demo.md');
    fsMod.writeFileSync(specAbs, specText);
    fsMod.writeFileSync(pathMod.join(repo, 'docs', 'ctx.md'), ctxText);
  });
  afterAll(() => { SafeFsExecutor.safeRmSync(home, { recursive: true, force: true, operation: 'tests/integration/gemini-payg-second-opinion-route.test.ts:e1' }); });

  const sha = () => cryptoMod.createHash('sha256').update(specText).digest('hex');
  const prompt = (spec = specText, ctx = ctxText) => `TEMPLATE\n\n--- SPEC UNDER REVIEW: docs/specs/demo.md ---\n${spec}\n--- CONTEXT: docs/ctx.md ---\n${ctx}`;

  function e1app(state: { refuse?: string; refuseModel?: string; models: string[] }) {
    const provider = {
      async call(req: { model: string; e1Slot?: unknown; caller: string }) {
        state.models.push(req.model);
        if (state.refuse && (!state.refuseModel || state.refuseModel === req.model)) throw new GeminiApiRefusal(state.refuse, 't');
        expect(req.caller).toBe('spec-review');
        expect(req.e1Slot).toBeTruthy();
        return { text: 'VERDICT: ok', modelId: req.model === 'neon' ? 'gemini-4-neon' : 'gemini-4-hydrogen', finishReason: 'STOP', incomplete: false, costUsd: 0.5, inputTokens: 1, usage: null, reserveId: 'r', booking: { kind: 'actual', usd: 0.5 }, requestSha256: 'x' };
      },
    } as unknown as GeminiApiProvider;
    const a = express();
    a.use(express.json({ limit: '2mb' }));
    a.use(createGeminiPaygRoutes({ provider: () => provider, isDesignatedHere: () => true, isLiveSession: () => false, reviewRoots: () => [home] }));
    return a;
  }

  it('reviews a real spec with Neon', async () => {
    const st = { models: [] as string[] };
    const r = await request(e1app(st)).post('/intelligence/gemini/review').send({ specPath: specAbs, specSha256: sha(), round: 1, promptText: prompt(), runNonce: 'abcdef0123' });
    expect(r.status).toBe(200);
    expect(r.body.model).toBe('gemini-4-neon');
    expect(r.body.run).toBe(`docs/specs/demo.md@${sha().slice(0, 8)}#1`);
    expect(st.models).toEqual(['neon']);
  });

  it('refuses a sha mismatch, a payload not bound to the spec, an unlisted or altered context doc, a spec outside the roots', async () => {
    const a = e1app({ models: [] });
    const base = { specPath: specAbs, specSha256: sha(), round: 1, promptText: prompt(), runNonce: 'abcdef0123' };
    const reasons = async (b: Record<string, unknown>) => (await request(a).post('/intelligence/gemini/review').send(b)).body.reason;
    expect(await reasons({ ...base, specSha256: 'f'.repeat(64) })).toBe('spec-sha-mismatch');
    expect(await reasons({ ...base, promptText: prompt('# other spec\n') })).toBe('payload-not-bound-to-spec');
    expect(await reasons({ ...base, promptText: prompt(specText, 'tampered context\n') })).toBe('context-not-bound');
    expect(await reasons({ ...base, promptText: `${prompt()}\n--- CONTEXT: docs/other.md ---\nx` })).toBe('context-not-listed-by-spec');
    const outside = fsMod.mkdtempSync(pathMod.join(os.tmpdir(), 'e1-outside-'));
    fsMod.mkdirSync(pathMod.join(outside, 'docs', 'specs'), { recursive: true });
    fsMod.writeFileSync(pathMod.join(outside, 'docs', 'specs', 'demo.md'), specText);
    expect(await reasons({ ...base, specPath: pathMod.join(outside, 'docs', 'specs', 'demo.md') })).toBe('spec-outside-allowed-roots');
    SafeFsExecutor.safeRmSync(outside, { recursive: true, force: true, operation: 'tests/integration/gemini-payg-second-opinion-route.test.ts:e1-outside' });
  });

  it('steps down to Hydrogen only on cap-exceeded / per-call-ceiling', async () => {
    const st = { refuse: 'per-call-ceiling', refuseModel: 'neon', models: [] as string[] };
    const r = await request(e1app(st)).post('/intelligence/gemini/review').send({ specPath: specAbs, specSha256: sha(), round: 2, promptText: prompt(), runNonce: 'abcdef0123' });
    expect(r.status).toBe(200);
    expect(r.body.model).toBe('gemini-4-hydrogen');
    expect(r.body.steppedDownReason).toBe('per-call-ceiling');
    const st2 = { refuse: 'e1-pass-limit', models: [] as string[] };
    const r2 = await request(e1app(st2)).post('/intelligence/gemini/review').send({ specPath: specAbs, specSha256: sha(), round: 2, promptText: prompt(), runNonce: 'abcdef0123' });
    expect(r2.status).toBe(429);
    expect(r2.body).toMatchObject({ status: 'unavailable', reason: 'e1-pass-limit' });
    expect(st2.models).toEqual(['neon']);
  });

  it('refuses tunnel ingress', async () => {
    const r = await request(e1app({ models: [] })).post('/intelligence/gemini/review').set('X-Forwarded-Host', 'x').send({});
    expect(r.status).toBe(403);
  });
});
