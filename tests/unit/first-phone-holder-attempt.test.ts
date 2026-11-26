import { expect, it, vi } from 'vitest';
import { createFirstPhoneHolderAttempt } from '../../src/core/trustJourney/firstPhoneHolderAttempt.js';
import { FIRST_PHONE_FACE_ID_ASSURANCE } from '../../src/core/trustJourney/firstPhoneOrderedChallenge.js';
import vector from '../fixtures/first-phone/face-id-challenge-v2.json';

const challenge = { ...vector.input, localAssurance: FIRST_PHONE_FACE_ID_ASSURANCE };
const next = { ...challenge, attemptId: '44444444-4444-4444-8444-444444444444', nonce: Buffer.alloc(32, 9).toString('base64url') };

function fixture() {
  let now = 0;
  let holds = true;
  const cancel = vi.fn<Parameters<typeof createFirstPhoneHolderAttempt>[0]['enrollment']['cancel']>();
  const reserveOpening = vi.fn(() => true);
  const readAccepted = vi.fn<Parameters<typeof createFirstPhoneHolderAttempt>[0]['readAccepted']>(async () => null);
  const deps = {
    holder: { machineId: challenge.holderMachineId, epoch: challenge.holderEpoch, incarnation: challenge.holderIncarnation },
    timeoutMs: 100, monotonicNow: () => now, isCurrentHolder: () => holds,
    reserveOpening, enrollment: { cancel }, readAccepted,
  };
  const lifecycle = createFirstPhoneHolderAttempt(deps);
  return { lifecycle, deps, cancel, reserveOpening, readAccepted, expire: () => { now = 100; }, loseHolder: () => { holds = false; } };
}

it('keeps the attempt closed until exact cancellation is witnessed and refuses to reuse the attempt key', async () => {
  const f = fixture();
  f.cancel.mockResolvedValueOnce({ kind: 'pending' }).mockImplementation(async input => ({
    kind: 'witnessed', outcome: { ...input, decision: 'canceled', requestDigest: 'a'.repeat(64) },
  }));
  const attempt = f.lifecycle.open(challenge)!;
  expect(attempt.challengeKey).toBe(vector.confirmation.challengeKey);
  expect(f.lifecycle.admitsSubmission(attempt)).toBe(true);
  expect(f.lifecycle.admitsSubmission({ ...attempt, challengeDigest: 'f'.repeat(64) })).toBe(false);
  f.expire();
  expect(f.lifecycle.admitsSubmission(attempt)).toBe(false);
  await expect(f.lifecycle.close()).resolves.toBe('pending');
  expect(f.lifecycle.open(next)).toBeNull();
  await expect(f.lifecycle.close()).resolves.toBe('canceled');
  expect(f.cancel.mock.calls[0]).toEqual(f.cancel.mock.calls[1]);
  expect(f.lifecycle.open(challenge)).toBeNull();
  expect(f.lifecycle.open(next)).not.toBeNull();
  await f.lifecycle.close();
});

it('a prior witnessed acceptance wins cancellation and permanently closes new local admission', async () => {
  const f = fixture();
  f.cancel.mockResolvedValue({ kind: 'refused' });
  const attempt = f.lifecycle.open(challenge)!;
  f.readAccepted.mockResolvedValue({ ...attempt, decision: 'accepted', operationId: 'exact-consume', requestDigest: 'b'.repeat(64) });
  await expect(f.lifecycle.close()).resolves.toBe('accepted');
  expect(f.lifecycle.admitsSubmission(attempt)).toBe(false);
  expect(f.lifecycle.open(next)).toBeNull();
});

it('refuses stale incarnations and stays unavailable after holder loss or unresolved restart history', async () => {
  const f = fixture();
  const attempt = f.lifecycle.open(challenge)!;
  f.loseHolder();
  expect(f.lifecycle.admitsSubmission(attempt)).toBe(false);
  await expect(f.lifecycle.close()).resolves.toBe('pending');
  expect(f.cancel).not.toHaveBeenCalled();

  const reserveOpening = vi.fn(() => false);
  const successor = createFirstPhoneHolderAttempt({
    ...f.deps, isCurrentHolder: () => true, reserveOpening,
    holder: { ...f.deps.holder, incarnation: 'process-2' },
  });
  expect(successor.open(challenge)).toBeNull();
  expect(reserveOpening).not.toHaveBeenCalled();
  expect(successor.open({ ...next, holderIncarnation: 'process-2' })).toBeNull();
  expect(reserveOpening).toHaveBeenCalledOnce();
});

it('closes a newly reserved attempt before exposing it when the issuer requests closure reentrantly', async () => {
  const f = fixture();
  f.cancel.mockResolvedValue({ kind: 'pending' });
  const lifecycle = createFirstPhoneHolderAttempt({
    ...f.deps, reserveOpening: () => { void lifecycle.close(); return true; },
  });
  expect(lifecycle.open(challenge)).toBeNull();
  await expect(lifecycle.close()).resolves.toBe('pending');
  expect(f.cancel).toHaveBeenCalledOnce();
  expect(lifecycle.open(next)).toBeNull();
});

it('does not expose admission to a callback while the holder check is still opening', async () => {
  const f = fixture();
  f.cancel.mockResolvedValue({ kind: 'pending' });
  let observed: boolean | undefined;
  const known = { challengeKey: vector.confirmation.challengeKey, challengeDigest: vector.confirmation.digestSha256Hex };
  let checks = 0;
  const lifecycle = createFirstPhoneHolderAttempt({
    ...f.deps,
    isCurrentHolder(): boolean {
      if (++checks === 2) observed = lifecycle.admitsSubmission(known);
      return true;
    },
  });
  expect(lifecycle.open(challenge)).toEqual(known);
  expect(observed).toBe(false);
  await lifecycle.close();
});
