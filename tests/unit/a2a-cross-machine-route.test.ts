/**
 * Unit tier — A2A cross-machine route (docs/specs/a2a-cross-machine-route.md).
 *
 *  A. The pure rules (src/threadline/relayForward.ts): the boot secret, the
 *     gate, finding the holder (both sides of every §1 condition + the cache),
 *     each §4 answer class, the holder handler, the inject receiver and the ask.
 *  B. The REAL /threadline/relay-send route on a STANDBY: when a forward is
 *     tried, what the caller is told, and each settlement + reply-claim row.
 *  C. The REAL route on the HOLDER: the §3 table, with the right secret, a
 *     wrong secret and no secret; a co-located target still goes over the relay;
 *     a forwarded request never forwards again.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import type { Server } from 'node:http';
import { createRoutes } from '../../src/server/routes.js';
import { StateManager } from '../../src/core/StateManager.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { checkCommandRBAC, type MeshCommand } from '../../src/core/MeshRpc.js';
import type { InstarConfig } from '../../src/core/types.js';
import {
  RELAY_FORWARD_HEADER,
  RelayForwarder,
  RelayHolderFinder,
  askTopicOwner,
  buildForwardAnswer,
  classifyForwardResult,
  createForwardSecret,
  createRelayForwardCounters,
  forwardLogLine,
  forwardSecretMatches,
  handleRelayForwardCommand,
  handleTopicReplyInjectCommand,
  isForwardableMessageId,
  resolveRelayForwardEnabled,
  type ForwardOutcome,
  type ForwardPeer,
  type RelayForwardCommand,
  type RelayForwardCounters,
} from '../../src/threadline/relayForward.js';

const OWN_FP = 'ab'.repeat(16);
const OTHER_FP = 'cd'.repeat(16);
const PEER: ForwardPeer = { machineId: 'm_holder', url: 'http://holder.test', nickname: 'the mini' };

const refused = () => Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
const aborted = () => Object.assign(new Error('aborted'), { name: 'AbortError' });

// ── A. pure rules ─────────────────────────────────────────────────

describe('the boot secret', () => {
  it('is 64 hex chars and different every boot', () => {
    const a = createForwardSecret();
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(createForwardSecret()).not.toBe(a);
  });
  it('matches only the exact secret; wrong, missing, array and short values never match or throw', () => {
    const s = createForwardSecret();
    expect(forwardSecretMatches(s, s)).toBe(true);
    expect(forwardSecretMatches(s, s.slice(0, -1) + (s.endsWith('0') ? '1' : '0'))).toBe(false);
    expect(forwardSecretMatches(s, s.slice(0, 10))).toBe(false);
    expect(forwardSecretMatches(s, undefined)).toBe(false);
    expect(forwardSecretMatches(s, '')).toBe(false);
    expect(forwardSecretMatches(s, [s])).toBe(false);
    expect(forwardSecretMatches(null, s)).toBe(false);
    expect(forwardSecretMatches('', '')).toBe(false);
    expect(forwardSecretMatches('short', 'short')).toBe(false);
  });
  it('a forwarded message id is bounded and shell-safe', () => {
    expect(isForwardableMessageId('msg-1759900000000-abc123')).toBe(true);
    expect(isForwardableMessageId('')).toBe(false);
    expect(isForwardableMessageId('a b')).toBe(false);
    expect(isForwardableMessageId('x'.repeat(129))).toBe(false);
    expect(isForwardableMessageId(42)).toBe(false);
  });
});

describe('the gate', () => {
  it('enabled omitted ⇒ the dev-agent gate; an explicit value always wins; the live value wins over boot config', () => {
    expect(resolveRelayForwardEnabled(undefined, { developmentAgent: true })).toBe(true);
    expect(resolveRelayForwardEnabled(undefined, { developmentAgent: false })).toBe(false);
    expect(resolveRelayForwardEnabled(false, { developmentAgent: true })).toBe(false);
    expect(resolveRelayForwardEnabled(true, { developmentAgent: false })).toBe(true);
    expect(resolveRelayForwardEnabled(undefined, { developmentAgent: true, threadline: { relayForward: { enabled: false } } })).toBe(false);
    expect(resolveRelayForwardEnabled(true, { developmentAgent: false, threadline: { relayForward: { enabled: false } } })).toBe(true);
  });
  it('the log line shape', () => {
    expect(forwardLogLine('msg-1', 'the mini', 'holder-200:delivered')).toBe('[a2a-forward] id=msg-1 to=the mini outcome=holder-200:delivered');
    expect(forwardLogLine('msg-1', '', 'not-executed:no-holder')).toBe('[a2a-forward] id=msg-1 to=none outcome=not-executed:no-holder');
  });
  it('both verbs are registered-peer class in the RBAC gate', () => {
    const deps = { routerHolder: () => null, ownerOf: () => null, placementTargetOf: () => null };
    expect(checkCommandRBAC({ type: 'a2a-relay-forward', targetAgent: 'x', body: 'b', messageId: 'm', resend: false } as MeshCommand, 'm_a', deps)).toEqual({ ok: true, reason: 'ok' });
    expect(checkCommandRBAC({ type: 'a2a-topic-reply-inject', topicId: 1, text: 't', messageId: 'm', threadId: 't' } as MeshCommand, 'm_a', deps)).toEqual({ ok: true, reason: 'ok' });
    // An OLDER peer has no case for the verb and answers claim-unauthorized.
    expect(checkCommandRBAC({ type: 'not-a-verb' } as unknown as MeshCommand, 'm_a', deps)).toEqual({ ok: false, reason: 'claim-unauthorized' });
  });
});

describe('RelayHolderFinder — which machine holds my relay connection', () => {
  const health = (fp: string, state: string) => ({ ok: true, json: async () => ({ fingerprint: fp, relay: { state } }) });
  const mk = (answers: Record<string, () => Promise<{ ok: boolean; json: () => Promise<unknown> }>>, extra: Partial<ConstructorParameters<typeof RelayHolderFinder>[0]> = {}) => {
    const hits: string[] = [];
    let now = 1_000_000;
    const finder = new RelayHolderFinder({
      listPeers: () => Object.keys(answers).map((u, i) => ({ machineId: `m_${i}`, url: u })),
      ownFingerprint: () => OWN_FP,
      fetchFn: async (url, init) => {
        const base = url.replace('/threadline/health', '');
        hits.push(base);
        return Promise.race([
          answers[base](),
          new Promise<never>((_r, rej) => init.signal.addEventListener('abort', () => rej(aborted()))),
        ]);
      },
      now: () => now,
      probeBudgetMs: 150,
      ...extra,
    });
    return { finder, hits, advance: (ms: number) => { now += ms; } };
  };

  it('a peer with my fingerprint and a connected relay qualifies', async () => {
    const { finder } = mk({ 'http://a': async () => health(OWN_FP, 'connected') });
    expect(await finder.find()).toMatchObject({ machineId: 'm_0', url: 'http://a' });
  });
  it('a wrong fingerprint does not qualify (another agent on that URL)', async () => {
    const { finder } = mk({ 'http://a': async () => health(OTHER_FP, 'connected') });
    expect(await finder.find()).toBeNull();
  });
  it('the fingerprint comparison is case-folded', async () => {
    const { finder } = mk({ 'http://a': async () => health(OWN_FP.toUpperCase(), 'connected') });
    expect(await finder.find()).not.toBeNull();
  });
  it.each(['not-configured', 'displaced', 'disconnected'])('relay.state %s does not qualify', async (state) => {
    const { finder } = mk({ 'http://a': async () => health(OWN_FP, state) });
    expect(await finder.find()).toBeNull();
  });
  it('a non-200, an unreadable body and an unreachable peer do not qualify', async () => {
    const { finder } = mk({
      'http://a': async () => ({ ok: false, json: async () => ({ fingerprint: OWN_FP, relay: { state: 'connected' } }) }),
      'http://b': async () => ({ ok: true, json: async () => { throw new Error('not json'); } }),
      'http://c': async () => { throw refused(); },
    });
    expect(await finder.find()).toBeNull();
  });
  it('no own fingerprint, or no peers ⇒ no holder, and nothing is probed', async () => {
    const a = mk({ 'http://a': async () => health(OWN_FP, 'connected') }, { ownFingerprint: () => null });
    expect(await a.finder.find()).toBeNull();
    expect(a.hits).toEqual([]);
    const b = mk({});
    expect(await b.finder.find()).toBeNull();
  });
  it('a throwing identity read ⇒ no holder (today\'s 503), never a throw', async () => {
    const { finder } = mk({ 'http://a': async () => health(OWN_FP, 'connected') }, { ownFingerprint: () => { throw new Error('locked'); } });
    expect(await finder.find()).toBeNull();
  });
  it('probes in parallel: a hanging peer does not hide the holder, and the whole probe is bounded', async () => {
    const { finder } = mk({
      'http://hang': () => new Promise(() => {}),
      'http://b': async () => health(OWN_FP, 'connected'),
    });
    const t = Date.now();
    expect(await finder.find()).toMatchObject({ url: 'http://b' });
    expect(Date.now() - t).toBeLessThan(140);
    const none = mk({ 'http://hang': () => new Promise(() => {}) });
    const t2 = Date.now();
    expect(await none.finder.find()).toBeNull();
    expect(Date.now() - t2).toBeLessThan(1000);
  });
  it('asks at most 8 peers', async () => {
    const answers: Record<string, () => Promise<{ ok: boolean; json: () => Promise<unknown> }>> = {};
    for (let i = 0; i < 12; i++) answers[`http://p${i}`] = async () => health(OTHER_FP, 'connected');
    const { finder, hits } = mk(answers);
    await finder.find();
    expect(hits).toHaveLength(8);
  });
  it('caches the answer for 60 s, re-probes after it, and drop() forgets it at once', async () => {
    const { finder, hits, advance } = mk({ 'http://a': async () => health(OWN_FP, 'connected') }, { ttlMs: 60_000 });
    await finder.find();
    await finder.find();
    expect(hits).toHaveLength(1);
    advance(59_000);
    await finder.find();
    expect(hits).toHaveLength(1);
    advance(2_000);
    await finder.find();
    expect(hits).toHaveLength(2);
    finder.drop();
    await finder.find();
    expect(hits).toHaveLength(3);
  });
  it('a negative answer is not cached', async () => {
    let state = 'displaced';
    const { finder } = mk({ 'http://a': async () => health(OWN_FP, state) });
    expect(await finder.find()).toBeNull();
    state = 'connected';
    expect(await finder.find()).not.toBeNull();
  });
});

describe('classifyForwardResult — each §4 class', () => {
  it.each([
    ['claim-unauthorized', 403], // an older peer
    ['stale-timestamp', 409],
    ['replayed-nonce', 409],
    ['unknown-sender', 401],
    ['no-handler', 501],
  ])('a typed mesh rejection (%s) ⇒ the forward did not execute', (reason, status) => {
    expect(classifyForwardResult(PEER, { ok: false, status, reason })).toEqual({ kind: 'not-executed', machine: PEER, reason });
  });
  it('the 503 "mesh-rpc not configured" (no reason) ⇒ did not execute', () => {
    expect(classifyForwardResult(PEER, { ok: false, status: 503 })).toMatchObject({ kind: 'not-executed', reason: 'mesh-rpc-not-configured' });
  });
  it('a standby refusing and the gate off on the holder ⇒ did not execute', () => {
    expect(classifyForwardResult(PEER, { ok: true, status: 200, result: { outcome: 'refused', reason: 'holder-is-standby' } })).toMatchObject({ kind: 'not-executed', reason: 'holder-is-standby' });
    expect(classifyForwardResult(PEER, { ok: true, status: 200, result: { outcome: 'refused', reason: 'relay-forward-disabled' } })).toMatchObject({ kind: 'not-executed', reason: 'relay-forward-disabled' });
  });
  it('the holder\'s own 503 ⇒ did not execute', () => {
    expect(classifyForwardResult(PEER, { ok: true, status: 200, result: { outcome: 'answered', status: 503, body: { success: false } } })).toMatchObject({ kind: 'not-executed', reason: 'holder-relay-not-connected' });
  });
  it.each([200, 502, 409, 404, 400, 413])('any other answer from the holder\'s route (%i) is transcribed', (status) => {
    const body = { success: status === 200, marker: status };
    expect(classifyForwardResult(PEER, { ok: true, status: 200, result: { outcome: 'answered', status, body } })).toEqual({ kind: 'answered', machine: PEER, status, body });
  });
  it('a non-200 with no reason, a holder "unknown" and a malformed result ⇒ unconfirmed', () => {
    expect(classifyForwardResult(PEER, { ok: false, status: 500 })).toMatchObject({ kind: 'unconfirmed', reason: 'http-500' });
    expect(classifyForwardResult(PEER, { ok: false, status: 400 })).toMatchObject({ kind: 'unconfirmed' });
    expect(classifyForwardResult(PEER, { ok: true, status: 200, result: { outcome: 'unknown', reason: 'holder-loopback-error' } })).toMatchObject({ kind: 'unconfirmed', reason: 'holder-loopback-error' });
    expect(classifyForwardResult(PEER, { ok: true, status: 200, result: undefined })).toMatchObject({ kind: 'unconfirmed' });
    expect(classifyForwardResult(PEER, { ok: true, status: 200, result: { outcome: 'answered', status: '200', body: {} } })).toMatchObject({ kind: 'unconfirmed' });
  });
});

describe('RelayForwarder — one attempt, no retry', () => {
  const cmd: RelayForwardCommand = { type: 'a2a-relay-forward', targetAgent: 'Dawn', body: 'hi', messageId: 'msg-1', resend: false };
  const mk = (send: (peer: ForwardPeer, c: RelayForwardCommand, t: number) => Promise<never> | Promise<{ ok: boolean; status: number; result?: unknown; reason?: string }>, found: ForwardPeer | null = PEER) => {
    const finder = { find: vi.fn(async () => found), drop: vi.fn() };
    const sendSpy = vi.fn(send);
    return { fwd: new RelayForwarder({ finder, send: sendSpy as never }), finder, sendSpy };
  };

  it('no holder ⇒ nothing is sent', async () => {
    const { fwd, sendSpy } = mk(async () => ({ ok: true, status: 200 }), null);
    expect(await fwd.forward(cmd)).toEqual({ kind: 'no-holder' });
    expect(sendSpy).not.toHaveBeenCalled();
  });
  it('sends ONCE with a 15 s budget and keeps the cache on an answer', async () => {
    const { fwd, finder, sendSpy } = mk(async () => ({ ok: true, status: 200, result: { outcome: 'answered', status: 200, body: { success: true } } }));
    expect(await fwd.forward(cmd)).toMatchObject({ kind: 'answered', status: 200 });
    expect(sendSpy).toHaveBeenCalledTimes(1);
    expect(sendSpy.mock.calls[0][2]).toBe(15_000);
    expect(finder.drop).not.toHaveBeenCalled();
  });
  it('a refused connection ⇒ did not execute, cache dropped, no retry', async () => {
    const { fwd, finder, sendSpy } = mk(async () => { throw refused(); });
    expect(await fwd.forward(cmd)).toMatchObject({ kind: 'not-executed', reason: 'connection-refused' });
    expect(sendSpy).toHaveBeenCalledTimes(1);
    expect(finder.drop).toHaveBeenCalledTimes(1);
  });
  it('a timeout ⇒ unconfirmed (it may have landed), cache dropped', async () => {
    const { fwd, finder } = mk(async () => { throw aborted(); });
    expect(await fwd.forward(cmd)).toMatchObject({ kind: 'unconfirmed', reason: 'timeout' });
    expect(finder.drop).toHaveBeenCalledTimes(1);
  });
  it('a reset mid-flight ⇒ unconfirmed, never "did not execute"', async () => {
    const { fwd } = mk(async () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } }); });
    expect(await fwd.forward(cmd)).toMatchObject({ kind: 'unconfirmed', reason: 'transport-error' });
  });
  it('a typed rejection drops the cache', async () => {
    const { fwd, finder } = mk(async () => ({ ok: false, status: 403, reason: 'claim-unauthorized' }));
    expect(await fwd.forward(cmd)).toMatchObject({ kind: 'not-executed', reason: 'claim-unauthorized' });
    expect(finder.drop).toHaveBeenCalledTimes(1);
  });
  it('a throwing finder ⇒ no holder, never a throw', async () => {
    const fwd = new RelayForwarder({ finder: { find: async () => { throw new Error('boom'); }, drop: () => {} }, send: (async () => ({ ok: true, status: 200 })) as never });
    expect(await fwd.forward(cmd)).toEqual({ kind: 'no-holder' });
  });
});

describe('buildForwardAnswer — what the caller is told and what is settled', () => {
  const ctx = { messageId: 'msg-1', threadId: 't-1', hadTopic: true };
  it('no holder / did not execute ⇒ null (today\'s 503, nothing settled)', () => {
    expect(buildForwardAnswer({ kind: 'no-holder' }, ctx)).toBeNull();
    expect(buildForwardAnswer({ kind: 'not-executed', machine: PEER, reason: 'claim-unauthorized' }, ctx)).toBeNull();
  });
  it.each([
    ['delivered', 'relay-sent'],
    ['queued', 'relay-queued'],
    ['unconfirmed', 'relay-unconfirmed'],
  ])('a 2xx with relay verdict %s is transcribed and settled as %s', (relayStatus, settlement) => {
    const body = { success: true, accepted: true, delivered: false, messageId: 'msg-1', threadId: 't-holder', deliveryPath: 'relay', relayStatus };
    const a = buildForwardAnswer({ kind: 'answered', machine: PEER, status: 200, body }, ctx)!;
    expect(a.status).toBe(200);
    expect(a.settlementOutcome).toBe(settlement);
    expect(a.body).toEqual({ ...body, deliveryPath: 'forwarded', forwardedTo: 'the mini', reply: null, replyArrivesIn: 'topic-session' });
  });
  it('a 502 refusal passes through with no settlement (stays re-drivable)', () => {
    const body = { success: false, relayStatus: 'rejected', relayReasonCode: 'rate_limited', retryLater: true, deliveryPath: 'relay' };
    const a = buildForwardAnswer({ kind: 'answered', machine: PEER, status: 502, body }, ctx)!;
    expect(a.status).toBe(502);
    expect(a.settlementOutcome).toBeUndefined();
    expect(a.body).toMatchObject({ success: false, relayStatus: 'rejected', relayReasonCode: 'rate_limited', retryLater: true, deliveryPath: 'forwarded', forwardedTo: 'the mini' });
  });
  it('a holder 4xx (the ambiguous-nickname 409) passes through with no settlement', () => {
    const a = buildForwardAnswer({ kind: 'answered', machine: PEER, status: 409, body: { success: false, error: 'Ambiguous nickname "Dawn"' } }, ctx)!;
    expect(a.status).toBe(409);
    expect(a.settlementOutcome).toBeUndefined();
    expect(a.body.error).toBe('Ambiguous nickname "Dawn"');
  });
  it('a timeout ⇒ relayStatus unconfirmed, do-not-resend, settled relay-unconfirmed', () => {
    const a = buildForwardAnswer({ kind: 'unconfirmed', machine: PEER, reason: 'timeout' }, ctx)!;
    expect(a.status).toBe(200);
    expect(a.settlementOutcome).toBe('relay-unconfirmed');
    expect(a.body).toMatchObject({ success: true, accepted: false, delivered: false, messageId: 'msg-1', relayStatus: 'unconfirmed', deliveryPath: 'forwarded', forwardedTo: 'the mini', reply: null });
    expect(String(a.body.deliveryOutcome)).toContain('Do not resend; check delivery on the mini');
  });
  it('replyArrivesIn is holder-hub for a send with no topic; forwardedTo falls back to the machine id', () => {
    const a = buildForwardAnswer({ kind: 'unconfirmed', machine: { machineId: 'm_x', url: 'u' }, reason: 'timeout' }, { messageId: 'm', hadTopic: false })!;
    expect(a.body).toMatchObject({ replyArrivesIn: 'holder-hub', forwardedTo: 'm_x' });
    expect(a.body).not.toHaveProperty('threadId');
  });
  it('never upgrades: a 2xx with no relay verdict settles nothing', () => {
    const a = buildForwardAnswer({ kind: 'answered', machine: PEER, status: 200, body: { success: true } }, ctx)!;
    expect(a.settlementOutcome).toBeUndefined();
  });
});

describe('handleRelayForwardCommand — the holder', () => {
  const cmd: RelayForwardCommand = {
    type: 'a2a-relay-forward', targetAgent: 'Dawn', resolvedFp: OTHER_FP, body: 'hello', messageId: 'msg-77',
    threadId: 't-9', resend: true, originTopicId: 4242, purpose: 'ask about the csv',
  };
  const SECRET = createForwardSecret();
  const mk = (over: Partial<Parameters<typeof handleRelayForwardCommand>[2]> = {}) => {
    const calls: Array<{ url: string; headers: Record<string, string>; body: Record<string, unknown> }> = [];
    const counters = createRelayForwardCounters();
    const deps = {
      enabled: () => true,
      relaySuppressedByStandby: () => false,
      secret: SECRET,
      loopbackUrl: 'http://127.0.0.1:4042',
      authToken: 'tok',
      counters,
      fetchFn: async (url: string, init: { headers: Record<string, string>; body: string }) => {
        calls.push({ url, headers: init.headers, body: JSON.parse(init.body) });
        return { status: 200, json: async () => ({ success: true, relayStatus: 'delivered', messageId: 'msg-77' }) };
      },
      ...over,
    };
    return { deps: deps as never as Parameters<typeof handleRelayForwardCommand>[2], calls, counters };
  };

  it('POSTs its own relay-send on loopback with the server token and the boot secret', async () => {
    const { deps, calls, counters } = mk();
    const r = await handleRelayForwardCommand(cmd, 'm_standby', deps);
    expect(r).toEqual({ outcome: 'answered', status: 200, body: { success: true, relayStatus: 'delivered', messageId: 'msg-77' } });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('http://127.0.0.1:4042/threadline/relay-send');
    expect(calls[0].headers.Authorization).toBe('Bearer tok');
    expect(calls[0].headers[RELAY_FORWARD_HEADER]).toBe(SECRET);
    expect(calls[0].body).toEqual({
      targetAgent: 'Dawn', resolvedFp: OTHER_FP, message: 'hello', threadId: 't-9', originTopicId: 4242,
      purpose: 'ask about the csv', waitForReply: false, messageId: 'msg-77', resend: true,
      forwardedFromMachine: 'm_standby',
    });
    expect(counters.holderHandled).toBe(1);
  });
  it('inReplyTo and originSessionName are NEVER sent, even if a peer puts them in the command', async () => {
    const { deps, calls } = mk();
    await handleRelayForwardCommand({ ...cmd, inReplyTo: 'in-1', originSessionName: 'sess', waitForReply: true, forwardedFromMachine: 'm_liar' } as never, 'm_standby', deps);
    expect(calls[0].body).not.toHaveProperty('inReplyTo');
    expect(calls[0].body).not.toHaveProperty('originSessionName');
    expect(calls[0].body.waitForReply).toBe(false);
    // forwardedFromMachine is the AUTHENTICATED mesh sender, never a payload field.
    expect(calls[0].body.forwardedFromMachine).toBe('m_standby');
  });
  it('the gate off ⇒ refuses, nothing is sent', async () => {
    const { deps, calls, counters } = mk({ enabled: () => false });
    expect(await handleRelayForwardCommand(cmd, 'm_standby', deps)).toEqual({ outcome: 'refused', reason: 'relay-forward-disabled' });
    expect(calls).toHaveLength(0);
    expect(counters.holderRefused).toBe(1);
  });
  it('a throwing gate reader is off', async () => {
    const { deps, calls } = mk({ enabled: () => { throw new Error('x'); } });
    expect(await handleRelayForwardCommand(cmd, 'm_standby', deps)).toMatchObject({ outcome: 'refused' });
    expect(calls).toHaveLength(0);
  });
  it('a STANDBY handler refuses (the loop stop)', async () => {
    const { deps, calls } = mk({ relaySuppressedByStandby: () => true });
    expect(await handleRelayForwardCommand(cmd, 'm_standby', deps)).toEqual({ outcome: 'refused', reason: 'holder-is-standby' });
    expect(calls).toHaveLength(0);
  });
  it.each([
    [{ ...cmd, targetAgent: '' }],
    [{ ...cmd, body: '' }],
    [{ ...cmd, messageId: 'has space' }],
    [{ ...cmd, messageId: undefined }],
  ])('an invalid payload is refused before the route', async (bad) => {
    const { deps, calls } = mk();
    expect(await handleRelayForwardCommand(bad as never, 'm_standby', deps)).toEqual({ outcome: 'refused', reason: 'invalid-payload' });
    expect(calls).toHaveLength(0);
  });
  it('a malformed resolvedFp is dropped (the holder then resolves the name itself)', async () => {
    const { deps, calls } = mk();
    await handleRelayForwardCommand({ ...cmd, resolvedFp: 'not-hex' }, 'm_standby', deps);
    expect(calls[0].body).not.toHaveProperty('resolvedFp');
  });
  it('the route\'s own 503 ⇒ refused (nothing was sent), counted as refused not handled', async () => {
    const { deps, counters } = mk({ fetchFn: (async () => ({ status: 503, json: async () => ({ success: false, error: 'Relay not connected' }) })) as never });
    expect(await handleRelayForwardCommand(cmd, 'm_standby', deps)).toEqual({ outcome: 'refused', reason: 'holder-relay-not-connected' });
    expect(counters).toMatchObject({ holderHandled: 0, holderRefused: 1 });
  });
  it('a 502 refusal and a 4xx are answered unchanged', async () => {
    const a = mk({ fetchFn: (async () => ({ status: 502, json: async () => ({ success: false, relayStatus: 'rejected' }) })) as never });
    expect(await handleRelayForwardCommand(cmd, 'm_standby', a.deps)).toEqual({ outcome: 'answered', status: 502, body: { success: false, relayStatus: 'rejected' } });
    const b = mk({ fetchFn: (async () => ({ status: 409, json: async () => ({ success: false, error: 'Ambiguous' }) })) as never });
    expect(await handleRelayForwardCommand(cmd, 'm_standby', b.deps)).toMatchObject({ outcome: 'answered', status: 409 });
  });
  it('a refused loopback (restart mid-flight) fails closed; a timeout or unreadable answer is unknown', async () => {
    const a = mk({ fetchFn: (async () => { throw refused(); }) as never });
    expect(await handleRelayForwardCommand(cmd, 'm_standby', a.deps)).toEqual({ outcome: 'refused', reason: 'holder-loopback-refused' });
    const b = mk({ fetchFn: (async () => { throw Object.assign(new Error('t'), { name: 'TimeoutError' }); }) as never });
    expect(await handleRelayForwardCommand(cmd, 'm_standby', b.deps)).toEqual({ outcome: 'unknown', reason: 'holder-loopback-error' });
    const c = mk({ fetchFn: (async () => ({ status: 200, json: async () => { throw new Error('nope'); } })) as never });
    expect(await handleRelayForwardCommand(cmd, 'm_standby', c.deps)).toEqual({ outcome: 'unknown', reason: 'holder-answer-unreadable' });
  });
});

describe('handleTopicReplyInjectCommand — the receiver', () => {
  const cmd = { type: 'a2a-topic-reply-inject' as const, topicId: 4242, text: '[threadline-reply] hi', messageId: 'in-1', threadId: 't-1' };
  const mk = (over: Record<string, unknown> = {}) => {
    const inject = vi.fn(async () => true);
    const counters = createRelayForwardCounters();
    const deps = {
      enabled: () => true,
      getSessionForTopic: vi.fn(() => 'echo-topic-4242' as string | null),
      isSessionAlive: vi.fn(() => true),
      inject,
      counters,
      ...over,
    };
    return { deps: deps as never as Parameters<typeof handleTopicReplyInjectCommand>[1], inject: (over.inject as typeof inject) ?? inject, counters, raw: deps };
  };

  it('a live session for the topic ⇒ the confirmed paste, { injected: true }', async () => {
    const { deps, inject, counters } = mk();
    expect(await handleTopicReplyInjectCommand(cmd, deps)).toEqual({ injected: true });
    expect(inject).toHaveBeenCalledWith('echo-topic-4242', '[threadline-reply] hi');
    expect(counters.injectsReceived).toBe(1);
  });
  it('no session for the topic ⇒ definitive not-injected, nothing typed, nothing spawned', async () => {
    const { deps, inject } = mk({ getSessionForTopic: () => null });
    expect(await handleTopicReplyInjectCommand(cmd, deps)).toEqual({ injected: false, definitive: true, reason: 'no-session-for-topic' });
    expect(inject).not.toHaveBeenCalled();
  });
  it('a registered but dead session ⇒ definitive not-injected, nothing typed', async () => {
    const { deps, inject } = mk({ isSessionAlive: () => false });
    expect(await handleTopicReplyInjectCommand(cmd, deps)).toEqual({ injected: false, definitive: true, reason: 'session-not-alive' });
    expect(inject).not.toHaveBeenCalled();
  });
  it('the receiver has NO spawn dependency at all (it can never spawn or move the topic)', () => {
    const { raw } = mk();
    expect(Object.keys(raw).sort()).toEqual(['counters', 'enabled', 'getSessionForTopic', 'inject', 'isSessionAlive']);
  });
  it('the gate off ⇒ refuses', async () => {
    const { deps, inject } = mk({ enabled: () => false });
    expect(await handleTopicReplyInjectCommand(cmd, deps)).toEqual({ injected: false, definitive: true, reason: 'relay-forward-disabled' });
    expect(inject).not.toHaveBeenCalled();
  });
  it('an unconfirmed or throwing paste is NOT definitive (it may still land)', async () => {
    const a = mk({ inject: vi.fn(async () => false) });
    expect(await handleTopicReplyInjectCommand(cmd, a.deps)).toEqual({ injected: false, definitive: false, reason: 'inject-unconfirmed' });
    const b = mk({ inject: vi.fn(async () => { throw new Error('tmux'); }) });
    expect(await handleTopicReplyInjectCommand(cmd, b.deps)).toEqual({ injected: false, definitive: false, reason: 'inject-unconfirmed' });
  });
  it('an invalid topic, empty or oversized text, and a throwing lookup are definitive refusals', async () => {
    const { deps, inject } = mk();
    expect(await handleTopicReplyInjectCommand({ ...cmd, topicId: 0 }, deps)).toMatchObject({ injected: false, definitive: true, reason: 'invalid-payload' });
    expect(await handleTopicReplyInjectCommand({ ...cmd, text: '' }, deps)).toMatchObject({ reason: 'invalid-payload' });
    expect(await handleTopicReplyInjectCommand({ ...cmd, text: 'x'.repeat(64 * 1024 + 1) }, deps)).toMatchObject({ reason: 'invalid-payload' });
    expect(inject).not.toHaveBeenCalled();
    const t = mk({ getSessionForTopic: () => { throw new Error('x'); } });
    expect(await handleTopicReplyInjectCommand(cmd, t.deps)).toEqual({ injected: false, definitive: true, reason: 'session-lookup-failed' });
  });
});

describe('askTopicOwner — the holder\'s ask', () => {
  const payload = { topicId: 4242, text: 'x', messageId: 'in-1', threadId: 't-1' };
  it('sends the verb once with the budget and reports an inject', async () => {
    const send = vi.fn(async () => ({ ok: true, status: 200, result: { injected: true } }));
    expect(await askTopicOwner(send, 'm_b', payload, 9000)).toEqual({ injected: true });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith('m_b', { type: 'a2a-topic-reply-inject', ...payload }, 9000);
  });
  it('a definitive not-injected from the receiver stays definitive', async () => {
    const send = async () => ({ ok: true, status: 200, result: { injected: false, definitive: true, reason: 'session-not-alive' } });
    expect(await askTopicOwner(send, 'm_b', payload, 1)).toEqual({ injected: false, definitive: true, reason: 'session-not-alive' });
  });
  it('an attempted, unconfirmed inject is not definitive', async () => {
    const send = async () => ({ ok: true, status: 200, result: { injected: false, definitive: false, reason: 'inject-unconfirmed' } });
    expect(await askTopicOwner(send, 'm_b', payload, 1)).toEqual({ injected: false, definitive: false, reason: 'inject-unconfirmed' });
  });
  it('an older peer (claim-unauthorized), a timeout, a transport error and no URL are never definitive', async () => {
    expect(await askTopicOwner(async () => ({ ok: false, status: 403, reason: 'claim-unauthorized' }), 'm', payload, 1)).toEqual({ injected: false, definitive: false, reason: 'claim-unauthorized' });
    expect(await askTopicOwner(async () => { throw aborted(); }, 'm', payload, 1)).toEqual({ injected: false, definitive: false, reason: 'timeout' });
    expect(await askTopicOwner(async () => { throw refused(); }, 'm', payload, 1)).toEqual({ injected: false, definitive: false, reason: 'transport-error' });
    expect(await askTopicOwner(async () => null, 'm', payload, 1)).toEqual({ injected: false, definitive: false, reason: 'no-peer-url' });
    expect(await askTopicOwner(async () => ({ ok: true, status: 200, result: {} }), 'm', payload, 1)).toMatchObject({ injected: false, definitive: false });
  });
});

// ── B + C. the real route ─────────────────────────────────────────

const TOKEN = 'relay-forward-unit-token';

interface RelayCall { recipient: string; message: string; threadId: string | undefined; messageId: string | undefined; resend: unknown; argc: number }

interface Harness {
  port: number;
  server: Server;
  projectDir: string;
  stateDir: string;
  config: Record<string, unknown>;
  fwd: { secret: string; relaySuppressedByStandby: boolean; forward: ((c: RelayForwardCommand) => Promise<ForwardOutcome>) | null; counters: RelayForwardCounters };
  relayCalls: RelayCall[];
  live: { enabled: boolean | undefined };
  relay: { client: unknown };
  captures: Array<Record<string, unknown>>;
  threadLegs: Array<Record<string, unknown>>;
  listener: ReturnType<typeof makeListener> | null;
  holder: { listener: boolean };
}

function makeListener() {
  const l = {
    inbox: new Map<string, { id: string; threadId: string; text: string }>(),
    claims: new Map<string, string>(),
    outbox: [] as Array<Record<string, unknown>>,
    released: [] as string[],
    retained: [] as string[],
    readLatestCanonicalInboxForThread: () => null,
    readCanonicalInboxEntry: (id: string) => l.inbox.get(id) ?? null,
    tryClaimReply: (id: string, owner: string) => { if (l.claims.has(id) && l.claims.get(id) !== owner) return false; l.claims.set(id, owner); return true; },
    releaseReplyClaim: (id: string) => { l.claims.delete(id); l.released.push(id); },
    retainReplyClaimFailure: (id: string) => { l.retained.push(id); },
    appendCanonicalOutboxEntry: (e: Record<string, unknown>) => { l.outbox.push(e); return e; },
  };
  return l;
}

async function startHarness(opts: { relay: 'none' | 'connected' | 'disconnected'; listener?: boolean }): Promise<Harness> {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-relay-forward-unit-'));
  const stateDir = path.join(projectDir, '.instar');
  fs.mkdirSync(path.join(stateDir, 'threadline'), { recursive: true });
  fs.mkdirSync(path.join(stateDir, 'logs'), { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ projectName: 'echo-forward-unit' }));
  const h = {
    projectDir, stateDir,
    relayCalls: [] as RelayCall[],
    live: { enabled: undefined as boolean | undefined },
    captures: [] as Array<Record<string, unknown>>,
    threadLegs: [] as Array<Record<string, unknown>>,
    listener: opts.listener ? makeListener() : null,
  } as Harness;
  const relayStub = {
    connectionState: opts.relay === 'connected' ? 'connected' : 'disconnected',
    resolveAgent: async () => 'e4'.repeat(16),
    sendAutoWithThread(recipient: string, message: string, threadId?: string, messageId?: string, resend?: boolean) {
      // eslint-disable-next-line prefer-rest-params
      h.relayCalls.push({ recipient, message, threadId, messageId, resend, argc: arguments.length });
      return { messageId: messageId ?? 'msg-stub', threadId: threadId ?? 'thread-minted-by-client' };
    },
    awaitRelayAck: async () => ({ status: 'delivered' }),
    banSuspected: false,
    noteUnconfirmedSettled() {},
    sendAuto: () => 'msg-stub',
  };
  h.relay = { client: opts.relay === 'none' ? null : relayStub };
  h.fwd = { secret: createForwardSecret(), relaySuppressedByStandby: false, forward: null, counters: createRelayForwardCounters() };
  h.config = { projectDir, stateDir, projectName: 'echo-forward-unit', port: 4042, authToken: TOKEN, developmentAgent: true };
  const router = createRoutes({
    config: h.config as unknown as InstarConfig,
    state: new StateManager(stateDir),
    sessionManager: { getCachedRunningSessions: () => ({ count: 0, sessions: [] }), listRunningSessions: () => [] },
    get threadlineRelayClient() { return h.relay.client; },
    liveConfig: { get: <T,>(p: string, def: T): T => (p === 'threadline.relayForward.enabled' ? (h.live.enabled as T) : def) },
    a2aRelayForward: h.fwd,
    meshSelfId: 'm_self',
    get listenerManager() { return h.listener; },
    topicLinkageHandler: { captureOriginOnSend: (input: Record<string, unknown>) => { h.captures.push(input); return null; } },
    threadMessageRecorder: {
      record: (input: Record<string, unknown>) => { h.threadLegs.push(input); return { recorded: true }; },
      resolveOutboundThread: async (i: { explicitThreadId?: string; mintedThreadId: string }) => ({ threadId: i.explicitThreadId ?? i.mintedThreadId }),
    },
    startTime: new Date(),
  } as never);
  const app = express();
  app.use(express.json());
  app.use(router);
  await new Promise<void>((resolve) => {
    h.server = app.listen(0, '127.0.0.1', () => { h.port = (h.server.address() as { port: number }).port; resolve(); });
  });
  return h;
}

async function stopHarness(h: Harness): Promise<void> {
  await new Promise<void>((r) => h.server.close(() => r()));
  SafeFsExecutor.safeRmSync(h.projectDir, { recursive: true, force: true, operation: 'tests/unit/a2a-cross-machine-route.test.ts' });
}

const post = async (h: Harness, body: Record<string, unknown>, headers: Record<string, string> = {}) => {
  const r = await fetch(`http://127.0.0.1:${h.port}/threadline/relay-send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}`, ...headers },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.json() as Record<string, unknown> };
};

describe('/threadline/relay-send on a STANDBY — when a forward is tried and what is answered', () => {
  let h: Harness;
  let forwarded: RelayForwardCommand[];
  let next: ForwardOutcome;
  let logs: string[];

  beforeAll(async () => { h = await startHarness({ relay: 'none', listener: true }); });
  afterAll(async () => { await stopHarness(h); });

  beforeEach(() => {
    forwarded = [];
    next = { kind: 'answered', machine: PEER, status: 200, body: { success: true, accepted: true, delivered: false, messageId: 'will-be-overwritten', threadId: 't-on-holder', resolvedAgent: OTHER_FP, deliveryPath: 'relay', relayStatus: 'delivered', deliveryOutcome: 'handed to the peer', topicLinkageStamped: true } };
    h.fwd.relaySuppressedByStandby = true;
    h.fwd.forward = async (c) => { forwarded.push(c); if (next.kind === 'answered') (next.body as Record<string, unknown>).messageId = c.messageId; return next; };
    h.fwd.counters = Object.assign(h.fwd.counters, createRelayForwardCounters());
    h.live.enabled = undefined;
    h.config.developmentAgent = true;
    h.relay.client = null;
    h.listener!.inbox.clear(); h.listener!.claims.clear();
    h.listener!.outbox.length = 0; h.listener!.released.length = 0; h.listener!.retained.length = 0;
    for (const f of ['known-agents.json', 'nicknames.json']) {
      SafeFsExecutor.safeRmSync(path.join(h.stateDir, 'threadline', f), { force: true, operation: 'tests/unit/a2a-cross-machine-route.test.ts:reset' });
    }
    logs = [];
    vi.restoreAllMocks();
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { logs.push(a.map(String).join(' ')); });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  it('a standby with the gate on forwards once and transcribes the holder\'s verdict', async () => {
    const r = await post(h, { targetAgent: 'Dawn', message: 'hello from the standby', originTopicId: 4242, purpose: 'the csv' });
    expect(r.status).toBe(200);
    expect(forwarded).toHaveLength(1);
    const c = forwarded[0];
    expect(c).toMatchObject({ type: 'a2a-relay-forward', targetAgent: 'Dawn', body: 'hello from the standby', resend: false, originTopicId: 4242, purpose: 'the csv' });
    expect(c.messageId).toMatch(/^msg-\d+-[a-z0-9]+$/);
    expect(c).not.toHaveProperty('threadId'); // the caller gave none: the holder's resolver decides
    expect(c).not.toHaveProperty('resolvedFp');
    expect(c).not.toHaveProperty('inReplyTo');
    expect(c).not.toHaveProperty('originSessionName');
    expect(r.body).toMatchObject({
      success: true, accepted: true, messageId: c.messageId, threadId: 't-on-holder', relayStatus: 'delivered',
      deliveryPath: 'forwarded', forwardedTo: 'the mini', reply: null, replyArrivesIn: 'topic-session',
    });
    expect(logs).toContain(`[a2a-forward] id=${c.messageId} to=the mini outcome=holder-200:delivered`);
  });

  it('the caller\'s raw thread id is forwarded; a send with no topic says holder-hub', async () => {
    const r = await post(h, { targetAgent: 'Dawn', message: 'm', threadId: 'thread-caller' });
    expect(forwarded[0].threadId).toBe('thread-caller');
    expect(forwarded[0]).not.toHaveProperty('originTopicId');
    expect(r.body.replyArrivesIn).toBe('holder-hub');
  });

  it('the standby\'s own nickname resolution rides as resolvedFp; the name itself is forwarded unchanged', async () => {
    fs.writeFileSync(path.join(h.stateDir, 'threadline', 'nicknames.json'), JSON.stringify({
      version: 1, nicknames: { [OTHER_FP]: { nickname: 'Dawn', source: 'user', updatedAt: new Date().toISOString() } },
    }));
    await post(h, { targetAgent: 'Dawn', message: 'm' });
    expect(forwarded[0]).toMatchObject({ targetAgent: 'Dawn', resolvedFp: OTHER_FP });
  });

  it('waitForReply is not honoured across machines: answered at once with reply null', async () => {
    const t = Date.now();
    const r = await post(h, { targetAgent: 'Dawn', message: 'm', waitForReply: true, timeoutSeconds: 30 });
    expect(Date.now() - t).toBeLessThan(3000);
    expect(r.body.reply).toBeNull();
  });

  it('NOT a standby (the client is merely absent) ⇒ today\'s 503, nothing forwarded', async () => {
    h.fwd.relaySuppressedByStandby = false;
    const r = await post(h, { targetAgent: 'Dawn', message: 'm' });
    expect(r.status).toBe(503);
    expect(r.body).toEqual({ success: false, error: 'Relay not connected and local delivery unavailable' });
    expect(forwarded).toHaveLength(0);
  });

  it('a displaced / disconnected machine (a client exists) keeps the 503 even if the flag were set', async () => {
    h.relay.client = { connectionState: 'disconnected' };
    const r = await post(h, { targetAgent: 'Dawn', message: 'm' });
    expect(r.status).toBe(503);
    expect(forwarded).toHaveLength(0);
  });

  it('a credential share is never forwarded', async () => {
    for (const extra of [{ kind: 'credential-share' }, { credentialShare: true }]) {
      const r = await post(h, { targetAgent: 'Dawn', message: 'the token', ...extra });
      expect(r.status).toBe(503);
    }
    expect(forwarded).toHaveLength(0);
  });

  it('the gate off — live false, boot false, or the fleet — is today\'s 503', async () => {
    h.live.enabled = false;
    expect((await post(h, { targetAgent: 'Dawn', message: 'm' })).status).toBe(503);
    h.live.enabled = undefined;
    h.config.threadline = { relayForward: { enabled: false } };
    expect((await post(h, { targetAgent: 'Dawn', message: 'm' })).status).toBe(503);
    delete h.config.threadline;
    h.config.developmentAgent = false;
    expect((await post(h, { targetAgent: 'Dawn', message: 'm' })).status).toBe(503);
    expect(forwarded).toHaveLength(0);
    // …and the fleet flip turns it on without a dev agent.
    h.live.enabled = true;
    expect((await post(h, { targetAgent: 'Dawn', message: 'm' })).status).toBe(200);
  });

  it('no forwarder wired yet (mesh client not built) ⇒ 503', async () => {
    h.fwd.forward = null;
    expect((await post(h, { targetAgent: 'Dawn', message: 'm' })).status).toBe(503);
  });

  it('no holder ⇒ today\'s 503, logged and counted', async () => {
    next = { kind: 'no-holder' };
    const r = await post(h, { targetAgent: 'Dawn', message: 'm' });
    expect(r.status).toBe(503);
    expect(r.body).toEqual({ success: false, error: 'Relay not connected and local delivery unavailable' });
    expect(logs.some((l) => /^\[a2a-forward\] id=msg-\S+ to=none outcome=not-executed:no-holder$/.test(l))).toBe(true);
    expect(h.fwd.counters.notExecuted).toBe(1);
  });

  it.each(['claim-unauthorized', 'stale-timestamp', 'replayed-nonce', 'unknown-sender', 'holder-is-standby', 'relay-forward-disabled', 'holder-relay-not-connected', 'connection-refused'])(
    'the forward did not execute (%s) ⇒ today\'s 503', async (reason) => {
      next = { kind: 'not-executed', machine: PEER, reason };
      const r = await post(h, { targetAgent: 'Dawn', message: 'm' });
      expect(r.status).toBe(503);
      expect(r.body).toEqual({ success: false, error: 'Relay not connected and local delivery unavailable' });
      expect(logs.some((l) => l.endsWith(`to=the mini outcome=not-executed:${reason}`))).toBe(true);
    });

  it('a relay refusal on the holder is the same 502, with the contract fields', async () => {
    next = { kind: 'answered', machine: PEER, status: 502, body: { success: false, error: 'not delivered: relay refused (rate_limited).', relayStatus: 'rejected', relayReasonCode: 'rate_limited', retryLater: true, deliveryPath: 'relay' } };
    const r = await post(h, { targetAgent: 'Dawn', message: 'm' });
    expect(r.status).toBe(502);
    expect(r.body).toMatchObject({ success: false, relayStatus: 'rejected', relayReasonCode: 'rate_limited', retryLater: true, deliveryPath: 'forwarded', forwardedTo: 'the mini', reply: null });
  });

  it('every holder 4xx passes through (the ambiguous-nickname 409, a 404)', async () => {
    next = { kind: 'answered', machine: PEER, status: 409, body: { success: false, error: 'Ambiguous nickname "Dawn"' } };
    let r = await post(h, { targetAgent: 'Dawn', message: 'm' });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('Ambiguous nickname "Dawn"');
    next = { kind: 'answered', machine: PEER, status: 404, body: { success: false, error: 'Agent not found: "Dawn".' } };
    r = await post(h, { targetAgent: 'Dawn', message: 'm' });
    expect(r.status).toBe(404);
  });

  it('a timeout ⇒ relayStatus unconfirmed with the id and "do not resend"', async () => {
    next = { kind: 'unconfirmed', machine: PEER, reason: 'timeout' };
    const r = await post(h, { targetAgent: 'Dawn', message: 'm', threadId: 'thread-caller' });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ success: true, accepted: false, delivered: false, relayStatus: 'unconfirmed', messageId: forwarded[0].messageId, threadId: 'thread-caller', deliveryPath: 'forwarded', forwardedTo: 'the mini' });
    expect(String(r.body.deliveryOutcome)).toContain('Do not resend');
    expect(h.fwd.counters.unconfirmed).toBe(1);
  });

  it('counters ride the AUTHED /health only', async () => {
    await post(h, { targetAgent: 'Dawn', message: 'm' });
    const authed = await (await fetch(`http://127.0.0.1:${h.port}/health`, { headers: { Authorization: `Bearer ${TOKEN}` } })).json() as { threadline?: { relayForward?: Record<string, number> } };
    expect(authed.threadline?.relayForward).toMatchObject({ forwarded: 1, notExecuted: 0, unconfirmed: 0 });
    const anon = await (await fetch(`http://127.0.0.1:${h.port}/health`)).json() as { threadline?: unknown };
    expect(anon.threadline).toBeUndefined();
  });

  // ── the settlement line + the reply claim (spec §4 table) ───────

  const inbound = () => { h.listener!.inbox.set('in-1', { id: 'in-1', threadId: 'thread-caller', text: 'q' }); };
  const reply = () => post(h, { targetAgent: 'Dawn', message: 'my answer', threadId: 'thread-caller', inReplyTo: 'in-1', originSessionName: 'echo-topic-4242' });

  it('an inReplyTo the standby never received ⇒ 400 from its own rule, before any forward', async () => {
    const r = await reply();
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('inReplyTo must name an authenticated inbound on this thread.');
    expect(forwarded).toHaveLength(0);
  });

  it('2xx with a relay verdict ⇒ ONE settlement line (inReplyTo, the request\'s own thread, the holder\'s outcome), claim released', async () => {
    inbound();
    const r = await reply();
    expect(r.status).toBe(200);
    expect(forwarded[0]).not.toHaveProperty('inReplyTo');
    expect(h.listener!.outbox).toHaveLength(1);
    expect(h.listener!.outbox[0]).toMatchObject({ inReplyTo: 'in-1', threadId: 'thread-caller', outcome: 'relay-sent', messageId: forwarded[0].messageId, recipientName: 'Dawn', text: 'my answer', to: OTHER_FP });
    expect(h.listener!.claims.has('in-1')).toBe(false);
  });

  it('a queued verdict settles as relay-queued', async () => {
    inbound();
    (next as { body: Record<string, unknown> }).body.relayStatus = 'queued';
    await reply();
    expect(h.listener!.outbox[0]).toMatchObject({ outcome: 'relay-queued' });
  });

  it('a 502 refusal ⇒ no settlement line (stays re-drivable), claim released by the finish handler', async () => {
    inbound();
    next = { kind: 'answered', machine: PEER, status: 502, body: { success: false, relayStatus: 'rejected' } };
    expect((await reply()).status).toBe(502);
    expect(h.listener!.outbox).toHaveLength(0);
    await vi.waitFor(() => expect(h.listener!.claims.has('in-1')).toBe(false));
  });

  it('a holder 4xx ⇒ no settlement line, claim released by the finish handler', async () => {
    inbound();
    next = { kind: 'answered', machine: PEER, status: 409, body: { success: false, error: 'Ambiguous' } };
    expect((await reply()).status).toBe(409);
    expect(h.listener!.outbox).toHaveLength(0);
    await vi.waitFor(() => expect(h.listener!.claims.has('in-1')).toBe(false));
  });

  it('503, the forward did not execute ⇒ no settlement line, claim released by the finish handler', async () => {
    inbound();
    next = { kind: 'not-executed', machine: PEER, reason: 'claim-unauthorized' };
    expect((await reply()).status).toBe(503);
    expect(h.listener!.outbox).toHaveLength(0);
    await vi.waitFor(() => expect(h.listener!.claims.has('in-1')).toBe(false));
  });

  it('a timeout ⇒ settled relay-unconfirmed (no duplicate over no loss), claim released', async () => {
    inbound();
    next = { kind: 'unconfirmed', machine: PEER, reason: 'timeout' };
    expect((await reply()).status).toBe(200);
    expect(h.listener!.outbox).toHaveLength(1);
    expect(h.listener!.outbox[0]).toMatchObject({ inReplyTo: 'in-1', threadId: 'thread-caller', outcome: 'relay-unconfirmed' });
    expect(h.listener!.claims.has('in-1')).toBe(false);
  });

  it('a second reply for the same inbound while one is in flight is refused 409 before any forward', async () => {
    inbound();
    h.listener!.claims.set('in-1', 'someone-else');
    const r = await reply();
    expect(r.status).toBe(409);
    expect(forwarded).toHaveLength(0);
  });

  it('the standby writes no other A2A record (no tracker row, no thread leg, no origin capture)', async () => {
    await post(h, { targetAgent: 'Dawn', message: 'm', originTopicId: 4242 });
    expect(h.captures).toHaveLength(0);
    expect(h.threadLegs).toHaveLength(0);
    expect(h.listener!.outbox).toHaveLength(0);
  });
});

describe('/threadline/relay-send on the HOLDER — the §3 table', () => {
  let h: Harness;
  let logs: string[];
  let loop: Server;
  let loopPort: number;
  let loopHits: { health: number; post: number };
  const LOCAL = `fwd-colo-${randomBytes(3).toString('hex')}`;
  const tokenPath = path.join(os.homedir(), '.instar', 'agent-tokens', `${LOCAL}.token`);

  beforeAll(async () => {
    h = await startHarness({ relay: 'connected' });
    loopHits = { health: 0, post: 0 };
    const app = express();
    app.use(express.json());
    app.get('/threadline/health', (_q, res) => { loopHits.health++; res.json({ fingerprint: OTHER_FP, relay: { state: 'connected' } }); });
    app.post('/messages/relay-agent', (_q, res) => { loopHits.post++; res.json({ ok: true, accepted: true, delivered: false, threadline: { accepted: true, async: true } }); });
    await new Promise<void>((resolve) => { loop = app.listen(0, '127.0.0.1', () => { loopPort = (loop.address() as { port: number }).port; resolve(); }); });
    fs.mkdirSync(path.dirname(tokenPath), { recursive: true });
    fs.writeFileSync(tokenPath, randomBytes(32).toString('hex'));
  });
  afterAll(async () => {
    await new Promise<void>((r) => { loop.close(() => r()); loop.closeAllConnections(); });
    SafeFsExecutor.safeRmSync(tokenPath, { force: true, operation: 'tests/unit/a2a-cross-machine-route.test.ts:token' });
    await stopHarness(h);
  });
  beforeEach(() => {
    h.relayCalls.length = 0; h.captures.length = 0; h.threadLegs.length = 0;
    h.fwd.relaySuppressedByStandby = false;
    h.fwd.forward = null;
    h.live.enabled = undefined;
    loopHits.health = 0; loopHits.post = 0;
    SafeFsExecutor.safeRmSync(path.join(h.stateDir, 'threadline', 'known-agents.json'), { force: true, operation: 'tests/unit/a2a-cross-machine-route.test.ts:reset' });
    logs = [];
    vi.restoreAllMocks();
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { logs.push(a.map(String).join(' ')); });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  const forwardedBody = { targetAgent: 'Dawn', resolvedFp: OTHER_FP, message: 'hello', threadId: 't-9', originTopicId: 4242, waitForReply: false, messageId: 'msg-from-standby-1', resend: true, forwardedFromMachine: 'm_standby' };
  const secret = () => ({ [RELAY_FORWARD_HEADER]: h.fwd.secret });

  it('with the secret: the caller\'s messageId and resend are honoured and resolvedFp is the recipient', async () => {
    const r = await post(h, forwardedBody, secret());
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ success: true, messageId: 'msg-from-standby-1', deliveryPath: 'relay', relayStatus: 'delivered', resolvedAgent: OTHER_FP });
    expect(h.relayCalls).toHaveLength(1);
    // resolveAgent() would have answered e4…; resolvedFp wins, the name cannot be re-resolved.
    expect(h.relayCalls[0]).toMatchObject({ recipient: OTHER_FP, messageId: 'msg-from-standby-1', threadId: 't-9', resend: true, argc: 5 });
  });

  it('with the secret: machineOrigin and the thread-log author are the authenticated mesh sender', async () => {
    await post(h, forwardedBody, secret());
    expect(h.captures).toHaveLength(1);
    expect(h.captures[0]).toMatchObject({ machineOrigin: 'm_standby', originTopicId: 4242, remoteAgent: OTHER_FP, remoteAgentDisplayName: 'Dawn' });
    expect(h.threadLegs).toHaveLength(1);
    expect(h.threadLegs[0]).toMatchObject({ direction: 'outbound', messageId: 'msg-from-standby-1', author: { machineId: 'm_standby' } });
  });

  it('with the secret and no resolvedFp: the holder resolves the name itself', async () => {
    const { resolvedFp: _omit, ...noFp } = forwardedBody;
    await post(h, noFp, secret());
    expect(h.relayCalls[0].recipient).toBe('e4'.repeat(16));
  });

  it('with the secret and resend false: the relay leg is unmarked', async () => {
    await post(h, { ...forwardedBody, resend: false }, secret());
    expect(h.relayCalls[0].argc).toBe(4);
    expect(h.relayCalls[0].resend).toBeUndefined();
  });

  it.each([
    ['a wrong secret', () => ({ [RELAY_FORWARD_HEADER]: createForwardSecret() })],
    ['no secret', () => ({})],
    ['an empty secret', () => ({ [RELAY_FORWARD_HEADER]: '' })],
  ])('%s: none of the forwarded fields are honoured — it is an ordinary send', async (_label, headers) => {
    const r = await post(h, forwardedBody, headers());
    expect(r.status).toBe(200);
    expect(r.body.messageId).not.toBe('msg-from-standby-1');
    expect(h.relayCalls[0].messageId).not.toBe('msg-from-standby-1');
    expect(h.relayCalls[0].recipient).toBe('e4'.repeat(16)); // resolvedFp ignored
    expect(h.relayCalls[0].argc).toBe(4); // resend ignored
    expect(h.captures[0]).not.toHaveProperty('machineOrigin'); // forwardedFromMachine ignored
    expect((h.threadLegs[0].author as { machineId?: string }).machineId).toBe('m_self');
  });

  it('a target co-located with the holder still goes over the relay under the secret — and goes local without it', async () => {
    fs.writeFileSync(path.join(h.stateDir, 'threadline', 'known-agents.json'), JSON.stringify({ agents: [{ name: LOCAL, port: loopPort, fingerprint: OTHER_FP }] }));
    const fwd = await post(h, { ...forwardedBody, targetAgent: LOCAL }, secret());
    expect(fwd.body.deliveryPath).toBe('relay');
    expect(loopHits).toEqual({ health: 0, post: 0 });
    expect(h.relayCalls).toHaveLength(1);

    const plain = await post(h, { targetAgent: LOCAL, message: 'hello' });
    expect(plain.body.deliveryPath).toBe('local');
    expect(loopHits.post).toBe(1);
    expect(h.relayCalls).toHaveLength(1);
  });

  it('a forwarded request NEVER forwards again: with no relay it is the 503, even on a machine flagged standby', async () => {
    const saved = h.relay.client;
    h.relay.client = null;
    h.fwd.relaySuppressedByStandby = true;
    const forward = vi.fn(async () => ({ kind: 'no-holder' as const }));
    h.fwd.forward = forward;
    try {
      const r = await post(h, forwardedBody, secret());
      expect(r.status).toBe(503);
      expect(forward).not.toHaveBeenCalled();
      // …while the same request WITHOUT the secret on that standby does try.
      await post(h, { targetAgent: 'Dawn', message: 'm' });
      expect(forward).toHaveBeenCalledTimes(1);
    } finally {
      h.relay.client = saved;
    }
  });

  it('the required-fields and 64 KiB checks still run for a forwarded request', async () => {
    expect((await post(h, { ...forwardedBody, message: '' }, secret())).status).toBe(400);
    expect((await post(h, { ...forwardedBody, message: 'x'.repeat(64 * 1024 + 1) }, secret())).status).toBe(413);
    expect(h.relayCalls).toHaveLength(0);
  });

  it('the secret never appears in a log line or a response', async () => {
    const r = await post(h, forwardedBody, secret());
    expect(JSON.stringify(r.body)).not.toContain(h.fwd.secret);
    expect(logs.join('\n')).not.toContain(h.fwd.secret);
  });
});
