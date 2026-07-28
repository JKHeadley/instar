/**
 * Tier-1 tests for PeerFailureLogGate — bounded per-peer failure logging for
 * fixed-cadence mesh loops (P19 brake: per-attempt log lines are amplification).
 *
 * The P19 sustained-failure pattern: a full day of failed 5s-cadence attempts
 * against a down peer must produce ~tens of log lines, never ~17,000.
 */

import { describe, it, expect } from 'vitest';
import { PeerFailureLogGate } from '../../src/core/PeerFailureLogGate.js';

describe('PeerFailureLogGate', () => {
  it('logs the FIRST failure, suppresses the streak, reminds every Nth', () => {
    const gate = new PeerFailureLogGate(5);
    expect(gate.failed('pull from m1', 'ECONNREFUSED')).toContain('became unreachable');
    expect(gate.failed('pull from m1', 'ECONNREFUSED')).toBeNull(); // #2
    expect(gate.failed('pull from m1', 'ECONNREFUSED')).toBeNull(); // #3
    expect(gate.failed('pull from m1', 'ECONNREFUSED')).toBeNull(); // #4
    const reminder = gate.failed('pull from m1', 'ECONNREFUSED'); // #5
    expect(reminder).toContain('still unreachable (5 consecutive failures)');
  });

  it('logs recovery exactly once, then steady success is silent', () => {
    const gate = new PeerFailureLogGate(5);
    gate.failed('pull from m1', 'x');
    gate.failed('pull from m1', 'x');
    expect(gate.succeeded('pull from m1')).toContain('recovered after 2 consecutive failures');
    expect(gate.succeeded('pull from m1')).toBeNull();
    expect(gate.succeeded('pull from m1')).toBeNull();
  });

  it('steady healthy state never logs', () => {
    const gate = new PeerFailureLogGate(5);
    for (let i = 0; i < 100; i++) expect(gate.succeeded('pull from m1')).toBeNull();
  });

  it('keys are independent (one peer down does not affect another)', () => {
    const gate = new PeerFailureLogGate(5);
    expect(gate.failed('pull from m1', 'x')).not.toBeNull();
    expect(gate.failed('pull from m2', 'x')).not.toBeNull(); // m2's own first failure
    expect(gate.succeeded('pull from m2')).not.toBeNull();
    expect(gate.failed('pull from m1', 'x')).toBeNull(); // m1 streak unaffected
  });

  it('SUSTAINED-FAILURE BOUND (P19): a day of 5s-cadence failures logs ⌈F/N⌉+1 lines, not F', () => {
    const gate = new PeerFailureLogGate(360); // shipped default
    const attemptsPerDay = Math.floor((24 * 3600) / 5); // 17,280
    let lines = 0;
    for (let i = 0; i < attemptsPerDay; i++) {
      if (gate.failed('pull from m1', 'down')) lines++;
    }
    expect(lines).toBe(1 + Math.floor(attemptsPerDay / 360)); // 49
    expect(lines).toBeLessThan(50);
  });

  it('a new streak after recovery starts fresh (first-failure line again)', () => {
    const gate = new PeerFailureLogGate(5);
    gate.failed('k', 'x');
    gate.succeeded('k');
    expect(gate.failed('k', 'x')).toContain('became unreachable');
  });
});
