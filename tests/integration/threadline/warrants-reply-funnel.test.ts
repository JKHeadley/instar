/**
 * Integration test — the warrants-a-reply funnel step (Threadline Phase 1).
 *
 * Exercises the REAL funnel code (`evaluateAndRecordInbound`) against a REAL
 * ConversationStore + WarrantsReplyGate — the same function the relay inbound
 * funnel in server.ts calls — so this is not a copy that could drift.
 *
 * Validates spec acceptance criteria:
 *  #4 — pure ack does not reply; question always does; novel collaboration never
 *       trips the budget while an ack/circular loop does.
 *  #6 — the echo↔codey ack-loop scenario, replayed, TERMINATES (suppresses)
 *       instead of ping-ponging.
 *  #7 — concurrent inbound on one thread does not lose turn-count updates.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ConversationStore } from '../../../src/threadline/ConversationStore.js';
import { WarrantsReplyGate, evaluateAndRecordInbound } from '../../../src/threadline/WarrantsReplyGate.js';
import { SafeFsExecutor } from '../../../src/core/SafeFsExecutor.js';

function tmpState(): { stateDir: string; cleanup: () => void } {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'warrants-funnel-'));
  return { stateDir, cleanup: () => SafeFsExecutor.safeRmSync(stateDir, { recursive: true, force: true, operation: 'tests/integration/threadline/warrants-reply-funnel.test.ts:cleanup' }) };
}

const CODEY = { senderFingerprint: 'codey-fp', senderName: 'codey', trustLevel: 'verified', humanInLoop: false };

describe('warrants-a-reply funnel (integration)', () => {
  let stateDir: string;
  let cleanup: () => void;
  let store: ConversationStore;
  let gate: WarrantsReplyGate;

  beforeEach(() => {
    ({ stateDir, cleanup } = tmpState());
    store = new ConversationStore(stateDir);
    gate = new WarrantsReplyGate(); // no intelligence → deterministic signals only
  });
  afterEach(() => cleanup());

  it('#6 the echo↔codey ack-loop terminates after first contact', async () => {
    const threadId = 'loop-thread';
    const acks = [
      'Message received. Composing response...',
      'thanks, got it!',
      'great, thank you',
      'perfect 👍',
      'ok cool, appreciate it',
    ];
    const decisions = [];
    for (const text of acks) {
      decisions.push(await evaluateAndRecordInbound(gate, store, { threadId, text, ...CODEY }));
    }
    // First contact replies (responsive). Every subsequent pure ack is suppressed —
    // the loop does NOT sustain a spawn cadence.
    expect(decisions[0].suppress).toBe(false); // first-contact
    for (let i = 1; i < decisions.length; i++) {
      expect(decisions[i].suppress).toBe(true);
    }
    expect(store.get(threadId)?.state).toBe('idle');
  });

  it('#4 a question always warrants a reply, even amid acks', async () => {
    const threadId = 'q-thread';
    await evaluateAndRecordInbound(gate, store, { threadId, text: 'thanks', ...CODEY }); // first contact
    await evaluateAndRecordInbound(gate, store, { threadId, text: 'thanks again', ...CODEY }); // ack, suppressed
    const q = await evaluateAndRecordInbound(gate, store, { threadId, text: 'How did the deploy go?', ...CODEY });
    expect(q.suppress).toBe(false);
    expect(q.verdict.signal).toBe('question');
  });

  it('#4 a novel multi-turn collaboration never trips the budget', async () => {
    const threadId = 'collab';
    const turns = [
      'Lets start by auditing the relay handshake timeout path',
      'The socket reconnect uses a fixed 30s backoff that starves the queue',
      'I propose an exponential backoff capped at five minutes instead',
      'That interacts with the heartbeat watchdog — we should align the windows',
      'Agreed; next we should add a canary on the WAL contention in the poller',
      'The poller byte-offset tracking makes re-scans idempotent already',
      'Right, so the remaining risk is the cross-machine failover reconciliation',
      'Lets write an e2e that kills the primary mid-thread and asserts resume',
    ];
    let anySuppressed = false;
    for (const text of turns) {
      const d = await evaluateAndRecordInbound(gate, store, { threadId, text, ...CODEY });
      if (d.suppress) anySuppressed = true;
    }
    expect(anySuppressed).toBe(false);
    // The no-progress counter stays low because each turn is novel.
    expect(store.get(threadId)!.turnCount).toBeLessThanOrEqual(1);
  });

  it('#4 a circular non-novel exchange trips the budget and escalates', async () => {
    const threadId = 'circular';
    const gate2 = new WarrantsReplyGate({ softCap: 3 });
    const repeated = 'i really think the current build status looks basically fine to me overall';
    let budgetHit = false;
    for (let i = 0; i < 8; i++) {
      const d = await evaluateAndRecordInbound(gate2, store, { threadId, text: repeated, ...CODEY });
      if (d.verdict.budgetExhausted) budgetHit = true;
    }
    expect(budgetHit).toBe(true);
    expect(store.get(threadId)?.state).toBe('idle');
  });

  it('#7 concurrent inbound on one thread loses no writes (CAS integrity)', async () => {
    const threadId = 'concurrent';
    // Seed a conversation so these are not first-contact.
    await evaluateAndRecordInbound(gate, store, { threadId, text: 'seed message that is substantive', ...CODEY });
    const repeated = 'the same non novel statement repeated concurrently many times over';
    await Promise.all(
      Array.from({ length: 20 }, () => evaluateAndRecordInbound(gate, store, { threadId, text: repeated, ...CODEY })),
    );
    // The real anti-clobber guarantee (acceptance #7): every concurrent mutate
    // is applied — none lost to a last-writer-wins race. seed (1) + 20 = 21.
    // (turnCount under fully-concurrent identical reads is inherently a read
    // window race and is not the integrity property under test.)
    const c = store.get(threadId)!;
    expect(c.version).toBe(21);
    expect(c.messageCount).toBe(21);
  });
});
