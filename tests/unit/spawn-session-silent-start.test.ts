/**
 * Unit — spawnSessionForTopic `silentStart` (dashboard-door-model-controls §3.3 step 4).
 *
 * Drives the REAL chokepoint exported from server.ts. A dashboard-created topic
 * starts idle: no bootstrap build (no history read, no temp file, no relay
 * block) and NO initial message — exactly what the raw
 * spawnInteractiveSession(undefined, …) path injected before. The contrast case
 * (no silentStart) proves the assertion can fail: it injects the
 * "Session started" bootstrap.
 */
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { spawnSessionForTopic } from '../../src/commands/server.js';
import type { TelegramAdapter } from '../../src/messaging/TelegramAdapter.js';
import type { SessionManager } from '../../src/core/SessionManager.js';

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
beforeEach(() => { fixture.inboundDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-silent-start-')); });
afterEach(() => {
  const dir = fixture.inboundDir; fixture.inboundDir = '';
  SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'test:silent-start-cleanup' });
});

function harness() {
  const calls: Array<{ initialMessage: string | undefined; name: string; opts: Record<string, unknown> }> = [];
  const sessionManager = {
    spawnInteractiveSession: async (initialMessage: string | undefined, name: string, opts: Record<string, unknown>) => {
      calls.push({ initialMessage, name, opts });
      return `tmux-${name}`;
    },
    listRunningSessions: () => [],
  } as unknown as SessionManager;
  let historyReads = 0;
  const telegram = {
    getTopicHistory: () => { historyReads++; return [{ fromUser: true, text: 'old message', timestamp: new Date().toISOString() }]; },
    getTopicName: () => 'fresh',
    sendToTopic: async () => ({}),
  } as unknown as TelegramAdapter;
  return { calls, sessionManager, telegram, historyReads: () => historyReads };
}

describe('spawnSessionForTopic silentStart', () => {
  it('passes NO initial message, reads no history, writes no temp file', async () => {
    const h = harness();
    const name = await spawnSessionForTopic(h.sessionManager, h.telegram, 'fresh', 7701,
      undefined, undefined, undefined, undefined, undefined, { silentStart: true });
    expect(name).toBe('tmux-fresh');
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0].initialMessage).toBeUndefined();
    expect(h.calls[0].opts.telegramTopicId).toBe(7701);
    expect(h.historyReads()).toBe(0);
    expect(fs.readdirSync(fixture.inboundDir)).toEqual([]);
  });

  it('without silentStart the chokepoint injects the bootstrap (the contrast case)', async () => {
    const h = harness();
    await spawnSessionForTopic(h.sessionManager, h.telegram, 'fresh', 7702);
    expect(typeof h.calls[0].initialMessage).toBe('string');
    expect(h.historyReads()).toBe(1);
    // History present ⇒ the history file is written — the side effect silentStart skips.
    expect(fs.readdirSync(fixture.inboundDir).length).toBeGreaterThan(0);
  });
});
