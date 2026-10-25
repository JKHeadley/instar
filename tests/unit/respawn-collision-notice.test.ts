import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import {
  RESPAWN_COLLISION_NOTICE,
  sendRespawnCollisionNotice,
} from '../../src/messaging/ColdStartFallbackReply.js';
import { clearGenerationlessCodexResumeBinding, wireTelegramRouting } from '../../src/commands/server.js';
import type { TelegramAdapter } from '../../src/messaging/TelegramAdapter.js';
import type { SessionManager } from '../../src/core/SessionManager.js';
import type { Message } from '../../src/core/types.js';
import * as deterministicOrigin from '../../src/messaging/telegram-origin/OriginDeterministicSend.js';

const fixture = vi.hoisted(() => ({ inboundDir: '' }));
vi.mock('../../src/messaging/shared/telegramInboundFiles.js', () => ({
  getTelegramInboundDir: () => {
    if (!fixture.inboundDir) throw new Error('test inbound fixture is not active');
    return fixture.inboundDir;
  },
}));
beforeEach(() => { fixture.inboundDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-respawn-notice-')); });
afterEach(async () => {
  // Routing assertions await the terminal spawn/notice boundary; drain its
  // remaining promise continuations before removing only this test's files.
  await new Promise<void>(resolve => setImmediate(resolve));
  vi.restoreAllMocks();
  const directory = fixture.inboundDir; fixture.inboundDir = '';
  SafeFsExecutor.safeRmSync(directory, { recursive: true, force: true, operation: 'test:instar-respawn-notice-inbound-cleanup' });
  expect(fs.existsSync(directory)).toBe(false);
});

// The regression intentionally drives the real respawn wiring. Keep that path
// real, but fence the production scaffold boundary: server.ts captures the
// checkout cwd as its projectDir at module load, and a real spawn otherwise
// renders identity shadows into the test runner's checkout.
vi.mock('../../src/core/IdentityRenderer.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/core/IdentityRenderer.js')>(),
  ensureFrameworkIdentityFile: vi.fn(() => null),
}));

describe('respawn collision custody notice', () => {
  it('reaches the deterministic topic-send funnel with honest loss wording', async () => {
    const sent: Array<{ topicId: number; text: string }> = [];
    await sendRespawnCollisionNotice(async (topicId, text) => {
      sent.push({ topicId, text });
      return { ok: true };
    }, 458);

    expect(sent).toEqual([{ topicId: 458, text: RESPAWN_COLLISION_NOTICE }]);
    expect(sent[0].text).toContain('not queued or delivered');
    expect(sent[0].text).toContain('Please resend');
  });

  it.each([['ordinary death', ''], ['context exhaustion', 'conversation too long']])('tells the user exactly once through the origin producer when a second inbound collides with %s', async (_cause, output) => {
    // Call through the shipped wrapper: bypassing it must fail even if text arrives.
    const deterministicSend = vi.spyOn(deterministicOrigin, 'sendDeterministicTelegramNotice');
    const sent: string[] = [];
    let releaseSpawn!: (name: string) => void;
    const heldSpawn = new Promise<string>((resolve) => { releaseSpawn = resolve; });
    const spawnInteractiveSession = vi.fn(() => heldSpawn);
    const injectTelegramMessage = vi.fn();
    const rawAdapter = {
      onTopicMessage: null as null | ((message: Message) => Promise<void>),
      isAuthorizedSender: () => true,
      handleCommand: async () => false,
      getTopicName: () => 'dev-task',
      getSessionForTopic: () => 'dead-session',
      getTopicHistory: () => [],
      getLifelineTopicId: () => null,
      resolveTopicName: async () => 'dev-task',
      registerTopicSession: vi.fn(),
      sendToTopic: async (_topicId: number, text: string) => { sent.push(text); },
      isPolling: false,
    };
    const sessionManager = {
      isSessionAlive: () => false,
      requiresCodexGenerationRespawn: () => false,
      captureOutput: () => output,
      clearSessionFrameworkCache: vi.fn(),
      spawnInteractiveSession,
      injectTelegramMessage,
    } as unknown as SessionManager;
    wireTelegramRouting(rawAdapter as unknown as TelegramAdapter, sessionManager);

    const message = (id: string, content: string): Message => ({
      id,
      userId: '8820318295',
      content,
      channel: { type: 'telegram', identifier: '458' },
      receivedAt: '2026-07-11T00:00:00Z',
      metadata: { messageThreadId: 458, telegramUserId: 8820318295, firstName: 'Echo' },
    } as Message);

    try {
      await rawAdapter.onTopicMessage!(message('tg-1', 'first message'));
      await vi.waitFor(() => expect(spawnInteractiveSession).toHaveBeenCalledTimes(1));
      await rawAdapter.onTopicMessage!(message('tg-2', 'second message'));

      expect(sent.filter((text) => text === RESPAWN_COLLISION_NOTICE)).toEqual([RESPAWN_COLLISION_NOTICE]);
      expect(spawnInteractiveSession).toHaveBeenCalledTimes(1);
      expect(injectTelegramMessage).not.toHaveBeenCalled();
      // Prove the real classifier entered the intended arm, not two copies of the ordinary case.
      expect(sent.some(text => text.includes('Conversation got too long'))).toBe(output !== '');

      const collisions = deterministicSend.mock.calls.filter(call => call[1] === 'respawn-collision');
      expect(collisions).toEqual([[rawAdapter, 'respawn-collision', 458, RESPAWN_COLLISION_NOTICE]]);
    } finally {
      // The detached respawn must settle before another branch gets a fresh registry.
      releaseSpawn('replacement-session');
      await vi.waitFor(() => expect(rawAdapter.registerTopicSession).toHaveBeenCalled());
    }
  });

  it('fresh-respawns a stale generationless Codex pane with history and the current inbound', async () => {
    const spawnInteractiveSession = vi.fn(async () => 'replacement-session');
    const clearSessionFrameworkCache = vi.fn();
    const injectTelegramMessage = vi.fn();
    const rawAdapter = {
      onTopicMessage: null as null | ((message: Message) => Promise<void>),
      isAuthorizedSender: () => true,
      handleCommand: async () => false,
      getTopicName: () => 'generationless-topic',
      getSessionForTopic: () => 'stale-generationless-pane',
      getTopicHistory: () => [{
        messageId: 1, topicId: 458, text: 'Earlier bounded history', fromUser: true,
        timestamp: '2026-09-01T05:59:00.000Z', senderName: 'Justin', forwarded: false,
      }],
      getLifelineTopicId: () => null,
      resolveTopicName: async () => 'generationless-topic',
      registerTopicSession: vi.fn(),
      sendToTopic: vi.fn(async () => ({ ok: true })),
      isPolling: false,
    };
    const sessionManager = {
      isSessionAlive: () => true,
      requiresCodexGenerationRespawn: () => true,
      captureOutput: vi.fn(() => { throw new Error('generationless recovery must not classify pane death'); }),
      clearSessionFrameworkCache,
      spawnInteractiveSession,
      injectTelegramMessage,
    } as unknown as SessionManager;
    wireTelegramRouting(rawAdapter as unknown as TelegramAdapter, sessionManager);

    await rawAdapter.onTopicMessage!({
      id: 'tg-3', userId: '7812716706', content: 'Current inbound survives recovery',
      channel: { type: 'telegram', identifier: '458' }, receivedAt: '2026-09-01T06:00:00.000Z',
      metadata: { messageThreadId: 458, telegramUserId: 7812716706, firstName: 'Justin' },
    } as Message);
    await vi.waitFor(() => expect(spawnInteractiveSession).toHaveBeenCalledTimes(1));

    const [prompt, name, options] = spawnInteractiveSession.mock.calls[0];
    expect(name).toBe('generationless-topic');
    expect(options.resumeSessionId).toBeUndefined();
    const pointer = String(prompt).match(/\[IMPORTANT: Read (.+?) —/);
    expect(pointer, 'the generationless history actually uses the bootstrap-file boundary').not.toBeNull();
    expect(path.dirname(pointer![1])).toBe(fixture.inboundDir);
    const bootstrap = fs.readFileSync(pointer![1], 'utf8');
    expect(bootstrap).toContain('Earlier bounded history');
    expect(bootstrap).toContain('Current inbound survives recovery');
    await vi.waitFor(() => expect(rawAdapter.registerTopicSession).toHaveBeenCalled());
    expect(clearSessionFrameworkCache).toHaveBeenCalledWith('stale-generationless-pane');
    expect(injectTelegramMessage).not.toHaveBeenCalled();
  });

  it('removes the resume binding before generationless recovery', () => {
    const remove = vi.fn();
    clearGenerationlessCodexResumeBinding({ remove } as never, 458);
    expect(remove).toHaveBeenCalledWith(458);
  });

  it('does not move the sentinel-before-exactly-once safety ordering', () => {
    const source = fs.readFileSync(path.resolve('src/server/routes.ts'), 'utf8');
    expect(source.indexOf('Sentinel intercept (P0 safety')).toBeGreaterThan(-1);
    expect(source.indexOf('Exactly-once ingress gate')).toBeGreaterThan(source.indexOf('Sentinel intercept (P0 safety'));
  });
});
