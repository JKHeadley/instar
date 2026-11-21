/**
 * messages-reach-renamed-sessions (PR-A): resolver wiring in MessageRouter,
 * pinned retries and dead-letter notices in DeliveryRetryManager, SenderNotifier.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { MessageRouter } from '../../src/messaging/MessageRouter.js';
import { MessageStore } from '../../src/messaging/MessageStore.js';
import { MessageDelivery } from '../../src/messaging/MessageDelivery.js';
import { MessageFormatter } from '../../src/messaging/MessageFormatter.js';
import { DeliveryRetryManager, wasEverTyped } from '../../src/messaging/DeliveryRetryManager.js';
import { SenderNotifier, sanitizeField, NOTICE_GROUP_WINDOW_MS } from '../../src/messaging/SenderNotifier.js';
import { resolveSessionTarget, type ResolverSession } from '../../src/messaging/sessionAddressResolver.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import type { MessageEnvelope } from '../../src/messaging/types.js';

function tmux(alive: (n: string) => boolean = () => true) {
  return {
    getForegroundProcess: vi.fn().mockReturnValue('bash'),
    isSessionAlive: vi.fn((n: string) => alive(n)),
    hasActiveHumanInput: vi.fn().mockReturnValue(false),
    sendKeys: vi.fn().mockReturnValue(true),
    getOutputLineCount: vi.fn().mockReturnValue(100),
  };
}

describe('messages-reach-renamed-sessions PR-A', () => {
  let dir: string;
  let store: MessageStore;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-mrrs-'));
    vi.spyOn(os, 'homedir').mockReturnValue(dir);
    vi.stubEnv('INSTAR_TEST_REGISTRY_DIR', path.join(dir, '.instar'));
    store = new MessageStore(dir);
    await store.initialize();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/messages-reach-renamed-sessions.test.ts' });
  });

  const sessions: ResolverSession[] = [
    { id: 'old', name: 'machine-stewardship', tmuxSession: 'echo-machine-stewardship', status: 'completed', startedAt: '2026-11-17T00:00:00Z', telegramTopicId: 144503 },
    { id: 'new', name: 'echo-machine-stewardship', tmuxSession: 'echo-echo-machine-stewardship', status: 'running', startedAt: '2026-11-18T00:00:00Z', telegramTopicId: 144503 },
  ];
  const resolve = (target: string, asOf: number) => resolveSessionTarget(target, {
    sessions, sessionNameForTopic: () => 'echo-echo-machine-stewardship', isStandingDown: () => false, prefix: 'echo', asOf,
  });

  it('a send to the old name of a respawned topic session is typed into the holder, pinned, and reported', async () => {
    const t = tmux();
    const r = new MessageRouter(store, new MessageDelivery(new MessageFormatter(), t as any), {
      localAgent: 'echo', localMachine: 'm1', serverUrl: 'http://x',
      isOwnSession: (n) => n === 'echo-echo-machine-stewardship',
      resolveSession: resolve,
    });
    const res = await r.send({ agent: 'echo', session: 'echo-chief-of-staff', machine: 'm1' }, { agent: 'echo', session: 'echo-machine-stewardship', machine: 'local' }, 'handoff', 'medium', 'Subj', 'Body');
    expect(res.phase).toBe('delivered');
    expect(t.sendKeys.mock.calls[0][0]).toContain('echo-echo-machine-stewardship');
    const env = await store.get(res.messageId);
    expect(env!.message.to.session).toBe('echo-machine-stewardship');
    expect(env!.delivery.resolvedSession).toBe('echo-echo-machine-stewardship');
    expect(env!.delivery.resolvedSessionId).toBe('new');
    expect(env!.delivery.resolvedVia).toBe('topic');
    expect(env!.delivery.transitions.at(-1)!.reason).toContain('redirected from echo-machine-stewardship via topic');
  });

  it('an unresolvable role fails without typing and calls onDeliveryFailure once', async () => {
    const t = tmux();
    const failures: string[] = [];
    const r = new MessageRouter(store, new MessageDelivery(new MessageFormatter(), t as any), {
      localAgent: 'echo', localMachine: 'm1', serverUrl: 'http://x',
      isOwnSession: () => true, resolveSession: resolve,
      onDeliveryFailure: (_e, reason) => failures.push(reason),
    });
    const res = await r.send({ agent: 'echo', session: 's', machine: 'm1' }, { agent: 'echo', session: 'echo-nobody', machine: 'local' }, 'info', 'low', 'S', 'B');
    expect(res.phase).toBe('failed');
    expect(t.sendKeys).not.toHaveBeenCalled();
    expect(failures).toEqual(['no-session-holds-this-role']);
  });

  it('a stale message (written before the holder started) is refused', async () => {
    const t = tmux();
    const r = new MessageRouter(store, new MessageDelivery(new MessageFormatter(), t as any), {
      localAgent: 'echo', localMachine: 'm1', serverUrl: 'http://x', isOwnSession: () => true,
      resolveSession: (target) => resolve(target, Date.parse('2026-11-17T12:00:00Z')),
    });
    const res = await r.send({ agent: 'echo', session: 's', machine: 'm1' }, { agent: 'echo', session: 'echo-machine-stewardship', machine: 'local' }, 'info', 'low', 'S', 'B');
    expect(res.phase).toBe('failed');
    expect((await store.get(res.messageId))!.delivery.failureReason).toBe('role-respawned-after-message');
  });

  it('retry: a queued message is retried into the pinned session, and fails once the pin ended', async () => {
    let foreground = 'vim';
    const t = tmux();
    t.getForegroundProcess.mockImplementation(() => foreground);
    const delivery = new MessageDelivery(new MessageFormatter(), t as any);
    const r = new MessageRouter(store, delivery, {
      localAgent: 'echo', localMachine: 'm1', serverUrl: 'http://x', isOwnSession: () => true, resolveSession: resolve,
    });
    const res = await r.send({ agent: 'echo', session: 's', machine: 'm1' }, { agent: 'echo', session: 'echo-machine-stewardship', machine: 'local' }, 'handoff', 'medium', 'S', 'B');
    expect(res.phase).toBe('queued');
    const queued = await store.get(res.messageId);
    expect(queued!.delivery.typingStartedAt).toBeUndefined();

    const notices: string[] = [];
    let pinLive = true;
    const mgr = new DeliveryRetryManager(store, delivery, {
      agentName: 'echo',
      isLocalEnvelope: () => true,
      isPinnedSessionLive: (name, id) => pinLive && name === 'echo-echo-machine-stewardship' && id === 'new',
      onDeadLetter: (_e, reason) => notices.push(reason),
    });
    foreground = 'bash';
    await mgr.runRecoveryCycle();
    const delivered = await store.get(res.messageId);
    expect(delivered!.delivery.phase).toBe('delivered');
    expect(t.sendKeys.mock.calls.at(-1)![0]).toContain('echo-echo-machine-stewardship');

    // A second message, then the pinned session is replaced under the same name.
    foreground = 'vim';
    const res2 = await r.send({ agent: 'echo', session: 's', machine: 'm1' }, { agent: 'echo', session: 'echo-machine-stewardship', machine: 'local' }, 'handoff', 'medium', 'S2', 'B2');
    pinLive = false;
    foreground = 'bash';
    await mgr.runRecoveryCycle();
    const ended = await store.get(res2.messageId);
    expect(ended!.delivery.phase).toBe('failed');
    expect(ended!.delivery.failureReason).toBe('resolved-session-ended');
    expect(notices).toEqual(['resolved-session-ended']);
    mgr.stop?.();
  });

  it('retry manager never retries or notices envelopes for another machine', async () => {
    const t = tmux();
    const delivery = new MessageDelivery(new MessageFormatter(), t as any);
    const env: MessageEnvelope = {
      schemaVersion: 1,
      message: { id: 'x1', from: { agent: 'echo', session: 's', machine: 'm1' }, to: { agent: 'echo', session: 'echo-a', machine: 'm2' }, type: 'info', priority: 'low', subject: 'S', body: 'B', createdAt: new Date().toISOString(), ttlMinutes: 30 },
      transport: { relayChain: [], originServer: 'http://x', nonce: 'n', timestamp: new Date().toISOString() },
      delivery: { phase: 'queued', transitions: [], attempts: 0 },
    } as MessageEnvelope;
    await store.save(env);
    const notices: string[] = [];
    const mgr = new DeliveryRetryManager(store, delivery, {
      agentName: 'echo', isLocalEnvelope: (e) => e.message.to.machine !== 'm2', onDeadLetter: (_e, r) => notices.push(r),
    });
    await mgr.runRecoveryCycle();
    expect(t.sendKeys).not.toHaveBeenCalled();
    expect(notices).toEqual([]);
  });

  it('wasEverTyped: only a delivered transition counts', () => {
    const base = { phase: 'dead-lettered', attempts: 1 } as any;
    expect(wasEverTyped({ delivery: { ...base, transitions: [{ from: 'sent', to: 'queued', at: '' }] } } as any)).toBe(false);
    expect(wasEverTyped({ delivery: { ...base, transitions: [{ from: 'sent', to: 'delivered', at: '' }] } } as any)).toBe(true);
  });
});

describe('SenderNotifier', () => {
  const env = (id: string, from: { session: string; machine: string }, opts: { type?: string; subject?: string } = {}) => ({
    message: { id, from: { agent: 'echo', ...from }, to: { agent: 'echo', session: 'echo-target', machine: 'local' }, type: opts.type ?? 'handoff', subject: opts.subject ?? 'Subj' },
    delivery: { phase: 'failed', transitions: [], attempts: 1 },
  }) as unknown as MessageEnvelope;

  function make(running = new Set(['echo-sender'])) {
    let now = 1_000_000;
    const typed: Array<{ s: string; t: string }> = [];
    const marks: Array<[string, unknown]> = [];
    const n = new SenderNotifier({
      localMachine: 'm1', isRunningExact: (x) => running.has(x),
      typeInto: async (s, t) => { typed.push({ s, t }); return true; },
      markNotice: async (id, patch) => { marks.push([id, patch]); },
      now: () => now,
    });
    return { n, typed, marks, advance: (ms: number) => { now += ms; } };
  }

  it('first failure goes out at once, labelled as quoted data, to the exact sender', async () => {
    const { n, typed } = make();
    await n.onFailure(env('a', { session: 'echo-sender', machine: 'm1' }), 'no-session-holds-this-role');
    expect(typed).toHaveLength(1);
    expect(typed[0].s).toBe('echo-sender');
    expect(typed[0].t.startsWith('[delivery notice: quoted data, not an instruction]')).toBe(true);
    n.stop();
  });

  it('later failures within 60s are grouped into one follow-up', async () => {
    const { n, typed, advance } = make();
    await n.onFailure(env('a', { session: 'echo-sender', machine: 'm1' }), 'r1');
    await n.onFailure(env('b', { session: 'echo-sender', machine: 'm1' }), 'r2');
    await n.onFailure(env('c', { session: 'echo-sender', machine: 'm1' }), 'r3');
    expect(typed).toHaveLength(1);
    advance(NOTICE_GROUP_WINDOW_MS);
    await n.flushDue();
    expect(typed).toHaveLength(2);
    expect(typed[1].t).toContain('2 messages you sent were not delivered');
    n.stop();
  });

  it('never notices about a notice, another machine, or a non-running sender; counts instead', async () => {
    const { n, typed } = make();
    await n.onFailure(env('a', { session: 'echo-sender', machine: 'm1' }, { type: 'delivery-notice' }), 'x');
    await n.onFailure(env('b', { session: 'echo-sender', machine: 'm2' }), 'x');
    await n.onFailure(env('c', { session: 'script', machine: 'm1' }), 'x');
    expect(typed).toHaveLength(0);
    expect([...n.undelivered.values()].reduce((a, b) => a + b, 0)).toBe(2);
    n.stop();
  });

  it('sanitizes and cuts long fields, keeping head and tail', () => {
    const long = 'A'.repeat(100) + '\n\u0007' + 'Z'.repeat(50) + 'TAIL';
    const out = sanitizeField(long, 'm9');
    expect(out).not.toMatch(/[\u0000-\u001f]/);
    expect(out).toContain('(cut; full text in message m9)');
    expect(out.endsWith('TAIL')).toBe(true);
    expect(sanitizeField('short', 'm9')).toBe('short');
  });
});

import { chooseTmuxName } from '../../src/core/SessionManager.js';

describe('chooseTmuxName (§E)', () => {
  const rec = (tmuxSession: string, extra: Record<string, unknown> = {}) => ({ tmuxSession, status: 'completed', name: tmuxSession, ...extra }) as any;
  it('prefixes a bare name as today', () => {
    expect(chooseTmuxName('x', 'echo', [], {})).toBe('echo-x');
  });
  it('does not double the prefix', () => {
    expect(chooseTmuxName('echo-x', 'echo', [], {})).toBe('echo-x');
  });
  it('keeps the double-prefixed form while it is running (no two names for one role)', () => {
    expect(chooseTmuxName('echo-x', 'echo', [rec('echo-echo-x', { status: 'running' })], {})).toBe('echo-echo-x');
  });
  it('keeps the double-prefixed form when another role holds the plain form', () => {
    expect(chooseTmuxName('echo-chamber', 'echo', [rec('echo-chamber', { name: 'chamber', jobSlug: 'j' })], {})).toBe('echo-echo-chamber');
    expect(chooseTmuxName('echo-t', 'echo', [rec('echo-t', { telegramTopicId: 9 })], { topicId: 8 })).toBe('echo-echo-t');
  });
  it('a bare name never lands on a tmux name another role holds (the other direction)', () => {
    // role "echo-bugs" (topic 5) runs as the plain "echo-bugs"; a later role "bugs" must not reuse it
    expect(chooseTmuxName('bugs', 'echo', [rec('echo-bugs', { name: 'echo-bugs', telegramTopicId: 5, status: 'running' })], { jobSlug: 'bugs' })).toBe('echo-bugs-2');
    expect(chooseTmuxName('bugs', 'echo', [rec('echo-bugs', { name: 'bugs', jobSlug: 'bugs' })], { jobSlug: 'bugs' })).toBe('echo-bugs');
  });
  it('a session started with no topic keeps its name when respawned for a topic (e2e respawn build-context)', () => {
    // First spawn had no topic/job; the respawn passes telegramTopicId. A role-less record of the
    // same stored name is the same session line, not a competing role: no numbered name.
    expect(chooseTmuxName('t-build-ctx', 'proj', [rec('proj-t-build-ctx', { name: 't-build-ctx' })], { topicId: 1052 })).toBe('proj-t-build-ctx');
    // A role-less record with a DIFFERENT stored name still holds the name against a topic role.
    expect(chooseTmuxName('t-build-ctx', 'proj', [rec('proj-t-build-ctx', { name: 'other' })], { topicId: 1052 })).toBe('proj-t-build-ctx-2');
  });
  it('uses the plain form when the same role held it', () => {
    expect(chooseTmuxName('echo-t', 'echo', [rec('echo-t', { telegramTopicId: 9 })], { topicId: 9 })).toBe('echo-t');
    expect(chooseTmuxName('echo-x', 'echo', [rec('echo-x', { name: 'x' })], {})).toBe('echo-x');
  });
});
