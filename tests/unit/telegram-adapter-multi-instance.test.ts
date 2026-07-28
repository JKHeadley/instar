/**
 * TelegramAdapter multi-instance state isolation (spec MENTOR-LIVE-READINESS §Fix 2b,
 * round-2 integration F1 — the reviewer-flagged state-file collision).
 *
 * The load-bearing safety property: a PRIMARY adapter (no opts) must keep its state-file
 * paths BYTE-FOR-BYTE unchanged (this code runs Echo's own Telegram — the channel to the
 * user). A non-primary adapter (subDir set) namespaces its per-bot state so two bots can
 * run in one process without clobbering each other's poll-offset / registry / message-log /
 * attention files.
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TelegramAdapter } from '../../src/messaging/TelegramAdapter.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

describe('TelegramAdapter — multi-instance state isolation', () => {
  const adapters: TelegramAdapter[] = [];
  const dirs: string[] = [];

  afterEach(async () => {
    for (const a of adapters) await a.stop().catch(() => {});
    adapters.length = 0;
    for (const d of dirs) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'telegram-multi-instance test cleanup' });
    dirs.length = 0;
  });

  function tmp(): string {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-tg-multi-'));
    dirs.push(d);
    return d;
  }

  function make(stateDir: string, opts?: { subDir?: string; suppressLifelineAutoCreate?: boolean }): TelegramAdapter {
    const a = new TelegramAdapter({ token: 't', chatId: '-1001' }, stateDir, opts);
    adapters.push(a);
    return a;
  }

  it('PRIMARY (no opts): state-file paths are byte-for-byte the historical {stateDir}/... paths', () => {
    const dir = tmp();
    const a = make(dir) as unknown as Record<string, string>;
    // These exact paths are what every prior install wrote to — must NOT change.
    expect(a.registryPath).toBe(path.join(dir, 'topic-session-registry.json'));
    expect(a.messageLogPath).toBe(path.join(dir, 'telegram-messages.jsonl'));
    expect(a.offsetPath).toBe(path.join(dir, 'telegram-poll-offset.json'));
    expect(a.attentionFilePath).toBe(path.join(dir, 'state', 'attention-items.json'));
    expect(a.botStateDir).toBe(dir);
  });

  it('subDir: per-bot state is namespaced under {stateDir}/{subDir}/ — no collision with primary', () => {
    const dir = tmp();
    const primary = make(dir) as unknown as Record<string, string>;
    const mentor = make(dir, { subDir: 'agent-telegram/mentor-bot' }) as unknown as Record<string, string>;

    const sub = path.join(dir, 'agent-telegram', 'mentor-bot');
    expect(mentor.botStateDir).toBe(sub);
    expect(mentor.offsetPath).toBe(path.join(sub, 'telegram-poll-offset.json'));
    expect(mentor.registryPath).toBe(path.join(sub, 'topic-session-registry.json'));
    expect(mentor.messageLogPath).toBe(path.join(sub, 'telegram-messages.jsonl'));
    expect(mentor.attentionFilePath).toBe(path.join(sub, 'state', 'attention-items.json'));

    // The critical isolation: the two adapters share NO state-file path.
    expect(mentor.offsetPath).not.toBe(primary.offsetPath);
    expect(mentor.registryPath).not.toBe(primary.registryPath);
    expect(mentor.messageLogPath).not.toBe(primary.messageLogPath);
    expect(mentor.attentionFilePath).not.toBe(primary.attentionFilePath);

    // The sub-dir is created on construction.
    expect(fs.existsSync(sub)).toBe(true);
  });

  it('suppressLifelineAutoCreate flag is recorded (non-primary bot will not create a 2nd Lifeline topic)', () => {
    const dir = tmp();
    const def = make(dir) as unknown as Record<string, boolean>;
    expect(def.suppressLifelineAutoCreate).toBe(false); // primary default

    const mentor = make(dir, { subDir: 'agent-telegram/mentor-bot', suppressLifelineAutoCreate: true }) as unknown as Record<string, boolean>;
    expect(mentor.suppressLifelineAutoCreate).toBe(true);
  });
});
