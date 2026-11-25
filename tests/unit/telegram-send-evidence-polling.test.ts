import Database from 'better-sqlite3';
import { expect, it, vi } from 'vitest';
import {
  editedTelegramMessageReference,
  exactDirectTelegramPollingSend,
} from '../../src/threadline/directTelegramSendEvidence.js';
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

type Update = { id: number; original: unknown } | { id: number; edit: unknown };

// Models the disposable direct poller. The live adapter is deliberately absent.
function processBatch(updates: Update[], store: TelegramSendEvidenceStore, acknowledge: (id: number) => void) {
  for (const update of updates) {
    if ('edit' in update) {
      const edited = editedTelegramMessageReference(update.edit, botId);
      if (!edited || !store.invalidate(edited)) throw new Error('edit coverage unavailable');
    } else {
      const captured = exactDirectTelegramPollingSend(update.original, botId, ownerId);
      if (captured && store.capture(captured.ownerMessageRef, captured.ownerEvidenceDigest) === 'refused') {
        throw new Error('capture unavailable');
      }
    }
    acknowledge(update.id);
  }
}

it('commits the capture and edit before acknowledging either update', () => {
  const db = new Database(':memory:');
  try {
    const store = new TelegramSendEvidenceStore(db);
    const acknowledged: Array<[number, boolean]> = [];
    processBatch([{ id: 1, original }, { id: 2, edit }], store, id => {
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
    const pending = [{ id: 2, edit }, { id: 3, original }];
    processBatch([{ id: 1, original }], store, acknowledge);
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
