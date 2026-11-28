import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NeverSilentStore } from '../../src/monitoring/neverSilent/NeverSilentStore.js';
import { NeverSilentWatcher, askCallbackData, type NeverSilentConfig, type NeverSilentDeps, type NoticeUndelivered, type SessionFacts } from '../../src/monitoring/neverSilent/NeverSilentWatcher.js';
import { neverSilentEvidenceKind } from '../../src/monitoring/neverSilent/neverSilentWiring.js';
import type { ConversationSilenceJudge, SilenceVerdict } from '../../src/monitoring/neverSilent/ConversationSilenceJudge.js';

let t = 1_000_000;
const now = () => t;

function harness(over: Partial<NeverSilentDeps> = {}, cfgOver: Partial<NeverSilentConfig> = {}, verdict?: Partial<SilenceVerdict> | (() => Promise<SilenceVerdict>)) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-watch-'));
  const store = new NeverSilentStore(dir, now);
  const sent: Array<{ text: string; button?: { text: string; data: string } }> = [];
  const moves: Array<{ target: string; by: string; text: string }> = [];
  let judgeCalls = 0;
  let pinned = false;
  const session: SessionFacts = { tmuxSession: 'agent-topic-7', framework: 'claude-code', accountId: 'claude-a', configHome: '/h/a', alive: true, startedAt: 1 };
  const judge = {
    judge: async () => {
      judgeCalls++;
      if (typeof verdict === 'function') return verdict();
      return { silenceClass: 'engine-login', confidence: 0.95, route: 'jev', evidence: 'x', truncated: false, actionsSinceMessage: 'none', calls: 1, ...(verdict ?? {}) } as SilenceVerdict;
    },
  } as unknown as ConversationSilenceJudge;
  const cfg: NeverSilentConfig = { enabled: true, judge: true, actions: true, frameworkFallback: true, confidenceFloor: 0.8, noticeAfterMs: 60_000, ...cfgOver };
  const deps: NeverSilentDeps = {
    store, config: () => cfg, judge,
    resolveSession: () => session,
    capturePane: () => '⏺ Login reached its time limit · Please run /login',
    authStatus: async () => ({ loggedIn: false }),
    accountFacts: () => ({ id: 'claude-a', status: 'active', loginCheck: 'unavailable' }),
    healthyByFramework: () => ({ 'codex-cli': 3 }),
    sameEngineHealthy: () => false,
    fallbackEngine: (_platform, stuck, tried) => (tried.includes('codex-cli') ? null : 'codex-cli'),
    hints: () => [],
    isPinned: () => pinned,
    isProtected: () => false,
    observeLoginExpired: async () => {},
    swap: async () => ({ swapped: false }),
    applyFallback: async (_p, _k, target, by, text) => { moves.push({ target, by, text }); return { ok: true, from: pinned ? 'claude-code' : null, fromUpdatedBy: pinned ? 'telegram:justin' : null }; },
    restoreFallback: async () => true,
    sendNotice: async (_p, _k, text, button) => { sent.push({ text, button }); return String(sent.length); },
    repairStarted: () => true,
    accountHealthy: () => false,
    now,
    ...over,
  };
  const w = new NeverSilentWatcher(deps);
  return { w, store, sent, moves, judgeCalls: () => judgeCalls, setPinned: (v: boolean) => { pinned = v; }, session };
}

beforeEach(() => { t = 1_000_000; });

describe('NeverSilentWatcher', () => {
  it('a message that gets no reply produces a notice — even when the judge throws', async () => {
    const h = harness({}, {}, async () => { throw new Error('boom'); });
    h.w.onInbound('telegram', '7', '101', 'hello?');
    t += 61_000;
    await h.w.tick();
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]!.text).toMatch(/wasn't answered yet/);
  });

  it('a judge that never returns does not block the sweep forever (judge off still tells)', async () => {
    const h = harness({}, { judge: false });
    h.w.onInbound('telegram', '7', '101', 'hello?');
    t += 61_000;
    await h.w.tick();
    expect(h.judgeCalls()).toBe(0);
    expect(h.sent).toHaveLength(1);
  });

  it('nothing is sent before the notice deadline, or when a reply came', async () => {
    const h = harness();
    h.w.onInbound('telegram', '7', '101', 'hello?');
    t += 30_000;
    await h.w.tick();
    expect(h.sent).toHaveLength(0);
    h.w.onReply('telegram', '7');
    t += 60_000;
    await h.w.tick();
    expect(h.sent).toHaveLength(0);
  });

  it('a delivered standby line counts as the waiting notice', async () => {
    const h = harness({}, {}, { silenceClass: 'working-slow', confidence: 0.9 });
    h.w.onInbound('telegram', '7', '101', 'hello?');
    h.w.onStandby('telegram', '7');
    t += 61_000;
    await h.w.tick();
    expect(h.sent).toHaveLength(0);
  });

  it('three waiting messages get one batched notice', async () => {
    const h = harness({}, { judge: false });
    for (const id of ['1', '2', '3']) h.w.onInbound('telegram', '7', id, `m${id}`);
    t += 61_000;
    await h.w.tick();
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]!.text).toMatch(/last 3 messages/);
    await h.w.tick();
    expect(h.sent).toHaveLength(1); // covered obligations are never re-noticed
  });

  it('a message arriving after a notice gets its own later notice', async () => {
    const h = harness({}, { judge: false });
    h.w.onInbound('telegram', '7', '1', 'first');
    t += 61_000;
    await h.w.tick();
    h.w.onInbound('telegram', '7', '2', 'second');
    t += 61_000;
    await h.w.tick();
    expect(h.sent).toHaveLength(2);
    expect(h.sent[1]!.text).toMatch(/^Your message wasn't answered/);
  });

  it('expired Claude login, unpinned: moves to Codex, re-drives the message with the "why late" line, tells once', async () => {
    const h = harness();
    h.w.onInbound('telegram', '7', '101', 'can you check the report?', 'Justin');
    t += 61_000;
    await h.w.tick();
    expect(h.moves).toHaveLength(1);
    expect(h.moves[0]!.target).toBe('codex-cli');
    expect(h.moves[0]!.text).toContain('Begin your reply with one short line saying why it is late');
    expect(h.moves[0]!.text).toContain('can you check the report?');
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]!.text).toContain('moved this conversation to Codex');
    expect(h.sent[0]!.button).toBeUndefined();
    // The re-driven message has a fresh deadline: no second move or notice on the next tick.
    await h.w.tick();
    expect(h.moves).toHaveLength(1);
    expect(h.sent).toHaveLength(1);
  });

  it('pinned conversation: one notice with one button, no move; a later message joins the open ask', async () => {
    const h = harness();
    h.setPinned(true);
    h.w.onInbound('telegram', '7', '101', 'hello');
    t += 61_000;
    await h.w.tick();
    expect(h.moves).toHaveLength(0);
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]!.text).toContain('You set this conversation to Claude');
    expect(h.sent[0]!.button?.text).toBe('Move to Codex');
    await h.w.tick();
    expect(h.sent).toHaveLength(1); // never re-asked on a timer
  });

  it('the tap moves it once; a second tap and a non-owner tap do nothing harmful', async () => {
    const h = harness();
    h.setPinned(true);
    h.w.onInbound('telegram', '7', '101', 'hello');
    t += 61_000;
    await h.w.tick();
    const data = h.sent[0]!.button!.data;
    const nonce = data.slice('ns:m:'.length);
    expect(data).toBe(askCallbackData(nonce));
    expect(await h.w.handleAskTap(nonce, false)).toMatch(/Only the owner/);
    expect(h.moves).toHaveLength(0);
    expect(await h.w.handleAskTap(nonce, true)).toMatch(/Moving this conversation to Codex/);
    await h.w.settle();
    expect(h.moves).toHaveLength(1);
    expect(h.moves[0]!.by).toBe('tap');
    expect(await h.w.handleAskTap(nonce, true)).toMatch(/Already moving/);
    await h.w.settle();
    expect(h.moves).toHaveLength(1);
    expect(await h.w.handleAskTap('f'.repeat(24), true)).toMatch(/no longer active/);
  });

  it('a tap queued behind a sweep does not move a conversation that answered meanwhile', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    let judged = 0;
    const h = harness({}, {}, async () => {
      judged++;
      if (judged === 2) await gate; // the second sweep holds the lock while "judging"
      return { silenceClass: 'engine-login', confidence: 0.95, route: 'jev', evidence: 'x', truncated: false, actionsSinceMessage: 'none', calls: 1 };
    });
    h.setPinned(true);
    h.w.onInbound('telegram', '7', '101', 'hello');
    t += 61_000;
    await h.w.tick();
    const nonce = h.sent[0]!.button!.data.slice(5);
    h.w.onInbound('telegram', '7', '102', 'more');
    t += 10 * 60_000; // past the judge backoff, so the sweep really judges
    const sweep = h.w.tick();
    await new Promise((r) => setTimeout(r, 5));
    expect(await h.w.handleAskTap(nonce, true)).toMatch(/Moving/);
    h.w.onReply('telegram', '7'); // the original engine answered while the tap waited
    release();
    await sweep;
    await h.w.settle();
    expect(h.moves).toHaveLength(0);
  });

  it('a stale tap after the conversation answered does nothing', async () => {
    const h = harness();
    h.setPinned(true);
    h.w.onInbound('telegram', '7', '101', 'hello');
    t += 61_000;
    await h.w.tick();
    const nonce = h.sent[0]!.button!.data.slice(5);
    h.w.onReply('telegram', '7');
    expect(await h.w.handleAskTap(nonce, true)).toMatch(/answered since/);
    expect(h.moves).toHaveLength(0);
  });

  it('unchanged evidence reuses the verdict without a new judge call', async () => {
    const h = harness({}, { actions: false });
    h.w.onInbound('telegram', '7', '101', 'hello');
    t += 61_000;
    await h.w.tick();
    await h.w.tick();
    await h.w.tick();
    expect(h.judgeCalls()).toBe(1);
    expect(h.sent).toHaveLength(1);
  });

  it('actions off (the dark default) tells the cause but moves nothing', async () => {
    const h = harness({}, { actions: false });
    h.w.onInbound('telegram', '7', '101', 'hello');
    t += 61_000;
    await h.w.tick();
    expect(h.moves).toHaveLength(0);
    expect(h.sent[0]!.text).toContain('the Claude sign-in this conversation uses ran out');
  });

  it('breaker: once moved, a silence on the new engine never moves it back to the old one', async () => {
    let current: SessionFacts = { tmuxSession: 'agent-topic-7', framework: 'claude-code', accountId: 'claude-a', configHome: '/h/a', alive: true, startedAt: 1 };
    let pane = '⏺ Login reached its time limit · Please run /login';
    const h = harness({
      resolveSession: () => current,
      capturePane: () => pane,
      // Claude is the only other engine; it is "healthy" again in the pool's eyes.
      fallbackEngine: (_platform, stuck, tried) => (['codex-cli', 'claude-code'].find((f) => f !== stuck && !tried.includes(f)) ?? null),
    });
    h.w.onInbound('telegram', '7', '101', 'hello');
    t += 61_000;
    await h.w.tick();
    expect(h.moves).toHaveLength(1);
    // The replacement session is on Codex and also goes silent with new evidence.
    current = { tmuxSession: 'agent-topic-7', framework: 'codex-cli', accountId: 'codex-a', configHome: null, alive: true, startedAt: t };
    pane = 'codex: usage limit reached';
    t += 61_000;
    await h.w.tick();
    expect(h.moves).toHaveLength(1);
    expect(h.sent.at(-1)!.text).not.toContain('moved this conversation');
  });

  it('a failed notice send leaves the message uncovered so the next tick retries', async () => {
    let fail = true;
    const sent: string[] = [];
    const h = harness({ sendNotice: async (_p, _k, text) => { if (fail) return null; sent.push(text); return '1'; } }, { judge: false });
    h.w.onInbound('telegram', '7', '101', 'hello');
    t += 61_000;
    await h.w.tick();
    expect(sent).toHaveLength(0);
    fail = false;
    await h.w.tick();
    expect(sent).toHaveLength(0); // still inside the first 30 s retry wait
    t += 30_000;
    await h.w.tick();
    expect(sent).toHaveLength(1);
  });

  it('a failing notice is retried after a doubling wait, not on every sweep (CMT-2078)', async () => {
    const events: Array<Record<string, unknown>> = [];
    const h = harness({ sendNotice: async () => ({ undelivered: 'no-adapter' as const }), log: (e) => events.push(e) }, { judge: false });
    h.w.onInbound('telegram', '7', '101', 'hello');
    t += 61_000;
    for (let i = 0; i <= 20; i++) { await h.w.tick(); t += 30_000; } // ten minutes of 30 s sweeps
    const tries = events.filter((e) => e.event === 'notice-undelivered');
    // Tries at 0, 30, 90, 210 and 450 s: five, where the old loop made twenty-one.
    expect(tries.map((e) => e.attempt)).toEqual([1, 2, 3, 4, 5]);
    expect(tries.filter((e) => neverSilentEvidenceKind(e) === 'error')).toHaveLength(1);
  });

  it('the wait never grows past 15 minutes', async () => {
    const events: Array<Record<string, unknown>> = [];
    const h = harness({ sendNotice: async () => null, log: (e) => events.push(e) }, { judge: false });
    h.w.onInbound('telegram', '7', '101', 'hello');
    t += 61_000;
    for (let i = 0; i < 400; i++) { await h.w.tick(); t += 30_000; } // 200 minutes
    const at = events.filter((e) => e.event === 'notice-undelivered').map((e) => Date.parse(String(e.at)));
    const gaps = at.slice(1).map((v, i) => v - at[i]);
    expect(Math.max(...gaps)).toBeLessThanOrEqual(15 * 60_000);
    expect(gaps.at(-1)).toBe(15 * 60_000);
  });

  it('a delivered notice resets the count, so a later failure is a first failure again', async () => {
    let fail = true;
    const events: Array<Record<string, unknown>> = [];
    const h = harness({ sendNotice: async () => (fail ? null : '1'), log: (e) => events.push(e) }, { judge: false });
    h.w.onInbound('telegram', '7', '101', 'hello');
    t += 61_000;
    await h.w.tick();
    fail = false;
    t += 30_000;
    await h.w.tick();
    expect(events.some((e) => e.event === 'notice-sent')).toBe(true);
    fail = true;
    h.w.onInbound('telegram', '7', '102', 'still there?');
    t += 61_000;
    await h.w.tick();
    const tries = events.filter((e) => e.event === 'notice-undelivered');
    expect(tries.map((e) => e.attempt)).toEqual([1, 1]);
  });

  it('a streak that starts held and then really fails is still counted as one error', async () => {
    let n = 0;
    const events: Array<Record<string, unknown>> = [];
    const h = harness({ sendNotice: async () => (++n === 1 ? { undelivered: 'held-quiet' as const } : { undelivered: 'no-adapter' as const }), log: (e) => events.push(e) }, { judge: false });
    h.w.onInbound('telegram', '7', '101', 'hello');
    t += 61_000;
    for (let i = 0; i < 4; i++) { await h.w.tick(); t += 30_000; }
    const tries = events.filter((e) => e.event === 'notice-undelivered');
    expect(tries.map((e) => [e.reason, e.attempt])).toEqual([['held-quiet', 1], ['no-adapter', 2], ['no-adapter', 3]]);
    expect(tries.map((e) => neverSilentEvidenceKind(e))).toEqual([null, 'error', null]);
  });

  it('a failing status notice backs off too, and a skipped try writes no ask state', async () => {
    const events: Array<Record<string, unknown>> = [];
    const h = harness({ sendNotice: async () => null, log: (e) => events.push(e) });
    h.setPinned(true); // pinned: the status notice carries the one-tap ask
    h.w.onInbound('telegram', '7', '101', 'hello');
    t += 61_000;
    await h.w.tick();
    const statusTries = () => events.filter((e) => e.event === 'notice-undelivered' && e.kind === 'status');
    expect(statusTries()).toHaveLength(1);
    const incident = h.store.openIncident('telegram', '7')!;
    const askBefore = JSON.stringify(h.store.getIncident(incident.id)?.ask);
    expect(h.store.getIncident(incident.id)?.ask?.state).toBe('open');
    t += 10_000;
    await h.w.tick(); // inside the 30 s wait
    expect(statusTries()).toHaveLength(1);
    expect(JSON.stringify(h.store.getIncident(incident.id)?.ask)).toBe(askBefore);
    t += 20_000;
    await h.w.tick();
    expect(statusTries().map((e) => e.attempt)).toEqual([1, 2]);
  });

  it('evidence counts a held or numberless notice as neither an error nor a send', () => {
    expect(neverSilentEvidenceKind({ event: 'notice-sent' })).toBe('fired');
    expect(neverSilentEvidenceKind({ event: 'fallback-applied' })).toBe('fired');
    expect(neverSilentEvidenceKind({ event: 'sweep-failed' })).toBe('error');
    expect(neverSilentEvidenceKind({ event: 'notice-undelivered', reason: 'no-adapter', attempt: 1, firstFailure: true })).toBe('error');
    expect(neverSilentEvidenceKind({ event: 'notice-undelivered', reason: 'threw:TypeError' })).toBe('error'); // move-failed, no try number
    expect(neverSilentEvidenceKind({ event: 'notice-undelivered', reason: 'no-adapter', attempt: 2 })).toBeNull();
    expect(neverSilentEvidenceKind({ event: 'notice-undelivered', reason: 'held-quiet', attempt: 1 })).toBeNull();
    expect(neverSilentEvidenceKind({ event: 'notice-undelivered', reason: 'no-message-id', attempt: 1 })).toBeNull();
    expect(neverSilentEvidenceKind({ event: 'notice-undelivered', reason: 'held-quiet' })).toBeNull();
    expect(neverSilentEvidenceKind({ event: 'pool-observed' })).toBeNull();
  });

  it.each([
    ['a held-quiet send', async () => ({ undelivered: 'held-quiet' as const }), 'held-quiet'],
    ['a send with no message id', async () => ({ undelivered: 'no-message-id' as const }), 'no-message-id'],
    ['a sender with no adapter', async () => ({ undelivered: 'no-adapter' as const }), 'no-adapter'],
    ['a sender that cannot say why', async () => null, 'no-receipt'],
    ['a sender with an unknown label', async () => ({ undelivered: 'chat 123 private words' }) as unknown as NoticeUndelivered, 'unknown-reason'],
    ['a send that throws', async () => { throw new TypeError('chat 4290919884 private words'); }, 'threw:TypeError'],
  ])('an undelivered notice logs why: %s', async (_label, send, reason) => {
    const events: Array<Record<string, unknown>> = [];
    const h = harness({ sendNotice: send as NeverSilentDeps['sendNotice'], log: (e) => events.push(e) }, { judge: false });
    h.w.onInbound('telegram', '7', '101', 'hello');
    t += 61_000;
    await h.w.tick();
    const undelivered = events.filter((e) => e.event === 'notice-undelivered');
    expect(undelivered.length).toBeGreaterThan(0);
    for (const e of undelivered) expect(e.reason).toBe(reason);
    expect(JSON.stringify(events)).not.toContain('private words');
    expect(events.some((e) => e.event === 'notice-sent')).toBe(false);
  });
  it('a bad error name is not copied into the reason', async () => {
    const events: Array<Record<string, unknown>> = [];
    const err = Object.assign(new Error('x'), { name: 'see https://example.invalid/private' });
    const h = harness({ sendNotice: async () => { throw err; }, log: (e) => events.push(e) }, { judge: false });
    h.w.onInbound('telegram', '7', '101', 'hello');
    t += 61_000;
    await h.w.tick();
    expect(events.find((e) => e.event === 'notice-undelivered')?.reason).toBe('threw:Error');
  });
  it('obligations survive a restart (durable store)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-dur-'));
    new NeverSilentStore(dir, now).accept({ platform: 'telegram', conversationKey: '7', inboundMessageId: '1', text: 'x', deadlineMs: 1000 });
    t += 2000;
    const reloaded = new NeverSilentStore(dir, now);
    expect(reloaded.overdueConversations(t)).toHaveLength(1);
    expect(reloaded.snapshot().obligations[0]!.text).toBeNull(); // the read surface never carries the text
  });

  it('a protected session is never moved, only told', async () => {
    const h = harness({ isProtected: () => true });
    h.w.onInbound('telegram', '7', '101', 'hello');
    t += 61_000;
    await h.w.tick();
    expect(h.moves).toHaveLength(0);
    expect(h.sent[0]!.text).toContain('sign-in this conversation uses ran out');
  });

  it('a silence soon after a move back asks instead of moving again (the repair did not hold)', async () => {
    let healthy = false;
    const h = harness({ accountHealthy: () => healthy });
    h.w.onInbound('telegram', '7', '101', 'hello');
    t += 61_000;
    await h.w.tick();
    expect(h.moves).toHaveLength(1);
    h.w.onReply('telegram', '7');
    healthy = true;
    await h.w.tick(); // moved back
    healthy = false;
    t += 60_000;
    h.w.onInbound('telegram', '7', '102', 'and now?');
    t += 61_000;
    await h.w.tick();
    expect(h.moves).toHaveLength(1);
    expect(h.sent.at(-1)!.button?.text).toBe('Move to Codex');
  });

  it('the move back restores who chose the engine, so a pin stays a pin', async () => {
    const restores: Array<{ from: string | null; by: string | null }> = [];
    let healthy = false;
    const h = harness({ accountHealthy: () => healthy, restoreFallback: async (_p, _k, from, by) => { restores.push({ from, by }); return true; } });
    h.setPinned(true);
    h.w.onInbound('telegram', '7', '101', 'hello');
    t += 61_000;
    await h.w.tick();
    const nonce = h.sent[0]!.button!.data.slice(5);
    await h.w.handleAskTap(nonce, true);
    await h.w.settle();
    h.w.onReply('telegram', '7');
    healthy = true;
    await h.w.tick();
    expect(restores).toEqual([{ from: 'claude-code', by: 'telegram:justin' }]); // the wiring writes it under the restored-pin label
  });

  it('a tap racing a sweep never produces a second button', async () => {
    const h = harness();
    h.setPinned(true);
    h.w.onInbound('telegram', '7', '101', 'hello');
    t += 61_000;
    await h.w.tick();
    const nonce = h.sent[0]!.button!.data.slice(5);
    h.w.onInbound('telegram', '7', '102', 'still there?');
    t += 61_000;
    await Promise.all([h.w.tick(), h.w.handleAskTap(nonce, true)]);
    await h.w.settle();
    await h.w.tick();
    expect(h.sent.filter((s) => s.button)).toHaveLength(1);
    expect(h.moves).toHaveLength(1);
  });

  it('judge calls back off: a changing screen does not buy a call every tick', async () => {
    let n = 0;
    const h = harness({ capturePane: () => `working… ${n++}` }, { actions: false }, { silenceClass: 'working-slow', confidence: 0.9 });
    h.w.onInbound('telegram', '7', '101', 'hello');
    t += 61_000;
    for (let i = 0; i < 8; i++) { await h.w.tick(); t += 15_000; } // two minutes of 15 s ticks
    expect(h.judgeCalls()).toBeLessThanOrEqual(3);
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]!.text).toMatch(/still being worked on/);
  });

  it('moves back after the original account works again, only when idle', async () => {
    const restores: string[] = [];
    let healthy = false;
    const h = harness({ accountHealthy: () => healthy, restoreFallback: async (_p, k) => { restores.push(k); return true; } });
    h.w.onInbound('telegram', '7', '101', 'hello');
    t += 61_000;
    await h.w.tick();
    healthy = true;
    await h.w.tick();
    expect(restores).toHaveLength(0); // the re-driven message is still open
    h.w.onReply('telegram', '7');
    await h.w.tick();
    expect(restores).toEqual(['7']);
    await h.w.tick();
    expect(restores).toEqual(['7']);
  });
});

// fb-faa9d074-e09: a message held for the other machine was told "the session stopped running".
describe('NeverSilentWatcher — a message held for the other machine', () => {
  it('says it is waiting for the other machine, never that a session stopped', async () => {
    const h = harness({ resolveSession: () => null, awaitingMachine: () => 'm_m5' });
    h.w.onInbound('telegram', '7', '101', 'hello?');
    t += 61_000;
    await h.w.tick();
    expect(h.judgeCalls()).toBe(0);
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]!.text).toMatch(/waiting for the other machine that runs this conversation/);
    expect(h.sent[0]!.text).not.toMatch(/stopped running/);
    expect(h.store.openIncident('telegram', '7')?.silenceClass).toBe('waiting-for-machine');
  });

  it('with no session and nothing held, the old structural class stands', async () => {
    const h = harness({ resolveSession: () => null, awaitingMachine: () => null });
    h.w.onInbound('telegram', '7', '101', 'hello?');
    t += 61_000;
    await h.w.tick();
    expect(h.store.openIncident('telegram', '7')?.silenceClass).toBe('crashed');
  });

  it('a throwing lookup falls back to the plain class instead of breaking the notice', async () => {
    const h = harness({ resolveSession: () => null, awaitingMachine: () => { throw new Error('queue down'); } });
    h.w.onInbound('telegram', '7', '101', 'hello?');
    t += 61_000;
    await h.w.tick();
    expect(h.sent).toHaveLength(1);
    expect(h.store.openIncident('telegram', '7')?.silenceClass).toBe('crashed');
  });

  it('a live session here is judged normally even if something is queued', async () => {
    const awaitingMachine = (): string | null => 'm_m5';
    const h = harness({ awaitingMachine });
    h.w.onInbound('telegram', '7', '101', 'hello?');
    t += 61_000;
    await h.w.tick();
    expect(h.judgeCalls()).toBe(1);
  });
});
