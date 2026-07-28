/**
 * Unit test — SessionManager.getTopicBinding() topic-name collision disambiguation.
 *
 * Bug (2026-06-09): two Telegram topics whose names differ only by case
 * ("Initiatives…" #21487 vs "initiatives…" #21624) slug to the SAME tmux session
 * name. The reverse-lookup in getTopicBinding returned the FIRST matching topic
 * (21487), so the InputGuard blocked every message from the live topic (21624)
 * as cross-topic — the session was silently unresponsive.
 *
 * Fix: getTopicBinding takes an optional preferTopicId (parsed from the message's
 * own [telegram:N] tag at the injectMessage call site). When multiple topics
 * collide onto one session, it binds to the one the message names.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { SessionManager } from '../../src/core/SessionManager.js';
import { StateManager } from '../../src/core/StateManager.js';
import { InputGuard } from '../../src/core/InputGuard.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import type { SessionManagerConfig } from '../../src/core/types.js';

const SESSION = 'echo-initiatives-and-maturation-check-ins';

describe('SessionManager.getTopicBinding — topic-name collision disambiguation', () => {
  let tmpDir: string;
  let sm: SessionManager;

  const getBinding = (session: string, prefer?: number | null) =>
    (sm as unknown as { getTopicBinding(s: string, p?: number | null): { topicId: number; topicName: string } | null })
      .getTopicBinding(session, prefer);

  const writeRegistry = (topicToSession: Record<string, string>, topicToName: Record<string, string>) => {
    const p = path.join(tmpDir, 'topic-session-registry.json');
    fs.writeFileSync(p, JSON.stringify({ topicToSession, topicToName }, null, 2));
    return p;
  };

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'topic-collision-test-'));
    const stateDir = path.join(tmpDir, 'state');
    fs.mkdirSync(stateDir, { recursive: true });
    const state = new StateManager(stateDir);
    const config: SessionManagerConfig = {
      tmuxPath: '/usr/bin/tmux',
      claudePath: '/usr/local/bin/claude',
      projectDir: tmpDir,
      maxSessions: 3,
      protectedSessions: [],
      completionPatterns: [],
      framework: 'claude-code',
    };
    sm = new SessionManager(config, state);
    const guard = new InputGuard({ config: { enabled: true } as never, stateDir });
    // Collision: two case-variant topics map to the SAME session name.
    const reg = writeRegistry(
      { '21487': SESSION, '21624': SESSION },
      { '21487': 'Initiatives and maturation check-ins', '21624': 'initiatives and maturation check-ins' },
    );
    sm.setInputGuard(guard, reg);
  });

  afterEach(() => {
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/unit/topic-collision-binding.test.ts:cleanup' });
  });

  it('THE FIX: binds to the topic the incoming tag names (live topic 21624), not the first (stale 21487)', () => {
    const b = getBinding(SESSION, 21624);
    expect(b?.topicId).toBe(21624);
    expect(b?.topicName).toBe('initiatives and maturation check-ins');
  });

  it('also resolves the other colliding topic by its tag (21487)', () => {
    expect(getBinding(SESSION, 21487)?.topicId).toBe(21487);
  });

  it('falls back to the first match when no tag is provided (back-compat)', () => {
    const b = getBinding(SESSION, null);
    expect([21487, 21624]).toContain(b?.topicId);
    expect(getBinding(SESSION)?.topicId).toBe(b?.topicId);
  });

  it('falls back to the first match when the tag names a topic NOT mapped to this session', () => {
    const b = getBinding(SESSION, 99999);
    expect([21487, 21624]).toContain(b?.topicId);
  });

  it('single-topic (no collision) session is unchanged regardless of preferTopicId', () => {
    const reg = writeRegistry({ '777': 'echo-solo' }, { '777': 'Solo topic' });
    (sm as unknown as { registryPath: string }).registryPath = reg;
    expect(getBinding('echo-solo', 12345)?.topicId).toBe(777);
    expect(getBinding('echo-solo')?.topicId).toBe(777);
  });

  it('returns null for a session not in the registry', () => {
    expect(getBinding('echo-nonexistent', 21624)).toBeNull();
  });
});
