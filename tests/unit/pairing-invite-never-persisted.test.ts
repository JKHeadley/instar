/**
 * A pairing invite carries a one-time secret (docs/specs/a2a-pairing-invite-link.md §6.1):
 * the lifeline's disk queue refuses it, and the direct-polling Telegram path never routes or
 * logs it (it points the owner at the dashboard instead).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { MessageQueue } from '../../src/lifeline/MessageQueue.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { TelegramAdapter } from '../../src/messaging/TelegramAdapter.js';
import { createInvite, inviteMessage, findInviteToken } from '../../src/threadline/PairingInvite.js';

const INVITE = inviteMessage(createInvite({ identityPubHex: crypto.randomBytes(32).toString('hex'), owner: 'Justin', agent: 'Scout' }));
let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'invite-never-persisted-')); });
afterEach(() => { SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/pairing-invite-never-persisted.test.ts' }); });

const qmsg = (id: string, text: string) => ({ id, topicId: 1, text, fromUserId: 1, fromFirstName: 'Op', timestamp: new Date().toISOString() });

describe('pairing invites are never persisted', () => {
  it('the lifeline queue refuses a message carrying an invite and writes nothing', () => {
    const q = new MessageQueue(dir);
    expect(q.enqueue(qmsg('tg-1', `Fwd: ${INVITE}`))).toBe(false);
    expect(q.enqueue(qmsg('tg-2', 'an ordinary message'))).toBe(true);
    const onDisk = fs.readFileSync(path.join(dir, 'lifeline-queue.json'), 'utf8');
    expect(onDisk).not.toContain(findInviteToken(INVITE)!.slice(7));
    expect(onDisk).toContain('an ordinary message');
  });

  it('the direct-polling adapter neither routes nor logs an invite', async () => {
    const adapter = new TelegramAdapter({ token: '', chatId: '-1001', authorizedUserIds: [4242] } as never, dir);
    const routed: string[] = [];
    adapter.onTopicMessage = (m: { content: string }) => { routed.push(m.content); };
    const update = (text: string, id: number) => ({
      update_id: id,
      message: { message_id: id, message_thread_id: 77, date: Math.floor(Date.now() / 1000), text, from: { id: 4242, first_name: 'Op', username: 'op' }, chat: { id: -1001, type: 'supergroup' } },
    });
    const proc = (adapter as unknown as { processUpdate(u: unknown): Promise<void> }).processUpdate.bind(adapter);
    await proc(update(`Fwd: ${INVITE}`, 1));
    expect(routed).toEqual([]);
    const token = findInviteToken(INVITE)!.slice(7);
    const walk = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);
    for (const f of walk(dir)) expect(fs.readFileSync(f, 'utf8')).not.toContain(token);
  });

  describe('a polling agent (no lifeline) with the pairing handler wired (PP, 2026-10-21)', () => {
    const mk = () => {
      const adapter = new TelegramAdapter({ token: '', chatId: '-1001', authorizedUserIds: [4242] } as never, dir);
      const routed: string[] = [];
      adapter.onTopicMessage = (m: { content: string }) => { routed.push(m.content); };
      const calls: Array<{ kind: string; arg: Record<string, unknown> }> = [];
      adapter.setPairingHandler({
        onForwardedInvite: async (m) => { calls.push({ kind: 'invite', arg: m as never }); },
        onCallback: async (c) => { calls.push({ kind: 'tap', arg: c as never }); return true; },
      });
      const proc = (adapter as unknown as { processUpdate(u: unknown): Promise<void> }).processUpdate.bind(adapter);
      return { adapter, routed, calls, proc };
    };
    const msg = (text: string, id: number, from = 4242) => ({
      update_id: id,
      message: { message_id: id, message_thread_id: 77, date: Math.floor(Date.now() / 1000), text, from: { id: from, first_name: 'Op', username: 'op' }, chat: { id: -1001, type: 'supergroup' } },
    });
    it('an authorized forward goes to the handler as read-from-Telegram, never to a session', async () => {
      const { routed, calls, proc } = mk();
      await proc(msg(`Fwd: ${INVITE}`, 1));
      expect(routed).toEqual([]);
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({ kind: 'invite', arg: { topicId: 77, fromUserId: 4242, chatId: '-1001', verified: true } });
    });
    it('an unauthorized sender still gets nothing, and the handler is not called', async () => {
      const { routed, calls, proc } = mk();
      await proc(msg(`Fwd: ${INVITE}`, 2, 999));
      expect(routed).toEqual([]);
      expect(calls).toEqual([]);
    });
    it('a pairing tap goes to the handler with the tapper and chat', async () => {
      const { calls, proc } = mk();
      await proc({ update_id: 3, callback_query: { id: 'cq-1', data: 'pi:abc', from: { id: 4242, first_name: 'Op' }, message: { message_id: 9, chat: { id: -1001, type: 'supergroup' } } } });
      expect(calls).toEqual([{ kind: 'tap', arg: { callbackQueryId: 'cq-1', data: 'pi:abc', fromUserId: 4242, chatId: '-1001', verified: true } }]);
    });
    it('if the handler throws, the owner still gets a reply (the dashboard line), never silence', async () => {
      const adapter = new TelegramAdapter({ token: '', chatId: '-1001', authorizedUserIds: [4242] } as never, dir);
      const sent: Array<{ topicId: number; text: string }> = [];
      (adapter as unknown as { sendToTopic: (t: number, x: string) => Promise<unknown> }).sendToTopic = async (topicId, text) => { sent.push({ topicId, text }); return {}; };
      adapter.setPairingHandler({ onForwardedInvite: async () => { throw new Error('boom'); }, onCallback: async () => true });
      const proc = (adapter as unknown as { processUpdate(u: unknown): Promise<void> }).processUpdate.bind(adapter);
      await proc(msg(`Fwd: ${INVITE}`, 5));
      await new Promise((r) => setTimeout(r, 0));
      expect(sent).toHaveLength(1);
      expect(sent[0]).toMatchObject({ topicId: 77 });
      expect(sent[0].text).toMatch(/Threadline tab on the dashboard/);
    });
    it('without a handler the old behaviour stands (the adapter is inert for pairing)', async () => {
      const adapter = new TelegramAdapter({ token: '', chatId: '-1001', authorizedUserIds: [4242] } as never, dir);
      expect(adapter.hasPairingHandler()).toBe(false);
    });
  });
});
