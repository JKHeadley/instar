import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import { CrossMachineRelayQueue } from '../../src/messaging/CrossMachineRelayQueue.js';
import os from 'node:os';
import path from 'node:path';
import { StateManager } from '../../src/core/StateManager.js';
import { SessionManager } from '../../src/core/SessionManager.js';
import { CAPABILITY_INDEX } from '../../src/server/CapabilityIndex.js';
import { MessageDelivery } from '../../src/messaging/MessageDelivery.js';
import { MessageFormatter } from '../../src/messaging/MessageFormatter.js';
import { MessageRouter } from '../../src/messaging/MessageRouter.js';
import { DeliveryRetryManager } from '../../src/messaging/DeliveryRetryManager.js';
import { MessageStore } from '../../src/messaging/MessageStore.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import type { MessageEnvelope } from '../../src/messaging/types.js';

const envelope = (): MessageEnvelope => ({
  schemaVersion: 1,
  message: { id: 'fixture', from: { agent: 'echo', session: 'sender', machine: 'self' }, to: { agent: 'echo', session: 'echo-worker', machine: 'self', sessionId: 'chosen', sessionGenerationRequired: true }, type: 'info', priority: 'low', subject: 'fixture', body: 'body', createdAt: new Date().toISOString(), ttlMinutes: 30 },
  transport: { relayChain: [], originServer: 'fixture', nonce: 'fixture', timestamp: new Date().toISOString() },
  delivery: { phase: 'received', transitions: [], attempts: 0, resolvedSessionId: 'chosen' },
});
const tmux = () => ({ getForegroundProcess: () => 'bash', isSessionAlive: () => true, hasActiveHumanInput: () => false, getOutputLineCount: () => 100, sendKeys: vi.fn(() => true) });

describe('generation is checked at the injection boundary', () => {
  it('a replacement during the safety await receives no text', async () => {
    let current = 'chosen';
    const t = { ...tmux(), currentSessionGeneration: () => current, isSessionGeneration: (_name: string, id: string) => id === current };
    const d = new MessageDelivery(new MessageFormatter(), t);
    vi.spyOn(d, 'checkInjectionSafety').mockImplementation(async () => {
      current = 'replacement';
      return { foregroundProcess: 'bash', isSafeProcess: true, hasHumanInput: false, contextBudgetExceeded: false };
    });
    expect(await d.deliverToSession('echo-worker', envelope())).toMatchObject({ success: false, shouldRetry: false, failureReason: 'target-session-generation-changed' });
    expect(t.sendKeys).not.toHaveBeenCalled();
  });

  it('a retry owner that wins before initial delivery executes the accepted envelope exactly once', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'initial-owner-'));
    const store = new MessageStore(dir); await store.initialize();
    const t = { ...tmux(), isSessionGeneration: () => true };
    const delivery = new MessageDelivery(new MessageFormatter(), t);
    const router = new MessageRouter(store, delivery, { localAgent: 'echo', localMachine: 'self', serverUrl: 'fixture', isOwnSession: () => true,
      resolveSession: () => ({ kind: 'exact', session: { id: 'chosen', tmuxSession: 'echo-worker', name: 'worker', status: 'running', startedAt: new Date().toISOString() }, via: 'exact' }) as any });
    const accepted = envelope(); delete accepted.delivery.resolvedSessionId; accepted.delivery.deliveryPending = true;
    await store.save(accepted);
    const retry = new DeliveryRetryManager(store, delivery, { agentName: 'echo', redeliverUnresolved: (e, claim) => router.redeliverSameAgentLocal(e, claim) });
    let release!: () => void;
    const firstRead = store.get.bind(store); let pause = true;
    vi.spyOn(store, 'get').mockImplementation(async (id) => { if (pause) { pause = false; await new Promise<void>((done) => { release = done; }); } return firstRead(id); });
    const running = retry.runRecoveryCycle();
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    await router.redeliverSameAgentLocal(accepted);
    release(); await running;
    expect(t.sendKeys).toHaveBeenCalledOnce();
    expect((await firstRead('fixture'))?.delivery.phase).toBe('delivered');
    retry.stop(); await store.destroy();
    SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/message-generation-delivery.test.ts' });
  });

  it.each(['queued', 'received'] as const)('a delayed initial callback cannot bypass retry-owned %s work', async (phase) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'delayed-initial-'));
    const store = new MessageStore(dir); await store.initialize();
    const t = { ...tmux(), isSessionGeneration: () => true };
    const router = new MessageRouter(store, new MessageDelivery(new MessageFormatter(), t), { localAgent: 'echo', localMachine: 'self', serverUrl: 'fixture', isOwnSession: () => true });
    const queued = envelope(); queued.delivery.phase = phase; queued.delivery.resolvedSession = 'echo-worker';
    if (phase === 'received') { queued.delivery.holderPending = true; delete queued.delivery.resolvedSessionId; }
    queued.delivery.holderRetryState = { attempts: 2, lastAttemptAt: Date.now(), firstAttemptAt: Date.now() };
    await store.save(queued);
    try {
      await (router as any).deliverRelayed(queued);
      expect(t.sendKeys).not.toHaveBeenCalled();
      expect((await store.get('fixture'))?.delivery).toMatchObject({ phase, holderRetryState: { attempts: 2 } });
    } finally { await store.destroy(); SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/message-generation-delivery.test.ts' }); }
  });

  it('a strict payload never follows a real HTTP 307 to an unregistered destination', async () => {
    let leaked = 0;
    const target = http.createServer((_req, res) => { leaked++; res.end('{}'); });
    await new Promise<void>((done) => target.listen(0, '127.0.0.1', done));
    const targetPort = (target.address() as any).port;
    const source = http.createServer((_req, res) => { res.writeHead(307, { Location: `http://127.0.0.1:${targetPort}/unregistered` }); res.end('{}'); });
    await new Promise<void>((done) => source.listen(0, '127.0.0.1', done));
    const sourcePort = (source.address() as any).port;
    const queue = new CrossMachineRelayQueue({ localMachine: 'self', addressesFor: () => [`http://127.0.0.1:${sourcePort}`], resignForAttempt: () => {}, signRequestHeaders: () => ({}), peerPublicKey: () => null, onOutcome: async () => {} });
    try {
      expect((await queue.onePass(envelope())).kind).toBe('unreachable');
      expect(leaked).toBe(0);
    } finally { await Promise.all([new Promise<void>((done) => source.close(() => done())), new Promise<void>((done) => target.close(() => done()))]); }
  });

  it('an expiry during safety inspection prevents injection even while the signed generation stays live', async () => {
    const t = { ...tmux(), isSessionGeneration: () => true };
    const delivery = new MessageDelivery(new MessageFormatter(), t);
    const env = envelope(); env.delivery.expiresAt = Date.now() + 100;
    vi.spyOn(delivery, 'checkInjectionSafety').mockImplementation(async () => { env.delivery.expiresAt = Date.now() - 1; return { foregroundProcess: 'bash', isSafeProcess: true, hasHumanInput: false, contextBudgetExceeded: false }; });
    expect(await delivery.deliverToSession('echo-worker', env)).toMatchObject({ success: false, failureReason: 'TTL expired', shouldRetry: false });
    expect(t.sendKeys).not.toHaveBeenCalled();
  });

  it('expiry inside a successful synchronous generation read is checked before physical injection', async () => {
    const env = envelope(); env.delivery.expiresAt = Date.now() + 100;
    const t = { ...tmux(), isSessionGeneration: () => { env.delivery.expiresAt = Date.now() - 1; return true; } };
    const delivery = new MessageDelivery(new MessageFormatter(), t);
    expect(await delivery.deliverToSession('echo-worker', env)).toMatchObject({ success: false, failureReason: 'TTL expired', shouldRetry: false });
    expect(t.sendKeys).not.toHaveBeenCalled();
  });

  it.each([null, 'replacement'])('a busy pin ending with current generation %s records the actual observed outcome', async (current) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pin-observed-'));
    const store = new MessageStore(dir); await store.initialize();
    const t = { ...tmux(), isSessionGeneration: () => true }; const events: string[] = [];
    const env = envelope(); env.delivery.phase = 'queued'; env.delivery.resolvedSession = 'echo-worker';
    await store.save(env);
    const retry = new DeliveryRetryManager(store, new MessageDelivery(new MessageFormatter(), t), { agentName: 'echo', isPinnedSessionLive: () => false,
      currentSessionGeneration: () => current, generationEvidence: (_kind, reason) => events.push(reason) });
    try {
      await retry.runRecoveryCycle();
      expect(events).toEqual([current ? 'generation-changed' : 'generation-unavailable']);
      expect((await store.get('fixture'))?.delivery.failureReason).toBe(current ? 'target-session-generation-changed' : 'target-session-generation-unavailable');
      expect(t.sendKeys).not.toHaveBeenCalled();
    } finally { retry.stop(); await store.destroy(); SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/message-generation-delivery.test.ts' }); }
  });

  it('a vanished bound generation is unavailable rather than a claimed replacement', async () => {
    const t = { ...tmux(), currentSessionGeneration: () => null };
    expect(await new MessageDelivery(new MessageFormatter(), t).deliverToSession('echo-worker', envelope())).toMatchObject({ success: false, failureReason: 'target-session-generation-unavailable', shouldRetry: false });
    expect(t.sendKeys).not.toHaveBeenCalled();
  });

  it('a retry admitted before its work deadline cannot inject after awaiting safety past that deadline', async () => {
    const env = envelope(); env.delivery.holderRetryState = { attempts: 4, lastAttemptAt: Date.now(), firstAttemptAt: Date.now() - 299000 };
    const t = { ...tmux(), currentSessionGeneration: () => 'chosen' };
    const delivery = new MessageDelivery(new MessageFormatter(), t);
    vi.spyOn(delivery, 'checkInjectionSafety').mockImplementation(async () => { env.delivery.holderRetryState!.firstAttemptAt = Date.now() - 301000; return { foregroundProcess: 'bash', isSafeProcess: true, hasHumanInput: false, contextBudgetExceeded: false }; });
    expect(await delivery.deliverToSession('echo-worker', env)).toMatchObject({ success: false, failureReason: 'holder retry work window ended before injection', shouldRetry: false });
    expect(t.sendKeys).not.toHaveBeenCalled();
  });

  it('a bound message with no generation checker is never typed', async () => {
    const t = tmux();
    const d = new MessageDelivery(new MessageFormatter(), t);
    expect(await d.deliverToSession('echo-worker', envelope())).toMatchObject({ success: false, shouldRetry: false });
    expect(t.sendKeys).not.toHaveBeenCalled();
  });

  it('a replacement while the pin write is awaited cannot receive the message', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'generation-pin-'));
    let current = 'chosen';
    const t = { ...tmux(), isSessionGeneration: (_name: string, id: string) => current === id };
    const store = new MessageStore(dir); await store.initialize();
    const update = store.updateDelivery.bind(store);
    vi.spyOn(store, 'updateDelivery').mockImplementation(async (id, state) => {
      await update(id, state);
      if (state.resolvedSessionId) current = 'replacement';
    });
    const router = new MessageRouter(store, new MessageDelivery(new MessageFormatter(), t), {
      localAgent: 'echo', localMachine: 'self', serverUrl: 'fixture', isOwnSession: () => true,
      resolveSession: () => ({ kind: 'exact', via: 'exact', session: { id: 'chosen', name: 'worker', tmuxSession: 'echo-worker', status: 'running', startedAt: new Date(Date.now() - 1000).toISOString() } }),
    });
    try {
      const sent = await router.send({ agent: 'echo', session: 'sender', machine: 'self' }, { agent: 'echo', session: 'echo-worker', machine: 'local' }, 'info', 'low', 'fixture', 'body');
      expect(sent.phase).toBe('failed');
      expect((await store.get(sent.messageId))?.delivery.failureReason).toBe('resolved-session-ended');
      expect(t.sendKeys).not.toHaveBeenCalled();
    } finally { await store.destroy(); SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/message-generation-delivery.test.ts' }); }
  });

  it('recovery does not duplicate an active attempt whose durable snapshot is still unpinned', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'generation-active-unpinned-'));
    const t = { ...tmux(), isSessionGeneration: () => true };
    const store = new MessageStore(dir); await store.initialize();
    const env = envelope(); delete env.delivery.resolvedSessionId;
    env.delivery.deliveryPending = true;
    await store.save(env);
    const update = store.updateDelivery.bind(store);
    let releasePin!: () => void;
    vi.spyOn(store, 'updateDelivery').mockImplementation(async (id, state) => {
      if (state.resolvedSessionId && state.deliveryPending) await new Promise<void>((done) => { releasePin = done; });
      return update(id, state);
    });
    const resolve = vi.fn(() => ({ kind: 'exact' as const, via: 'exact' as const, session: { id: 'chosen', name: 'worker', tmuxSession: 'echo-worker', status: 'running', startedAt: new Date(Date.now() - 1000).toISOString() } }));
    const delivery = new MessageDelivery(new MessageFormatter(), t);
    const router = new MessageRouter(store, delivery, { localAgent: 'echo', localMachine: 'self', serverUrl: 'fixture', isOwnSession: () => true, resolveSession: resolve });
    const sending = router.redeliverSameAgentLocal(env);
    await vi.waitFor(() => expect(releasePin).toBeTypeOf('function'));
    try {
      expect((await store.get(env.message.id))?.delivery.typingStartedAt).toBeUndefined();
      await router.recoverPendingRelayed();
      const retry = new DeliveryRetryManager(store, delivery, { agentName: 'echo' });
      await retry.runRecoveryCycle(); retry.stop();
      expect(resolve).toHaveBeenCalledOnce();
      expect(t.sendKeys).not.toHaveBeenCalled();
      releasePin(); await sending;
      expect(t.sendKeys).toHaveBeenCalledOnce();
    } finally { await store.destroy(); SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/message-generation-delivery.test.ts' }); }
  });

  it('a warm one-second session cache cannot hide a same-name replacement from the production lookup', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'generation-cache-'));
    const state = new StateManager(dir);
    const old = { id: 'chosen', name: 'worker', tmuxSession: 'echo-worker', status: 'running' as const, startedAt: new Date(Date.now() - 60_000).toISOString() };
    state.saveSession(old as any);
    const productionLookup = () => SessionManager.prototype.listRunningSessions.call({ state, tmuxAsyncEnabled: true } as any);
    expect(productionLookup().some((s) => s.id === 'chosen')).toBe(true); // warm the cache
    state.saveSession({ ...old, id: 'replacement', startedAt: new Date().toISOString() } as any);
    const t = { ...tmux(), currentSessionGeneration: (name: string) => productionLookup().find((s) => s.tmuxSession === name)?.id ?? null, isSessionGeneration: (name: string, id: string) => productionLookup().some((s) => s.tmuxSession === name && s.id === id) };
    try {
      expect(await new MessageDelivery(new MessageFormatter(), t).deliverToSession('echo-worker', envelope())).toMatchObject({ success: false, failureReason: 'target-session-generation-changed' });
      expect(t.sendKeys).not.toHaveBeenCalled();
      expect(productionLookup().map((s) => s.id)).toEqual(['replacement']);
    } finally { SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/message-generation-delivery.test.ts' }); }
  });

  it.each(['missing', 'conflict'])('the common injection boundary rejects a %s signed generation even when a mutable pin is present', async (kind) => {
    const env = envelope();
    if (kind === 'missing') delete env.message.to.sessionId;
    else env.delivery.resolvedSessionId = 'other-generation';
    const t = { ...tmux(), isSessionGeneration: () => true };
    expect(await new MessageDelivery(new MessageFormatter(), t).deliverToSession('echo-worker', env)).toMatchObject({ success: false, shouldRetry: false });
    expect(t.sendKeys).not.toHaveBeenCalled();
  });

  it('the sender rollout switch is live and defaults off; when on, missing proof wiring fails visibly before any relay', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'generation-rollout-'));
    const store = new MessageStore(dir); await store.initialize();
    let enabled = false;
    const r = new MessageRouter(store, new MessageDelivery(new MessageFormatter(), tmux()), { localAgent: 'echo', localMachine: 'self', serverUrl: 'fixture', generationBindingEnabled: () => enabled });
    try {
      const to = { agent: 'echo', session: 'echo-worker', machine: 'other', sessionId: 'caller-supplied', sessionGenerationRequired: true as const };
      const legacy = await r.send({ agent: 'echo', session: 'sender', machine: 'self' }, to, 'info', 'low', 'legacy', 'body');
      expect((await store.get(legacy.messageId))?.message.to.sessionGenerationRequired).toBeUndefined();
      expect((await store.get(legacy.messageId))?.message.to.sessionId).toBeUndefined();
      const capability = CAPABILITY_INDEX.find((entry) => entry.key === 'multiMachinePool')!;
      const view = () => capability.build({ ctx: { config: { multiMachine: { messageSessionGeneration: { enabled: false } } }, messageRouter: r } } as any) as any;
      expect(view().sessionGenerationBinding).toBe(false);
      enabled = true;
      expect(view().sessionGenerationBinding).toBe(true);
      const guarded = await r.send({ agent: 'echo', session: 'sender', machine: 'self' }, to, 'info', 'low', 'guarded', 'body');
      expect(guarded.phase).toBe('failed');
      expect((await store.get(guarded.messageId))?.message.to.sessionGenerationRequired).toBe(true);
      expect((await store.get(guarded.messageId))?.message.to.sessionId).toBeUndefined();
      expect((await store.get(guarded.messageId))?.delivery.failureReason).toContain('no receiving session generation was proved');
    } finally { await store.destroy(); SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/message-generation-delivery.test.ts' }); }
  });

  it('an expired last waiter cannot release a predecessor peer admission lane', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'generation-expired-waiter-'));
    const store = new MessageStore(dir); await store.initialize();
    let calls = 0; let release!: () => void;
    const router = new MessageRouter(store, new MessageDelivery(new MessageFormatter(), tmux()), { localAgent: 'echo', localMachine: 'self', serverUrl: 'fixture', generationBindingEnabled: () => true,
      peerSessionGeneration: async () => { calls++; if (calls === 1) await new Promise<void>((done) => { release = done; }); return { sessionId: 'chosen' }; } });
    const send = () => router.send({ agent: 'echo', session: 'sender', machine: 'self' }, { agent: 'echo', session: 'echo-worker', machine: 'other' }, 'info', 'low', 'fixture', 'body');
    try {
      const first = send(); await vi.waitFor(() => expect(calls).toBe(1));
      expect((await send()).phase).toBe('failed');
      const third = send();
      await new Promise((done) => setTimeout(done, 30));
      expect(calls).toBe(1);
      release(); await Promise.all([first, third]); expect(calls).toBe(2);
    } finally { await store.destroy(); SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/message-generation-delivery.test.ts' }); }
  }, 15000);

  it.each(['timer', 'boot'])('expired unarmed accepted work is never injected by %s recovery', async (mode) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'generation-expired-'));
    const store = new MessageStore(dir); await store.initialize();
    const t = { ...tmux(), isSessionGeneration: () => true };
    const delivery = new MessageDelivery(new MessageFormatter(), t);
    const router = new MessageRouter(store, delivery, { localAgent: 'echo', localMachine: 'self', serverUrl: 'fixture', isOwnSession: () => true });
    const accepted = envelope(); accepted.message.createdAt = new Date(Date.now() - 3600000).toISOString(); accepted.delivery.deliveryPending = true;
    await store.save(accepted);
    const retry = new DeliveryRetryManager(store, delivery, { agentName: 'echo', redeliverUnresolved: (e, claim) => router.redeliverSameAgentLocal(e, claim) });
    try {
      if (mode === 'timer') await retry.runRecoveryCycle(); else await router.recoverPendingRelayed();
      expect(t.sendKeys).not.toHaveBeenCalled();
    } finally { retry.stop(); await store.destroy(); SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/message-generation-delivery.test.ts' }); }
  });

  it('simultaneous sends to one peer admit only one preflight at a time', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'generation-admission-'));
    const store = new MessageStore(dir); await store.initialize();
    let calls = 0, active = 0, maxActive = 0; let releaseFirst!: () => void;
    const r = new MessageRouter(store, new MessageDelivery(new MessageFormatter(), tmux()), { localAgent: 'echo', localMachine: 'self', serverUrl: 'fixture', generationBindingEnabled: () => true,
      peerSessionGeneration: async () => { calls++; active++; maxActive = Math.max(maxActive, active); if (calls === 1) await new Promise<void>((done) => { releaseFirst = done; }); active--; return { sessionId: 'chosen' }; },
    });
    try {
      const send = (subject: string) => r.send({ agent: 'echo', session: 'sender', machine: 'self' }, { agent: 'echo', session: 'echo-worker', machine: 'other' }, 'info', 'low', subject, 'body');
      const first = send('one'); const second = send('two');
      await vi.waitFor(() => expect(calls).toBe(1));
      releaseFirst(); await Promise.all([first, second]);
      expect(calls).toBe(2); expect(maxActive).toBe(1);
    } finally { await store.destroy(); SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/message-generation-delivery.test.ts' }); }
  });

  it('a stale snapshot cannot resurrect a message already moved to the dead-letter store', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'generation-stale-snapshot-'));
    const t = { ...tmux(), isSessionGeneration: () => true };
    const store = new MessageStore(dir); await store.initialize();
    const stale = envelope(); delete stale.delivery.resolvedSessionId;
    stale.delivery.holderPending = true;
    await store.save(stale); await store.deadLetter(stale.message.id, 'TTL expired');
    const router = new MessageRouter(store, new MessageDelivery(new MessageFormatter(), t), {
      localAgent: 'echo', localMachine: 'self', serverUrl: 'fixture', isOwnSession: () => true,
      resolveSession: () => ({ kind: 'exact', via: 'exact', session: { id: 'chosen', name: 'worker', tmuxSession: 'echo-worker', status: 'running', startedAt: new Date(Date.now() - 1000).toISOString() } }),
    });
    try {
      await router.redeliverSameAgentLocal(stale);
      expect(t.sendKeys).not.toHaveBeenCalled();
      expect(await store.isDeadLettered(stale.message.id)).toBe(true);
      expect(await store.get(stale.message.id)).toBeNull();
    } finally { await store.destroy(); SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/message-generation-delivery.test.ts' }); }
  });

  it.each(['false', 'throw'])('a physical side effect followed by %s is an uncertain terminal result, never a retry', async (failure) => {
    let sideEffects = 0;
    const t = { ...tmux(), isSessionGeneration: () => true };
    t.sendKeys.mockImplementation(() => {
      sideEffects++; // The paste/Enter already reached tmux before its acknowledgement failed.
      if (failure === 'throw') throw new Error('Enter executed, then execFileSync timed out');
      return false;
    });
    const d = new MessageDelivery(new MessageFormatter(), t);
    expect(await d.deliverToSession('echo-worker', envelope())).toMatchObject({ success: false, shouldRetry: false, phase: 'failed', outcomeUnknown: true });
    expect(sideEffects).toBe(1);
  });

  it.each([true, false])('a receiver without a resolver refuses a signed bound id (requirement flag %s)', async (required) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'generation-no-resolver-'));
    const t = { ...tmux(), isSessionGeneration: () => true };
    const store = new MessageStore(dir); await store.initialize();
    const router = new MessageRouter(store, new MessageDelivery(new MessageFormatter(), t), { localAgent: 'echo', localMachine: 'self', serverUrl: 'fixture', isOwnSession: () => true });
    const env = envelope(); delete env.delivery.resolvedSessionId;
    if (!required) delete env.message.to.sessionGenerationRequired;
    await store.save(env);
    try {
      expect(await router.redeliverSameAgentLocal(env)).toBe('failed');
      expect(t.sendKeys).not.toHaveBeenCalled();
    } finally { await store.destroy(); SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/message-generation-delivery.test.ts' }); }
  });

  it('a failed durable pin write never reaches injection', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'generation-pin-fail-'));
    const t = { ...tmux(), isSessionGeneration: () => true };
    const store = new MessageStore(dir); await store.initialize();
    vi.spyOn(store, 'updateDelivery').mockRejectedValue(new Error('disk write refused'));
    const router = new MessageRouter(store, new MessageDelivery(new MessageFormatter(), t), {
      localAgent: 'echo', localMachine: 'self', serverUrl: 'fixture', isOwnSession: () => true,
      resolveSession: () => ({ kind: 'exact', via: 'exact', session: { id: 'chosen', name: 'worker', tmuxSession: 'echo-worker', status: 'running', startedAt: new Date(Date.now() - 1000).toISOString() } }),
    });
    try {
      await router.send({ agent: 'echo', session: 'sender', machine: 'self' }, { agent: 'echo', session: 'echo-worker', machine: 'local' }, 'info', 'low', 'fixture', 'body');
      expect(t.sendKeys).not.toHaveBeenCalled();
    } finally { await store.destroy(); SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/message-generation-delivery.test.ts' }); }
  });
});
