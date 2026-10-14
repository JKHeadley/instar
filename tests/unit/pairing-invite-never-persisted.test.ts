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
});
