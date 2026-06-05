/**
 * Tier-1 tests for planTransferByNickname (Multi-Machine Session Pool §L4/§L5):
 * the headline "move this to <nickname>" planner + its gates — unknown-nickname
 * rejection (lists valid names), rate-limit, already-there no-op, and the
 * confirmation gate (offline target / mid-reply).
 */
import { describe, it, expect } from 'vitest';
import { planTransferByNickname, type TransferByNicknameState } from '../../src/core/TransferByNickname.js';
import type { NicknameCommand } from '../../src/core/NicknameCommand.js';

const CMD: NicknameCommand = { intent: 'transfer', nickname: 'mini', matchedVerb: 'move' };

function state(over: Partial<TransferByNicknameState> = {}): TransferByNicknameState {
  return {
    resolveNickname: (n) => (n === 'mini' ? 'm_mini' : n === 'workstation' ? 'm_ws' : null),
    validNicknames: () => ['mini', 'workstation'],
    isOnline: () => true,
    currentOwnerOf: () => 'm_ws',
    isMidReply: () => false,
    lastPlacementUpdateAt: () => null,
    now: () => 1_000_000,
    minUpdateIntervalMs: 10000,
    ...over,
  };
}

describe('planTransferByNickname (§L4/§L5)', () => {
  it('plans a transfer to the resolved online machine (with a hard pin)', () => {
    const p = planTransferByNickname(CMD, state(), 's1');
    expect(p).toMatchObject({ action: 'transfer', targetMachine: 'm_mini', setPin: true });
  });

  it('rejects an unknown nickname and lists the valid ones (never silent mis-route)', () => {
    const p = planTransferByNickname({ ...CMD, nickname: 'mars' }, state(), 's1');
    expect(p).toMatchObject({ action: 'reject', rejectReason: 'unknown-machine-nickname' });
    expect(p.validNicknames).toEqual(['mini', 'workstation']);
  });

  it('rate-limits rapid-fire transfers on the same topic', () => {
    const p = planTransferByNickname(CMD, state({ lastPlacementUpdateAt: () => 999_995, now: () => 1_000_000 }), 's1');
    expect(p).toMatchObject({ action: 'reject', rejectReason: 'rate-limited' });
  });

  it('allows the transfer once the rate-limit window has passed', () => {
    const p = planTransferByNickname(CMD, state({ lastPlacementUpdateAt: () => 980_000, now: () => 1_000_000 }), 's1');
    expect(p.action).toBe('transfer');
  });

  it('no-ops (still pins) when the session is already on the target', () => {
    const p = planTransferByNickname(CMD, state({ currentOwnerOf: () => 'm_mini' }), 's1');
    expect(p).toMatchObject({ action: 'noop', targetMachine: 'm_mini', setPin: true });
  });

  it('requires confirmation when the target is offline', () => {
    const p = planTransferByNickname(CMD, state({ isOnline: () => false }), 's1');
    expect(p.action).toBe('confirm-required');
    expect(p.confirmationPrompt).toMatch(/offline/i);
  });

  it('requires confirmation when transferring off the current owner mid-reply', () => {
    const p = planTransferByNickname(CMD, state({ isMidReply: () => true }), 's1');
    expect(p.action).toBe('confirm-required');
    expect(p.confirmationPrompt).toMatch(/mid-reply|catch-up/i);
  });

  it('does NOT require confirmation mid-reply when already on the target (no move)', () => {
    const p = planTransferByNickname(CMD, state({ currentOwnerOf: () => 'm_mini', isMidReply: () => true }), 's1');
    expect(p.action).toBe('noop');
  });
});

// ── Idempotency before the rate limit (2026-06-05 incident) ─────────────
// A retried/replayed "move to laptop" hit the transfer cooldown and told the
// user "I can't move this right now (rate-limited)" SECONDS after "Moving this
// conversation to Laptop" — for one request that had already succeeded. A
// duplicate of an already-satisfied move must read as "already there", never
// as a rate-limit rejection.
describe('planTransferByNickname — duplicate-move idempotency', () => {
  it('already ON the target within the rate window → noop, NOT rate-limited (the incident)', () => {
    const p = planTransferByNickname(CMD, state({
      currentOwnerOf: () => 'm_mini',
      lastPlacementUpdateAt: () => 999_995, // 5ms ago — inside the 10s window
      now: () => 1_000_000,
    }), 's1');
    expect(p).toMatchObject({ action: 'noop', detail: 'already-on-target' });
  });

  it('already PINNED to the target (ownership not yet re-placed) within the rate window → noop, NOT rate-limited', () => {
    const p = planTransferByNickname(CMD, state({
      currentOwnerOf: () => 'm_ws',          // still owned by the old machine
      currentPinOf: () => 'm_mini',          // but the pin already points at the target
      lastPlacementUpdateAt: () => 999_995,
      now: () => 1_000_000,
    }), 's1');
    expect(p).toMatchObject({ action: 'noop', detail: 'already-pinned-to-target' });
  });

  it('a move to a DIFFERENT machine within the window is still rate-limited (the guard keeps its job)', () => {
    const p = planTransferByNickname(CMD, state({
      currentOwnerOf: () => 'm_ws',
      currentPinOf: () => 'm_ws',            // pinned elsewhere — this is a real move
      lastPlacementUpdateAt: () => 999_995,
      now: () => 1_000_000,
    }), 's1');
    expect(p).toMatchObject({ action: 'reject', rejectReason: 'rate-limited' });
  });

  it('without currentPinOf (backward compat) a pin-only duplicate still rate-limits as before', () => {
    const p = planTransferByNickname(CMD, state({
      currentOwnerOf: () => 'm_ws',
      // currentPinOf absent — pre-existing consumers
      lastPlacementUpdateAt: () => 999_995,
      now: () => 1_000_000,
    }), 's1');
    expect(p).toMatchObject({ action: 'reject', rejectReason: 'rate-limited' });
  });

  it('already-pinned noop still respects an offline target (no confirm prompt needed — nothing moves)', () => {
    const p = planTransferByNickname(CMD, state({
      currentOwnerOf: () => 'm_ws',
      currentPinOf: () => 'm_mini',
      isOnline: () => false,
    }), 's1');
    expect(p.action).toBe('noop');
  });
});
