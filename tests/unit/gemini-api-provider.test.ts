/**
 * gemini-payg-metered-lane §1, §4, §5 — the in-server Gemini API door.
 * Transport (fixed host, key only in a header, redaction, outcome classes), the key
 * reader (one reader, plain-config refusal, fingerprint), and the provider (one immutable
 * request, preflight before the key, exact-value secret check, countTokens refusal, the
 * settle table, no retry, truncation).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import {
  GeminiApiTransport,
  GEMINI_API_HOST,
  deriveGenerateTimeoutMs,
  GEMINI_API_MAX_TIMEOUT_MS,
  redactSecret,
  type FetchLike,
} from '../../src/providers/metered/gemini-api/geminiApiTransport.js';
import { GeminiApiKeyReader, GeminiKeyRefusal, keyFingerprint } from '../../src/providers/metered/gemini-api/geminiApiKeyReader.js';
import { resolveGeminiApiModel, cheapestGeminiApiModel, GEMINI_API_MODELS } from '../../src/providers/metered/gemini-api/geminiApiModels.js';
import {
  GeminiApiProvider,
  GeminiApiRefusal,
  buildGeminiRequest,
  settleBookingFor,
  requestContainsLiveSecret,
  type GeminiMoneyPort,
} from '../../src/providers/metered/gemini-api/GeminiApiProvider.js';

const KEY = 'AIzaSy-TEST-KEY-VALUE-0123456789abcdefghij';

type Call = { url: string; headers: Record<string, string>; body: string };
function fakeFetch(handler: (url: string, body: string) => { status: number; body: unknown } | Error): { fetchImpl: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, headers: init.headers, body: init.body });
    const r = handler(url, init.body);
    if (r instanceof Error) throw r;
    return { status: r.status, text: async () => (typeof r.body === 'string' ? r.body : JSON.stringify(r.body)) };
  };
  return { fetchImpl, calls };
}

describe('geminiApiModels', () => {
  it('resolves labels and exact ids, never defaults an unknown', () => {
    expect(resolveGeminiApiModel('neon')?.id).toBe('gemini-4-neon');
    expect(resolveGeminiApiModel('models/gemini-4-hydrogen')?.label).toBe('hydrogen');
    expect(resolveGeminiApiModel('gemini-2.5-flash')).toBeNull();
    expect(resolveGeminiApiModel(undefined)).toBeNull();
    expect(cheapestGeminiApiModel().label).toBe('hydrogen');
    expect(Object.keys(GEMINI_API_MODELS).sort()).toEqual(['hydrogen', 'neon']);
  });
});

describe('geminiApiTransport', () => {
  it('uses the fixed host and carries the key ONLY in the x-goog-api-key header', async () => {
    const { fetchImpl, calls } = fakeFetch((url) => (url.includes(':countTokens') ? { status: 200, body: { totalTokens: 7 } } : { status: 200, body: { candidates: [] } }));
    const t = new GeminiApiTransport({ fetchImpl });
    const body = buildGeminiRequest(GEMINI_API_MODELS.hydrogen, { caller: 'second-opinion', component: 'test', model: 'hydrogen', prompt: 'hi' });
    expect(await t.countTokens('gemini-4-hydrogen', body, KEY)).toBe(7);
    await t.generateContent('gemini-4-hydrogen', body, KEY, 1000);
    for (const c of calls) {
      expect(new URL(c.url).host).toBe(GEMINI_API_HOST);
      expect(c.url).not.toContain(KEY);
      expect(c.body).not.toContain(KEY);
      expect(c.headers['x-goog-api-key']).toBe(KEY);
    }
  });

  it('classifies outcomes: ok, pre-generation rejection, post-send failure, not-sent', async () => {
    const body = buildGeminiRequest(GEMINI_API_MODELS.hydrogen, { caller: 'second-opinion', component: 'test', model: 'hydrogen', prompt: 'hi' });
    const mk = (status: number, b: unknown) => new GeminiApiTransport({ fetchImpl: fakeFetch(() => ({ status, body: b })).fetchImpl });
    expect((await mk(200, { candidates: [] }).generateContent('gemini-4-hydrogen', body, KEY, 1000)).kind).toBe('ok');
    for (const s of [400, 401, 403, 404, 429]) {
      expect((await mk(s, { error: { status: 'X' } }).generateContent('gemini-4-hydrogen', body, KEY, 1000)).kind).toBe('rejected');
    }
    expect((await mk(503, {}).generateContent('gemini-4-hydrogen', body, KEY, 1000)).kind).toBe('post-send-failure');
    expect((await mk(200, 'not json').generateContent('gemini-4-hydrogen', body, KEY, 1000)).kind).toBe('post-send-failure');
    const drop = new GeminiApiTransport({ fetchImpl: fakeFetch(() => new Error(`socket hang up ${KEY}`)).fetchImpl });
    const o = await drop.generateContent('gemini-4-hydrogen', body, KEY, 1000);
    expect(o.kind).toBe('post-send-failure');
    expect(JSON.stringify(o)).not.toContain(KEY);
  });

  it('countTokens errors never carry the key in message, cause or stack', async () => {
    const t = new GeminiApiTransport({ fetchImpl: fakeFetch(() => new Error(`boom ${KEY}`)).fetchImpl });
    const body = buildGeminiRequest(GEMINI_API_MODELS.neon, { caller: 'spec-review', component: 'test', model: 'neon', prompt: 'x' });
    try {
      await t.countTokens('gemini-4-neon', body, KEY);
      throw new Error('expected throw');
    } catch (err) {
      const e = err as Error;
      expect(e.message).not.toContain(KEY);
      expect(String(e.stack)).not.toContain(KEY);
      expect(String((e as { cause?: unknown }).cause ?? '')).not.toContain(KEY);
    }
  });

  it('derives the timeout from reserved output and the throughput floor, capped at 900s', () => {
    expect(deriveGenerateTimeoutMs(4000, 40)).toBe(130_000);
    expect(deriveGenerateTimeoutMs(4000, undefined)).toBe(130_000);
    expect(deriveGenerateTimeoutMs(10_000_000, 40)).toBe(GEMINI_API_MAX_TIMEOUT_MS);
    expect(redactSecret(`a${KEY}b${KEY}`, KEY)).toBe('a[redacted]b[redacted]');
  });
});

describe('geminiApiKeyReader', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-key-reader-')); });
  afterEach(() => { SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/gemini-api-provider.test.ts:afterEach' }); });

  const reader = (expected: string | null, onPlain?: () => void) => new GeminiApiKeyReader({
    stateDir: dir,
    vaultGet: (n) => (n === 'gemini_api_key_payg' ? KEY : undefined),
    expectedKeyGeneration: () => expected,
    ...(onPlain ? { onPlainConfigCopy: onPlain } : {}),
  });

  it('hands the key to fn when the fingerprint matches', async () => {
    expect(await reader(keyFingerprint(KEY)).withKey(async (k) => k.length)).toBe(KEY.length);
  });

  it('refuses key-generation-mismatch, and with no committed generation, before fn runs', async () => {
    let ran = false;
    await expect(reader(keyFingerprint('other')).withKey(async () => { ran = true; })).rejects.toMatchObject({ code: 'key-generation-mismatch' });
    await expect(reader(null).withKey(async () => { ran = true; })).rejects.toBeInstanceOf(GeminiKeyRefusal);
    expect(ran).toBe(false);
  });

  it('refuses a plain-config copy and raises one notice', async () => {
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ gemini_api_key_payg: KEY }));
    let notices = 0;
    const r = reader(keyFingerprint(KEY), () => { notices++; });
    await expect(r.withKey(async () => 1)).rejects.toMatchObject({ code: 'key-in-plain-config' });
    await expect(r.withKey(async () => 1)).rejects.toMatchObject({ code: 'key-in-plain-config' });
    expect(notices).toBe(1);
  });

  it('refuses an absent key', async () => {
    const r = new GeminiApiKeyReader({ stateDir: dir, vaultGet: () => undefined, expectedKeyGeneration: () => 'x' });
    await expect(r.withKey(async () => 1)).rejects.toMatchObject({ code: 'key-absent' });
  });
});

describe('settleBookingFor — the §5 settle table', () => {
  const res = { bookedInPerMtok: 1.5, bookedOutPerMtok: 7.5 };
  it('200 with usage books actual: prompt × in + (candidates + thoughts) × out', () => {
    const b = settleBookingFor({ kind: 'ok', status: 200, body: { usageMetadata: { promptTokenCount: 1_000_000, candidatesTokenCount: 500_000, thoughtsTokenCount: 500_000 } } }, res);
    expect(b).toEqual({ kind: 'actual', usd: 1.5 + 7.5 });
  });
  it('200 without usage books the full reserve', () => {
    expect(settleBookingFor({ kind: 'ok', status: 200, body: {} }, res)).toEqual({ kind: 'full-reserve' });
  });
  it('pre-generation rejection and not-sent book no charge', () => {
    expect(settleBookingFor({ kind: 'rejected', status: 429, errorCode: null }, res)).toEqual({ kind: 'no-charge' });
    expect(settleBookingFor({ kind: 'not-sent', reason: 'dns' }, res)).toEqual({ kind: 'no-charge' });
  });
  it('any post-send failure books a provisional full reserve', () => {
    expect(settleBookingFor({ kind: 'post-send-failure', status: 503, reason: 'http-503' }, res)).toEqual({ kind: 'provisional' });
    expect(settleBookingFor({ kind: 'post-send-failure', status: null, reason: 'timeout' }, res)).toEqual({ kind: 'provisional' });
  });
});

interface PortLog { events: string[] }
function fakeMoney(log: PortLog, opts: { preflightThrows?: Error } = {}): GeminiMoneyPort {
  return {
    async preflight() { log.events.push('preflight'); if (opts.preflightThrows) throw opts.preflightThrows; },
    async reserve(r) { log.events.push(`reserve:${r.inputTokens}:${r.maxOutputTokens}`); return { reserveId: 'r1', keyRef: 'gemini_api_key_payg', reserveUsd: 0.05, bookedInPerMtok: 1.5, bookedOutPerMtok: 7.5 }; },
    async settleActual(_k, _r, usd) { log.events.push(`settle-actual:${usd.toFixed(6)}`); },
    async settleNoCharge() { log.events.push('settle-none'); },
    async settleProvisional() { log.events.push('settle-provisional'); },
  };
}

describe('GeminiApiProvider', () => {
  const okBody = { candidates: [{ content: { parts: [{ text: 'thinking', thought: true }, { text: 'answer' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, thoughtsTokenCount: 20 } };

  function provider(handler: Parameters<typeof fakeFetch>[0], money: GeminiMoneyPort, secrets: string[] = [], keyUsed?: { n: number }) {
    const { fetchImpl, calls } = fakeFetch(handler);
    const p = new GeminiApiProvider({
      money,
      transport: new GeminiApiTransport({ fetchImpl }),
      keyReader: { withKey: async (fn) => { if (keyUsed) keyUsed.n++; return fn(KEY); } },
      liveSecretValues: () => secrets,
    });
    return { p, calls };
  }

  it('happy path: preflight → count → reserve (output + thinking) → call → actual settle; thoughts excluded from text', async () => {
    const log = { events: [] as string[] };
    const { p, calls } = provider((url) => (url.includes(':countTokens') ? { status: 200, body: { totalTokens: 10 } } : { status: 200, body: okBody }), fakeMoney(log));
    const r = await p.call({ caller: 'second-opinion', component: 'test', model: 'hydrogen', prompt: 'q' });
    expect(r.text).toBe('answer');
    expect(r.incomplete).toBe(false);
    expect(log.events).toEqual(['preflight', 'reserve:10:6144', `settle-actual:${((10 / 1e6) * 1.5 + (25 / 1e6) * 7.5).toFixed(6)}`]);
    // One immutable request used for both the count and the call.
    const countReq = JSON.parse(calls[0].body).generateContentRequest;
    const genReq = JSON.parse(calls[1].body);
    delete countReq.model;
    expect(countReq).toEqual(genReq);
    expect(calls).toHaveLength(2); // no retry
  });

  it('the key is never touched when preflight refuses', async () => {
    const used = { n: 0 };
    const log = { events: [] as string[] };
    const { p, calls } = provider(() => ({ status: 200, body: {} }), fakeMoney(log, { preflightThrows: new GeminiApiRefusal('frozen', 'x') }), [], used);
    await expect(p.call({ caller: 'second-opinion', component: 't', model: 'hydrogen', prompt: 'q' })).rejects.toMatchObject({ reason: 'frozen' });
    expect(used.n).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it('refuses an exact live secret value before any network call; a key SHAPE is only a signal', async () => {
    const log = { events: [] as string[] };
    const secret = 'live-secret-value-xyz-123';
    const { p, calls } = provider(() => ({ status: 200, body: { totalTokens: 1 } }), fakeMoney(log), [secret]);
    await expect(p.call({ caller: 'second-opinion', component: 't', model: 'hydrogen', prompt: `here: ${secret}` })).rejects.toMatchObject({ reason: 'prompt-contains-live-secret' });
    expect(calls).toHaveLength(0);
    expect(requestContainsLiveSecret(buildGeminiRequest(GEMINI_API_MODELS.neon, { caller: 'spec-review', component: 't', model: 'neon', prompt: 'example AIzaSyEXAMPLEEXAMPLEEXAMPLEEXAMPLE12' }), [secret])).toBe(false);
  });

  it('the secret check matches RAW text: a secret with a quote, backslash or newline is still caught', () => {
    const tricky = 'pa"ss\\word\nwith-escapes-123';
    const body = buildGeminiRequest(GEMINI_API_MODELS.hydrogen, { caller: 'second-opinion', component: 't', model: 'hydrogen', prompt: `x ${tricky} y`, systemInstruction: 'sys' });
    expect(requestContainsLiveSecret(body, [tricky])).toBe(true);
    const inSys = buildGeminiRequest(GEMINI_API_MODELS.hydrogen, { caller: 'second-opinion', component: 't', model: 'hydrogen', prompt: 'p', systemInstruction: `sys ${tricky}` });
    expect(requestContainsLiveSecret(inSys, [tricky])).toBe(true);
  });

  it('a countTokens failure refuses token-count-unavailable before dispatch', async () => {
    const log = { events: [] as string[] };
    const { p, calls } = provider((url) => (url.includes(':countTokens') ? { status: 500, body: {} } : { status: 200, body: okBody }), fakeMoney(log));
    await expect(p.call({ caller: 'second-opinion', component: 't', model: 'hydrogen', prompt: 'q' })).rejects.toMatchObject({ reason: 'token-count-unavailable' });
    expect(log.events).toEqual(['preflight']);
    expect(calls.filter((c) => c.url.includes(':generateContent'))).toHaveLength(0);
  });

  it('a post-send failure books provisional and is never retried', async () => {
    const log = { events: [] as string[] };
    const { p, calls } = provider((url) => (url.includes(':countTokens') ? { status: 200, body: { totalTokens: 3 } } : { status: 503, body: {} }), fakeMoney(log));
    await expect(p.call({ caller: 'spec-review', component: 't', model: 'neon', prompt: 'q' })).rejects.toMatchObject({ reason: 'provider-failed' });
    expect(log.events.at(-1)).toBe('settle-provisional');
    expect(calls.filter((c) => c.url.includes(':generateContent'))).toHaveLength(1);
  });

  it('a pre-generation 429 books no charge', async () => {
    const log = { events: [] as string[] };
    const { p } = provider((url) => (url.includes(':countTokens') ? { status: 200, body: { totalTokens: 3 } } : { status: 429, body: {} }), fakeMoney(log));
    await expect(p.call({ caller: 'spec-review', component: 't', model: 'neon', prompt: 'q' })).rejects.toMatchObject({ reason: 'provider-rejected' });
    expect(log.events.at(-1)).toBe('settle-none');
  });

  it('a MAX_TOKENS finish is marked incomplete', async () => {
    const log = { events: [] as string[] };
    const body = { ...okBody, candidates: [{ ...okBody.candidates[0], finishReason: 'MAX_TOKENS' }] };
    const { p } = provider((url) => (url.includes(':countTokens') ? { status: 200, body: { totalTokens: 3 } } : { status: 200, body }), fakeMoney(log));
    expect((await p.call({ caller: 'spec-review', component: 't', model: 'neon', prompt: 'q' })).incomplete).toBe(true);
  });

  it('an unknown model is refused before preflight; evaluate() without a caller is refused', async () => {
    const log = { events: [] as string[] };
    const { p } = provider(() => ({ status: 200, body: {} }), fakeMoney(log));
    await expect(p.call({ caller: 'second-opinion', component: 't', model: 'gemini-2.5-flash', prompt: 'q' })).rejects.toMatchObject({ reason: 'unknown-price' });
    await expect(p.evaluate('q')).rejects.toMatchObject({ reason: 'not-allowlisted' });
    expect(log.events).toEqual([]);
  });

  it('request sizes: defaults per caller and output+thinking always set', () => {
    const b = buildGeminiRequest(GEMINI_API_MODELS.neon, { caller: 'spec-review', component: 't', model: 'neon', prompt: 'q', systemInstruction: 'sys' });
    expect(b.generationConfig.maxOutputTokens).toBe(16_384);
    expect(b.generationConfig.thinkingConfig.thinkingBudget).toBe(8_192);
    expect(b.systemInstruction?.parts[0].text).toBe('sys');
    expect(Object.isFrozen(b.generationConfig)).toBe(true);
  });
});
