import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { TelegramLifeline } from '../../../src/lifeline/TelegramLifeline.js';
import type { OriginSessionLifecycle } from '../../../src/messaging/telegram-origin/OriginSessionRegistry.js';
import { OriginTransportCancelledBeforeNetwork } from '../../../src/messaging/telegram-origin/OriginTransportCancellation.js';
import { OriginCapacityUnavailable } from '../../../src/messaging/telegram-origin/OriginEgressCapacity.js';
import { TelegramOriginRuntime } from '../../../src/messaging/telegram-origin/TelegramOriginRuntime.js';
import { telegramFetch } from '../../../src/messaging/telegram-egress.js';
import { compileOriginWorker, temporaryState } from '../../helpers/telegramOriginStore.js';
import { fixtureOriginContentDedup } from '../../helpers/originContentDedup.js';

let worker: URL;
const runtimes: TelegramOriginRuntime[] = [];
const privateKey = generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
beforeAll(async () => { worker = await compileOriginWorker(); });
afterEach(async () => { for (const runtime of runtimes.splice(0)) await runtime.close(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
async function harness() {
  const stateDir = temporaryState(), token = `123:${randomUUID()}`;
  let lifecycle: OriginSessionLifecycle | undefined;
  const runtime = await TelegramOriginRuntime.open({ storage: { stateDir, agentId: 'echo' }, workerUrl: worker,
    identity: { agentId: 'echo', agentName: 'Echo', originMachineId: 'studio', originMachineName: 'Studio' },
    signingKey: { privateKey, keyId: 'studio-1', keyEpoch: 1 }, bot: { token, accountId: 'bot-1', chatId: '-100123' },
    isSessionLive: () => true, attachSessionLifecycle: value => { lifecycle = value; },
    display: () => ({}), authorize: () => true, diagnoseUnknown: async () => undefined,
    alertDestinations: () => [], getAlertPolicy: () => null, onNoticeState: () => undefined });
  runtimes.push(runtime);
  const sessionToken = await lifecycle!.issue({ sessionId: 'deadline-session', harnessId: 'codex-cli', projectDir: process.cwd(), configuredModel: 'fixture-model' });
  const review = vi.fn(async () => ({ ok: true as const }));
  runtime.attachSendPolicy({ review, authorizeDispatch: () => ({ ok: true }), ...fixtureOriginContentDedup(stateDir) });
  const network = vi.fn(async (_url: string, init: RequestInit) => {
    init.signal?.throwIfAborted();
    const body = JSON.parse(init.body as string);
    return new Response(JSON.stringify({ ok: true, result: { message_id: 27, chat: { id: -100123 }, message_thread_id: body.message_thread_id } }));
  });
  vi.stubGlobal('fetch', network);
  const send = (options: RequestInit & { networkTimeoutMs?: number } = {}, text = 'Requested report') =>
    runtime.service.runWithSessionToken(sessionToken, () => telegramFetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST', body: JSON.stringify({ chat_id: '-100123', message_thread_id: 42, text }), ...options }));
  return { runtime, review, network, send, token, sessionToken };
}
describe('Telegram network deadlines after origin preparation', () => {
  it('wires the Lifeline sender to a late network duration and preserves long-poll headroom', async () => {
    const h = await harness(), projectDir = temporaryState();
    mkdirSync(path.join(projectDir, '.instar'));
    // This constructor-only fixture never starts a provider or tmux. Private
    // fail-on-use executables remove unrelated host CLI prerequisites.
    const codexPath = path.join(projectDir, 'fixture-codex'), tmuxPath = path.join(projectDir, 'fixture-tmux');
    for (const binary of [codexPath, tmuxPath]) {
      writeFileSync(binary, '#!/bin/sh\nprintf invoked > \"$0.invoked\"\nexit 91\n', { mode: 0o700 });
    }
    writeFileSync(path.join(projectDir, '.instar/config.json'), JSON.stringify({
      projectName: 'deadline-fixture', port: 4042,
      sessions: { framework: 'codex-cli', frameworkBinaryPaths: { 'codex-cli': codexPath }, tmuxPath },
      messaging: [{ type: 'telegram', enabled: true,
        config: { token: h.token, chatId: '-100123' } }],
    }));
    // Construct the actual class without starting polling or process supervision.
    const lifeline = new TelegramLifeline(projectDir) as unknown as {
      apiCall(method: string, params: Record<string, unknown>): Promise<unknown>;
      projectConfig: { sessions: { framework: string; frameworkBinaryPaths: Record<string, string>; tmuxPath: string } };
    };
    expect(lifeline.projectConfig.sessions.framework).toBe('codex-cli');
    expect(lifeline.projectConfig.sessions.frameworkBinaryPaths['codex-cli']).toBe(codexPath);
    expect(lifeline.projectConfig.sessions.tmuxPath).toBe(tmuxPath);
    const deadline = new AbortController();
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(deadline.signal);
    h.review.mockImplementation(async () => { expect(timeout).not.toHaveBeenCalled(); return { ok: true }; });
    await expect(h.runtime.service.runWithSessionToken(h.sessionToken, () => lifeline.apiCall('sendMessage', {
      chat_id: '-100123', message_thread_id: 42, text: 'Requested Lifeline status',
    }))).resolves.toMatchObject({ message_id: 27 });
    expect(h.review).toHaveBeenCalledOnce(); expect(timeout).toHaveBeenCalledWith(15_000);
    expect(h.network.mock.calls[0][1].signal).toBe(deadline.signal);
    await lifeline.apiCall('getUpdates', { timeout: 30 });
    expect(timeout).toHaveBeenLastCalledWith(60_000);
    expect(existsSync(`${codexPath}.invoked`)).toBe(false);
    expect(existsSync(`${tmuxPath}.invoked`)).toBe(false);
  });
  it('starts the deadline only after policy, durable claim and capacity consumption', async () => {
    const h = await harness();
    const clocks: AbortController[] = [];
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockImplementation(() => { const c = new AbortController(); clocks.push(c); return c.signal; });
    h.review.mockImplementation(async () => { expect(timeout).not.toHaveBeenCalled(); return { ok: true }; });
    const claim = h.runtime.store.claim.bind(h.runtime.store);
    vi.spyOn(h.runtime.store, 'claim').mockImplementation(async input => { expect(timeout).not.toHaveBeenCalled(); return claim(input); });
    const consume = h.runtime.service.options.capacity!.consume.bind(h.runtime.service.options.capacity!);
    vi.spyOn(h.runtime.service.options.capacity!, 'consume').mockImplementation(async grant => { expect(timeout).not.toHaveBeenCalled(); return consume(grant); });
    expect((await h.send({ networkTimeoutMs: 15_000 })).ok).toBe(true);
    expect(timeout).toHaveBeenCalledOnce(); expect(timeout).toHaveBeenCalledWith(15_000);
    expect(h.review).toHaveBeenCalledOnce();
    expect(h.network.mock.calls[0][1].signal).toBe(clocks[0].signal);
    expect(h.network.mock.calls[0][1]).not.toHaveProperty('networkTimeoutMs');
    expect((await h.runtime.store.listOrigins()).records[0].children[0].state).toBe('accepted');
  });
  it.each(['already', 'during-review'] as const)('records %s caller cancellation as known unsent without a network invocation', async when => {
    const h = await harness(), caller = new AbortController();
    if (when === 'already') caller.abort();
    else h.review.mockImplementation(async () => { caller.abort(); return { ok: true }; });
    await expect(h.send({ signal: caller.signal, networkTimeoutMs: 15_000 }))
      .rejects.toMatchObject({ reason: 'telegram-request-cancelled-before-network' });
    expect(h.network).not.toHaveBeenCalled();
    const row = (await h.runtime.store.listOrigins()).records[0];
    expect(row.attempts[0]).toMatchObject({ phase: 'dispatched', outcome: 'known-failed', reason: 'telegram-request-cancelled-before-network' });
    expect(row.children[0].state).toBe('queued');
    expect(row.operation?.operationId).toBe(JSON.parse(row.record.envelopeJson).operationId);
  });
  it('retains caller cancellation after invocation as unknown and never automatically replays it', async () => {
    const h = await harness(), caller = new AbortController();
    h.network.mockImplementation(async (_url, init) => { caller.abort(); init.signal!.throwIfAborted(); throw new Error('unreachable'); });
    await expect(h.send({ signal: caller.signal, networkTimeoutMs: 15_000 })).rejects.toMatchObject({ outcome: 'outcome-unknown' });
    expect((await h.runtime.store.listOrigins()).records[0].children[0].state).toBe('outcome-unknown');
    expect(await h.runtime.recoverHeld()).toEqual({ processed: 0, recovered: 0 });
    expect(h.network).toHaveBeenCalledOnce();
  });
  it('keeps the deadline live after headers while the receipt body is read', async () => {
    const h = await harness(), deadline = new AbortController();
    vi.spyOn(AbortSignal, 'timeout').mockReturnValue(deadline.signal);
    h.network.mockImplementation(async (_url, init) => new Response(new ReadableStream({ start(controller) {
      expect(init.signal).toBe(deadline.signal);
      init.signal!.addEventListener('abort', () => controller.error(init.signal!.reason), { once: true });
      queueMicrotask(() => deadline.abort(new DOMException('Network deadline', 'TimeoutError')));
    } })));
    await expect(h.send({ networkTimeoutMs: 15_000 })).rejects.toMatchObject({ outcome: 'outcome-unknown' });
    expect((await h.runtime.store.listOrigins()).records[0].children[0].state).toBe('outcome-unknown');
    expect(await h.runtime.recoverHeld()).toEqual({ processed: 0, recovered: 0 });
  });
  it.each([0, -1, NaN, Infinity, 1.5])('rejects invalid network duration %s before origin mutation', async networkTimeoutMs => {
    const h = await harness();
    await expect(h.send({ networkTimeoutMs })).rejects.toThrow('telegram-network-timeout-invalid');
    expect(h.network).not.toHaveBeenCalled(); expect((await h.runtime.store.listOrigins()).records).toEqual([]);
  });
  it('starts a fresh deadline for every split child', async () => {
    const h = await harness(), clocks: AbortController[] = [];
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockImplementation(() => {
      const c = new AbortController(); clocks.push(c); return c.signal;
    });
    const mark = h.runtime.store.markDispatched.bind(h.runtime.store);
    vi.spyOn(h.runtime.store, 'markDispatched').mockImplementation(async fence => {
      // Earlier child deadlines may expire while storing the next child's intent.
      for (const clock of clocks) clock.abort();
      return mark(fence);
    });
    expect((await h.send({ networkTimeoutMs: 15_000 }, 'This is the requested detailed report. '.repeat(260))).ok).toBe(true);
    expect(h.network.mock.calls.length).toBeGreaterThan(1);
    expect(timeout).toHaveBeenCalledTimes(h.network.mock.calls.length);
    h.network.mock.calls.forEach((call, index) => expect(call[1].signal).toBe(clocks[index].signal));
    expect((await h.runtime.store.listOrigins()).records[0].children.every(child => child.state === 'accepted')).toBe(true);
  });
  it('loads and verifies durable multipart bytes before starting the network deadline', async () => {
    const h = await harness(), deadline = new AbortController();
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(deadline.signal);
    const getPayload = h.runtime.store.getPayload.bind(h.runtime.store);
    const payloadReads = vi.spyOn(h.runtime.store, 'getPayload').mockImplementation(async id => {
      expect(timeout).not.toHaveBeenCalled(); return getPayload(id);
    });
    h.network.mockImplementation(async (_url, init) => {
      expect(init.signal).toBe(deadline.signal);
      expect(Buffer.from(init.body as Uint8Array).toString()).toContain('Requested attachment bytes');
      return new Response(JSON.stringify({ ok: true, result: { message_id: 27, chat: { id: -100123 }, message_thread_id: 42 } }));
    });
    const body = new FormData(); body.append('chat_id', '-100123'); body.append('message_thread_id', '42');
    body.append('caption', 'The requested attachment'); body.append('document', new Blob(['Requested attachment bytes']), 'report.txt');
    expect((await h.runtime.service.runWithSessionToken(h.sessionToken, () => telegramFetch(`https://api.telegram.org/bot${h.token}/sendDocument`,
      { method: 'POST', body, networkTimeoutMs: 60_000 }))).ok).toBe(true);
    expect(payloadReads).toHaveBeenCalled(); expect(timeout).toHaveBeenCalledOnce(); expect(timeout).toHaveBeenCalledWith(60_000);
    expect((await h.runtime.store.listOrigins()).records[0].children[0].state).toBe('accepted');
  });
  it('fences a network deadline after invocation and does not classify it as caller cancellation', async () => {
    const h = await harness(), deadline = new AbortController();
    vi.spyOn(AbortSignal, 'timeout').mockReturnValue(deadline.signal);
    h.network.mockImplementation(async (_url, init) => {
      deadline.abort(new DOMException('Network deadline', 'TimeoutError'));
      init.signal!.throwIfAborted(); throw new Error('unreachable');
    });
    await expect(h.send({ networkTimeoutMs: 15_000 })).rejects.toMatchObject({ outcome: 'outcome-unknown' });
    expect((await h.runtime.store.listOrigins()).records[0].children[0].state).toBe('outcome-unknown');
    expect(await h.runtime.recoverHeld()).toEqual({ processed: 0, recovered: 0 });
  });
  it.each([OriginTransportCancelledBeforeNetwork, OriginCapacityUnavailable])('does not reuse %s as proof when native fetch rejects with that abort reason', async (ErrorType) => {
    const h = await harness(), caller = new AbortController();
    const recycled = new ErrorType();
    h.network.mockImplementation(async (_url, init) => { caller.abort(recycled); init.signal!.throwIfAborted(); throw new Error('unreachable'); });
    await expect(h.send({ signal: caller.signal, networkTimeoutMs: 15_000 })).rejects.toMatchObject({ outcome: 'outcome-unknown' });
    expect((await h.runtime.store.listOrigins()).records[0].children[0].state).toBe('outcome-unknown');
    expect(await h.runtime.recoverHeld()).toEqual({ processed: 0, recovered: 0 });
  });
  it('preserves the original caller signal when no network duration was requested', async () => {
    const h = await harness(), caller = new AbortController();
    expect((await h.send({ signal: caller.signal })).ok).toBe(true);
    expect(h.network.mock.calls[0][1].signal).toBe(caller.signal);
  });
});
