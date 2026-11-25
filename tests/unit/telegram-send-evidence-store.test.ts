import Database from 'better-sqlite3';
import { expect, it } from 'vitest';
import { TelegramSendEvidenceStore } from '../../src/threadline/TelegramSendEvidenceStore.js';

it('records an exact digest once and permanently refuses conflicting copies', () => {
  const db = new Database(':memory:');
  try {
    const writer = new TelegramSendEvidenceStore(db);
    const reader = new TelegramSendEvidenceStore(db);
    const reference = 'telegram:248:-10001:42:15';
    const original = 'a'.repeat(64);
    const conflicting = 'b'.repeat(64);

    expect(writer.capture('telegram:unverified:1:2:3', original)).toBe('refused');
    expect(writer.capture(reference, 'malformed')).toBe('refused');
    db.transaction(() => {
      expect(writer.capture(reference, original)).toBe('refused');
      expect(reader.matches(reference, original)).toBe(false);
    })();
    expect(writer.capture(reference, original)).toBe('recorded');
    expect(reader.matches(reference, original)).toBe(true);
    expect(writer.capture(reference, original)).toBe('duplicate');
    expect(reader.matches(reference, conflicting)).toBe(false);
    expect(writer.capture(reference, conflicting)).toBe('conflict');
    expect(reader.matches(reference, original)).toBe(false);
    expect(reader.matches(reference, conflicting)).toBe(false);
    expect(writer.capture(reference, original)).toBe('conflict');
  } finally {
    db.close();
  }
});
