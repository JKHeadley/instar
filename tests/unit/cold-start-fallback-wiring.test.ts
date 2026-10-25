/**
 * Wiring-integrity guard for the G1 cold-start lifeline fallback reply
 * ("The Agent Is Always Reachable", corollary 2: no silent resource rejection).
 *
 * A pure builder that compiles but is never called is the "shipped inert" failure
 * mode this repo keeps hitting (see rate-limit-recovery-wiring.test.ts). This asserts
 * server.ts actually wires `buildColdStartFallbackReply` into BOTH inbound
 * session-start failure paths — the cold spawn AND the restart — delivers it on the
 * DETERMINISTIC path (sendToTopic, never the LLM tone gate), resolves the real
 * Lifeline topic id, and that the old jargon-leaking message is gone.
 */
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { wireTelegramRouting } from '../../src/commands/server.js';
import * as replies from '../../src/messaging/ColdStartFallbackReply.js';
import * as deterministicOrigin from '../../src/messaging/telegram-origin/OriginDeterministicSend.js';
import type { TelegramAdapter } from '../../src/messaging/TelegramAdapter.js';
import type { SessionManager } from '../../src/core/SessionManager.js';
import type { Message } from '../../src/core/types.js';

// Exercise real inbound routing without rendering identity shadows into this checkout.
vi.mock('../../src/core/IdentityRenderer.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/core/IdentityRenderer.js')>(),
  ensureFrameworkIdentityFile: vi.fn(() => null),
}));
const fixture = vi.hoisted(() => ({ inboundDir: '' }));
vi.mock('../../src/messaging/shared/telegramInboundFiles.js', () => ({
  getTelegramInboundDir: () => {
    if (!fixture.inboundDir) throw new Error('test inbound fixture is not active');
    return fixture.inboundDir;
  },
}));
beforeEach(() => { fixture.inboundDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-cold-start-notice-')); });
afterEach(async () => {
  // Routing assertions await the terminal spawn/notice boundary; drain its
  // remaining promise continuations before removing only this test's files.
  await new Promise<void>(resolve => setImmediate(resolve));
  vi.restoreAllMocks();
  const directory = fixture.inboundDir; fixture.inboundDir = '';
  SafeFsExecutor.safeRmSync(directory, { recursive: true, force: true, operation: 'test:instar-cold-start-notice-inbound-cleanup' });
  expect(fs.existsSync(directory)).toBe(false);
});

const SERVER_SRC = fs.readFileSync(path.join(process.cwd(), 'src/commands/server.ts'), 'utf-8');

describe('G1 cold-start fallback — wiring integrity', () => {
  it('imports the builder from the messaging module', () => {
    expect(SERVER_SRC).toContain("import { buildColdStartFallbackReply } from '../messaging/ColdStartFallbackReply.js'");
  });

  it('wires the builder into BOTH inbound failure paths (spawn + restart)', () => {
    const calls = SERVER_SRC.match(/buildColdStartFallbackReply\(/g) || [];
    // One in the cold-spawn catch, one in the restart catch.
    expect(calls.length).toBeGreaterThanOrEqual(2);
  });

  it('resolves the REAL Lifeline topic id (not a hardcoded/no-op)', () => {
    expect(SERVER_SRC).toMatch(/lifelineTopicId:\s*telegram\.getLifelineTopicId\(\)/);
  });

  it('passes both kinds so the wording matches the failure', () => {
    expect(SERVER_SRC).toMatch(/kind:\s*'spawn'/);
    expect(SERVER_SRC).toMatch(/kind:\s*'restart'/);
  });

  it.each(['spawn', 'restart'] as const)('delivers the real %s fallback through its origin producer with the builder output', async kind => {
    const failure = new Error('Session limit (3) reached');
    const builder = vi.spyOn(replies, 'buildColdStartFallbackReply');
    const deterministicSend = vi.spyOn(deterministicOrigin, 'sendDeterministicTelegramNotice');
    const spawnInteractiveSession = vi.fn(async () => { throw failure; });
    const rawAdapter = {
      onTopicMessage: null as null | ((message: Message) => Promise<void>),
      isAuthorizedSender: () => true, handleCommand: async () => false,
      getTopicName: () => 'Reachable discussion', resolveTopicName: async () => 'Reachable discussion',
      getSessionForTopic: () => kind === 'restart' ? 'dead-session' : null,
      getTopicHistory: () => [], getLifelineTopicId: vi.fn(() => 457),
      registerTopicSession: vi.fn(), sendToTopic: vi.fn(async (_topicId: number, _text: string) => ({ ok: true })),
      sendMessageThroughFunnel: vi.fn(), isPolling: false,
    };
    const sessionManager = {
      isSessionAlive: () => false, requiresCodexGenerationRespawn: () => false,
      captureOutput: () => '', clearSessionFrameworkCache: vi.fn(),
      spawnInteractiveSession, injectTelegramMessage: vi.fn(),
    };
    wireTelegramRouting(rawAdapter as unknown as TelegramAdapter, sessionManager as unknown as SessionManager);
    await rawAdapter.onTopicMessage!({ id: 'tg-1', userId: '8820318295', content: 'Please continue this work',
      channel: { type: 'telegram', identifier: '458' }, receivedAt: '2026-07-11T00:00:00Z',
      metadata: { messageThreadId: 458, telegramUserId: 8820318295, firstName: 'Echo' },
    } as Message);
    await vi.waitFor(() => expect(builder).toHaveBeenCalledOnce());
    expect(builder).toHaveBeenCalledWith({ error: failure, topicId: 458, topicName: 'Reachable discussion', lifelineTopicId: 457, kind });
    const built = builder.mock.results[0].value;
    expect(built).toMatchObject({ lifelineTopicId: 457, reason: 'session-limit' });
    expect(built.userMessage).toContain('Lifeline topic');
    const fallbackCalls = deterministicSend.mock.calls.filter(call => call[1] === 'cold-start-fallback');
    expect(fallbackCalls).toEqual([[rawAdapter, 'cold-start-fallback', 458, built.userMessage]]);
    expect(rawAdapter.sendToTopic.mock.calls.filter(call => call[1] === built.userMessage)).toEqual([[458, built.userMessage]]);
    expect(rawAdapter.sendMessageThroughFunnel).not.toHaveBeenCalled();
    expect(spawnInteractiveSession).toHaveBeenCalledOnce();
    expect(sessionManager.injectTelegramMessage).not.toHaveBeenCalled();
  });

  it('drops the old jargon-leaking "increase maxSessions in your config" message', () => {
    expect(SERVER_SRC).not.toContain('increase maxSessions in your config');
  });
});
