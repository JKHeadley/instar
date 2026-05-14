/**
 * Unit tests for ServerSupervisor — F-6 Remediator ↔ Supervisor
 * handshake. Per v2 spec §A15 (partial-upgrade lag rule), v3 §3 (state-
 * file taxonomy: `supervisor-handshake.json` + HMAC-extended
 * `restart-requested.json`), and v3 §9 (Tier-2 sequencing).
 *
 * Tests:
 *  1. Valid signed restart-requested with matching HMAC → accepted.
 *  2. Forged HMAC → rejected with `invalid-hmac`.
 *  3. Stale request (requestedAt > 5 minutes ago) → rejected with `stale`.
 *  4. blastRadius === 'fleet' → rejected with `blast-radius-out-of-scope`.
 *  5. Handshake protocol version mismatch → rejected with A15 message.
 *  6. onRestartComplete fires after the restart cycle completes.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

// Mock child_process so spawn/execFile from the supervisor don't touch
// the real shell. We never invoke a real tmux session in these tests.
vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  return {
    ...actual,
    spawnSync: vi.fn(() => ({ stdout: '', stderr: '', status: 0, signal: null, pid: 0, output: [] })),
    execFileSync: vi.fn(() => ''),
  };
});

vi.mock('../../src/core/Config.js', () => ({
  detectTmuxPath: () => '/usr/bin/tmux',
}));

vi.mock('../../src/core/SleepWakeDetector.js', () => ({
  SleepWakeDetector: vi.fn().mockImplementation(() => ({
    start: vi.fn(),
    stop: vi.fn(),
    on: vi.fn(),
  })),
}));

// Import after mocks.
import {
  ServerSupervisor,
  canonicalRestartRequestedBody,
  type RestartRequestedPayload,
  type RegisteredRemediator,
} from '../../src/lifeline/ServerSupervisor.js';

function createTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'supervisor-handshake-test-'));
  fs.mkdirSync(path.join(dir, '.instar', 'state'), { recursive: true });
  return dir;
}

function buildPayload(
  key: Buffer,
  overrides: Partial<RestartRequestedPayload> = {},
): RestartRequestedPayload {
  const base: Omit<RestartRequestedPayload, 'hmac'> = {
    requestId: overrides.requestId ?? crypto.randomUUID(),
    runbookId: overrides.runbookId ?? 'supervisor-preflight',
    attemptId: overrides.attemptId ?? crypto.randomUUID(),
    blastRadius: overrides.blastRadius ?? 'machine',
    requestedAt: overrides.requestedAt ?? Date.now(),
    monotonicTs: overrides.monotonicTs ?? process.hrtime.bigint(),
    handshakeVersion: overrides.handshakeVersion ?? ServerSupervisor.HANDSHAKE_PROTOCOL_VERSION,
  };
  const draft = { ...base, hmac: Buffer.alloc(0) } as RestartRequestedPayload;
  const body = canonicalRestartRequestedBody(draft);
  const hmac = crypto.createHmac('sha256', key).update(body).digest();
  return { ...draft, hmac };
}

describe('ServerSupervisor F-6 handshake', () => {
  let tmpDir: string;
  let projectDir: string;
  let supervisor: ServerSupervisor;
  let leafKey: Buffer;
  let remediator: RegisteredRemediator & {
    onRestartComplete: ReturnType<typeof vi.fn>;
    getCapabilityLeafKey: ReturnType<typeof vi.fn>;
  };
  let performGracefulRestartSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmpDir = createTmpDir();
    projectDir = tmpDir;
    leafKey = crypto.randomBytes(32);
    supervisor = new ServerSupervisor({
      projectDir,
      projectName: 'test-agent',
      port: 0,
      stateDir: path.join(tmpDir, '.instar'),
    });
    remediator = {
      onRestartComplete: vi.fn(),
      getCapabilityLeafKey: vi.fn(() => leafKey),
    };
    // Stop the supervisor from actually attempting a tmux restart when
    // a request is accepted; the handshake itself is what we're testing.
    performGracefulRestartSpy = vi.spyOn(supervisor, 'performGracefulRestart').mockResolvedValue(true);
  });

  afterEach(() => {
    performGracefulRestartSpy.mockRestore();
    if (fs.existsSync(tmpDir)) {
      SafeFsExecutor.safeRmSync(tmpDir, {
        recursive: true,
        force: true,
        operation: 'tests/unit/ServerSupervisor-handshake.test.ts',
      });
    }
  });

  it('accepts a validly signed restart-requested with matching HMAC', async () => {
    supervisor.registerRemediator(remediator);

    const payload = buildPayload(leafKey);
    const reply = await supervisor.handleRestartRequested(payload);

    expect(reply.accepted).toBe(true);
    expect(reply.reason).toBe('accepted');
    expect(reply.requestId).toBe(payload.requestId);
    expect(reply.supervisorHandshakeVersion).toBe(ServerSupervisor.HANDSHAKE_PROTOCOL_VERSION);
    expect(performGracefulRestartSpy).toHaveBeenCalledTimes(1);
    expect(supervisor.getPendingRemediatorRequestCount()).toBe(1);
  });

  it('rejects a payload with a forged HMAC', async () => {
    supervisor.registerRemediator(remediator);

    const wrongKey = crypto.randomBytes(32);
    const payload = buildPayload(wrongKey);
    // Bypass the canonical helper so the inner body matches what we sent,
    // but the HMAC is from the wrong key.

    const reply = await supervisor.handleRestartRequested(payload);

    expect(reply.accepted).toBe(false);
    expect(reply.reason).toBe('invalid-hmac');
    expect(performGracefulRestartSpy).not.toHaveBeenCalled();
    expect(supervisor.getPendingRemediatorRequestCount()).toBe(0);
  });

  it('rejects a stale request (requestedAt > 5 minutes ago)', async () => {
    supervisor.registerRemediator(remediator);

    const sixMinutesAgo = Date.now() - 6 * 60_000;
    const payload = buildPayload(leafKey, { requestedAt: sixMinutesAgo });

    const reply = await supervisor.handleRestartRequested(payload);

    expect(reply.accepted).toBe(false);
    expect(reply.reason).toMatch(/^stale:/);
    expect(performGracefulRestartSpy).not.toHaveBeenCalled();
  });

  it("rejects blastRadius === 'fleet' as out-of-scope for Tier-2", async () => {
    supervisor.registerRemediator(remediator);

    const payload = buildPayload(leafKey, { blastRadius: 'fleet' });

    const reply = await supervisor.handleRestartRequested(payload);

    expect(reply.accepted).toBe(false);
    expect(reply.reason).toBe('blast-radius-out-of-scope: fleet');
    expect(performGracefulRestartSpy).not.toHaveBeenCalled();
  });

  it('rejects handshake-protocol version mismatch with the A15 message', async () => {
    supervisor.registerRemediator(remediator);

    const payload = buildPayload(leafKey, {
      handshakeVersion: ServerSupervisor.HANDSHAKE_PROTOCOL_VERSION + 1,
    });

    const reply = await supervisor.handleRestartRequested(payload);

    expect(reply.accepted).toBe(false);
    expect(reply.reason).toContain('handshake-version-mismatch');
    expect(reply.reason).toContain('A15');
    expect(reply.reason).toContain('alert-only');
    expect(performGracefulRestartSpy).not.toHaveBeenCalled();
  });

  it('fires onRestartComplete after the restart cycle completes', async () => {
    supervisor.registerRemediator(remediator);

    const payload = buildPayload(leafKey);
    const reply = await supervisor.handleRestartRequested(payload);
    expect(reply.accepted).toBe(true);
    expect(remediator.onRestartComplete).not.toHaveBeenCalled();

    // Simulate the supervisor seeing a healthy tick after the restart.
    supervisor.triggerHealthyTickForTests();

    expect(remediator.onRestartComplete).toHaveBeenCalledTimes(1);
    expect(remediator.onRestartComplete).toHaveBeenCalledWith({ requestId: payload.requestId });
    expect(supervisor.getPendingRemediatorRequestCount()).toBe(0);

    // Subsequent healthy ticks must be no-ops (idempotency guard).
    supervisor.triggerHealthyTickForTests();
    expect(remediator.onRestartComplete).toHaveBeenCalledTimes(1);
  });

  it('rejects when no Remediator is registered', async () => {
    const payload = buildPayload(leafKey);
    const reply = await supervisor.handleRestartRequested(payload);

    expect(reply.accepted).toBe(false);
    expect(reply.reason).toBe('no-remediator-registered');
  });

  it('writes supervisor-handshake.json on registration', () => {
    supervisor.setSupervisorBuildId('v0.99.0-test');
    supervisor.registerRemediator(remediator);

    const filePath = path.join(tmpDir, '.instar', 'state', 'supervisor-handshake.json');
    expect(fs.existsSync(filePath)).toBe(true);

    const body = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    expect(body.version).toBe(ServerSupervisor.HANDSHAKE_PROTOCOL_VERSION);
    expect(body.supervisorBuildId).toBe('v0.99.0-test');
    expect(typeof body.writtenAt).toBe('string');
  });

  it('rejects a malformed payload (missing fields)', async () => {
    supervisor.registerRemediator(remediator);
    const bogus = { requestId: 'r1' } as unknown as RestartRequestedPayload;
    const reply = await supervisor.handleRestartRequested(bogus);
    expect(reply.accepted).toBe(false);
    expect(reply.reason).toBe('malformed-payload');
  });
});
