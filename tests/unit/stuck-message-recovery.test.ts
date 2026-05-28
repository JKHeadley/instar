/**
 * Unit tests for stuckMessageRecovery — the no-LOSS half of G3a (spec §8 G3a
 * "Stuck-processing recovery"). Real in-memory ledger; both sides of every gate.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { MessageProcessingLedger } from '../../src/messaging/MessageProcessingLedger.js';
import { decideIngress, commitInboundReply, dedupeKeyFor } from '../../src/messaging/ingressDedup.js';
import { recoverStuckMessages } from '../../src/messaging/stuckMessageRecovery.js';

const TOPIC = '13481';
const KEY = dedupeKeyFor('telegram', TOPIC, 5000);

function claim(led: MessageProcessingLedger, key = KEY, input = 'do the thing') {
  decideIngress(led, key, { platform: 'telegram', topic: TOPIC, input, epoch: 1, maxProcessingMs: 300_000 });
}

describe('recoverStuckMessages', () => {
  it('re-runs a stuck processing entry from its stored input (the lost reply)', () => {
    const led = MessageProcessingLedger.openMemory();
    claim(led);
    const reinjected: Array<[string, string, string]> = [];
    const res = recoverStuckMessages({
      ledger: led,
      holdsLease: () => true,
      epoch: 2,
      maxProcessingMs: -1, // any elapsed → stuck (the ledger uses real wall-clock)
      reinject: (t, k, text) => reinjected.push([t, k, text]),
    });
    expect(res.recovered).toBe(1);
    expect(reinjected).toEqual([[TOPIC, KEY, 'do the thing']]);
    expect(led.get(KEY)!.attempts).toBe(2); // re-claimed under the new epoch
    expect(led.get(KEY)!.replyEpoch).toBe(2);
  });

  it('a STANDBY (no lease) never re-injects', () => {
    const led = MessageProcessingLedger.openMemory();
    claim(led);
    const reinjected: unknown[] = [];
    const res = recoverStuckMessages({
      ledger: led, holdsLease: () => false, epoch: 2, maxProcessingMs: -1,
      reinject: () => reinjected.push(1),
    });
    expect(res).toEqual({ recovered: 0, skipped: 0 });
    expect(reinjected).toHaveLength(0);
  });

  it('does NOT re-run an entry already replied (not in processing)', () => {
    const led = MessageProcessingLedger.openMemory();
    claim(led);
    commitInboundReply(led, KEY, 1); // → cursor_advanced
    const reinjected: unknown[] = [];
    const res = recoverStuckMessages({
      ledger: led, holdsLease: () => true, epoch: 2, maxProcessingMs: -1,
      reinject: () => reinjected.push(1),
    });
    expect(res.recovered).toBe(0);
    expect(reinjected).toHaveLength(0);
  });

  it('does NOT re-run a processing entry still within maxProcessingMs (in flight)', () => {
    const led = MessageProcessingLedger.openMemory();
    claim(led);
    const reinjected: unknown[] = [];
    const res = recoverStuckMessages({
      ledger: led, holdsLease: () => true, epoch: 2, maxProcessingMs: 300_000, // generous window
      reinject: () => reinjected.push(1),
    });
    expect(res.recovered).toBe(0);
    expect(reinjected).toHaveLength(0);
  });

  it('gives up after maxReplayAttempts (no infinite storm for an unanswered message)', () => {
    const led = MessageProcessingLedger.openMemory();
    claim(led);
    // Drive attempts up to the cap via repeated recovery passes.
    const run = () => recoverStuckMessages({
      ledger: led, holdsLease: () => true, epoch: 1, maxProcessingMs: -1, maxReplayAttempts: 3,
      reinject: () => {},
    });
    run(); // attempts 1→2
    run(); // 2→3
    const third = run(); // attempts now 3 ≥ 3 → skip
    expect(third.recovered).toBe(0);
    expect(third.skipped).toBe(1);
    expect(led.get(KEY)!.attempts).toBe(3); // not bumped past the cap
  });

  it('skips an entry with no stored input (cannot replay what was not captured)', () => {
    const led = MessageProcessingLedger.openMemory();
    // record without input, then claim → processing but inputSnapshot null
    led.record(KEY, { platform: 'telegram', topic: TOPIC });
    led.beginProcessing(KEY, 1);
    const res = recoverStuckMessages({
      ledger: led, holdsLease: () => true, epoch: 1, maxProcessingMs: -1,
      reinject: () => { throw new Error('should not reinject'); },
    });
    expect(res.recovered).toBe(0);
    expect(res.skipped).toBe(1);
  });
});

/**
 * Wiring-integrity: recoverStuckMessages must actually be CALLED at boot (after
 * server.start()), inside the messageLedger-gated block, lease-gated via the
 * coordinator. The absence of exactly this kind of assertion is what let dead
 * code ship as "wired" before (PR #334). Source-level because the boot path
 * needs a live Telegram adapter to exercise behaviorally; the live flag-flip
 * test-as-self exercises the actual re-injection.
 */
describe('stuck-message recovery — boot wiring integrity', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', '..', 'src', 'commands', 'server.ts'),
    'utf-8',
  );
  it('server.ts calls recoverStuckMessages after server.start(), gated on messageLedger + lease', () => {
    const startIdx = src.indexOf('await server.start()');
    const callIdx = src.indexOf('recoverStuckMessages({', startIdx);
    expect(callIdx).toBeGreaterThan(startIdx); // called AFTER the server is listening
    // The enclosing block is gated on the ledger (flag on) and lease-checks via coordinator.
    const block = src.slice(startIdx, callIdx + 400);
    expect(block).toMatch(/if \(messageLedger && currentInboundByTopic && telegram\)/);
    expect(block).toMatch(/holdsLease: \(\) => coordinator\.holdsLease\(\)/);
  });
});
