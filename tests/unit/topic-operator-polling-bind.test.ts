/**
 * Unit tests — polling-path topic-operator auto-bind (Know Your Principal,
 * Phase-1 increment 2e).
 *
 * The `onTopicMessage` seam wired by `wireTelegramRouting` is the convergence
 * BOTH ingress paths reach (lifeline-forward AND server-polling). Increment 2d
 * (#909) binds the verified operator on the lifeline-forward route only; this
 * increment binds at the seam so the no-lifeline polling path is covered too.
 * The bind MUST re-check `isAuthorizedSender` — the lifeline path fires this
 * callback for unauthorized senders as well (it only skips its own bind), so
 * an unchecked seam bind would re-open the cross-principal "Caroline" bug.
 *
 * Messages here are slash-commands with a handleCommand that reports handled,
 * so the callback early-returns right after the bind block — the session
 * routing tail never runs and needs no stubbing.
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
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'topop2e-')); });
afterEach(() => { SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/topic-operator-polling-bind.test.ts' }); });

/** Minimal fake adapter: captures the wired onTopicMessage and exposes the
 *  two methods the bind path touches. Cast via unknown — the callback only
 *  reaches handleCommand/isAuthorizedSender on the slash-command path. */
function makeAdapter(authorized: (id: number | string) => boolean) {
  const calls: { handleCommand: number } = { handleCommand: 0 };
  const adapter = {
    onTopicMessage: null as null | ((msg: Message) => Promise<void> | void),
    handleCommand: async () => { calls.handleCommand += 1; return true; },
    isAuthorizedSender: authorized,
  };
  return { adapter: adapter as unknown as TelegramAdapter, raw: adapter, calls };
}

function makeMessage(opts: { uid?: number; firstName?: string; topicId?: number; text?: string }): Message {
  return {
    id: 'tg-1',
    userId: String(opts.uid ?? 0),
    content: opts.text ?? '/status',
    channel: { type: 'telegram', identifier: String(opts.topicId ?? 19437) },
    receivedAt: '2026-06-06T00:00:00Z',
    metadata: {
      telegramUserId: opts.uid,
      firstName: opts.firstName,
      messageThreadId: opts.topicId ?? 19437,
    },
  } as Message;
}

describe('polling-path operator auto-bind (increment 2e)', () => {
  it('binds an AUTHORIZED sender as the verified operator', async () => {
    const store = new TopicOperatorStore(dir);
    const { adapter, raw } = makeAdapter(() => true);
    wireTelegramRouting(adapter, {} as SessionManager, undefined, undefined, undefined, undefined, undefined, () => store);

    await raw.onTopicMessage!(makeMessage({ uid: 7812716706, firstName: 'Justin' }));

    const op = store.getOperator(19437);
    expect(op?.uid).toBe('7812716706');
    expect(op?.names).toEqual(['justin']);
    expect(op?.boundFrom).toBe('authenticated-inbound');
  });

  it('does NOT bind an UNAUTHORIZED sender — the Caroline invariant at the seam', async () => {
    const store = new TopicOperatorStore(dir);
    const { adapter, raw } = makeAdapter(() => false);
    wireTelegramRouting(adapter, {} as SessionManager, undefined, undefined, undefined, undefined, undefined, () => store);

    await raw.onTopicMessage!(makeMessage({ uid: 999, firstName: 'Caroline' }));

    expect(store.getOperator(19437)).toBeNull();
  });

  it('no store available (getter returns null) → no-op, routing continues', async () => {
    const { adapter, raw, calls } = makeAdapter(() => true);
    wireTelegramRouting(adapter, {} as SessionManager, undefined, undefined, undefined, undefined, undefined, () => null);

    await raw.onTopicMessage!(makeMessage({ uid: 7812716706 }));

    expect(calls.handleCommand).toBe(1); // reached the slash-command handler
  });

  it('getter THROWS → caught, routing continues (fail-soft)', async () => {
    const { adapter, raw, calls } = makeAdapter(() => true);
    wireTelegramRouting(adapter, {} as SessionManager, undefined, undefined, undefined, undefined, undefined, () => { throw new Error('boom'); });

    await raw.onTopicMessage!(makeMessage({ uid: 7812716706 }));

    expect(calls.handleCommand).toBe(1);
  });

  it('store.setOperator THROWS → caught, routing continues (fail-soft)', async () => {
    const { adapter, raw, calls } = makeAdapter(() => true);
    const broken = { setOperator: () => { throw new Error('disk full'); } } as unknown as TopicOperatorStore;
    wireTelegramRouting(adapter, {} as SessionManager, undefined, undefined, undefined, undefined, undefined, () => broken);

    await raw.onTopicMessage!(makeMessage({ uid: 7812716706 }));

    expect(calls.handleCommand).toBe(1);
  });

  it('missing telegramUserId → no bind even with a permissive authorizer', async () => {
    const store = new TopicOperatorStore(dir);
    const { adapter, raw } = makeAdapter(() => true);
    wireTelegramRouting(adapter, {} as SessionManager, undefined, undefined, undefined, undefined, undefined, () => store);

    await raw.onTopicMessage!(makeMessage({ uid: undefined }));

    expect(store.getOperator(19437)).toBeNull();
  });
});
