// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.
/**
 * Unit tests — SpendAlertDispatcher + TelegramSpendTopicChannel + the resolver's
 * pool-published rung 2 (routing-control-room-spend Increment C, §Surface 2
 * Alerts / FD-6 / S-F8 / G5).
 *
 * Pins: lane assignment (money-critical vs informational), dryRun-first default
 * (FD-16), informational coalescing into ONE digest, money-critical never
 * digested, edge latch on CONFIRMED delivery only (a transient failure stays
 * eligible), digest-failure un-latching, channel throw isolation, the durable
 * relay preference for money-critical kinds, lifeline fallback on ANY failure,
 * repoint audibility (G5), and the rung-2 pool half (inherit, adopt, publish;
 * degraded registry read falls through the FENCED create).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { SpendAlertDispatcher, MONEY_CRITICAL_KINDS, type SpendAlertKind } from '../../src/core/SpendAlertDispatcher.js';
import { TelegramSpendTopicChannel } from '../../src/core/TelegramSpendTopicChannel.js';
import { SpendAlertResolver } from '../../src/core/SpendAlertResolver.js';

let dir: string;
let clock: number;
const now = () => clock;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sad-'));
  clock = Date.parse('2026-07-08T12:00:00Z');
});
afterEach(() => {
  SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/spend-alert-dispatcher.test.ts' });
});

function mkChannel(over: Partial<ConstructorParameters<typeof TelegramSpendTopicChannel>[0]> = {}) {
  const sent: Array<{ topicId: number; text: string }> = [];
  const resolver = new SpendAlertResolver({
    configuredTopicId: () => 42,
    readPersistedTopicId: () => undefined,
    persistTopicId: () => {},
    servingLeaseConfirmedAgoMs: () => 0,
    createTopic: async () => 42,
    sendToTopic: async () => true,
    lifelineTopicId: () => 999,
    now,
  });
  const channel = new TelegramSpendTopicChannel({
    resolver,
    sendToTopic: async (topicId, text) => {
      sent.push({ topicId, text });
      return true;
    },
    lifelineTopicId: () => 999,
    ...over,
  });
  return { channel, sent };
}

function mkDispatcher(channelOver: Partial<ConstructorParameters<typeof TelegramSpendTopicChannel>[0]> = {}, dryRun = false) {
  const { channel, sent } = mkChannel(channelOver);
  const auditPath = path.join(dir, 'alerts.jsonl');
  const dispatcher = new SpendAlertDispatcher({ channels: [channel], dryRun, auditPath, digestWindowMs: 50, now });
  return { dispatcher, sent, auditPath };
}

const INFO = (key = 'k1'): { kind: SpendAlertKind; dedupeKey: string; text: string } => ({ kind: 'door-dark', dedupeKey: key, text: `notice ${key}` });
const MONEY = (key = 'm1'): { kind: SpendAlertKind; dedupeKey: string; text: string } => ({ kind: 'cap-hit', dedupeKey: key, text: `money ${key}` });

describe('SpendAlertDispatcher', () => {
  it('lane assignment: cap-hit + holder-dead are money-critical; the rest informational', () => {
    const { dispatcher } = mkDispatcher();
    for (const kind of MONEY_CRITICAL_KINDS) expect(dispatcher.laneOf(kind as SpendAlertKind)).toBe('money-critical');
    for (const kind of ['stale-price', 'observed-drift', 'cap-approach', 'door-dark', 'fallback-spike', 'recon-drift'] as const) {
      expect(dispatcher.laneOf(kind)).toBe('informational');
    }
  });

  it('dryRun is the DEFAULT (FD-16): decisions audited, nothing delivered, latch set for soak volume', async () => {
    const { channel, sent } = mkChannel();
    const auditPath = path.join(dir, 'dry.jsonl');
    const d = new SpendAlertDispatcher({ channels: [channel], auditPath, now }); // dryRun omitted → TRUE
    expect((await d.dispatch(MONEY())).decision).toBe('dry-run');
    expect((await d.dispatch(MONEY())).decision).toBe('suppressed'); // latched — soak measures post-dedup volume
    expect(sent).toHaveLength(0);
    const lines = fs.readFileSync(auditPath, 'utf-8').trim().split('\n').map((l) => JSON.parse(l));
    expect(lines[0].decision).toBe('dry-run');
    expect(lines[1].decision).toBe('suppressed');
  });

  it('informational alerts COALESCE into one digest message; money-critical send immediately', async () => {
    const { dispatcher, sent } = mkDispatcher();
    expect((await dispatcher.dispatch(INFO('a'))).decision).toBe('coalesced');
    expect((await dispatcher.dispatch(INFO('b'))).decision).toBe('coalesced');
    expect((await dispatcher.dispatch(MONEY())).decision).toBe('sent'); // immediate, never digested
    expect(sent).toHaveLength(1);
    await dispatcher.flushDigest();
    expect(sent).toHaveLength(2);
    expect(sent[1].text).toContain('digest (2 notices)');
    expect(sent[1].text).toContain('notice a');
    expect(sent[1].text).toContain('notice b');
  });

  it('a single-item digest window sends the bare text (no digest wrapper)', async () => {
    const { dispatcher, sent } = mkDispatcher();
    await dispatcher.dispatch(INFO('solo'));
    await dispatcher.flushDigest();
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toBe('notice solo');
  });

  it('edge latch: a CONFIRMED money-critical send suppresses repeats until the re-arm window', async () => {
    const { dispatcher, sent } = mkDispatcher();
    expect((await dispatcher.dispatch(MONEY())).decision).toBe('sent');
    expect((await dispatcher.dispatch(MONEY())).decision).toBe('suppressed');
    clock += 7 * 60 * 60 * 1000; // past the 6h money re-arm
    expect((await dispatcher.dispatch(MONEY())).decision).toBe('sent');
    expect(sent).toHaveLength(2);
  });

  it('a FAILED delivery does NOT latch — the alert stays eligible', async () => {
    const { dispatcher, sent } = mkDispatcher({
      sendToTopic: async () => {
        throw new Error('telegram down');
      },
      lifelineTopicId: () => undefined,
    });
    expect((await dispatcher.dispatch(MONEY())).decision).toBe('failed');
    expect((await dispatcher.dispatch(MONEY())).decision).toBe('failed'); // NOT suppressed
    expect(sent).toHaveLength(0);
  });

  it('a failed DIGEST flush un-latches the digested keys (they retry next occurrence)', async () => {
    let fail = true;
    const { dispatcher, sent } = mkDispatcher({
      sendToTopic: async (topicId, text) => {
        if (fail) throw new Error('down');
        sent.push({ topicId, text });
        return true;
      },
      lifelineTopicId: () => undefined,
    });
    // note: mkDispatcher's own sent capture is bypassed by the override above
    await dispatcher.dispatch(INFO('x'));
    await dispatcher.flushDigest(); // fails → un-latched
    fail = false;
    expect((await dispatcher.dispatch(INFO('x'))).decision).toBe('coalesced'); // eligible again
    await dispatcher.flushDigest();
  });

  it('one channel throwing never breaks dispatch (channel isolation)', async () => {
    const { channel, sent } = mkChannel();
    const bad = { id: 'bad', deliver: async () => { throw new Error('boom'); } };
    const d = new SpendAlertDispatcher({ channels: [bad, channel], dryRun: false, now });
    expect((await d.dispatch(MONEY())).decision).toBe('sent');
    expect(sent).toHaveLength(1);
  });
});

describe('TelegramSpendTopicChannel', () => {
  it('money-critical prefers the DURABLE relay; informational sends direct', async () => {
    const enqueued: number[] = [];
    const { channel, sent } = mkChannel({ enqueueDurable: (topicId) => { enqueued.push(topicId); return true; } });
    expect(await channel.deliver('critical', true)).toBe('queued-durable');
    expect(enqueued).toEqual([42]);
    expect(await channel.deliver('info', false)).toBe('sent');
    expect(sent).toHaveLength(1);
  });

  it('falls back to the LIFELINE on a dead dedicated topic (a set-but-wrong id is not a black hole)', async () => {
    const calls: number[] = [];
    const { channel } = mkChannel({
      sendToTopic: async (topicId) => {
        calls.push(topicId);
        if (topicId === 42) throw new Error('topic deleted');
        return true;
      },
    });
    expect(await channel.deliver('x', false)).toBe('sent-lifeline');
    expect(calls).toEqual([42, 999]);
  });

  it('G5 repoint audibility: a CHANGED configured id announces into BOTH topics', async () => {
    let configured = 42;
    const sent: Array<{ topicId: number; text: string }> = [];
    const resolver = new SpendAlertResolver({
      configuredTopicId: () => configured,
      readPersistedTopicId: () => undefined,
      persistTopicId: () => {},
      servingLeaseConfirmedAgoMs: () => 0,
      createTopic: async () => 1,
      sendToTopic: async () => true,
      lifelineTopicId: () => 999,
      now,
    });
    const channel = new TelegramSpendTopicChannel({
      resolver,
      sendToTopic: async (topicId, text) => {
        sent.push({ topicId, text });
        return true;
      },
      lifelineTopicId: () => 999,
    });
    await channel.deliver('first', false); // observes 42 — no announcement
    configured = 77; // a Bearer-level PATCH repointed the knob
    await channel.deliver('second', false);
    const repoints = sent.filter((s) => s.text.includes('Spend alerts now route to'));
    expect(repoints.map((r) => r.topicId).sort()).toEqual([42, 77]);
  });
});

describe('SpendAlertResolver — rung 2 pool half (FD-6)', () => {
  function deps(over: Partial<ConstructorParameters<typeof SpendAlertResolver>[0]> = {}) {
    return {
      configuredTopicId: () => undefined as number | undefined,
      readPersistedTopicId: () => undefined as number | undefined,
      persistTopicId: () => {},
      servingLeaseConfirmedAgoMs: () => 0 as number | null,
      createTopic: async () => 500,
      sendToTopic: async () => true,
      lifelineTopicId: () => 999 as number | undefined,
      now,
      ...over,
    };
  }

  it('a POOL-PUBLISHED id is inherited (never re-created) and adopted locally', async () => {
    let created = 0;
    let persisted: number | undefined;
    const r = new SpendAlertResolver(deps({
      readPoolPublishedTopicId: () => 314,
      persistTopicId: (id) => { persisted = id; },
      createTopic: async () => { created++; return 1; },
    }));
    expect(await r.resolveTopicId()).toBe(314);
    expect(created).toBe(0); // inheritance, never a duplicate mint
    expect(persisted).toBe(314); // adopted locally for disk-fast resolves
  });

  it('a created id is PUBLISHED pool-wide (peers + future holders inherit)', async () => {
    let published: number | undefined;
    const r = new SpendAlertResolver(deps({ publishTopicId: (id) => { published = id; } }));
    expect(await r.resolveTopicId()).toBe(500);
    expect(published).toBe(500);
  });

  it('a DEGRADED registry read falls through the ladder — creation stays lease-fenced', async () => {
    let created = 0;
    const r = new SpendAlertResolver(deps({
      readPoolPublishedTopicId: () => { throw new Error('registry unreadable'); },
      servingLeaseConfirmedAgoMs: () => null, // not the holder
      createTopic: async () => { created++; return 1; },
    }));
    expect(await r.resolveTopicId()).toBeUndefined(); // → lifeline, never a possible duplicate
    expect(created).toBe(0);
  });

  it('a failed publish leaves the machine-local record authoritative (no throw)', async () => {
    let persisted: number | undefined;
    const r = new SpendAlertResolver(deps({
      persistTopicId: (id) => { persisted = id; },
      publishTopicId: () => { throw new Error('no registry entry'); },
    }));
    expect(await r.resolveTopicId()).toBe(500);
    expect(persisted).toBe(500);
  });
});
