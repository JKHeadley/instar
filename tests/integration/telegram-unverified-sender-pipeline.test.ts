/**
 * Integration — the REAL message pipeline (`wireTelegramRouting`, the seam both
 * Telegram ingress paths converge on) refuses authority to an inbound that the
 * lifeline-secret gate accepted WITHOUT proof of the lifeline
 * (docs/specs/telegram-internal-route-lifeline-secret.md §Sender not trusted).
 *
 * The forward route already removes the sender id for such a request; these
 * tests pin the second line of defence: even if an id reached this seam on a
 * message flagged `senderUnverified`, the pipeline must not seat an operator
 * from it, and must hand command authority a sender id of 0.
 *
 * Real TopicOperatorStore, real wireTelegramRouting (the
 * topic-operator-polling-bind.test.ts harness).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { wireTelegramRouting } from '../../src/commands/server.js';
import { TopicOperatorStore } from '../../src/users/TopicOperatorStore.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import type { TelegramAdapter } from '../../src/messaging/TelegramAdapter.js';
import type { SessionManager } from '../../src/core/SessionManager.js';
import type { Message } from '../../src/core/types.js';

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'unverified-sender-')); });
afterEach(() => { SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/integration/telegram-unverified-sender-pipeline.test.ts' }); });

const OPERATOR_UID = 7812716706;
const TOPIC = 19437;

function makeAdapter() {
  const commandCalls: Array<{ text: string; uid: unknown }> = [];
  const adapter = {
    onTopicMessage: null as null | ((msg: Message) => Promise<void> | void),
    handleCommand: async (text: string, _topicId: number, uid: unknown) => { commandCalls.push({ text, uid }); return true; },
    isAuthorizedSender: (id: number | string) => String(id) === String(OPERATOR_UID),
  };
  return { adapter: adapter as unknown as TelegramAdapter, raw: adapter, commandCalls };
}

function inbound(metadata: Record<string, unknown>): Message {
  return {
    id: 'tg-1',
    userId: String(metadata.telegramUserId ?? 'unknown'),
    content: '/status',
    channel: { type: 'telegram', identifier: String(TOPIC) },
    receivedAt: '2026-10-12T00:00:00Z',
    metadata: { messageThreadId: TOPIC, ...metadata },
  } as Message;
}

describe('message pipeline — an unverified sender carries no authority', () => {
  it('control: a normal inbound from the authorized operator binds and is passed to commands with its id', async () => {
    const store = new TopicOperatorStore(dir);
    const { adapter, raw, commandCalls } = makeAdapter();
    wireTelegramRouting(adapter, {} as SessionManager, undefined, undefined, undefined, undefined, undefined, () => store);

    await raw.onTopicMessage!(inbound({ telegramUserId: OPERATOR_UID, firstName: 'Justin' }));
    expect(store.getOperator(TOPIC)?.uid).toBe(String(OPERATOR_UID));
    expect(commandCalls).toEqual([{ text: '/status', uid: OPERATOR_UID }]);
  });

  it('an inbound flagged senderUnverified binds NO operator, even carrying the operator\'s id', async () => {
    const store = new TopicOperatorStore(dir);
    const { adapter, raw } = makeAdapter();
    wireTelegramRouting(adapter, {} as SessionManager, undefined, undefined, undefined, undefined, undefined, () => store);

    await raw.onTopicMessage!(inbound({ telegramUserId: OPERATOR_UID, firstName: 'Justin', senderUnverified: true }));
    expect(store.getOperator(TOPIC)).toBeNull();
  });

  it('…and command authority receives sender id 0, not the claimed id', async () => {
    const store = new TopicOperatorStore(dir);
    const { adapter, raw, commandCalls } = makeAdapter();
    wireTelegramRouting(adapter, {} as SessionManager, undefined, undefined, undefined, undefined, undefined, () => store);

    await raw.onTopicMessage!(inbound({ telegramUserId: OPERATOR_UID, senderUnverified: true }));
    expect(commandCalls).toEqual([{ text: '/status', uid: 0 }]);
  });

  it('what the forward route actually sends for an unverified request (no id at all) also binds nothing', async () => {
    const store = new TopicOperatorStore(dir);
    const { adapter, raw, commandCalls } = makeAdapter();
    wireTelegramRouting(adapter, {} as SessionManager, undefined, undefined, undefined, undefined, undefined, () => store);

    await raw.onTopicMessage!(inbound({ telegramUserId: undefined, firstName: 'Unverified sender', senderUnverified: true }));
    expect(store.getOperator(TOPIC)).toBeNull();
    expect(commandCalls[0].uid).toBe(0);
  });

  it('an unverified inbound cannot displace an operator who is already bound', async () => {
    const store = new TopicOperatorStore(dir);
    const { adapter, raw } = makeAdapter();
    wireTelegramRouting(adapter, {} as SessionManager, undefined, undefined, undefined, undefined, undefined, () => store);

    await raw.onTopicMessage!(inbound({ telegramUserId: OPERATOR_UID, firstName: 'Justin' }));
    await raw.onTopicMessage!(inbound({ telegramUserId: 999, firstName: 'Mallory', senderUnverified: true }));
    expect(store.getOperator(TOPIC)?.uid).toBe(String(OPERATOR_UID));
  });
});
