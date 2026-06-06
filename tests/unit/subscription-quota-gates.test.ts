/**
 * Unit tests — subscription-quota gates on the A2A spawn surfaces
 * (june15-headless-spawn-reroute, security finding S1 + S4).
 *
 * When the subscription-path reroute is active, A2A cold spawns and pipe
 * replies land on the operator's subscription 5h window. These gates are
 * what stops inbound peer traffic from exhausting that window and blocking
 * the USER's own conversations (a peer-triggered rate-limit DoS). Both
 * seams are optional: absent (the default wiring when mode=off), admission
 * behavior is byte-for-byte unchanged — pinned by the both-sides tests.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SpawnRequestManager } from '../../src/messaging/SpawnRequestManager.js';
import type { SpawnRequest } from '../../src/messaging/SpawnRequestManager.js';
import { PipeSessionSpawner } from '../../src/threadline/PipeSessionSpawner.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

function makeRequest(overrides: Partial<SpawnRequest> = {}): SpawnRequest {
  return {
    requester: { agent: 'peer-agent', session: 'sess-1', machine: 'm1' },
    target: { agent: 'this-agent', machine: 'm1' },
    priority: 'medium',
    reason: 'test spawn',
    ...overrides,
  } as SpawnRequest;
}

describe('SpawnRequestManager — subscription quota gate (S1)', () => {
  let spawnCalls: string[];

  function makeManager(gate?: () => { allowed: boolean; reason: string }) {
    spawnCalls = [];
    return new SpawnRequestManager({
      maxSessions: 10,
      getActiveSessions: () => [],
      spawnSession: async (prompt: string) => {
        spawnCalls.push(prompt);
        return 'session-1';
      },
      ...(gate ? { shouldSpawnSession: gate } : {}),
    });
  }

  it('denies (and does not spawn) when the gate reports quota exhausted', async () => {
    const manager = makeManager(() => ({
      allowed: false,
      reason: '5-hour rate limit at 96% — sessions will fail immediately',
    }));
    const result = await manager.evaluate(makeRequest());
    expect(result.approved).toBe(false);
    expect(result.reason).toContain('Subscription quota gate');
    expect(result.reason).toContain('5-hour rate limit at 96%');
    expect(result.retryAfterMs).toBeGreaterThan(0);
    expect(spawnCalls).toHaveLength(0);
  });

  it('queues the message content under quota denial (content survives the pressure)', async () => {
    const manager = makeManager(() => ({ allowed: false, reason: 'window hot' }));
    await manager.evaluate(makeRequest({ context: 'important peer message' }));
    // A later allowed spawn for the same agent must carry the queued content.
    const open = makeManager(() => ({ allowed: true, reason: 'ok' }));
    // (Queue is per-manager state; verify on the SAME manager by flipping the gate.)
    let allowed = false;
    const flipping = new SpawnRequestManager({
      maxSessions: 10,
      getActiveSessions: () => [],
      spawnSession: async (prompt: string) => {
        spawnCalls.push(prompt);
        return 'session-1';
      },
      shouldSpawnSession: () => (allowed ? { allowed: true, reason: 'ok' } : { allowed: false, reason: 'window hot' }),
      cooldownMs: 0,
    });
    await flipping.evaluate(makeRequest({ context: 'queued-under-quota' }));
    allowed = true;
    spawnCalls = [];
    const result = await flipping.evaluate(makeRequest({ context: 'second message' }));
    expect(result.approved).toBe(true);
    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0]).toContain('queued-under-quota');
    void open;
  });

  it('absent gate (default wiring) — admission proceeds exactly as before', async () => {
    const manager = makeManager(undefined);
    const result = await manager.evaluate(makeRequest());
    expect(result.approved).toBe(true);
    expect(spawnCalls).toHaveLength(1);
  });

  it('allowed gate — admission proceeds', async () => {
    const manager = makeManager(() => ({ allowed: true, reason: 'No quota data — fail open' }));
    const result = await manager.evaluate(makeRequest());
    expect(result.approved).toBe(true);
    expect(spawnCalls).toHaveLength(1);
  });
});

describe('PipeSessionSpawner — force-mode refusal from inside spawn() (S4 / Class 7)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pipe-gate-')));
  });

  afterEach(() => {
    SafeFsExecutor.safeRmSync(tmpDir, {
      recursive: true,
      force: true,
      operation: 'tests/unit/subscription-quota-gates.test.ts:cleanup',
    });
  });

  const request = {
    threadId: 't-force',
    messageText: 'quick question',
    fromFingerprint: 'abc',
    fromName: 'peer',
    trustLevel: 'trusted',
    iqsBand: 90,
  };

  it('force mode + claude-code → {spawned:false} (falls through to the rerouted A2A path), no tmux attempt', async () => {
    const spawner = new PipeSessionSpawner({
      stateDir: tmpDir,
      tmpDir,
      framework: 'claude-code',
      binaryPath: '/usr/bin/false', // would fail loudly if spawn were attempted
      getSubscriptionPathMode: () => 'force',
    });
    const result = await spawner.spawn(request);
    expect(result.spawned).toBe(false);
    expect(result.reason).toContain('force-mode');
    // Refusal must happen before the prompt temp-file write — nothing on disk.
    expect(fs.readdirSync(tmpDir).filter((f) => f.startsWith('prompt-'))).toHaveLength(0);
  });

  it('quota-blocked under auto mode → {spawned:false} with the gate reason', async () => {
    const spawner = new PipeSessionSpawner({
      stateDir: tmpDir,
      tmpDir,
      framework: 'claude-code',
      binaryPath: '/usr/bin/false',
      getSubscriptionPathMode: () => 'auto',
      shouldSpawnSession: () => ({ allowed: false, reason: '5-hour rate limit at 96%' }),
    });
    const result = await spawner.spawn(request);
    expect(result.spawned).toBe(false);
    expect(result.reason).toContain('quota gate');
  });

  it('codex-cli framework is untouched by force mode (no Anthropic billing to protect)', async () => {
    const spawner = new PipeSessionSpawner({
      stateDir: tmpDir,
      tmpDir,
      framework: 'codex-cli',
      binaryPath: '/usr/bin/false',
      getSubscriptionPathMode: () => 'force',
    });
    // Refusal must NOT fire — the spawn proceeds into the real path (which
    // fails on the stub binary, proving the gate didn't short-circuit it).
    const result = await spawner.spawn(request);
    expect(result.reason ?? '').not.toContain('force-mode');
  });

  it('absent accessors (default wiring) — claude-code spawn is not gated', async () => {
    const spawner = new PipeSessionSpawner({
      stateDir: tmpDir,
      tmpDir,
      framework: 'claude-code',
      binaryPath: '/usr/bin/false',
    });
    const result = await spawner.spawn(request);
    expect(result.reason ?? '').not.toContain('force-mode');
    expect(result.reason ?? '').not.toContain('quota gate');
  });
});
