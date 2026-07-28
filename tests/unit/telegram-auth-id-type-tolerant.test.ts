import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TelegramAdapter } from '../../src/messaging/TelegramAdapter.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

/**
 * Regression: the legacy (non-shared-AuthGate) auth path used
 * `authorizedUserIds.includes(userId)`. The field is typed `number[]`, but
 * config JSON is untyped at runtime, so an operator (or an onboarding agent)
 * can write the id as a string. `includes` uses SameValueZero (no coercion),
 * so a string-configured id silently failed to match the numeric userId and
 * the authorized user was treated as unknown (hit the registration gate).
 *
 * Surfaced live while Codey onboarded the Gemini mentee onto Telegram: it
 * wrote `authorizedUserIds` as a string and Gemini rejected the owner as an
 * unknown user. The fix makes the comparison type-tolerant.
 */
describe('TelegramAdapter authorizedUserIds — type-tolerant auth', () => {
  const dirs: string[] = [];

  function makeAdapter(authorizedUserIds: unknown): TelegramAdapter {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-tg-auth-'));
    dirs.push(tmpDir);
    return new TelegramAdapter(
      {
        token: 'test-token-123',
        chatId: '-100123456',
        pollIntervalMs: 100,
        // Intentionally pass through whatever the test supplies (string,
        // number, mixed) to mirror untyped config JSON.
        authorizedUserIds: authorizedUserIds as number[],
      },
      tmpDir,
    );
  }

  afterEach(() => {
    for (const d of dirs.splice(0)) {
      SafeFsExecutor.safeRmSync(d, {
        recursive: true,
        force: true,
        operation: 'tests/unit/telegram-auth-id-type-tolerant.test.ts',
      });
    }
  });

  it('authorizes a numeric userId when config holds the id as a number', () => {
    const adapter = makeAdapter([7812716706]);
    expect((adapter as any).isAuthorized(7812716706)).toBe(true);
  });

  it('authorizes a numeric userId when config holds the id as a STRING (the bug)', () => {
    const adapter = makeAdapter(['7812716706']);
    // Before the fix this returned false (string !== number under includes),
    // silently locking out the authorized user.
    expect((adapter as any).isAuthorized(7812716706)).toBe(true);
  });

  it('authorizes from a MIXED string/number authorized list', () => {
    const adapter = makeAdapter(['7812716706', 42]);
    expect((adapter as any).isAuthorized(7812716706)).toBe(true);
    expect((adapter as any).isAuthorized(42)).toBe(true);
  });

  it('rejects an unauthorized id regardless of config id type', () => {
    expect((makeAdapter(['7812716706']) as any).isAuthorized(999)).toBe(false);
    expect((makeAdapter([7812716706]) as any).isAuthorized(999)).toBe(false);
  });

  it('accepts all when authorizedUserIds is empty or absent (open, unchanged)', () => {
    expect((makeAdapter([]) as any).isAuthorized(999)).toBe(true);
    expect((makeAdapter(undefined) as any).isAuthorized(999)).toBe(true);
  });
});
