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
    expect(res).toEqual({ recovered: 0, skipped: 0, alreadyHandled: 0, abandoned: [] });
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
    const third = run(); // attempts now 3 ≥ 3 → abandon
    expect(third.recovered).toBe(0);
    expect(third.skipped).toBe(1);
    expect(led.get(KEY)!.attempts).toBe(3); // not bumped past the cap
  });

  // ── Gap #2 (2026-06-15): exhausted entry is TERMINALLY abandoned + surfaced, not
  // left to re-loop the give-up log every cycle nor silently dropped ──
  it('abandons an exhausted entry: marks it terminal, surfaces it, and stops re-selecting it', () => {
    const led = MessageProcessingLedger.openMemory();
    claim(led);
    const run = () => recoverStuckMessages({
      ledger: led, holdsLease: () => true, epoch: 1, maxProcessingMs: -1, maxReplayAttempts: 3,
      reinject: () => {},
    });
    run(); run(); // attempts → 3
    const exhausting = run(); // attempts 3 ≥ 3 → abandon THIS pass
    expect(exhausting.abandoned).toEqual([{ topic: TOPIC, dedupeKey: KEY }]);
    // Terminal 'abandoned' state — out of 'processing', no false reply evidence.
    expect(led.get(KEY)!.state).toBe('abandoned');
    expect(led.get(KEY)!.abandonedAt).toBeTruthy();
    expect(led.get(KEY)!.replyCommittedAt).toBeNull();
    expect(led.isActedOn(KEY)).toBe(true); // a redelivery of the SAME event is dropped
    // The give-up loop is gone: a subsequent pass does NOT re-select or re-surface it.
    const next = run();
    expect(next.abandoned).toEqual([]);
    expect(next.skipped).toBe(0);
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

  // ── 1A: reply-evidence guard (the 2026-06-07 every-~10-min "from Unknown" loop) ──
  it('does NOT re-run a stuck entry whose topic was already answered since it arrived (commits it instead)', () => {
    const led = MessageProcessingLedger.openMemory();
    claim(led); // entry stuck in processing, its own reply never committed
    const reinjected: unknown[] = [];
    const res = recoverStuckMessages({
      ledger: led, holdsLease: () => true, epoch: 2, maxProcessingMs: -1,
      // The agent DID reply to this topic since the entry arrived — evidence the
      // message was effectively handled (a duplicate / a reply that failed to commit).
      hasRepliedSince: () => true,
      reinject: () => reinjected.push(1),
    });
    expect(res.recovered).toBe(0);
    expect(res.alreadyHandled).toBe(1);
    expect(reinjected).toHaveLength(0);
    // Committed so it leaves 'processing' for good — no more ~10-min re-runs.
    expect(led.isActedOn(KEY)).toBe(true);
  });

  it('reply-evidence guard defaults to the ledger: a reply committed on the topic AFTER the stuck entry arrived suppresses the re-run', () => {
    const led = MessageProcessingLedger.openMemory();
    // The stuck entry (a duplicate / a turn whose own reply failed to commit) arrives FIRST.
    claim(led);
    // THEN the agent answers the topic (commits a sibling inbound) — exactly the
    // real incident: the report arrived, then I replied to the topic repeatedly.
    const sibling = dedupeKeyFor('telegram', TOPIC, 6000);
    decideIngress(led, sibling, { platform: 'telegram', topic: TOPIC, input: 'later', epoch: 1, maxProcessingMs: 300_000 });
    commitInboundReply(led, sibling, 1); // reply_committed_at >= the stuck entry's receivedAt
    const reinjected: unknown[] = [];
    const res = recoverStuckMessages({
      ledger: led, holdsLease: () => true, epoch: 2, maxProcessingMs: -1,
      reinject: () => reinjected.push(1), // NO explicit hasRepliedSince → uses ledger query
    });
    expect(res.alreadyHandled).toBe(1);
    expect(reinjected).toHaveLength(0);
    expect(led.isActedOn(KEY)).toBe(true);
  });

  it('still re-runs a genuinely unanswered stuck entry (no reply evidence on the topic)', () => {
    const led = MessageProcessingLedger.openMemory();
    claim(led);
    const reinjected: unknown[] = [];
    const res = recoverStuckMessages({
      ledger: led, holdsLease: () => true, epoch: 2, maxProcessingMs: -1,
      hasRepliedSince: () => false, // no reply since the entry arrived → legitimately lost
      reinject: () => reinjected.push(1),
    });
    expect(res.recovered).toBe(1);
    expect(res.alreadyHandled).toBe(0);
    expect(reinjected).toHaveLength(1);
  });

  // ── 1B: sender preservation (no "from Unknown" on a legitimate re-run) ──
  it('preserves the original sender envelope when re-injecting a recovered entry', () => {
    const led = MessageProcessingLedger.openMemory();
    decideIngress(led, KEY, {
      platform: 'telegram', topic: TOPIC, input: 'do the thing',
      sender: { userId: 7812716706, username: 'justin', firstName: 'Justin' },
      epoch: 1, maxProcessingMs: 300_000,
    });
    const reinjected: Array<[string, string, string, unknown]> = [];
    const res = recoverStuckMessages({
      ledger: led, holdsLease: () => true, epoch: 2, maxProcessingMs: -1,
      hasRepliedSince: () => false,
      reinject: (t, k, text, sender) => reinjected.push([t, k, text, sender]),
    });
    expect(res.recovered).toBe(1);
    expect(reinjected[0][3]).toEqual({ userId: 7812716706, username: 'justin', firstName: 'Justin' });
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

  it('reinjectStuck forwards the stored sender (no "from Unknown") into the replayed message metadata', () => {
    // The replay must carry the real sender into the metadata fields
    // messageToPipeline reads (firstName/username/telegramUserId), not a hardcoded
    // userId:'unknown'. This is the identity-loss half of the 2026-06-07 fix.
    const reinjectIdx = src.indexOf('const reinjectStuck =');
    expect(reinjectIdx).toBeGreaterThan(0);
    const block = src.slice(reinjectIdx, reinjectIdx + 1200);
    expect(block).toMatch(/sender\??\.userId/);     // uses the preserved sender id
    expect(block).toMatch(/firstName: sender\.firstName/); // sets the prefix name
  });
});

/**
 * Part D, third site (docs/specs/ownership-follows-live-work.md): the
 * `ownerElsewhereReachable` per-topic gate ON TOP of the existing machine-level
 * holdsLease() gate. A topic owned by a REACHABLE peer is SKIPPED — its stuck
 * messages stay IN the durable ledger UNTOUCHED so the owner drains them.
 */
describe('recoverStuckMessages — Part D per-topic owner gate', () => {
  it('SKIPS a topic owned by a reachable peer (entry left untouched in the ledger, never re-injected)', () => {
    const led = MessageProcessingLedger.openMemory();
    claim(led);
    const reinjected: unknown[] = [];
    const res = recoverStuckMessages({
      ledger: led, holdsLease: () => true, epoch: 2, maxProcessingMs: -1,
      reinject: () => reinjected.push(1),
      ownerElsewhereReachable: (topic) => topic === TOPIC, // a reachable peer owns it
    });
    expect(res.recovered).toBe(0);
    expect(res.skipped).toBe(1);
    expect(reinjected).toHaveLength(0);
    // UNTOUCHED: still 'processing', attempts NOT bumped, NOT abandoned/committed.
    const entry = led.get(KEY)!;
    expect(entry.attempts).toBe(1);
    expect(entry.state).toBe('processing');
  });

  it('does NOT skip a topic this machine owns / unowned (re-feeds as today)', () => {
    const led = MessageProcessingLedger.openMemory();
    claim(led);
    const reinjected: Array<[string, string, string]> = [];
    const res = recoverStuckMessages({
      ledger: led, holdsLease: () => true, epoch: 2, maxProcessingMs: -1,
      reinject: (t, k, text) => reinjected.push([t, k, text]),
      ownerElsewhereReachable: () => false, // not owned by a reachable peer
    });
    expect(res.recovered).toBe(1);
    expect(reinjected).toEqual([[TOPIC, KEY, 'do the thing']]);
  });

  it('regression-lock: with NO ownerElsewhereReachable dep (flag off / legacy), re-feeds exactly as today', () => {
    const led = MessageProcessingLedger.openMemory();
    claim(led);
    const reinjected: Array<[string, string, string]> = [];
    const res = recoverStuckMessages({
      ledger: led, holdsLease: () => true, epoch: 2, maxProcessingMs: -1,
      reinject: (t, k, text) => reinjected.push([t, k, text]),
      // ownerElsewhereReachable absent → no ownership check
    });
    expect(res.recovered).toBe(1);
    expect(reinjected).toHaveLength(1);
  });
});

/**
 * Wiring-integrity: the forward route must CAPTURE the sender into the ledger at
 * ingress — otherwise a recovery re-run has nothing to replay as and falls back
 * to "Unknown". Source-level guard against the capture silently regressing.
 */
describe('exactly-once ingress — sender capture wiring', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', '..', 'src', 'server', 'routes.ts'),
    'utf-8',
  );
  it('decideIngress is called with a sender envelope built from the inbound', () => {
    const callIdx = src.indexOf('decideIngress(ctx.messageLedger, dedupeKey, {');
    expect(callIdx).toBeGreaterThan(0);
    const block = src.slice(callIdx, callIdx + 400);
    expect(block).toMatch(/sender:\s*\{/);
    expect(block).toMatch(/userId: fromUserId/);
    expect(block).toMatch(/firstName: fromFirstName/);
  });
});
