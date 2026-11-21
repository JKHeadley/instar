// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.
/**
 * SEC-136: a relay {type:'error'} frame must never take the agent server down. On the server path
 * nothing listens for ThreadlineClient's 'error'; an unheard 'error' event throws. A real
 * ThreadlineClient logs in to a ws stand-in relay, which then sends error frames: with no listener
 * nothing is thrown and a degradation is reported (throttled); with a listener the frame arrives.
 */
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import type { AddressInfo } from 'node:net';
import { ThreadlineClient, isWellFormedEnvelope } from '../../src/threadline/client/ThreadlineClient.js';
import { DegradationReporter } from '../../src/monitoring/DegradationReporter.js';
import { reportUnheardRelayError, resetUnheardRelayErrorReportsForTesting } from '../../src/threadline/client/relayErrorReport.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const cleanups: Array<() => Promise<void> | void> = [];
beforeEach(() => { DegradationReporter.resetForTesting(); resetUnheardRelayErrorReportsForTesting(); });
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
  DegradationReporter.resetForTesting();
  resetUnheardRelayErrorReportsForTesting();
});

async function standInRelay(opts: { challenge?: unknown } = {}): Promise<{ url: string; connected: Promise<WebSocket>; first: Promise<WebSocket> }> {
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise<void>((r) => wss.on('listening', () => r()));
  cleanups.push(() => new Promise<void>((r) => { for (const cl of wss.clients) cl.terminate(); wss.close(() => r()); }));
  let firstResolve: (ws: WebSocket) => void = () => {};
  const first = new Promise<WebSocket>((r) => { firstResolve = r; });
  const connected = new Promise<WebSocket>((resolve) => {
    wss.on('connection', (ws) => {
      firstResolve(ws);
      ws.on('message', (m) => {
        const f = JSON.parse(m.toString());
        if (f.type === 'auth') { ws.send(JSON.stringify({ type: 'auth_ok', sessionId: 's-1', heartbeatInterval: 60_000 })); resolve(ws); }
      });
      ws.send(opts.challenge !== undefined ? JSON.stringify(opts.challenge) : JSON.stringify({ type: 'challenge', nonce: crypto.randomBytes(32).toString('base64') }));
    });
  });
  return { url: `ws://127.0.0.1:${(wss.address() as AddressInfo).port}`, connected, first };
}

function client(url: string): ThreadlineClient {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sec136-'));
  const c = new ThreadlineClient({ name: 'sec136', relayUrl: url, stateDir });
  cleanups.push(() => { try { c.disconnect(); } catch { /* already closed */ } SafeFsExecutor.safeRmSync(stateDir, { recursive: true, force: true, operation: 'tests/unit/relay-error-frame-no-crash.test.ts' }); });
  return c;
}
const flush = () => new Promise((r) => setTimeout(r, 50));
const reported = () => DegradationReporter.getInstance().getRecentEvents().filter((e) => e.feature === 'ThreadlineClient.relayErrorFrame');

describe('SEC-136: relay error frames never crash the agent', () => {
  it('with no error listener, error frames are logged and reported once, and nothing is thrown', async () => {
    const { url, connected } = await standInRelay();
    const c = client(url);
    let uncaught: unknown = null;
    const onUncaught = (e: unknown) => { uncaught = e; };
    process.on('uncaughtException', onUncaught);
    cleanups.push(() => { process.off('uncaughtException', onUncaught); });
    await c.connect();
    const ws = await connected;
    ws.send(JSON.stringify({ type: 'error', code: 'internal_error', message: 'boom\u0000\nwith control chars' }));
    ws.send(JSON.stringify({ type: 'error', code: 'internal_error', message: 'again' }));
    await flush();
    expect(uncaught).toBeNull();
    expect(reported()).toHaveLength(1);
    // Only the code is reported; the relay's own words stay out of the health report.
    expect(JSON.stringify(reported()[0])).not.toMatch(/boom|control chars/);
  });

  it('a caller that listens for error still receives the frame', async () => {
    const { url, connected } = await standInRelay();
    const c = client(url);
    const got: unknown[] = [];
    c.on('error', (e) => { got.push(e); });
    await c.connect();
    (await connected).send(JSON.stringify({ type: 'error', code: 'rate_limited', message: 'slow down' }));
    await flush();
    expect(got).toEqual([expect.objectContaining({ type: 'error', code: 'rate_limited' })]);
    expect(reported()).toHaveLength(0);
  });

  it('malformed frames after login never throw: null, a null envelope, a discover result without a list', async () => {
    const { url, connected } = await standInRelay();
    const c = client(url);
    let uncaught: unknown = null;
    const onUncaught = (e: unknown) => { uncaught = e; };
    process.on('uncaughtException', onUncaught);
    cleanups.push(() => { process.off('uncaughtException', onUncaught); });
    await c.connect();
    const ws = await connected;
    for (const raw of ['null', '5', '"text"', '{}', JSON.stringify({ type: 'message', envelope: null }), JSON.stringify({ type: 'discover_result' }), JSON.stringify({ type: 'discover_result', agents: 'nope' }), JSON.stringify({ type: 'discover_result', agents: [null, 7] })]) ws.send(raw);
    await flush();
    expect(uncaught).toBeNull();
  });

  it('malformed frames before login never throw: a challenge without a nonce, an auth error with a non-text message', async () => {
    for (const challenge of [{ type: 'challenge' }, { type: 'auth_error', message: 5 }]) {
      const { url, first } = await standInRelay({ challenge });
      const c = client(url);
      let uncaught: unknown = null;
      const onUncaught = (e: unknown) => { uncaught = e; };
      process.on('uncaughtException', onUncaught);
      cleanups.push(() => { process.off('uncaughtException', onUncaught); });
      c.connect().catch(() => { /* refused or timed out: either is fine, a throw is not */ });
      await first;
      await flush();
      expect(uncaught).toBeNull();
    }
  });

  it('cycling error codes cannot flood the degradation store: at most 5 reports per 10 minutes', () => {
    const t = 5_000_000;
    for (let i = 0; i < 50; i++) reportUnheardRelayError({ code: `code-${i}` }, t + i);
    expect(reported()).toHaveLength(5);
    reportUnheardRelayError({ code: 'code-late' }, t + 11 * 60_000);
    expect(reported()).toHaveLength(6);
  });

  it('documented relay error codes are still reported after made-up codes used up the shared cap', () => {
    const t = 7_000_000;
    for (let i = 0; i < 20; i++) reportUnheardRelayError({ code: `junk-${i}` }, t + i);
    reportUnheardRelayError({ code: 'banned' }, t + 100);
    expect(reported().map((e) => e.reason)).toContain('The relay sent an error (code banned).');
  });

  it('an envelope whose fields only pretend to be text never reaches a listener', async () => {
    expect(isWellFormedEnvelope({ from: 'a', payload: 'b' })).toBe(true);
    for (const bad of [null, [], {}, { from: { toString: 1 }, payload: 'x' }, { from: 'a' }, { from: 'a', payload: 'b', threadId: { toString: 1 } }, { from: 'a', payload: 'b', timestamp: 5 }]) {
      expect(isWellFormedEnvelope(bad)).toBe(false);
    }
    const { url, connected } = await standInRelay();
    const c = client(url);
    let uncaught: unknown = null;
    const onUncaught = (e: unknown) => { uncaught = e; };
    process.on('uncaughtException', onUncaught);
    process.on('unhandledRejection', onUncaught);
    cleanups.push(() => { process.off('uncaughtException', onUncaught); process.off('unhandledRejection', onUncaught); });
    const seen: unknown[] = [];
    // Mirrors the server's async unknown-sender listener, which reads String(envelope.from).
    c.on('unknown-sender', async (env: { from: unknown }) => { seen.push(String(env.from)); });
    await c.connect();
    (await connected).send(JSON.stringify({ type: 'message', envelope: { from: { toString: 1 }, payload: Buffer.from('{"text":"hi"}').toString('base64') } }));
    await flush();
    expect(uncaught).toBeNull();
    expect(seen).toEqual([]);
    expect(reported().some((e) => String(e.reason).includes('malformed-envelope'))).toBe(true);
  });
});
