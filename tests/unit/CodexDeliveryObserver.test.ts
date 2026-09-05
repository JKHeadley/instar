import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CodexDeliveryObserver, observeCodexComposer, scanRollout, scanSharedRollout } from '../../src/core/CodexDeliveryObserver.js';
import { InboundDeliveryStore } from '../../src/core/InboundDeliveryStore.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const KEY = 'ab'.repeat(32);
let dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs) SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'CodexDeliveryObserver.test cleanup' });
  dirs = [];
});

function fixture(envelope = 'full inbound envelope') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-observer-'));
  dirs.push(dir);
  const rollout = path.join(dir, 'rollout.jsonl');
  fs.writeFileSync(rollout, JSON.stringify({ type: 'session_meta', payload: { id: 'thread-1' } }) + '\n');
  const baseline = fs.statSync(rollout).size;
  const store = InboundDeliveryStore.openMemory({ now: () => 1_000 });
  const row = store.prepare({ conversationId: '59199', deliveryId: 'd1', incarnation: 'tmux-1', framework: 'codex-cli', envelope, hmacKey: KEY });
  expect(store.bindRolloutBaseline('59199', 'd1', rollout, 'thread-1', baseline)).toBe(true);
  expect(store.transition('59199', 'd1', 'prepared', 'dispatch-armed')).toBe(true);
  expect(store.transition('59199', 'd1', 'dispatch-armed', 'dispatch-started')).toBe(true);
  expect(store.transition('59199', 'd1', 'dispatch-started', 'dispatched')).toBe(true);
  return { store, rollout, envelope, row: store.get('59199', 'd1')! };
}

function event(type: string, payload: Record<string, unknown>): string {
  return JSON.stringify({ type, payload, timestamp: new Date().toISOString() }) + '\n';
}

function user(turnId: string, text: string): string {
  return event('response_item', {
    type: 'message', role: 'user', content: [{ type: 'input_text', text }],
    internal_chat_message_metadata_passthrough: { turn_id: turnId },
  });
}

function assistant(turnId: string): string {
  return event('response_item', {
    type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }],
    internal_chat_message_metadata_passthrough: { turn_id: turnId },
  });
}

function complete(turnId: string): string {
  return event('event_msg', { type: 'task_complete', turn_id: turnId });
}

function currentMessage(role: 'user' | 'assistant' | 'developer' | 'system', text: string): string {
  return event('response_item', {
    type: 'message', role,
    content: [{ type: role === 'assistant' ? 'output_text' : 'input_text', text }],
  });
}

describe('CodexDeliveryObserver', () => {
  it('requires the exact post-baseline envelope and same task turn, then records responded', async () => {
    const f = fixture();
    fs.appendFileSync(f.rollout,
      event('event_msg', { type: 'task_started', turn_id: 't1' }) + user('t1', f.envelope) + assistant('t1') + complete('t1'));
    const observer = new CodexDeliveryObserver({
      store: f.store, hmacKey: KEY, resolveRolloutPath: () => f.rollout, resolveRolloutId: () => 'thread-1', capturePane: () => null, now: () => 1_000,
    });
    await observer.sweep();
    expect(f.store.get('59199', 'd1')).toMatchObject({
      transportState: 'consumed', composerState: 'cleared', transcriptState: 'responded', turnId: 't1',
    });
    expect(f.store.status().deliveriesByState.responded).toBe(1);
  });

  it('accepts the live Codex 0.149 task envelope without repeated response-item turn metadata', async () => {
    const f = fixture('live 0.149 envelope');
    fs.appendFileSync(f.rollout,
      event('event_msg', { type: 'thread_settings_applied' })
      + event('event_msg', { type: 'task_started', turn_id: 'live-turn' })
      + event('world_state', { state: {}, full: true })
      + event('inter_agent_communication_metadata', { trigger_turn: 'live-turn' })
      + currentMessage('user', f.envelope)
      + event('event_msg', { type: 'item_completed', turn_id: 'live-turn' })
      + currentMessage('developer', 'hook context')
      + currentMessage('system', 'runtime context')
      + event('response_item', {
        type: 'agent_message', id: 'agent-message-1', author: 'helper', recipient: 'root', content: 'status',
        internal_chat_message_metadata_passthrough: { turn_id: 'live-turn' },
      })
      + event('response_item', {
        type: 'tool_search_call', id: 'tool-search-1', call_id: 'call-1', status: 'completed',
        arguments: {}, execution: {},
      })
      + event('response_item', {
        type: 'tool_search_output', id: 'tool-search-output-1', call_id: 'call-1', status: 'completed',
        tools: [], execution: {},
      })
      + event('event_msg', { type: 'item_completed', turn_id: 'live-turn' })
      + currentMessage('assistant', 'ok')
      + complete('live-turn'));
    await new CodexDeliveryObserver({
      store: f.store, hmacKey: KEY, resolveRolloutPath: () => f.rollout,
      resolveRolloutId: () => 'thread-1', capturePane: () => null, now: () => 1_000,
    }).sweep();
    expect(f.store.get('59199', 'd1')).toMatchObject({
      transportState: 'consumed', transcriptState: 'responded', turnId: 'live-turn',
    });
  });

  it('binds a fresh pre-rollout bootstrap from offset zero once its generation appears', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-bootstrap-observer-'));
    dirs.push(dir);
    const rollout = path.join(dir, 'rollout.jsonl');
    const envelope = 'fresh bootstrap envelope';
    fs.writeFileSync(rollout,
      JSON.stringify({ type: 'session_meta', payload: { id: 'fresh-thread' } }) + '\n'
      + event('event_msg', { type: 'task_started', turn_id: 'fresh-turn' })
      + currentMessage('user', envelope)
      + currentMessage('assistant', 'ok')
      + complete('fresh-turn'));
    const store = InboundDeliveryStore.openMemory({ now: () => 1_000 });
    const row = store.prepare({
      conversationId: 'fresh', deliveryId: 'bootstrap', incarnation: 'fresh-incarnation',
      framework: 'codex-cli', envelope, hmacKey: KEY,
    });
    store.transition('fresh', row.deliveryId, 'prepared', 'dispatch-armed');
    store.transition('fresh', row.deliveryId, 'dispatch-armed', 'dispatch-started');
    store.transition('fresh', row.deliveryId, 'dispatch-started', 'dispatched');
    await new CodexDeliveryObserver({
      store, hmacKey: KEY, resolveRolloutPath: () => rollout, resolveRolloutId: () => 'fresh-thread',
      bindLocalBootstrap: (delivery) => store.bindBootstrapRollout(
        delivery.conversationId, delivery.deliveryId, rollout, 'fresh-thread',
      ),
      capturePane: () => null, now: () => 1_000,
    }).sweep();
    expect(store.get('fresh', 'bootstrap')).toMatchObject({
      baselineOffset: 0, transcriptState: 'responded', turnId: 'fresh-turn',
    });
  });

  it('still fails closed when legacy response-item metadata conflicts with the active turn', async () => {
    const f = fixture();
    fs.appendFileSync(f.rollout,
      event('event_msg', { type: 'task_started', turn_id: 'active' }) + user('forged', f.envelope));
    await new CodexDeliveryObserver({
      store: f.store, hmacKey: KEY, resolveRolloutPath: () => f.rollout,
      resolveRolloutId: () => 'thread-1', capturePane: () => null, now: () => 1_000,
    }).sweep();
    expect(f.store.get('59199', 'd1')).toMatchObject({ transcriptState: 'unknown', eligibilityState: 'unknown' });
  });

  it.each([
    null,
    'not-an-object',
    {},
    { turn_id: 42 },
  ])('fails closed when present response-item metadata is malformed: %j', async (metadata) => {
    const f = fixture();
    fs.appendFileSync(f.rollout,
      event('event_msg', { type: 'task_started', turn_id: 'active' })
      + event('response_item', {
        type: 'message', role: 'user', content: [{ type: 'input_text', text: f.envelope }],
        internal_chat_message_metadata_passthrough: metadata,
      }));
    await new CodexDeliveryObserver({
      store: f.store, hmacKey: KEY, resolveRolloutPath: () => f.rollout,
      resolveRolloutId: () => 'thread-1', capturePane: () => null, now: () => 1_000,
    }).sweep();
    expect(f.store.get('59199', 'd1')).toMatchObject({ transcriptState: 'unknown', eligibilityState: 'unknown' });
  });

  it('normalizes exactly one transport-added final newline symmetrically', async () => {
    const f = fixture('line one\nline two\n');
    fs.appendFileSync(f.rollout,
      event('event_msg', { type: 'task_started', turn_id: 'newline' })
      + user('newline', 'line one\nline two') + assistant('newline') + complete('newline'));
    await new CodexDeliveryObserver({
      store: f.store, hmacKey: KEY, resolveRolloutPath: () => f.rollout,
      resolveRolloutId: () => 'thread-1', capturePane: () => null, now: () => 1_000,
    }).sweep();
    expect(f.store.get('59199', 'd1')?.transcriptState).toBe('responded');
  });

  it('does not consume an identical pre-baseline or a different post-baseline envelope', async () => {
    const f = fixture();
    fs.appendFileSync(f.rollout,
      event('event_msg', { type: 'task_started', turn_id: 't2' }) + user('t2', 'different envelope'));
    await new CodexDeliveryObserver({
      store: f.store, hmacKey: KEY, resolveRolloutPath: () => f.rollout, resolveRolloutId: () => 'thread-1', capturePane: () => null, now: () => 1_000,
    }).sweep();
    expect(f.store.get('59199', 'd1')?.transcriptState).toBe('unseen');
  });

  it('ignores unrelated user turns but fails closed when the pinned rollout identity changes', async () => {
    const f = fixture();
    fs.appendFileSync(f.rollout,
      event('event_msg', { type: 'task_started', turn_id: 'other' }) + user('other', 'unrelated') + complete('other'));
    const observer = new CodexDeliveryObserver({
      store: f.store, hmacKey: KEY, resolveRolloutPath: () => f.rollout, resolveRolloutId: () => 'thread-1',
      capturePane: () => null, now: () => 1_000,
    });
    await observer.sweep();
    expect(f.store.get('59199', 'd1')?.transcriptState).toBe('unseen');

    fs.writeFileSync(f.rollout, JSON.stringify({ type: 'session_meta', payload: { id: 'replacement-thread' } }) + '\n');
    await observer.sweep();
    expect(f.store.get('59199', 'd1')).toMatchObject({ transcriptState: 'unknown', eligibilityState: 'unknown' });
  });

  it('fails closed on a user turn that is not enclosed by its task_started id', async () => {
    const f = fixture();
    fs.appendFileSync(f.rollout,
      event('event_msg', { type: 'task_started', turn_id: 't3' }) + user('forged-turn', f.envelope));
    await new CodexDeliveryObserver({
      store: f.store, hmacKey: KEY, resolveRolloutPath: () => f.rollout, resolveRolloutId: () => 'thread-1', capturePane: () => null, now: () => 1_000,
    }).sweep();
    expect(f.store.get('59199', 'd1')).toMatchObject({ transcriptState: 'unknown', eligibilityState: 'unknown' });
  });

  it('ignores an incomplete trailing JSONL item until the newline arrives', async () => {
    const f = fixture();
    const complete = event('event_msg', { type: 'task_started', turn_id: 't4' }) + user('t4', f.envelope);
    fs.appendFileSync(f.rollout, complete.slice(0, -1));
    const observer = new CodexDeliveryObserver({
      store: f.store, hmacKey: KEY, resolveRolloutPath: () => f.rollout, resolveRolloutId: () => 'thread-1', capturePane: () => null, now: () => 1_000,
    });
    await observer.sweep();
    expect(f.store.get('59199', 'd1')?.transcriptState).toBe('unseen');
    fs.appendFileSync(f.rollout, '\n');
    await observer.sweep();
    expect(f.store.get('59199', 'd1')?.transcriptState).toBe('consumed');
  });

  it('authorizes composer presence only from a complete exact-envelope HMAC', () => {
    const f = fixture('exact draft text');
    expect(observeCodexComposer('header\n› exact draft text\n', f.row.envelopeHmac, KEY)).toBe('present');
    expect(observeCodexComposer('header\n› exact draft\n', f.row.envelopeHmac, KEY)).toBe('unknown');
    expect(observeCodexComposer('header\n›\n', f.row.envelopeHmac, KEY)).toBe('cleared');
    expect(observeCodexComposer('› exact draft text\n› second prompt\n', f.row.envelopeHmac, KEY)).toBe('unknown');
  });

  it('reports bounded scanner backlog, lag, and budget exhaustion without exposing content', async () => {
    const f = fixture();
    fs.appendFileSync(f.rollout, event('event_msg', { type: 'task_started', turn_id: 'later' }));
    const observer = new CodexDeliveryObserver({
      store: f.store, hmacKey: KEY, resolveRolloutPath: () => f.rollout,
      resolveRolloutId: () => 'thread-1', capturePane: () => null,
      now: () => 2_000, maxAggregateBytesPerSweep: 4_096, maxBytesPerRow: 4_096,
    });
    await observer.sweep();
    expect(observer.status()).toMatchObject({
      oldestLagMs: 1_000,
      budgetExhaustionCount: 0,
      lastSweepRows: 1,
    });
    expect(observer.status().backlogBytes).toBeGreaterThan(0);
    expect(observer.status().lastSweepBytes).toBeGreaterThan(0);
  });

  it('does not claim responded until matching task_complete follows the assistant item', async () => {
    const f = fixture();
    fs.appendFileSync(f.rollout,
      event('event_msg', { type: 'task_started', turn_id: 't5' }) + user('t5', f.envelope) + assistant('t5'));
    const observer = new CodexDeliveryObserver({
      store: f.store, hmacKey: KEY, resolveRolloutPath: () => f.rollout,
      resolveRolloutId: () => 'thread-1', capturePane: () => null, now: () => 1_000,
    });
    await observer.sweep();
    expect(f.store.get('59199', 'd1')?.transcriptState).toBe('consumed');
    fs.appendFileSync(f.rollout, complete('t5'));
    await observer.sweep();
    expect(f.store.get('59199', 'd1')?.transcriptState).toBe('responded');
  });

  it('coalesces sweeps, launches one four-capture window, and terminalizes 20 expired rows despite hung captures', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-observer-concurrency-'));
    dirs.push(dir);
    const rollout = path.join(dir, 'rollout.jsonl');
    fs.writeFileSync(rollout, JSON.stringify({ type: 'session_meta', payload: { id: 'shared' } }) + '\n');
    const baseline = fs.statSync(rollout).size;
    const store = InboundDeliveryStore.openMemory({ now: () => 0 });
    for (let index = 0; index < 20; index++) {
      const conversationId = `c${index}`;
      const deliveryId = `d${index}`;
      store.prepare({ conversationId, deliveryId, incarnation: `i${index}`, framework: 'codex-cli', envelope: `body${index}`, hmacKey: KEY });
      store.bindRolloutBaseline(conversationId, deliveryId, rollout, 'shared', baseline);
      store.transition(conversationId, deliveryId, 'prepared', 'dispatch-armed');
      store.transition(conversationId, deliveryId, 'dispatch-armed', 'dispatch-started');
      store.transition(conversationId, deliveryId, 'dispatch-started', 'dispatched');
    }
    let active = 0;
    let maximum = 0;
    let captures = 0;
    const observer = new CodexDeliveryObserver({
      store, hmacKey: KEY, resolveRolloutPath: () => rollout, resolveRolloutId: () => 'shared', capturePane: () => null,
      capturePaneAsync: async () => {
        captures += 1;
        active += 1;
        maximum = Math.max(maximum, active);
        return await new Promise<null>(() => undefined);
      },
      captureTimeoutMs: 5,
      now: () => 1_000_000,
    });
    const first = observer.sweep();
    const overlapping = observer.sweep();
    expect(overlapping).toBe(first);
    await first;
    expect(captures).toBe(4);
    expect(maximum).toBe(4);
    expect(store.status().deliveriesByState['effect-unknown']).toBe(20);
  });

  it('advances one durable rollout cursor and fans each event sequence to matching live deliveries', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-observer-fanout-'));
    dirs.push(dir);
    const rollout = path.join(dir, 'rollout.jsonl');
    fs.writeFileSync(rollout, JSON.stringify({ type: 'session_meta', payload: { id: 'fanout' } }) + '\n');
    const baseline = fs.statSync(rollout).size;
    const store = InboundDeliveryStore.openMemory();
    for (const [conversationId, deliveryId, envelope] of [['c1', 'd1', 'first'], ['c2', 'd2', 'second']]) {
      store.prepare({ conversationId, deliveryId, incarnation: conversationId, framework: 'codex-cli', envelope, hmacKey: KEY });
      store.bindRolloutBaseline(conversationId, deliveryId, rollout, 'fanout', baseline);
      store.transition(conversationId, deliveryId, 'prepared', 'dispatch-armed');
      store.transition(conversationId, deliveryId, 'dispatch-armed', 'dispatch-started');
      store.transition(conversationId, deliveryId, 'dispatch-started', 'dispatched');
    }
    const observer = new CodexDeliveryObserver({
      store, hmacKey: KEY, resolveRolloutPath: () => rollout,
      resolveRolloutId: () => 'fanout', capturePane: () => null,
    });
    fs.appendFileSync(rollout,
      event('event_msg', { type: 'task_started', turn_id: 'one' }) + user('one', 'first') + assistant('one') + complete('one'));
    await observer.sweep();
    expect(store.get('c1', 'd1')?.transcriptState).toBe('responded');
    expect(store.get('c2', 'd2')?.transcriptState).toBe('unseen');
    const afterFirst = store.rolloutWork()[0].observedOffset;

    fs.appendFileSync(rollout,
      event('event_msg', { type: 'task_started', turn_id: 'two' }) + user('two', 'second') + assistant('two') + complete('two'));
    await observer.sweep();
    expect(store.get('c2', 'd2')?.transcriptState).toBe('responded');
    expect(store.rolloutWork()).toHaveLength(0);
    expect(afterFirst).toBeGreaterThan(baseline);
  });

  it('terminalizes all actionable rows on unsupported rollout schema drift', async () => {
    const f = fixture();
    fs.appendFileSync(f.rollout, event('event_msg', { type: 'unrecognized_future_shape' }));
    await new CodexDeliveryObserver({
      store: f.store, hmacKey: KEY, resolveRolloutPath: () => f.rollout,
      resolveRolloutId: () => 'thread-1', capturePane: () => null,
    }).sweep();
    expect(f.store.get('59199', 'd1')).toMatchObject({ transcriptState: 'unknown', eligibilityState: 'unknown' });
  });

  it('advances an exact-newline byte-cap prefix and resumes the next chunk', async () => {
    const f = fixture();
    const cap = 4_096;
    const prefix = '{"type":"turn_context","payload":{"type":"turn_context","padding":"';
    const suffix = '"}}\n';
    const padding = 'x'.repeat(cap - Buffer.byteLength(prefix) - Buffer.byteLength(suffix));
    const exactChunk = `${prefix}${padding}${suffix}`;
    expect(Buffer.byteLength(exactChunk)).toBe(cap);
    fs.appendFileSync(f.rollout, exactChunk
      + event('event_msg', { type: 'task_started', turn_id: 'after-cap' })
      + user('after-cap', f.envelope) + assistant('after-cap') + complete('after-cap'));
    expect(scanSharedRollout(f.store.rolloutWork()[0], KEY, cap)).toMatchObject({
      kind: 'events', observedThrough: f.row.baselineOffset + cap,
    });
    const observer = new CodexDeliveryObserver({
      store: f.store, hmacKey: KEY, resolveRolloutPath: () => f.rollout,
      resolveRolloutId: () => 'thread-1', capturePane: () => null,
      maxBytesPerRow: cap, maxAggregateBytesPerSweep: cap, now: () => 1_000,
    });
    await observer.sweep();
    expect(f.store.get('59199', 'd1')).toMatchObject({ transcriptState: 'unseen', eligibilityState: 'open' });
    await observer.sweep();
    expect(f.store.get('59199', 'd1')?.transcriptState).toBe('responded');
  });

  it('advances the complete prefix when a byte cap lands mid-event', () => {
    const f = fixture();
    const cap = 4_096;
    const prefix = event('turn_context', { type: 'turn_context' });
    fs.appendFileSync(f.rollout,
      prefix
      + `{"type":"turn_context","payload":{"type":"turn_context","padding":"${'x'.repeat(cap)}"}}\n`);
    expect(scanSharedRollout(f.store.rolloutWork()[0], KEY, cap)).toMatchObject({
      kind: 'events', observedThrough: f.row.baselineOffset + Buffer.byteLength(prefix), bytesRead: cap,
    });
  });

  it('advances the complete prefix in the compatibility scanner when a byte cap lands mid-event', () => {
    const f = fixture();
    const cap = 4_096;
    const prefix = event('turn_context', { type: 'turn_context' });
    fs.appendFileSync(f.rollout,
      prefix
      + `{"type":"turn_context","payload":{"type":"turn_context","padding":"${'x'.repeat(cap)}"}}\n`);
    expect(scanRollout(f.row, f.rollout, KEY, cap)).toMatchObject({
      kind: 'unseen', observedThrough: f.row.baselineOffset + Buffer.byteLength(prefix), bytesRead: cap,
    });
  });

  it('converges a valid multi-budget rollout whose bounded reads end mid-event', async () => {
    const f = fixture();
    const cap = 1_024;
    const paddingEvent = event('turn_context', {
      type: 'turn_context', padding: 'x'.repeat(700),
    });
    fs.appendFileSync(f.rollout,
      paddingEvent + paddingEvent + paddingEvent
      + event('event_msg', { type: 'task_started', turn_id: 'after-backlog' })
      + user('after-backlog', f.envelope) + assistant('after-backlog') + complete('after-backlog'));
    const observer = new CodexDeliveryObserver({
      store: f.store, hmacKey: KEY, resolveRolloutPath: () => f.rollout,
      resolveRolloutId: () => 'thread-1', capturePane: () => null,
      maxBytesPerRow: cap, maxAggregateBytesPerSweep: cap, now: () => 1_000,
    });
    for (let index = 0; index < 6 && f.store.get('59199', 'd1')?.transcriptState !== 'responded'; index++) {
      await observer.sweep();
      expect(f.store.get('59199', 'd1')?.eligibilityState).toBe('open');
    }
    expect(f.store.get('59199', 'd1')?.transcriptState).toBe('responded');
  });

  it('fails closed at exact cap equality only when there is no complete boundary', () => {
    const cap = 4_096;
    const noNewline = fixture();
    fs.appendFileSync(noNewline.rollout, 'x'.repeat(cap));
    expect(scanSharedRollout(noNewline.store.rolloutWork()[0], KEY, cap))
      .toMatchObject({ kind: 'unknown', bytesRead: cap });

    const partialTail = fixture();
    const prefix = event('turn_context', { type: 'turn_context' });
    fs.appendFileSync(partialTail.rollout, prefix + 'x'.repeat(cap - Buffer.byteLength(prefix)));
    expect(fs.statSync(partialTail.rollout).size - partialTail.row.baselineOffset).toBe(cap);
    expect(scanSharedRollout(partialTail.store.rolloutWork()[0], KEY, cap))
      .toMatchObject({
        kind: 'events', observedThrough: partialTail.row.baselineOffset + Buffer.byteLength(prefix), bytesRead: cap,
      });
  });

  it('persists capped failure backoff across restart, notifies once, and resets after recovery', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-observer-backoff-'));
    dirs.push(dir);
    const rollout = path.join(dir, 'rollout.jsonl');
    fs.writeFileSync(rollout, JSON.stringify({ type: 'session_meta', payload: { id: 'backoff' } }) + '\n');
    let now = 1_000;
    let store = InboundDeliveryStore.open(dir, { now: () => now });
    const row = store.prepare({ conversationId: 'c', deliveryId: 'd', incarnation: 'i', framework: 'codex-cli', envelope: 'body', hmacKey: KEY });
    store.bindRolloutBaseline('c', 'd', rollout, 'backoff', fs.statSync(rollout).size);
    store.transition('c', 'd', 'prepared', 'dispatch-armed');
    store.transition('c', 'd', 'dispatch-armed', 'dispatch-started');
    store.transition('c', 'd', 'dispatch-started', 'dispatched');
    const brokenScan = () => { throw new Error('operational read failure'); };
    const notices: string[] = [];
    const make = () => new CodexDeliveryObserver({
      store, hmacKey: KEY, resolveRolloutPath: () => rollout, resolveRolloutId: () => 'backoff',
      capturePane: () => null, now: () => now, scanRolloutWorkForTesting: brokenScan,
      onSustainedFailure: ({ episodeId }) => notices.push(episodeId),
    });
    let observer = make();
    await observer.sweep();
    expect(store.observerWorkerStatus()).toMatchObject({ consecutiveFailures: 1, nextAttemptAt: 11_000 });
    now = 11_000;
    await observer.sweep();
    const episode = store.observerWorkerStatus().episodeId;
    store.close();
    store = InboundDeliveryStore.open(dir, { now: () => now });
    observer = make();
    expect(store.observerWorkerStatus()).toMatchObject({ consecutiveFailures: 2, episodeId: episode });
    now = 41_000;
    await observer.sweep();
    now = 131_000;
    await observer.sweep();
    expect(store.observerWorkerStatus()).toMatchObject({ consecutiveFailures: 4, notified: true, nextAttemptAt: 401_000 });
    expect(notices).toEqual([episode]);
    store.close();
    store = InboundDeliveryStore.open(dir, { now: () => now });
    const redelivered: string[] = [];
    const restartedBeforeAck = new CodexDeliveryObserver({
      store, hmacKey: KEY, resolveRolloutPath: () => rollout, resolveRolloutId: () => 'backoff',
      capturePane: () => null, now: () => now, scanRolloutWorkForTesting: brokenScan,
      onSustainedFailure: ({ episodeId }) => redelivered.push(episodeId),
    });
    await restartedBeforeAck.sweep();
    expect(redelivered).toEqual([episode]);
    expect(store.markObserverNoticeDelivered(episode!)).toBe(true);
    await restartedBeforeAck.sweep();
    expect(redelivered).toEqual([episode]);
    now = 401_000;
    const recovered = new CodexDeliveryObserver({
      store, hmacKey: KEY, resolveRolloutPath: () => rollout, resolveRolloutId: () => 'backoff',
      capturePane: () => null, now: () => now,
    });
    await recovered.sweep();
    expect(store.observerWorkerStatus()).toMatchObject({ consecutiveFailures: 0, nextAttemptAt: 0, notified: false });
    expect(store.observerAudit(10).map((entry) => entry.outcome)).toEqual(['success', 'failure', 'failure', 'failure', 'failure']);
    expect(store.get('c', row.deliveryId)?.eligibilityState).toBe('open');
    store.close();
  });

  it('rechecks the 25ms scheduling budget between synchronous rollout scans', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-observer-scan-budget-'));
    dirs.push(dir);
    const store = InboundDeliveryStore.openMemory({ now: () => 0 });
    for (let index = 0; index < 3; index++) {
      const rollout = path.join(dir, `rollout-${index}.jsonl`);
      fs.writeFileSync(rollout, JSON.stringify({ type: 'session_meta', payload: { id: `r${index}` } }) + '\n');
      const row = store.prepare({ conversationId: `c${index}`, deliveryId: `d${index}`, incarnation: `i${index}`, framework: 'codex-cli', envelope: `e${index}`, hmacKey: KEY });
      store.bindRolloutBaseline(`c${index}`, row.deliveryId, rollout, `r${index}`, fs.statSync(rollout).size);
      store.transition(`c${index}`, row.deliveryId, 'prepared', 'dispatch-armed');
      store.transition(`c${index}`, row.deliveryId, 'dispatch-armed', 'dispatch-started');
      store.transition(`c${index}`, row.deliveryId, 'dispatch-started', 'dispatched');
    }
    let clock = 0;
    let scans = 0;
    const observer = new CodexDeliveryObserver({
      store, hmacKey: KEY, resolveRolloutPath: () => null, resolveRolloutId: () => null,
      capturePane: () => null, now: () => clock,
      scanRolloutWorkForTesting: (work) => {
        scans += 1;
        clock += 30;
        return { kind: 'events', events: [], observedThrough: work.observedOffset, bytesRead: 1 };
      },
    });
    await observer.sweep();
    expect(scans).toBe(1);
    expect(observer.status().budgetExhaustionCount).toBe(1);
  });
});
