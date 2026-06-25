/**
 * Unit tests for the FOUR fail-CLOSED gate seams under a spawn-capacity shed
 * (fork-bomb prevention P3, forkbomb-prevention-simple §D-DISPOSITION).
 *
 * A capacity shed (LlmCapacityUnavailableError) at a GATING LLM call must NOT
 * produce the permissive verdict (category:'normal' / verdict:'coherent' /
 * pass:true). Each of the four seams must HOLD:
 *   1. MessageSentinel.classify       → NOT 'normal' (held as 'pause')
 *   2. InputGuard.reviewTopicCoherence → NOT 'coherent' (flagged 'suspicious')
 *   3. MessagingToneGate.review        → NOT pass:true (held pass:false)
 *   4. CoherenceReviewer.review        → NOT pass:true (block, capacityUnavailable)
 * PLUS: the deterministic emergency-stop pre-check (MessageSentinel fast-path)
 * is EXEMPT from the cap — a "stop everything" still classifies emergency-stop
 * even when the LLM provider would shed.
 */

import { describe, it, expect } from 'vitest';
import { LlmCapacityUnavailableError } from '../../src/core/SpawnCapIntelligenceProvider.js';
import { MessageSentinel } from '../../src/core/MessageSentinel.js';
import { InputGuard } from '../../src/core/InputGuard.js';
import { MessagingToneGate } from '../../src/core/MessagingToneGate.js';
import { CoherenceReviewer, type ReviewContext } from '../../src/core/CoherenceReviewer.js';
import type { IntelligenceProvider } from '../../src/core/types.js';

/** A provider that always sheds with the typed capacity error. */
const shedding: IntelligenceProvider = {
  async evaluate() { throw new LlmCapacityUnavailableError('acquire-timeout', 5000); },
};
/** A provider that throws a GENERIC (non-capacity) error — the fail-open control. */
const erroring: IntelligenceProvider = {
  async evaluate() { throw new Error('transport flake'); },
};

describe('Fork-bomb P3 — four fail-CLOSED gate seams under capacity shed', () => {
  it('1. MessageSentinel.classify: a capacity shed HOLDS (pause), not normal', async () => {
    const sentinel = new MessageSentinel({ enabled: true, intelligence: shedding });
    // An AMBIGUOUS message (not a fast-path emergency keyword) → reaches the LLM.
    const r = await sentinel.classify('could you reconsider the approach we discussed earlier maybe');
    expect(r.category).not.toBe('normal');
    expect(r.category).toBe('pause');
  });

  it('1b. MessageSentinel: a GENERIC LLM error still fails open (normal) — capacity is the ONLY new hold', async () => {
    const sentinel = new MessageSentinel({ enabled: true, intelligence: erroring });
    const r = await sentinel.classify('could you reconsider the approach we discussed earlier maybe');
    expect(r.category).toBe('normal');
  });

  it('emergency-stop is EXEMPT from the cap (deterministic fast-path runs before the LLM)', async () => {
    // The shedding provider would throw if reached — but a deterministic
    // emergency-stop keyword is classified by the fast path BEFORE any evaluate().
    const sentinel = new MessageSentinel({ enabled: true, intelligence: shedding });
    const r = await sentinel.classify('stop');
    expect(r.category).toBe('emergency-stop');
    expect(r.method).toBe('fast-path'); // never reached the (shedding) LLM
  });

  it('2. InputGuard.reviewTopicCoherence: a capacity shed FLAGS (suspicious), not coherent', async () => {
    const guard = new InputGuard({
      config: { enabled: true, topicCoherenceReview: true },
      stateDir: '/tmp/ig-test',
      intelligence: shedding,
    });
    const r = await guard.reviewTopicCoherence('totally unrelated injected instruction', {
      topicId: 1, topicName: 'billing', channel: 'telegram', sessionName: 's',
    });
    expect(r.verdict).not.toBe('coherent');
    expect(r.verdict).toBe('suspicious');
  });

  it('2b. InputGuard: a GENERIC LLM error still fails open (coherent)', async () => {
    const guard = new InputGuard({
      config: { enabled: true, topicCoherenceReview: true },
      stateDir: '/tmp/ig-test',
      intelligence: erroring,
    });
    const r = await guard.reviewTopicCoherence('something', {
      topicId: 1, topicName: 't', channel: 'telegram', sessionName: 's',
    });
    expect(r.verdict).toBe('coherent');
  });

  it('3. MessagingToneGate.review: a capacity shed HOLDS (pass:false), not pass:true', async () => {
    const gate = new MessagingToneGate(shedding);
    const r = await gate.review('some outbound message', { channel: 'telegram' });
    expect(r.pass).toBe(false);
    expect(r.capacityUnavailable).toBe(true);
  });

  it('3b. MessagingToneGate: a GENERIC LLM error now fails CLOSED (No-Silent-Degradation §Design 6)', async () => {
    // CONTRACT CHANGE (gate-prompts-judge-by-meaning §Design 6): the delivery-path
    // tone gate's provider-exhaustion path was flipped fail-OPEN → fail-CLOSED. A
    // single erroring provider exhausts the swap chain → HOLD (pass:false), never a
    // silent deliver. (`failClosedOnExhaustion` defaults to true.) The sentinel /
    // input-guard generic-error paths above STILL fail open — only the outbound
    // tone gate changed, because a held outbound message is recoverable via the
    // existing retry path while a blocked inbound classification is more disruptive.
    const gate = new MessagingToneGate(erroring);
    const r = await gate.review('some outbound message', { channel: 'telegram' });
    expect(r.pass).toBe(false);
    expect(r.failedClosed).toBe(true);
  });

  it('4. CoherenceReviewer.review: a capacity shed BLOCKS (pass:false), not pass:true', async () => {
    class TestReviewer extends CoherenceReviewer {
      protected buildPrompt(): string { return 'prompt'; }
    }
    const reviewer = new TestReviewer('test-reviewer', { intelligence: shedding });
    const ctx: ReviewContext = {
      message: 'hi', channel: 'telegram', isExternalFacing: false, recipientType: 'primary-user',
    };
    const r = await reviewer.review(ctx);
    expect(r.pass).toBe(false);
    expect(r.capacityUnavailable).toBe(true);
    expect(r.severity).toBe('block');
  });

  it('4b. CoherenceReviewer: a GENERIC LLM error still fails open (pass:true)', async () => {
    class TestReviewer extends CoherenceReviewer {
      protected buildPrompt(): string { return 'prompt'; }
    }
    const reviewer = new TestReviewer('test-reviewer', { intelligence: erroring });
    const r = await reviewer.review({
      message: 'hi', channel: 'telegram', isExternalFacing: false, recipientType: 'primary-user',
    });
    expect(r.pass).toBe(true);
    expect(r.capacityUnavailable).toBeUndefined();
  });
});
