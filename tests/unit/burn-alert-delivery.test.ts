import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

import {
  BurnAlertDelivery,
  isTerminalBurnAlertTopicError,
  type BurnAttentionInput,
} from '../../src/monitoring/BurnAlertDelivery.js';

const dirs: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) {
    SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'burn-alert-delivery test cleanup' });
  }
});

function stateFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'burn-alert-delivery-'));
  dirs.push(dir);
  return path.join(dir, 'state', 'burn-alert-delivery.json');
}

describe('BurnAlertDelivery terminal-state invariant', () => {
  it('recognises the real deleted-topic Telegram fixture as terminal', () => {
    expect(isTerminalBurnAlertTopicError(
      new Error('Telegram API error (400): Bad Request: message thread not found'),
    )).toBe(true);
    expect(isTerminalBurnAlertTopicError(new Error('ETIMEDOUT'))).toBe(false);
  });

  it('quarantines a gone destination, persists it, and raises one durable notice carrying the alert', async () => {
    const file = stateFile();
    const sent: number[] = [];
    const attention: BurnAttentionInput[] = [];
    const delivery = new BurnAlertDelivery({
      stateFile: file,
      now: () => Date.parse('2026-07-16T20:00:00Z'),
      sendToTopic: async (topicId) => {
        sent.push(topicId);
        throw new Error('Telegram API error (400): Bad Request: message thread not found');
      },
      raiseAttention: async (item) => { attention.push(item); },
      log: () => {},
    });

    await delivery.deliver(8615, 'InputDetector is burning tokens');

    expect(sent).toEqual([8615]);
    expect(attention).toHaveLength(1);
    expect(attention[0]).toMatchObject({
      id: 'burn-alert-topic-terminal-8615',
      priority: 'HIGH',
      description: 'InputDetector is burning tokens',
    });
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toMatchObject({
      version: 1,
      topicId: 8615,
      terminalAt: '2026-07-16T20:00:00.000Z',
    });
  });

  it('does not retry the quarantined topic after restart and dedupes identical rerouted alerts', async () => {
    const file = stateFile();
    const attention: BurnAttentionInput[] = [];
    const failedSend = vi.fn(async () => {
      throw new Error('Bad Request: message thread not found');
    });
    const raiseAttention = vi.fn(async (item: BurnAttentionInput) => { attention.push(item); });

    await new BurnAlertDelivery({ stateFile: file, sendToTopic: failedSend, raiseAttention, log: () => {} })
      .deliver(8615, 'same burn alert');

    const sendAfterRestart = vi.fn(async () => undefined);
    const restarted = new BurnAlertDelivery({ stateFile: file, sendToTopic: sendAfterRestart, raiseAttention, log: () => {} });
    await restarted.deliver(8615, 'same burn alert');
    await restarted.deliver(8615, 'same burn alert');

    expect(failedSend).toHaveBeenCalledTimes(1);
    expect(sendAfterRestart).not.toHaveBeenCalled();
    expect(attention.slice(1).map((item) => item.id)).toEqual([
      attention[1].id,
      attention[1].id,
    ]);
  });

  it('retains the original alert until Attention accepts custody, then clears the pending handoff', async () => {
    const file = stateFile();
    const send = vi.fn(async () => { throw new Error('message thread not found'); });
    const failingAttention = vi.fn(async () => { throw new Error('attention store unavailable'); });
    const first = new BurnAlertDelivery({ stateFile: file, sendToTopic: send, raiseAttention: failingAttention, log: () => {} });

    await expect(first.deliver(8615, 'original alert must survive')).rejects.toThrow('attention store unavailable');
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).pendingNotice.description).toBe('original alert must survive');

    const recovered: BurnAttentionInput[] = [];
    const sendAfterRestart = vi.fn(async () => undefined);
    const restarted = new BurnAlertDelivery({
      stateFile: file,
      sendToTopic: sendAfterRestart,
      raiseAttention: async (item) => { recovered.push(item); },
      log: () => {},
    });
    await restarted.recoverPending();

    expect(sendAfterRestart).not.toHaveBeenCalled();
    expect(recovered[0].description).toBe('original alert must survive');
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).pendingNotice).toBeUndefined();
  });

  it('uses the durable Attention notice as a restart witness when state persistence failed', async () => {
    const file = stateFile();
    const attentionIds = new Set<string>();
    const rename = vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => { throw new Error('read-only state dir'); });
    const firstSend = vi.fn(async () => { throw new Error('message thread not found'); });
    const first = new BurnAlertDelivery({
      stateFile: file,
      sendToTopic: firstSend,
      raiseAttention: async (item) => { attentionIds.add(item.id); },
      log: () => {},
    });
    await first.deliver(8615, 'alert retained by Attention');
    rename.mockRestore();

    const restartedSend = vi.fn(async () => undefined);
    const restarted = new BurnAlertDelivery({
      stateFile: file,
      sendToTopic: restartedSend,
      raiseAttention: async (item) => { attentionIds.add(item.id); },
      hasAttentionItem: (id) => attentionIds.has(id),
      log: () => {},
    });
    await restarted.deliver(8615, 'next alert');

    expect(firstSend).toHaveBeenCalledTimes(1);
    expect(restartedSend).not.toHaveBeenCalled();
  });

  it('fails closed on corrupt terminal state instead of reopening the dead topic', () => {
    const file = stateFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{not-json');
    expect(() => new BurnAlertDelivery({
      stateFile: file,
      sendToTopic: async () => undefined,
      raiseAttention: async () => undefined,
    })).toThrow(/Cannot load burn-alert terminal state/);
  });

  it('leaves transient failures retryable and does not create a misleading terminal notice', async () => {
    const file = stateFile();
    const send = vi.fn()
      .mockRejectedValueOnce(new Error('ETIMEDOUT'))
      .mockResolvedValueOnce(undefined);
    const raiseAttention = vi.fn(async () => undefined);
    const delivery = new BurnAlertDelivery({ stateFile: file, sendToTopic: send, raiseAttention, log: () => {} });

    await delivery.deliver(8615, 'alert');
    await delivery.deliver(8615, 'alert');

    expect(send).toHaveBeenCalledTimes(2);
    expect(raiseAttention).not.toHaveBeenCalled();
    expect(fs.existsSync(file)).toBe(false);
  });

  it('tries a newly configured topic even when the old topic is quarantined', async () => {
    const file = stateFile();
    const first = new BurnAlertDelivery({
      stateFile: file,
      sendToTopic: async () => { throw new Error('topic deleted'); },
      raiseAttention: async () => undefined,
      log: () => {},
    });
    await first.deliver(8615, 'old destination');

    const send = vi.fn(async () => undefined);
    const restarted = new BurnAlertDelivery({ stateFile: file, sendToTopic: send, raiseAttention: async () => undefined });
    await restarted.deliver(9001, 'new destination');
    expect(send).toHaveBeenCalledWith(9001, 'new destination');
  });

  it('changed configuration recovers despite an old pending Attention handoff', async () => {
    const file = stateFile();
    const first = new BurnAlertDelivery({
      stateFile: file,
      sendToTopic: async () => { throw new Error('message thread not found'); },
      raiseAttention: async () => { throw new Error('attention unavailable'); },
      log: () => {},
    });
    await expect(first.deliver(8615, 'retained original')).rejects.toThrow('attention unavailable');

    const sent: Array<{ topic: number; text: string }> = [];
    const restarted = new BurnAlertDelivery({
      stateFile: file,
      sendToTopic: async (topic, text) => { sent.push({ topic, text }); },
      raiseAttention: async () => { throw new Error('attention still unavailable'); },
      log: () => {},
    });
    await restarted.deliver(9001, 'current alert');

    expect(sent).toEqual([
      { topic: 9001, text: 'retained original' },
      { topic: 9001, text: 'current alert' },
    ]);
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).pendingNotice).toBeUndefined();
  });

  it('preserves the old pending alert when the newly configured topic is also gone', async () => {
    const file = stateFile();
    const unavailableAttention = async () => { throw new Error('attention unavailable'); };
    const first = new BurnAlertDelivery({
      stateFile: file,
      sendToTopic: async () => { throw new Error('message thread not found'); },
      raiseAttention: unavailableAttention,
      log: () => {},
    });
    await expect(first.deliver(8615, 'original from old topic')).rejects.toThrow();

    const restarted = new BurnAlertDelivery({
      stateFile: file,
      sendToTopic: async () => { throw new Error('message thread not found'); },
      raiseAttention: unavailableAttention,
      log: () => {},
    });
    await expect(restarted.deliver(9001, 'current from new topic')).rejects.toThrow();

    const persisted = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(persisted.topicId).toBe(9001);
    expect(persisted.pendingNotice.description).toContain('original from old topic');
    expect(persisted.pendingNotice.description).toContain('current from new topic');
  });
});
