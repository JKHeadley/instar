import { describe, expect, it, vi } from 'vitest';
import { cameraAcceptanceRuntime } from '../../src/core/CameraAcceptanceRuntime.js';
import type { CameraJournalScope } from '../../src/core/CameraAcceptanceJournalRecord.js';
import type { OriginSessionBinding } from '../../src/messaging/telegram-origin/OriginSessionRegistry.js';

const token = 'ior1_' + 'r'.repeat(43);
const scope = { conversationKey: 'app:camera', milestone: 'camera', leaseEpoch: 2, binding: { physical: 100, logical: 0, node: 'studio' } };
const binding: OriginSessionBinding = {
  agentId: 'test', machineId: 'studio', harnessId: 'codex-cli', sessionId: 'review-session',
  sessionIncarnation: 'live', projectDir: '/test-agent', issuedAt: '2026-11-25T04:33:00Z',
};

function fixture() {
  const activeScope = vi.fn<() => CameraJournalScope | null>(() => scope);
  const loadEvidence = vi.fn(async () => null);
  let live = true;
  const runtime = cameraAcceptanceRuntime({
    activeScope, loadEvidence,
    journal: { withSnapshot: (_scope, operation) => operation(null) },
    authentication: {
      machineId: 'studio',
      sessions: { verify: () => live ? { ok: true, binding } : { ok: false, reason: 'revoked' } },
      sessionProducer: async () => ({
        producerKind: 'session', originMachineId: 'studio',
        sessionId: binding.sessionId, sessionIncarnation: binding.sessionIncarnation,
      }),
      assignmentFor: () => ({ principal: 'reviewer', epoch: 1 }),
    },
  });
  return { runtime, activeScope, loadEvidence, revoke: () => { live = false; } };
}

describe('Camera review runtime composition', () => {
  it('binds protected evidence to the verified reviewer and configured scope', async () => {
    const { runtime, loadEvidence } = fixture();
    await expect(runtime.resolveVerifier('generic-bearer')).resolves.toBeNull();
    const reviewer = await runtime.resolveVerifier(token);
    expect(reviewer?.principal).toBe('reviewer');
    await reviewer?.loadEvidence('issued-request');
    expect(loadEvidence).toHaveBeenCalledWith(scope, 'reviewer', 'issued-request');
  });

  it('does not invoke the protected reader after revocation', async () => {
    const { runtime, loadEvidence, revoke } = fixture();
    const reviewer = await runtime.resolveVerifier(token);
    expect(reviewer).not.toBeNull();
    revoke();
    await expect(reviewer?.loadEvidence('issued-request')).resolves.toBeNull();
    expect(loadEvidence).not.toHaveBeenCalled();
  });

  it('refuses a scope that changes during authentication or before evidence access', async () => {
    const { runtime, activeScope, loadEvidence } = fixture();
    activeScope.mockReturnValueOnce(scope).mockReturnValueOnce({ ...scope, leaseEpoch: 3 });
    await expect(runtime.resolveVerifier(token)).resolves.toBeNull();

    const reviewer = await runtime.resolveVerifier(token);
    expect(reviewer).not.toBeNull();
    activeScope.mockReturnValue(null);
    await expect(reviewer?.loadEvidence('issued-request')).resolves.toBeNull();
    expect(loadEvidence).not.toHaveBeenCalled();
  });
});
