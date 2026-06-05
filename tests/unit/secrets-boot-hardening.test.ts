/**
 * Tier-1 tests for the v1.3.270 boot-crash hardening — CONSUMER-SIDE guards.
 *
 * Scope note: the config-layer fix (per-agent keychain master key, verify-decrypt
 * precedence, loud merge failure + critical-placeholder fail-fast) is a SEPARATE
 * converged spec (docs/specs/keychain-per-agent-master-key.md) built in a parallel
 * session. THIS file covers the consumer-side guards that hold regardless of WHY
 * an unresolved `{ secret: true }` placeholder reaches the messaging layer:
 *   1. TelegramAdapter constructor — a placeholder token NORMALIZES to the
 *      well-defined tokenless state (never a truthy object downstream).
 *   2. TelegramAdapter.start() — refuses to long-poll without a usable token
 *      (fatalReason surfaced via getStatus) instead of 404-zombie-looping;
 *      a real token still starts polling.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TelegramAdapter } from '../../src/messaging/TelegramAdapter.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

describe('TelegramAdapter — placeholder-token normalization + poll refusal', () => {
  let tmpDir: string;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-boot-hard-'));
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    warnSpy.mockRestore();
    errorSpy.mockRestore();
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/unit/secrets-boot-hardening.test.ts' });
  });

  it('constructor NORMALIZES a `{ secret: true }` placeholder token to tokenless — loudly, no throw', () => {
    const adapter = new TelegramAdapter({
      token: { secret: true } as unknown as string,
      chatId: '-100123456',
    }, tmpDir);
    // The truthy-object can never flow downstream: status shows a clean stopped state.
    expect(adapter.getStatus().started).toBe(false);
    expect(warnSpy.mock.calls.some((c) => String(c[0]).includes('TOKENLESS'))).toBe(true);
  });

  it('start() REFUSES to long-poll without a usable token (no 404 zombie) and surfaces the reason', async () => {
    const adapter = new TelegramAdapter({
      token: { secret: true } as unknown as string,
      chatId: '-100123456',
    }, tmpDir);
    await adapter.start();
    const status = adapter.getStatus();
    expect(status.started).toBe(false); // polling never began
    expect(status.fatalReason).toBe('no-usable-bot-token');
    expect(errorSpy.mock.calls.some((c) => String(c[0]).includes('NOT starting long-polling'))).toBe(true);
    await adapter.stop();
  });

  it('start() with an EMPTY string token also refuses (both sides of the normalize path)', async () => {
    const adapter = new TelegramAdapter({ token: '', chatId: '-100123456' }, tmpDir);
    await adapter.start();
    expect(adapter.getStatus().started).toBe(false);
    expect(adapter.getStatus().fatalReason).toBe('no-usable-bot-token');
    await adapter.stop();
  });

  it('a REAL string token still starts polling (the healthy path is untouched)', async () => {
    const adapter = new TelegramAdapter({
      token: 'test-token-123',
      chatId: '-100123456',
      pollIntervalMs: 50,
    }, tmpDir);
    // Stub the network so the poll loop runs without real HTTP.
    (adapter as unknown as { getUpdates: () => Promise<unknown[]> }).getUpdates = async () => [];
    (adapter as unknown as { ensureLifelineTopic: () => Promise<void> }).ensureLifelineTopic = async () => {};
    await adapter.start();
    expect(adapter.getStatus().started).toBe(true);
    expect(adapter.getStatus().fatalReason).toBeNull();
    await adapter.stop();
  });
});
