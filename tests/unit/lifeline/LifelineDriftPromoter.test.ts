import { describe, it, expect, vi } from 'vitest';
import { LifelineDriftPromoter } from '../../../src/lifeline/LifelineDriftPromoter.js';

describe('LifelineDriftPromoter', () => {
  function makeDeps(overrides: Partial<{
    isCleanWindow: () => boolean;
    requestSelfRestart: (r: string) => Promise<void>;
    recordPendingNotice: (info: { observedDiff: number; observedAt: string; reason: string }) => void;
    now: () => number;
    log: (msg: string) => void;
  }> = {}) {
    return {
      isCleanWindow: overrides.isCleanWindow ?? (() => true),
      requestSelfRestart: overrides.requestSelfRestart ?? vi.fn().mockResolvedValue(undefined),
      recordPendingNotice: overrides.recordPendingNotice ?? vi.fn(),
      now: overrides.now,
      log: overrides.log ?? (() => {}),
    };
  }

  describe('config validation', () => {
    it('rejects non-positive thresholds', () => {
      expect(() => new LifelineDriftPromoter(makeDeps(), { threshold: 0 })).toThrow(/positive/);
      expect(() => new LifelineDriftPromoter(makeDeps(), { threshold: -5 })).toThrow(/positive/);
      expect(() => new LifelineDriftPromoter(makeDeps(), { threshold: Number.NaN })).toThrow(/positive/);
    });
    it('rejects non-positive pollIntervalMs', () => {
      expect(() => new LifelineDriftPromoter(makeDeps(), { pollIntervalMs: 0 })).toThrow(/positive/);
    });
  });

  describe('disabled', () => {
    it('starts in disabled state when config disables it', () => {
      const p = new LifelineDriftPromoter(makeDeps(), { enabled: false });
      expect(p._getState().kind).toBe('disabled');
    });
    it('noteDrift is a noop when disabled', () => {
      const deps = makeDeps();
      const p = new LifelineDriftPromoter(deps, { enabled: false, threshold: 5 });
      p.noteDrift(100);
      expect(p._getState().kind).toBe('disabled');
      expect(deps.requestSelfRestart).not.toHaveBeenCalled();
    });
  });

  describe('threshold gating', () => {
    it('noteDrift below threshold is a noop', () => {
      const deps = makeDeps();
      const p = new LifelineDriftPromoter(deps, { threshold: 20 });
      p.noteDrift(15);
      expect(p._getState().kind).toBe('idle');
      expect(deps.requestSelfRestart).not.toHaveBeenCalled();
    });
    it('noteDrift exactly at threshold engages (>=, not >)', () => {
      const deps = makeDeps({ isCleanWindow: () => false });
      const p = new LifelineDriftPromoter(deps, { threshold: 20 });
      p.noteDrift(20);
      expect(p._getState().kind).toBe('pending');
    });
  });

  describe('clean-window flow', () => {
    it('fires immediately when first drift observation lands in a clean window', async () => {
      const deps = makeDeps({ isCleanWindow: () => true });
      const p = new LifelineDriftPromoter(deps, { threshold: 20, pollIntervalMs: 1000 });
      p.noteDrift(30);
      // The immediate try is async — await microtasks.
      await Promise.resolve();
      await Promise.resolve();
      expect(deps.requestSelfRestart).toHaveBeenCalledOnce();
      expect(deps.requestSelfRestart).toHaveBeenCalledWith('drift-auto-promote');
      expect(deps.recordPendingNotice).toHaveBeenCalledWith({
        observedDiff: 30,
        observedAt: expect.any(String),
        reason: 'drift-auto-promote',
      });
      expect(p._getState().kind).toBe('fired');
    });

    it('defers when busy, then fires on next clean tick', async () => {
      let clean = false;
      const deps = makeDeps({ isCleanWindow: () => clean });
      const p = new LifelineDriftPromoter(deps, { threshold: 20, pollIntervalMs: 1000 });
      p.noteDrift(30);
      await Promise.resolve();
      await Promise.resolve();
      expect(deps.requestSelfRestart).not.toHaveBeenCalled();
      expect(p._getState().kind).toBe('pending');

      // Window opens — explicit manual tick.
      clean = true;
      await p._tickForTesting();
      expect(deps.requestSelfRestart).toHaveBeenCalledOnce();
      expect(p._getState().kind).toBe('fired');
    });

    it('keeps the max observed diff when noteDrift is called multiple times while pending', () => {
      const deps = makeDeps({ isCleanWindow: () => false });
      const p = new LifelineDriftPromoter(deps, { threshold: 10 });
      p.noteDrift(15);
      p.noteDrift(12);
      p.noteDrift(25);
      p.noteDrift(20);
      const s = p._getState();
      expect(s.kind).toBe('pending');
      if (s.kind === 'pending') {
        expect(s.observedDiff).toBe(25);
      }
    });

    it('isCleanWindow throw is logged and treated as not-clean (no fire)', async () => {
      const deps = makeDeps({
        isCleanWindow: () => { throw new Error('boom'); },
      });
      const p = new LifelineDriftPromoter(deps, { threshold: 10 });
      p.noteDrift(30);
      await Promise.resolve();
      await Promise.resolve();
      expect(deps.requestSelfRestart).not.toHaveBeenCalled();
      expect(p._getState().kind).toBe('pending');
    });
  });

  describe('hard deadline', () => {
    it('fires when maxDeferMs elapses even if never clean', async () => {
      let nowMs = 1_000_000;
      const deps = makeDeps({
        isCleanWindow: () => false,
        now: () => nowMs,
      });
      const p = new LifelineDriftPromoter(deps, {
        threshold: 10,
        maxDeferMs: 60_000,
        pollIntervalMs: 1000,
      });
      p.noteDrift(30);
      await Promise.resolve();
      await Promise.resolve();
      expect(deps.requestSelfRestart).not.toHaveBeenCalled();

      // Advance past maxDeferMs.
      nowMs += 61_000;
      await p._tickForTesting();
      expect(deps.requestSelfRestart).toHaveBeenCalledOnce();
      expect(deps.requestSelfRestart).toHaveBeenCalledWith('drift-auto-promote-deadline');
    });

    it('maxDeferMs=0 disables the deadline (defers forever)', async () => {
      let nowMs = 1_000_000;
      const deps = makeDeps({
        isCleanWindow: () => false,
        now: () => nowMs,
      });
      const p = new LifelineDriftPromoter(deps, {
        threshold: 10,
        maxDeferMs: 0,
        pollIntervalMs: 1000,
      });
      p.noteDrift(30);
      await Promise.resolve();
      await Promise.resolve();
      nowMs += 24 * 60 * 60_000; // a full day
      await p._tickForTesting();
      expect(deps.requestSelfRestart).not.toHaveBeenCalled();
    });
  });

  describe('idempotency', () => {
    it('a second noteDrift after fired is ignored', async () => {
      const deps = makeDeps({ isCleanWindow: () => true });
      const p = new LifelineDriftPromoter(deps, { threshold: 10 });
      p.noteDrift(30);
      await Promise.resolve();
      await Promise.resolve();
      expect(p._getState().kind).toBe('fired');
      const callCount = (deps.requestSelfRestart as ReturnType<typeof vi.fn>).mock.calls.length;
      p.noteDrift(40);
      await Promise.resolve();
      expect((deps.requestSelfRestart as ReturnType<typeof vi.fn>).mock.calls.length).toBe(callCount);
    });

    it('does not double-fire when tryFire is re-entered concurrently', async () => {
      const deps = makeDeps({
        isCleanWindow: () => true,
        requestSelfRestart: vi.fn().mockImplementation(async () => {
          // Simulate a slow restart that holds the firing lock.
          await new Promise(r => setTimeout(r, 50));
        }),
      });
      const p = new LifelineDriftPromoter(deps, { threshold: 10 });
      p.noteDrift(30);
      // Fire two ticks back-to-back; only one restart should land.
      await Promise.all([p._tickForTesting(), p._tickForTesting(), p._tickForTesting()]);
      expect(deps.requestSelfRestart).toHaveBeenCalledOnce();
    });
  });

  describe('stop()', () => {
    it('stop() clears the tick timer', () => {
      const deps = makeDeps({ isCleanWindow: () => false });
      const p = new LifelineDriftPromoter(deps, { threshold: 10, pollIntervalMs: 100 });
      p.noteDrift(30);
      p.stop();
      // No assertion needed beyond "no throw" — but check state stays pending.
      expect(p._getState().kind).toBe('pending');
    });
  });
});
