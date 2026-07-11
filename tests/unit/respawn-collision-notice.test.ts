import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  RESPAWN_COLLISION_NOTICE,
  sendRespawnCollisionNotice,
} from '../../src/messaging/ColdStartFallbackReply.js';
import { wireTelegramRouting } from '../../src/commands/server.js';
import type { TelegramAdapter } from '../../src/messaging/TelegramAdapter.js';
import type { SessionManager } from '../../src/core/SessionManager.js';
import type { Message } from '../../src/core/types.js';

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

  it('tells the user exactly once when a second inbound collides with an unresolved respawn', async () => {
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
      captureOutput: () => '',
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

    await rawAdapter.onTopicMessage!(message('tg-1', 'first message'));
    await vi.waitFor(() => expect(spawnInteractiveSession).toHaveBeenCalledTimes(1));
    await rawAdapter.onTopicMessage!(message('tg-2', 'second message'));

    expect(sent.filter((text) => text === RESPAWN_COLLISION_NOTICE)).toEqual([RESPAWN_COLLISION_NOTICE]);
    expect(spawnInteractiveSession).toHaveBeenCalledTimes(1);
    expect(injectTelegramMessage).not.toHaveBeenCalled();

    // Let the detached respawn settle after the collision assertions.
    releaseSpawn('replacement-session');
  });

  it('is wired into both dead-session respawn collision guards', () => {
    const source = fs.readFileSync(path.resolve('src/commands/server.ts'), 'utf8');
    const calls = source.match(/sendRespawnCollisionNotice\(telegram\.sendToTopic\.bind\(telegram\), topicId\)/g) ?? [];
    expect(calls).toHaveLength(2);
  });

  it('does not move the sentinel-before-exactly-once safety ordering', () => {
    const source = fs.readFileSync(path.resolve('src/server/routes.ts'), 'utf8');
    expect(source.indexOf('Sentinel intercept (P0 safety')).toBeGreaterThan(-1);
    expect(source.indexOf('Exactly-once ingress gate')).toBeGreaterThan(source.indexOf('Sentinel intercept (P0 safety'));
  });
});
