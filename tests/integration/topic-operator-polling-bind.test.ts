/**
 * Integration tests — polling-path operator auto-bind (Know Your Principal,
 * Phase-1 increment 2e) with the REAL TopicOperatorStore + REAL PrincipalGuard
 * establishOperator under the wired seam.
 *
 * Covers the cross-increment invariants the unit tier can't: the Caroline
 * replay through the full bind path, the single-store-instance no-clobber
 * guarantee (the reason the seam resolves the SERVER'S store late-bound
 * instead of constructing its own), and the pre-construction lifecycle
 * (messages arriving before the AgentServer exists bind nothing, fail-safe).
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
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'topop2e-int-')); });
afterEach(() => { SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/integration/topic-operator-polling-bind.test.ts' }); });

const OPERATOR_UID = 7812716706;

function makeAdapter(authorizedUids: Array<number | string>) {
  const adapter = {
    onTopicMessage: null as null | ((msg: Message) => Promise<void> | void),
    handleCommand: async () => true,
    isAuthorizedSender: (id: number | string) => authorizedUids.map(String).includes(String(id)),
  };
  return { adapter: adapter as unknown as TelegramAdapter, raw: adapter };
}

function inbound(uid: number, firstName: string, topicId = 19437): Message {
  return {
    id: `tg-${uid}`,
    userId: String(uid),
    content: '/status',
    channel: { type: 'telegram', identifier: String(topicId) },
    receivedAt: '2026-06-06T00:00:00Z',
    metadata: { telegramUserId: uid, firstName, messageThreadId: topicId },
  } as Message;
}

describe('increment 2e — polling-path bind, integration', () => {
  it('CAROLINE REPLAY: the authorized operator binds; an unauthorized "Caroline" in the same topic cannot displace them', async () => {
    const store = new TopicOperatorStore(dir);
    const { adapter, raw } = makeAdapter([OPERATOR_UID]);
    wireTelegramRouting(adapter, {} as SessionManager, undefined, undefined, undefined, undefined, undefined, () => store);

    await raw.onTopicMessage!(inbound(OPERATOR_UID, 'Justin'));
    expect(store.getOperator(19437)?.names).toEqual(['justin']);

    // The unauthorized party — her name appears in content metadata, but the
    // authenticated uid is not authorized, so the binding must not move.
    await raw.onTopicMessage!(inbound(999, 'Caroline'));
    const op = store.getOperator(19437);
    expect(op?.uid).toBe(String(OPERATOR_UID));
    expect(op?.names).toEqual(['justin']);
  });

  it('single-instance no-clobber: a seam bind never loses a record written through the same store', async () => {
    const store = new TopicOperatorStore(dir);
    // Pre-existing binding made through the server's instance (e.g. the
    // POST /topic-operator route or the lifeline auto-bind).
    store.setOperator(111, { platform: 'telegram', uid: '555', displayName: 'Alice' });

    const { adapter, raw } = makeAdapter([OPERATOR_UID]);
    wireTelegramRouting(adapter, {} as SessionManager, undefined, undefined, undefined, undefined, undefined, () => store);
    await raw.onTopicMessage!(inbound(OPERATOR_UID, 'Justin', 222));

    // Both bindings coexist — nothing clobbered.
    expect(store.getOperator(111)?.uid).toBe('555');
    expect(store.getOperator(222)?.uid).toBe(String(OPERATOR_UID));
    // And the durable file carries both.
    const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'topic-operators.json'), 'utf-8'));
    expect(Object.keys(onDisk).sort()).toEqual(['111', '222']);
  });

  it('pre-construction lifecycle: messages before the server exists bind nothing (fail-safe); after late-bind resolution they bind', async () => {
    const store = new TopicOperatorStore(dir);
    let serverReady = false; // mirrors _agentServerRef being null until construction
    const { adapter, raw } = makeAdapter([OPERATOR_UID]);
    wireTelegramRouting(adapter, {} as SessionManager, undefined, undefined, undefined, undefined, undefined,
      () => (serverReady ? store : null));

    await raw.onTopicMessage!(inbound(OPERATOR_UID, 'Justin'));
    expect(store.getOperator(19437)).toBeNull(); // fail-safe: no binding yet

    serverReady = true;
    await raw.onTopicMessage!(inbound(OPERATOR_UID, 'Justin'));
    expect(store.getOperator(19437)?.uid).toBe(String(OPERATOR_UID));
  });
});
