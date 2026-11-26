/**
 * ACT-091 — the router's `delivered` verdict is load-bearing on EVERY path now
 * (it settles the promising auto-ack), so each delivering route must report
 * `delivered === true` when a session really received the message, and the
 * busy-session case must never report it until the text has left the prompt.
 *
 * Real ThreadlineRouter + real TopicLinkageHandler + a real SessionManager
 * whose tmux I/O is stubbed (captured pane + fake timers), wired exactly as
 * server.ts wires them, settled through the real relay ack settler.
 *
 *  live inject, idle session         → delivered true, ack sent
 *  live inject, BUSY session, text taken at the next tool round
 *                                    → delivered false NOW + deliveryPending → true; ONE ack, late
 *  live inject, busy footer that never clears (stale footer / ceiling)
 *                                    → deliveryPending → false; NO ack, surfaced in the topic
 *  live inject, idle prompt, text still there after the window
 *                                    → delivered false, no ack, surfaced (unchanged)
 *  respawn-inject (reaped topic)     → delivered true
 *  cold spawn (new thread)           → delivered true
 *  resume (--resume of a thread)     → delivered true
 *  warm session (keep-alive worker)  → delivered true
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { ThreadlineRouter } from '../../../src/threadline/ThreadlineRouter.js';
import { ThreadResumeMap } from '../../../src/threadline/ThreadResumeMap.js';
import { TopicResumeMap } from '../../../src/core/TopicResumeMap.js';
import { TopicLinkageHandler, type LiveInjectOutcome } from '../../../src/threadline/TopicLinkageHandler.js';
import { SalienceGate } from '../../../src/threadline/SalienceGate.js';
import { CommitmentTracker } from '../../../src/monitoring/CommitmentTracker.js';
import { LiveConfig } from '../../../src/config/LiveConfig.js';
import { SafeFsExecutor } from '../../../src/core/SafeFsExecutor.js';
import { SessionManager, type InjectionConfirmation } from '../../../src/core/SessionManager.js';
import { WarmSessionPool } from '../../../src/threadline/WarmSessionPool.js';
import {
  DEFAULT_AUTO_ACK_MESSAGE,
  createRelayAckSettler,
  runRelayAckStage,
  type RelayAckStageDeps,
} from '../../../src/threadline/autoAck.js';
import type { MessageEnvelope } from '../../../src/messaging/types.js';

const PEER = 'd'.repeat(32);
const TOPIC = 9210;
const SESSION = 'echo-topic-9210';

// The paste ref the session manager types in, and what the pane shows for it.
const REF = '[paste] Content notification saved to /tmp/x/notif.md — read it to see the details.';
const IDLE_WITH_MARKER = `⏺ Done.\n❯ ${REF}\n  ⏵⏵ bypass permissions on`;
const BUSY_WITH_MARKER = `⏺ Running the suite…\n❯ ${REF}\n  esc to interrupt · 12s`;
const IDLE_CLEAR = `⏺ User: ${REF}\n⏺ Reading it.\n❯ \n  ⏵⏵ bypass permissions on`;
const BUSY_CLEAR = `⏺ User: ${REF}\n⏺ Reading it.\n❯ \n  esc to interrupt · 3s`;

function envelope(threadId: string, body = 'the answer you asked for'): MessageEnvelope {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1,
    message: {
      id: crypto.randomUUID(),
      from: { agent: PEER, session: 'relay', machine: 'relay' },
      to: { agent: 'echo', session: 'best', machine: 'local' },
      type: 'query', priority: 'medium', subject: 'Relay message', body, createdAt: now, threadId,
    },
    transport: { relayChain: [], originServer: 'http://localhost:1', nonce: `${crypto.randomUUID()}:${now}`, timestamp: now },
    delivery: { phase: 'received', transitions: [], attempts: 1 },
  } as MessageEnvelope;
}
const relayCtx = { trust: { kind: 'plaintext-tofu' as const, senderFingerprint: PEER }, senderFingerprint: PEER, senderName: 'dawn', trustLevel: 'trusted' as const };

/** server.ts's adapter: the session manager's observation → the handler's outcome (starts the watch lazily). */
function liveInjectOutcomeFromObservation(r: InjectionConfirmation): LiveInjectOutcome {
  if (r.state === 'queued-busy') return { state: 'queued-busy', settled: r.settle() };
  return { state: r.state };
}

/** A real SessionManager with tmux stubbed: the pane is whatever `pane()` says now. */
function sessionManagerOver(pane: () => string) {
  const mgr: any = Object.create(SessionManager.prototype);
  mgr.config = { tmuxPath: '/usr/bin/tmux' };
  mgr.injectPasteNotification = vi.fn(() => REF);
  mgr.captureOutput = vi.fn(pane);
  mgr.tmuxSessionExists = vi.fn(() => true);
  return mgr as SessionManager;
}

/**
 * A resume map whose transcript / tmux probes are stubbed: `get()` otherwise
 * scans ~/.claude/projects for the uuid's JSONL (tens of seconds on a real
 * machine) and asks tmux whether the session exists — neither is this test's
 * subject. The two routes below need an entry that RESOLVES.
 */
class ResumableMap extends ThreadResumeMap {
  constructor(stateDir: string, projectDir: string, private readonly live: boolean) { super(stateDir, projectDir); }
  protected override jsonlExists(): boolean { return !this.live; }
  protected override sessionAlive(): boolean { return this.live; }
}

/** A pane that changes with the (fake) clock: the last entry whose atMs <= now. */
function timeline(entries: Array<{ atMs: number; pane: string }>): () => string {
  const t0 = Date.now();
  return () => {
    const now = Date.now() - t0;
    let pane = entries[0].pane;
    for (const e of entries) if (e.atMs <= now) pane = e.pane;
    return pane;
  };
}

describe('delivered verdict per route (ACT-091)', () => {
  let dir: string;
  let stateDir: string;
  let threadResumeMap: ThreadResumeMap;
  let spawn: { evaluate: ReturnType<typeof vi.fn>; handleDenial: ReturnType<typeof vi.fn>; getStatus: ReturnType<typeof vi.fn>; reset: ReturnType<typeof vi.fn> };
  let sent: Array<{ to: string; text: string; threadId?: string }>;
  let ackDeps: RelayAckStageDeps;

  beforeEach(() => {
    vi.useFakeTimers();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-verdict-'));
    stateDir = path.join(dir, '.instar');
    fs.mkdirSync(path.join(stateDir, 'state'), { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ sessions: { maxSessions: 3 } }));
    threadResumeMap = new ThreadResumeMap(stateDir, dir);
    spawn = {
      evaluate: vi.fn().mockResolvedValue({ approved: true, sessionId: 'sid', tmuxSession: 'thread-worker', reason: 'ok' }),
      handleDenial: vi.fn(), getStatus: vi.fn().mockReturnValue({ cooldowns: [], pendingRetries: 0 }), reset: vi.fn(),
    };
    sent = [];
    ackDeps = {
      autoAckEnabled: true,
      isAckRateLimited: () => false,
      sendAck: (to, text, threadId) => { sent.push({ to, text, threadId }); },
      recordDelivery: vi.fn(),
    };
  });
  afterEach(() => {
    vi.useRealTimers();
    SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/integration/threadline/delivered-verdict-per-route.test.ts' });
  });

  /** The relay handler's ack stage + router exit, as server.ts does it. */
  function ackFor(threadId: string) {
    const input = { isAutoAck: false, trustLevel: 'trusted', msgType: 'chat', senderFingerprint: PEER, threadId, ticket: null, deferSend: true };
    const relayAck = createRelayAckSettler(ackDeps, input);
    expect(runRelayAckStage(ackDeps, input)).toBe('continue');
    return relayAck;
  }
  function settleFromRouter(relayAck: ReturnType<typeof createRelayAckSettler>, result: Awaited<ReturnType<ThreadlineRouter['handleInboundMessage']>>) {
    if (result.deliveryPending) {
      return result.deliveryPending.then(({ delivered, reason }) => ({ late: true, reason, ack: relayAck.settle(delivered ? 'router-delivered' : 'router-undelivered') }));
    }
    return Promise.resolve({ late: false, reason: null, ack: relayAck.settle(result.delivered === true ? 'router-delivered' : 'router-undelivered') });
  }

  function buildTopic(opts: { manager: SessionManager; alive?: boolean; respawn?: ReturnType<typeof vi.fn> }) {
    const sendTg = vi.fn().mockResolvedValue(undefined);
    const handler = new TopicLinkageHandler({
      commitmentTracker: new CommitmentTracker({ stateDir, liveConfig: new LiveConfig(stateDir) }),
      topicResumeMap: new TopicResumeMap(stateDir, dir),
      threadResumeMap,
      salienceGate: new SalienceGate({ classify: async () => ({ verdict: 'agent-internal' as const, reason: 'chatter' }) }),
      localAgent: 'echo',
      // server.ts: the observed paste, mapped — never the bare boolean.
      injectIntoSession: async (sessionName, text) => liveInjectOutcomeFromObservation(await opts.manager.injectPasteNotificationObserved(sessionName, text)),
      isSessionAlive: () => opts.alive ?? true,
      sendTelegramToTopic: sendTg,
      getSessionForTopic: () => SESSION,
      ...(opts.respawn ? { respawnTopicSession: opts.respawn } : {}),
    });
    const store = { getThread: vi.fn().mockResolvedValue(null), exists: vi.fn(), save: vi.fn() };
    const router = new ThreadlineRouter({ getThread: vi.fn().mockResolvedValue(null) } as never, spawn as never, threadResumeMap, store as never,
      { localAgent: 'echo', localMachine: 'local' }, null as never, null as never);
    router.setTopicLinkageHandler(handler);
    const threadId = crypto.randomUUID();
    handler.captureOriginOnSend({ threadId, remoteAgent: PEER, originTopicId: TOPIC });
    return { router, threadId, sendTg };
  }

  // ── live inject into the topic's session ─────────────────────────

  it('live inject into an IDLE session → delivered true, path topic, promising ack', async () => {
    const { router, threadId } = buildTopic({ manager: sessionManagerOver(() => IDLE_CLEAR) });
    const relayAck = ackFor(threadId);
    const p = router.handleInboundMessage(envelope(threadId), relayCtx);
    await vi.advanceTimersByTimeAsync(1000);
    const r = await p;
    expect(r).toMatchObject({ handled: true, delivered: true, injected: true, path: 'topic' });
    expect(r.deliveryPending).toBeUndefined();
    expect((await settleFromRouter(relayAck, r)).ack).toBe('sent');
    expect(sent).toEqual([{ to: PEER, text: DEFAULT_AUTO_ACK_MESSAGE, threadId }]);
  });

  it('live inject into a BUSY session (the 22:21Z false negative) → not delivered NOW, deliveryPending → true when the text leaves the prompt; ONE ack, sent late', async () => {
    // Busy with the marker queued through the 7.5 s window, consumed ~9 s later.
    const pane = timeline([{ atMs: 0, pane: BUSY_WITH_MARKER }, { atMs: 16_500, pane: BUSY_CLEAR }]);
    const { router, threadId, sendTg } = buildTopic({ manager: sessionManagerOver(pane) });
    const relayAck = ackFor(threadId);
    const p = router.handleInboundMessage(envelope(threadId), relayCtx);
    await vi.advanceTimersByTimeAsync(7500);
    const r = await p;
    // Provisional: nothing claimed, nothing surfaced, no ack yet.
    expect(r).toMatchObject({ handled: true, delivered: false, injected: false });
    expect(r.queued).toBeUndefined();
    expect(r.deliveryPending).toBeInstanceOf(Promise);
    const settling = settleFromRouter(relayAck, r);
    expect(sent).toHaveLength(0);
    expect(sendTg).not.toHaveBeenCalled();
    // The watch sees the text leave the prompt at its second poll (17.5 s).
    await vi.advanceTimersByTimeAsync(10_000);
    const late = await settling;
    expect(late).toEqual({ late: true, reason: 'submitted', ack: 'sent' });
    expect(sent).toEqual([{ to: PEER, text: DEFAULT_AUTO_ACK_MESSAGE, threadId }]);
    expect(sendTg).not.toHaveBeenCalled(); // a live inject never surfaces
    // A second settle (anyone racing) sends nothing more.
    expect(relayAck.settle('router-delivered')).toBe('already-settled');
    expect(sent).toHaveLength(1);
  });

  it('a STALE busy footer over an idle prompt with the marker present → never a promising ack; ceiling → not delivered, surfaced in the topic', async () => {
    const { router, threadId, sendTg } = buildTopic({ manager: sessionManagerOver(() => BUSY_WITH_MARKER) });
    const relayAck = ackFor(threadId);
    const p = router.handleInboundMessage(envelope(threadId), relayCtx);
    await vi.advanceTimersByTimeAsync(7500);
    const r = await p;
    expect(r.delivered).toBe(false);
    const settling = settleFromRouter(relayAck, r);
    await vi.advanceTimersByTimeAsync(SessionManager.QUEUED_INJECTION_WATCH_CEILING_MS - 1000);
    expect(sent).toHaveLength(0); // ten minutes in: still nothing promised
    await vi.advanceTimersByTimeAsync(1000);
    expect(await settling).toEqual({ late: true, reason: 'ceiling', ack: 'skipped-undelivered' });
    expect(sent).toHaveLength(0);
    // failure-visible: the reply was posted in the topic so it is not silent.
    expect(sendTg).toHaveBeenCalledTimes(1);
    expect(sendTg.mock.calls[0][0]).toBe(TOPIC);
    expect(String(sendTg.mock.calls[0][1])).toContain('the answer you asked for');
  });

  it('busy, then the turn ends with the text still at an IDLE prompt → stuck: no ack, surfaced', async () => {
    const pane = timeline([{ atMs: 0, pane: BUSY_WITH_MARKER }, { atMs: 15_000, pane: IDLE_WITH_MARKER }]);
    const { router, threadId, sendTg } = buildTopic({ manager: sessionManagerOver(pane) });
    const relayAck = ackFor(threadId);
    const p = router.handleInboundMessage(envelope(threadId), relayCtx);
    await vi.advanceTimersByTimeAsync(7500);
    const settling = settleFromRouter(relayAck, await p);
    await vi.advanceTimersByTimeAsync(15_000); // polls at 12.5 (busy), 17.5 (idle), 22.5 (idle) s
    expect(await settling).toEqual({ late: true, reason: 'stuck', ack: 'skipped-undelivered' });
    expect(sent).toHaveLength(0);
    expect(sendTg).toHaveBeenCalledTimes(1);
  });

  it('live inject into an idle session that leaves the text at the prompt → delivered false immediately, no ack, surfaced (unchanged)', async () => {
    const { router, threadId, sendTg } = buildTopic({ manager: sessionManagerOver(() => IDLE_WITH_MARKER) });
    const relayAck = ackFor(threadId);
    const p = router.handleInboundMessage(envelope(threadId), relayCtx);
    await vi.advanceTimersByTimeAsync(7500);
    const r = await p;
    expect(r).toMatchObject({ handled: true, delivered: false, queued: true });
    expect(r.deliveryPending).toBeUndefined();
    expect((await settleFromRouter(relayAck, r)).ack).toBe('skipped-undelivered');
    expect(sent).toHaveLength(0);
    expect(sendTg).toHaveBeenCalledTimes(1);
  });

  // ── the other delivering routes ──────────────────────────────────

  it('respawn-inject (reaped topic session) → delivered true, resumed, path topic', async () => {
    const respawn = vi.fn().mockResolvedValue({ delivered: true, mode: 'respawn-inject', sessionName: SESSION });
    const { router, threadId } = buildTopic({ manager: sessionManagerOver(() => IDLE_CLEAR), alive: false, respawn });
    const relayAck = ackFor(threadId);
    const r = await router.handleInboundMessage(envelope(threadId), relayCtx);
    expect(r).toMatchObject({ handled: true, delivered: true, resumed: true, path: 'topic' });
    expect((await settleFromRouter(relayAck, r)).ack).toBe('sent');
  });

  it('the respawn hook\'s own live paste into a busy session → pending, settled from the hook\'s verdict', async () => {
    let resolveSettled!: (v: 'submitted') => void;
    const settled = new Promise<'submitted'>((res) => { resolveSettled = res; });
    const respawn = vi.fn().mockResolvedValue({ delivered: false, pending: true, reason: 'queued-busy', mode: 'live-inject', sessionName: SESSION, settled });
    const { router, threadId } = buildTopic({ manager: sessionManagerOver(() => IDLE_CLEAR), alive: false, respawn });
    const relayAck = ackFor(threadId);
    const r = await router.handleInboundMessage(envelope(threadId), relayCtx);
    expect(r).toMatchObject({ handled: true, delivered: false });
    const settling = settleFromRouter(relayAck, r);
    expect(sent).toHaveLength(0);
    resolveSettled('submitted');
    expect(await settling).toEqual({ late: true, reason: 'submitted', ack: 'sent' });
    expect(sent).toHaveLength(1);
  });

  function plainRouter(messageDelivery: unknown = null, pool: WarmSessionPool | null = null, warm = false, map: ThreadResumeMap = threadResumeMap) {
    const store = { getThread: vi.fn().mockResolvedValue(null), exists: vi.fn(), save: vi.fn() };
    return new ThreadlineRouter({ getThread: vi.fn().mockResolvedValue(null) } as never, spawn as never, map, store as never,
      { localAgent: 'echo', localMachine: 'local' }, null as never, messageDelivery as never, undefined, undefined, pool, warm, 'verified', null);
  }

  it('cold spawn (first message on a new thread) → delivered true, spawned, path cold', async () => {
    const threadId = crypto.randomUUID();
    const relayAck = ackFor(threadId);
    const r = await plainRouter().handleInboundMessage(envelope(threadId), relayCtx);
    expect(r).toMatchObject({ handled: true, delivered: true, spawned: true, path: 'cold' });
    expect(spawn.evaluate).toHaveBeenCalledTimes(1);
    expect((await settleFromRouter(relayAck, r)).ack).toBe('sent');
  });

  it('resume (--resume of a known thread with no live session) → delivered true, resumed, path cold', async () => {
    const threadId = crypto.randomUUID();
    const now = new Date().toISOString();
    const map = new ResumableMap(stateDir, dir, false); // transcript exists, no live session
    map.save(threadId, {
      uuid: crypto.randomUUID(), sessionName: 'thread-old', createdAt: now, savedAt: now, lastAccessedAt: now,
      remoteAgent: PEER, subject: 'Relay message', state: 'active', pinned: false, messageCount: 1,
    });
    const relayAck = ackFor(threadId);
    const r = await plainRouter(null, null, false, map).handleInboundMessage(envelope(threadId), relayCtx);
    expect(r).toMatchObject({ handled: true, delivered: true, resumed: true, path: 'cold' });
    expect(spawn.evaluate.mock.calls[0][0]).toMatchObject({ resumeSessionId: expect.any(String) });
    expect((await settleFromRouter(relayAck, r)).ack).toBe('sent');
  });

  it('warm session (keep-alive worker spawn) → delivered true, spawned, path warm', async () => {
    const threadId = crypto.randomUUID();
    const pool = new WarmSessionPool({ globalCap: 3, perPeerCap: 1, ttlMs: 600_000 });
    const relayAck = ackFor(threadId);
    const r = await plainRouter(null, pool, true).handleInboundMessage(envelope(threadId), { ...relayCtx, trustLevel: 'verified' as const, preferWarmSession: true });
    expect(r).toMatchObject({ handled: true, delivered: true, spawned: true, path: 'warm' });
    expect(spawn.evaluate.mock.calls[0][0]).toMatchObject({ interactive: true });
    expect((await settleFromRouter(relayAck, r)).ack).toBe('sent');
  });

  it('live inject through the router\'s own messageDelivery (a warm worker already running) → delivered true, path live', async () => {
    const threadId = crypto.randomUUID();
    const now = new Date().toISOString();
    const map = new ResumableMap(stateDir, dir, true); // the worker's tmux session is alive
    map.save(threadId, {
      uuid: crypto.randomUUID(), sessionName: 'echo-warm-1', createdAt: now, savedAt: now, lastAccessedAt: now,
      remoteAgent: PEER, subject: 'Relay message', state: 'active', pinned: false, messageCount: 1,
    });
    const messageDelivery = {
      deliverToSession: vi.fn().mockResolvedValue({ success: true, phase: 'delivered', shouldRetry: false }),
      checkInjectionSafety: vi.fn(), formatInline: vi.fn(), formatPointer: vi.fn(),
    };
    const relayAck = ackFor(threadId);
    const r = await plainRouter(messageDelivery, null, false, map).handleInboundMessage(envelope(threadId), relayCtx);
    expect(r).toMatchObject({ handled: true, delivered: true, injected: true, path: 'live' });
    expect(spawn.evaluate).not.toHaveBeenCalled();
    expect((await settleFromRouter(relayAck, r)).ack).toBe('sent');
  });
});
