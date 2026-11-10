// safe-fs-allow: test file — temp dirs via mkdtemp/rm only.
// safe-git-allow: test file — no git calls.
/**
 * context-budget-layered-summaries §14 / §6.1 — the channel-neutral row writer
 * against REAL components, wired the way server.ts wires them:
 *  - Slack: a real SlackAdapter's inbound path (`_handleMessage`) logs each
 *    message; its `onMessageLogged` feeds `writeSlackLogRow` into a real
 *    TopicMemory. Two messages in one channel land as two rows keyed ts × 1e6,
 *    and the operator's Slack id maps to their UserManager person (§6.1).
 *  - App conversations: a real AppConversationStore's append observer feeds
 *    `writeAppConversationRow` (alias from a real ConversationRegistry) — local
 *    and replicated events alike — behind the context-budget switch.
 *  - Fold precondition: a real FoldCoordinator built by buildFoldCoordinator
 *    with the writer's hasRowSource refuses `no-row-source` for a channel with
 *    no writer on, and passes that check for one that has it.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { TopicMemory } from '../../src/memory/TopicMemory.js';
import { TopicRowWriter, writeAppConversationRow, writeSlackLogRow } from '../../src/memory/topicRowWriter.js';
import { SlackAdapter } from '../../src/messaging/slack/SlackAdapter.js';
import { UserManager } from '../../src/users/UserManager.js';
import { SlackPrincipalResolver } from '../../src/permissions/SlackPrincipalResolver.js';
import { AppConversationStore } from '../../src/core/AppConversationStore.js';
import { ConversationRegistry } from '../../src/core/ConversationRegistry.js';
import { candidateIdForRoutingKey } from '../../src/core/conversationIdentity.js';
import { buildFoldCoordinator } from '../../src/monitoring/foldCoordinatorBoot.js';

const OP = 'tests/integration/topic-row-writer-channels.test.ts';
const OPERATOR_SLACK = 'U0OPERATOR1';
const STRANGER_SLACK = 'U0STRANGER1';
const CHANNEL = 'D0OPERATORDM';

describe('row writer × real channels × real TopicMemory', () => {
  let dir: string;
  let tm: TopicMemory;
  let appOn: boolean;
  let writer: TopicRowWriter;
  let refusals: string[];

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'row-writer-int-'));
    tm = new TopicMemory(dir);
    await tm.open();
    appOn = true;
    refusals = [];
    writer = new TopicRowWriter({
      topicMemory: () => tm,
      channelEnabled: (ch) => ch === 'app' ? appOn : true,
      reportRefusal: (e) => refusals.push(`${e.channel}:${e.refused}:${e.detail}`),
    });
  });
  afterEach(() => {
    tm.close();
    SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: OP });
  });

  it('Slack: two inbound messages in one channel are two rows, and the operator is bound to their person', async () => {
    const users = new UserManager(dir, [{
      id: 'u-justin', name: 'Justin', channels: [{ type: 'slack', identifier: OPERATOR_SLACK }],
      permissions: ['admin'], preferences: {}, slackUserId: OPERATOR_SLACK,
    } as never]);
    const resolver = new SlackPrincipalResolver(users);
    const adapter = new SlackAdapter({
      botToken: 'xoxb-test', appToken: 'xapp-test',
      authorizedUserIds: [OPERATOR_SLACK, STRANGER_SLACK], workspaceMode: 'dedicated',
    } as never, dir);
    adapter.onMessage(async () => {});
    const topicId = candidateIdForRoutingKey(CHANNEL);
    adapter.onMessageLogged = (entry) => {
      writeSlackLogRow(writer, entry, {
        topicIdFor: (ch) => candidateIdForRoutingKey(ch),
        resolveUserId: (id) => resolver.resolve(id).userId,
      });
    };
    const handle = (adapter as never as { _handleMessage: (e: Record<string, unknown>) => Promise<void> })._handleMessage.bind(adapter);
    await handle({ user: OPERATOR_SLACK, text: 'first ask', channel: CHANNEL, ts: '1762800000.000100' });
    await handle({ user: OPERATOR_SLACK, text: 'second ask', channel: CHANNEL, ts: '1762800005.000200' });
    await handle({ user: STRANGER_SLACK, text: 'someone else', channel: CHANNEL, ts: '1762800009.000300' });

    const rows = tm.getRecentMessages(topicId, 10);
    expect(rows.map((r) => r.text)).toEqual(['first ask', 'second ask', 'someone else']);
    expect(rows.map((r) => r.messageId)).toEqual([1_762_800_000_000_100, 1_762_800_005_000_200, 1_762_800_009_000_300]);
    expect(rows.map((r) => r.channelMessageId)).toEqual(['1762800000.000100', '1762800005.000200', '1762800009.000300']);
    // §6.1: user_id names the operator's person; an unregistered sender stores none.
    expect(rows.map((r) => r.userId ?? null)).toEqual(['u-justin', 'u-justin', null]);
    expect(rows.every((r) => r.fromUser)).toBe(true);
    expect(refusals).toEqual([]);
    expect(writer.hasRowSource(topicId)).toBe(true);
  });

  it('app conversations: local and replicated messages land as rows under the alias, gated by the switch', () => {
    const registry = new ConversationRegistry({ stateDir: dir, machineId: () => 'm1', isRecordingEnabled: () => true } as never);
    registry.load();
    const store = new AppConversationStore({ stateDir: dir, machineId: () => 'm1' });
    store.addAppendListener((ev) => {
      if (ev.kind !== 'message' && ev.kind !== 'media-message') return;
      if (!writer.channelOn('app')) return;
      writeAppConversationRow(writer, ev, { aliasFor: (k) => registry.appAliasFor(k), ownerUserId: () => 'u-owner' });
    });
    const KEY = '0a1b2c3d-4e5f-4061-8273-94a5b6c7d8e9';
    const minted = registry.mintAppAlias(KEY);
    expect(minted.ok).toBe(true);
    const alias = (minted as { id: number }).id;
    const base = { kind: 'message' as const, conversationKey: KEY, machineId: 'm1' };

    store.append({ ...base, eventId: 'ev-1', messageId: 'm-1', role: 'operator', text: 'start the build', at: '2026-11-10T01:00:00.000Z' });
    store.append({ ...base, eventId: 'ev-2', messageId: 'm-2', role: 'agent', text: 'on it', at: '2026-11-10T01:00:01.000Z' });
    store.ingestReplicated({ ...base, eventId: 'ev-3', messageId: 'm-3', role: 'operator', text: 'from the other machine', at: '2026-11-10T01:00:02.000Z', machineId: 'm2' });
    appOn = false;
    store.append({ ...base, eventId: 'ev-4', messageId: 'm-4', role: 'operator', text: 'switch is off', at: '2026-11-10T01:00:03.000Z' });

    const rows = tm.getRecentMessages(alias, 10);
    expect(rows.map((r) => [r.text, r.fromUser, r.userId ?? null, r.channelMessageId])).toEqual([
      ['start the build', true, 'u-owner', 'ev-1'],
      ['on it', false, null, 'ev-2'],
      ['from the other machine', true, 'u-owner', 'ev-3'],
    ]);
    expect(new Set(rows.map((r) => r.messageId)).size).toBe(3);
    expect(writer.hasRowSource(alias)).toBe(false);
    appOn = true;
    expect(writer.hasRowSource(alias)).toBe(true);
  });

  it('the fold refuses no-row-source for a channel without a writer on, and passes that check otherwise', () => {
    const appAlias = -(2 ** 33) - 5;
    appOn = false;
    const { coordinator } = buildFoldCoordinator({
      stateDir: dir,
      runningTopicSessions: () => [{ topicKey: String(appAlias) }, { topicKey: '141133' }],
      poolPlacementLive: () => false,
      inboundQueueLive: () => true,
      topicRowsPresent: () => true,
      sentinelHeartbeatFresh: () => false,
      layerKindPresent: () => true,
      hasRowSource: (id) => writer.hasRowSource(id),
    });
    expect(coordinator.begin(String(appAlias))).toEqual({ ok: false, reason: 'no-row-source' });
    // Telegram has a writer: the fold gets past the row-source check to the next precondition.
    expect(coordinator.begin('141133')).toEqual({ ok: false, reason: 'no-sentinel' });
    appOn = true;
    expect(coordinator.begin(String(appAlias))).toEqual({ ok: false, reason: 'no-sentinel' });
  });
});
