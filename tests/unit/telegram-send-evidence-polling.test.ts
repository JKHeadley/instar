import Database from 'better-sqlite3';
import { expect, it, vi } from 'vitest';
import { exactDirectTelegramPollingSend } from '../../src/threadline/directTelegramSendEvidence.js';
import { recordTelegramSendPollingEvidence } from '../../src/threadline/recordTelegramSendPollingEvidence.js';
import { TelegramSendEvidenceStore } from '../../src/threadline/TelegramSendEvidenceStore.js';

const botId = 248;
const ownerId = 75;
const original = {
  message_id: 15, message_thread_id: 42, is_topic_message: true,
  chat: { id: -10001, type: 'supergroup' },
  from: { id: ownerId, is_bot: false },
  date: 1795586730, text: `Send via Threadline to ${'a'.repeat(32)}:\nThe exact message.`,
};
const edit = { ...original, text: 'Ordinary chat now', edit_date: original.date + 1 };
const proof = exactDirectTelegramPollingSend(original, botId, ownerId)!;
const reference = proof.ownerMessageRef;
const digest = proof.ownerEvidenceDigest;

type Update = { id: number; message: unknown } | { id: number; edited_message: unknown };

// The fixture holds the cursor until the evidence helper returns.
function processBatch(updates: Update[], store: TelegramSendEvidenceStore, acknowledge: (id: number) => void) {
  for (const update of updates) {
    recordTelegramSendPollingEvidence(update, store, botId, ownerId);
    acknowledge(update.id);
  }
}

it('commits the capture and edit before acknowledging either update', () => {
  const db = new Database(':memory:');
  try {
    const store = new TelegramSendEvidenceStore(db);
    const acknowledged: Array<[number, boolean]> = [];
    processBatch([{ id: 1, message: original }, { id: 2, edited_message: edit }], store, id => {
      acknowledged.push([id, store.matches(reference, digest)]);
    });
    expect(acknowledged).toEqual([[1, true], [2, false]]);
  } finally {
    db.close();
  }
});

it('stops at an unrecorded edit and can replay it before acknowledging later updates', () => {
  const db = new Database(':memory:');
  try {
    const store = new TelegramSendEvidenceStore(db);
    const acknowledge = vi.fn();
    const pending = [{ id: 2, edited_message: edit }, { id: 3, message: original }];
    processBatch([{ id: 1, message: original }], store, acknowledge);
    const failOnce = vi.spyOn(store, 'invalidate').mockReturnValueOnce(false);
    expect(() => processBatch(pending, store, acknowledge)).toThrow('edit coverage unavailable');
    expect(acknowledge.mock.calls).toEqual([[1]]);
    expect(store.matches(reference, digest)).toBe(true);
    expect(failOnce).toHaveBeenCalledWith(reference);
    failOnce.mockRestore();
    processBatch(pending, store, acknowledge);
    expect(acknowledge.mock.calls).toEqual([[1], [2], [3]]);
    expect(store.matches(reference, digest)).toBe(false);
  } finally {
    db.close();
  }
});

it('does not acknowledge an edit with no usable coordinates', () => {
  const db = new Database(':memory:');
  try {
    const store = new TelegramSendEvidenceStore(db);
    const acknowledge = vi.fn();
    expect(() => processBatch([{ id: 1, edited_message: undefined }], store, acknowledge))
      .toThrow('edit coverage unavailable');
    expect(acknowledge).not.toHaveBeenCalled();
  } finally {
    db.close();
  }
});
