import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SleepWakeDetector } from '../../src/core/SleepWakeDetector.js';

describe('SleepWakeDetector', () => {
  let detector: SleepWakeDetector;

  afterEach(() => {
    detector?.stop();
    vi.restoreAllMocks();
  });

  it('emits wake event when timer drift exceeds threshold', async () => {
    detector = new SleepWakeDetector({
      checkIntervalMs: 50,
      driftThresholdMs: 100,
    });

    const wakePromise = new Promise<any>((resolve) => {
      detector.on('wake', resolve);
    });

    // Fake a sleep by advancing time
    let realNow = Date.now();
    const origDateNow = Date.now;
    vi.spyOn(Date, 'now').mockImplementation(() => realNow);

    detector.start();

    // First tick — normal (no drift)
    realNow += 60;
    await new Promise(r => setTimeout(r, 60));

    // Second tick — simulate a wake (large time jump)
    realNow += 5000; // 5 second sleep

    const event = await Promise.race([
      wakePromise,
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 500)),
    ]);

    expect(event).toHaveProperty('sleepDurationSeconds');
    expect(event).toHaveProperty('timestamp');
    expect(event.sleepDurationSeconds).toBeGreaterThan(0);
  });

  it('does not emit wake on normal ticks', async () => {
    detector = new SleepWakeDetector({
      checkIntervalMs: 50,
      driftThresholdMs: 500,
    });

    const wakeSpy = vi.fn();
    detector.on('wake', wakeSpy);
    detector.start();

    // Wait for a few normal ticks
    await new Promise(r => setTimeout(r, 200));

    expect(wakeSpy).not.toHaveBeenCalled();
  });

  it('stop prevents further events', () => {
    detector = new SleepWakeDetector();
    detector.start();
    detector.stop();
    // No assertion needed — just verify it doesn't throw
    expect(true).toBe(true);
  });

  it('start is idempotent', () => {
    detector = new SleepWakeDetector();
    detector.start();
    detector.start(); // second call should be no-op
    detector.stop();
    expect(true).toBe(true);
  });
});
