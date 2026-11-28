import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { TelegramAdapter } from '../../src/messaging/TelegramAdapter.js';
import { CommitmentTracker } from '../../src/monitoring/CommitmentTracker.js';
import { telegramInjectionFailureFixture } from '../helpers/telegramInjectionFailureFixture.js';
import type { Message } from '../../src/core/types.js';

let f: ReturnType<typeof telegramInjectionFailureFixture> | undefined;
afterEach(async () => { await f?.close(); f = undefined; vi.restoreAllMocks(); });

describe('Telegram injection failure production composition', () => {
  it('retains the refusal and agent-owned obligation after store reload, without a physical dispatch or a binding', async () => {
    f = telegramInjectionFailureFixture();
    const message = { id: 'tg-157', userId: '777', content: 'private earlier-unknown message',
      channel: { type: 'telegram', identifier: '41' }, receivedAt: new Date().toISOString(),
      metadata: { messageThreadId: 41, telegramUserId: 777, firstName: 'Fixture', replay: true } } as Message;
    // Same callback that server polling and send-only/lifeline composition use.
    expect(await f.telegram.onTopicMessage!(message)).toEqual({ refused: true });
    expect(f.effect).not.toHaveBeenCalled();
    expect(f.manager.inboundDeliveryStatus()).toMatchObject({ logicalRows: 0 });
    expect(f.project.state.listSessions()[0].claudeSessionId).toBeUndefined();
    const reloaded = new CommitmentTracker({ stateDir: f.project.stateDir });
    expect(reloaded.getActive()).toHaveLength(1);
    expect(reloaded.getActive()[0]).toMatchObject({ owner: 'agent', topicId: 41, sourceConversationKey: 'telegram:41', sourceMessageId: '157', status: 'pending' });
    const adapter = new TelegramAdapter({ token: '123:synthetic-n80', chatId: '-100123' }, f.project.stateDir);
    expect(adapter.getAttentionItems()).toHaveLength(1);
    expect(adapter.getAttentionItems()[0].summary).toContain('cannot confirm whether an earlier attempt delivered');
    expect(f.notices[0]).toContain('cannot confirm whether an earlier attempt delivered');
    expect(f.notices[0]).not.toContain('message was not delivered');
    expect(fs.readFileSync(path.join(process.cwd(), 'src/commands/server.ts'), 'utf8').match(/\(\) => commitmentTracker \?\? null/g)).toHaveLength(2);
    // An acknowledgement is not a delivery receipt and cannot discharge the obligation.
    const item = f.telegram.getAttentionItems()[0];
    expect(item.status).toBe('OPEN');
    expect(reloaded.getActive()[0].status).toBe('pending');
    await adapter.stop();
  });
});
