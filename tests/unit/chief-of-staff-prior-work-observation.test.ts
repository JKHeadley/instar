import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { TelegramAdapter } from '../../src/messaging/TelegramAdapter.js';
import { ChiefOfStaffPrSearch } from '../../src/core/ChiefOfStaffPrSearch.js';
import { ChiefOfStaffPriorWorkObservation } from '../../src/core/ChiefOfStaffPriorWorkObservation.js';

const turn = {
  topicId: 42, senderId: 9, replay: false, agentAuthored: false,
  text: 'Why do we not have instar.sh addresses yet? private-value-in-turn',
};
const row = {
  number: 3342, title: 'Permanent agent links', body: 'Design for instar.sh',
  headRefName: 'topic/agent-links', baseRefName: 'main', state: 'OPEN' as const,
  updatedAt: '2026-11-23T00:00:00.000Z', mergedAt: null,
};

function fixture(hold?: Promise<void>) {
  let enabled = true;
  let owner = 9;
  const fetchPage = vi.fn(async (_token: string, state: string) => {
    await hold;
    return { repository: { isPrivate: false, pullRequests: {
      nodes: state === 'OPEN' ? [row] : [], pageInfo: { hasNextPage: false, endCursor: null },
    } } };
  });
  const provider = new ChiefOfStaffPrSearch({ readToken: () => 'test-only-provider-token', fetchPage });
  const report = vi.fn();
  const observer = new ChiefOfStaffPriorWorkObservation({
    enabled: () => enabled, chiefOfStaffTopic: () => 42, owner: () => owner, lookup: provider, report,
  });
  return { observer, provider, report, fetchPage, disable: () => { enabled = false; }, changeOwner: () => { owner = 10; } };
}

describe('Chief of Staff prior-work shadow observation', () => {
  it('keeps the delivery synchronous and shares a provider cache with a later ordinary lookup', async () => {
    const f = fixture();
    f.observer.observe(turn);
    expect(f.fetchPage).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(f.report.mock.calls).toEqual([['matched']]));
    await expect(f.provider.search('#3342')).resolves.toMatchObject({ items: [{ number: 3342 }] });
    expect(f.fetchPage).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(f.fetchPage.mock.calls)).not.toMatch(/instar\.sh|private-value-in-turn/);
    expect(JSON.stringify(f.report.mock.calls)).not.toMatch(/3342|instar\.sh|private-value-in-turn/);
  });

  it('ignores wrong principals, other topics, replays, agent-authored messages and bare prose', async () => {
    const f = fixture();
    for (const patch of [{ senderId: 10 }, { senderId: 0 }, { topicId: 44 },
      { replay: true }, { agentAuthored: true }, { text: 'An ordinary greeting' }]) {
      f.observer.observe({ ...turn, ...patch });
    }
    f.disable();
    f.observer.observe(turn);
    await new Promise<void>(resolve => { setImmediate(resolve); });
    expect(f.fetchPage).not.toHaveBeenCalled();
    expect(f.report).not.toHaveBeenCalled();
  });

  it('bounds concurrent observations and drops the result after owner authority changes', async () => {
    let release!: () => void;
    const hold = new Promise<void>(resolve => { release = resolve; });
    const f = fixture(hold);
    f.observer.observe(turn);
    f.observer.observe(turn);
    expect(f.report.mock.calls).toEqual([['busy']]);
    try {
      await vi.waitFor(() => expect(f.fetchPage).toHaveBeenCalledTimes(2));
      f.changeOwner();
    } finally { release(); }
    await f.provider.search('#3342');
    await new Promise<void>(resolve => { setImmediate(resolve); });
    expect(f.report).toHaveBeenCalledTimes(1);
  });

  it('contains provider or reporting faults without throwing into delivery', async () => {
    const report = vi.fn(() => { throw new Error('local report failure'); });
    const observer = new ChiefOfStaffPriorWorkObservation({
      enabled: () => true, chiefOfStaffTopic: () => 42, owner: () => 9,
      lookup: { search: async () => { throw new Error('provider rejected'); } }, report,
    });
    expect(() => observer.observe(turn)).not.toThrow();
    await vi.waitFor(() => expect(report.mock.calls).toEqual([['unavailable']]));
  });
});

it('requires direct plain text provenance from the actual Telegram poller path', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-observation-poll-'));
  const adapter = new TelegramAdapter({
    token: '', chatId: '-1001', authorizedUserIds: [9],
  } as never, dir, { suppressLifelineAutoCreate: true });
  const poller = adapter as unknown as { processUpdate(update: unknown): Promise<void> };
  const received = vi.fn();
  adapter.onTopicMessage = received;
  const send = async (id: number, fields: Record<string, unknown> = {}) => poller.processUpdate({
    update_id: id,
    message: {
      message_id: id, from: { id: 9, first_name: 'Owner' }, chat: { id: -1001, type: 'supergroup' },
      date: 1, message_thread_id: 42, text: 'Where is instar.sh addressed?', ...fields,
    },
  });
  try {
    await send(900);
    await send(901, { forward_origin: { type: 'hidden_user', sender_user_name: 'Example', date: 1 } });
    await send(902, { via_bot: { id: 89, is_bot: true, first_name: 'Bot' } });
    expect(received).toHaveBeenCalledTimes(3);
    expect(received.mock.calls.map(([event]) => event.metadata.telegramDirectPlainText)).toEqual([true, false, false]);
  } finally {
    await adapter.stop();
    SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/chief-of-staff-prior-work-observation.test.ts' });
  }
});
