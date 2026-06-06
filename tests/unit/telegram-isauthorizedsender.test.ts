import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TelegramAdapter } from '../../src/messaging/TelegramAdapter.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

/**
 * Unit tests — TelegramAdapter.isAuthorizedSender (Know Your Principal #898,
 * increment 2d). The public wrapper the lifeline-forward route uses to decide
 * whether an inbound sender is an authorized operator BEFORE binding them as the
 * topic operator. Covers both sides of the boundary + number/string ids + the
 * blank/non-numeric guard + the no-allowlist trust model.
 */
describe('TelegramAdapter.isAuthorizedSender', () => {
  const dirs: string[] = [];

  function makeAdapter(authorizedUserIds: unknown): TelegramAdapter {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-tg-authsender-'));
    dirs.push(tmpDir);
    return new TelegramAdapter(
      { token: 'test-token-123', chatId: '-100123456', pollIntervalMs: 100, authorizedUserIds: authorizedUserIds as number[] },
      tmpDir,
    );
  }

  afterEach(() => {
    for (const d of dirs.splice(0)) {
      SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/unit/telegram-isauthorizedsender.test.ts' });
    }
  });

  it('authorizes a sender in the allowlist (number id, number config)', () => {
    expect(makeAdapter([7812716706]).isAuthorizedSender(7812716706)).toBe(true);
  });

  it('authorizes a sender whose id the route carries as a STRING (the route\'s shape)', () => {
    // The lifeline-forward route holds fromUserId; it may arrive numeric or string.
    expect(makeAdapter([7812716706]).isAuthorizedSender('7812716706')).toBe(true);
    expect(makeAdapter(['7812716706']).isAuthorizedSender('7812716706')).toBe(true);
  });

  it('REJECTS an unauthorized sender — they must never become the operator', () => {
    expect(makeAdapter([7812716706]).isAuthorizedSender(999)).toBe(false);
    expect(makeAdapter(['7812716706']).isAuthorizedSender('999')).toBe(false);
  });

  it('returns false for a blank / non-numeric id (no operator from garbage)', () => {
    const a = makeAdapter([7812716706]);
    expect(a.isAuthorizedSender('')).toBe(false);
    expect(a.isAuthorizedSender('   ')).toBe(false);
    expect(a.isAuthorizedSender('not-a-number')).toBe(false);
  });

  it('accepts any authenticated sender when no allowlist is configured (existing trust model)', () => {
    expect(makeAdapter([]).isAuthorizedSender(999)).toBe(true);
    expect(makeAdapter(undefined).isAuthorizedSender('12345')).toBe(true);
  });
});
