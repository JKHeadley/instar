import { describe, expect, it, vi } from 'vitest';
import { authorizeCameraVerifier } from '../../src/core/CameraVerifierAuth.js';
import type { OriginSessionBinding, OriginTokenVerification } from '../../src/messaging/telegram-origin/OriginSessionRegistry.js';

const token = 'ior1_' + 'a'.repeat(43);
const binding: OriginSessionBinding = {
  agentId: 'echo', machineId: 'studio', harnessId: 'codex-cli', sessionId: 'session', sessionIncarnation: 'current', projectDir: '/test-agent',
  issuedAt: '2026-11-25T02:44:00Z',
};
const requirement = { candidate: 'camera', revision: 1, verifier: 'reviewer', builders: ['builder'] };

function fixture() {
  const verify = vi.fn<() => OriginTokenVerification>(() => ({ ok: true, binding }));
  const sessionProducer = vi.fn(async () => ({
    originMachineId: 'studio', producerKind: 'session' as const, sessionId: 'session', sessionIncarnation: 'current',
  }));
  const assignmentFor = vi.fn(() => ({ principal: 'reviewer', epoch: 2 }));
  return { machineId: 'studio', sessions: { verify }, sessionProducer, assignmentFor };
}

describe('Camera verifier authentication', () => {
  it('requires a strict credential and the observed local session incarnation', async () => {
    const deps = fixture();
    await expect(authorizeCameraVerifier(deps, 'generic bearer')).resolves.toBeNull();
    expect(deps.sessionProducer).not.toHaveBeenCalled();
    deps.sessionProducer.mockResolvedValueOnce({
      originMachineId: 'studio', producerKind: 'session', sessionId: 'session', sessionIncarnation: 'expired',
    });
    await expect(authorizeCameraVerifier(deps, token)).resolves.toBeNull();
    deps.sessionProducer.mockRejectedValueOnce(new Error('credential rejected'));
    await expect(authorizeCameraVerifier(deps, token)).resolves.toBeNull();
  });

  it('holds after revocation or reassignment and refuses a builder or stale epoch', async () => {
    const deps = fixture();
    const auth = await authorizeCameraVerifier(deps, token);
    expect(auth?.allows(requirement, 2)).toBe(true);
    expect(auth?.allows(requirement, 1)).toBe(false);
    expect(auth?.allows({ ...requirement, builders: ['reviewer'] }, 2)).toBe(false);
    deps.assignmentFor.mockReturnValueOnce({ principal: 'reviewer', epoch: 3 });
    expect(auth?.allows(requirement, 2)).toBe(false);
    deps.sessions.verify.mockReturnValueOnce({ ok: false, reason: 'session-not-live' });
    expect(auth?.allows(requirement, 2)).toBe(false);
  });
});
