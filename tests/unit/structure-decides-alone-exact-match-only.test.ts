/**
 * *Structure Decides Alone Only on an Exact Match* — the ratchet.
 *
 * Operator ruling A, 2026-08-07: structure may decide ALONE only on an EXACT,
 * whole-message match from a short enumerated list — never a substring, never a
 * prefix, never a regex. Every other decision of consequence is the mind's.
 *
 * The ruling exists because an external family reviewer found the emergency-stop
 * split contradicting *The Body and the Mind* ("every decision of consequence is
 * made by the mind" vs the floor's "decides alone"). Measuring the code against
 * the new rule then showed it had NEVER obeyed it: a prefix layer sat beneath the
 * exact sets and was what actually fired — `stop the build please` killed the
 * session, and `hold on a sec` was consumed.
 *
 * EVERY test here constructs the sentinel with NO intelligence provider. That is
 * the isolation that makes the file meaningful: with no model attached, anything
 * that still produces a kill/pause is *structure deciding alone*, which is exactly
 * the authority the rule bounds.
 */
import { describe, it, expect } from 'vitest';
import { MessageSentinel, FAST_STOP_EXACT, FAST_PAUSE_EXACT, SLASH_STOP, SLASH_PAUSE, FAST_STOP_PATTERNS, FAST_PAUSE_PATTERNS } from '../../src/core/MessageSentinel.js';
import type { IntelligenceProvider } from '../../src/core/types.js';

/**
 * A provider that is PRESENT but UNAVAILABLE — the capacity-shed condition.
 * This is the blind spot the first version of this file had: it constructed the
 * sentinel with NO provider, which takes a different branch entirely. Production
 * always has a provider, so "no provider" never exercised the fallback path where
 * a substring rescue was still killing. Found by Codey's advisory review.
 */
function shedProvider(): IntelligenceProvider {
  return { evaluate: async () => { throw Object.assign(new Error('cap'), { capacityUnavailable: true }); } } as unknown as IntelligenceProvider;
}
/** A provider that returns `pause` — the other route into the same rescue path. */
function pauseProvider(): IntelligenceProvider {
  return { evaluate: async () => 'pause' } as unknown as IntelligenceProvider;
}

/** No provider → every non-pass-through verdict is structure acting on its own. */
function structureOnly() {
  return new MessageSentinel({});
}

const DECIDES = new Set(['kill', 'pause']);

describe('structure decides alone ONLY on an exact match', () => {
  it('A-CASE: every enumerated stop entry decides alone', async () => {
    const s = structureOnly();
    for (const entry of [...FAST_STOP_EXACT, ...SLASH_STOP]) {
      const d = await s.decideInboundDisposition(entry, 1);
      expect(d.disposition, `enumerated stop "${entry}" must decide`).toBe('kill');
      expect(d.method).toBe('fast-path');
    }
  });

  it('A-CASE: every enumerated pause entry decides alone', async () => {
    const s = structureOnly();
    // A DISTINCT topic per entry, deliberately. The operator-channel-sacred
    // circuit-breaker caps pause-CONSUMES per topic per window, so looping the
    // whole list against one topic trips it and later entries route through —
    // which the first version of this test did, and read as a rule violation.
    // The breaker firing there was correct behaviour, not a defect; isolating
    // the topic is what makes this arm measure the exact-match rule instead.
    let topic = 9000;
    for (const entry of [...FAST_PAUSE_EXACT, ...SLASH_PAUSE]) {
      const d = await s.decideInboundDisposition(entry, topic++);
      expect(d.disposition, `enumerated pause "${entry}" must decide`).toBe('pause');
    }
  });

  /**
   * The load-bearing arm. Checked over the WHOLE enumerated list rather than a
   * sampled few, because the defect this rule was written against was precisely a
   * prefix match: an entry that decides when it is a PREFIX of a longer message is
   * structure deciding alone on a substring.
   */
  it('THE PROPERTY: no enumerated entry decides when it is merely a PREFIX of a longer message', async () => {
    const s = structureOnly();
    const suffixes = [' the build please', ' deploying for now', ' a sec', ' warning me'];
    const violations: string[] = [];

    let topic = 9500;
    for (const entry of [...FAST_STOP_EXACT, ...FAST_PAUSE_EXACT]) {
      for (const suffix of suffixes) {
        const message = `${entry}${suffix}`;
        const d = await s.decideInboundDisposition(message, topic++);
        if (DECIDES.has(d.disposition)) violations.push(`${JSON.stringify(message)} → ${d.disposition} (${d.reason})`);
      }
    }

    expect(violations, 'structure decided alone on a non-exact message').toEqual([]);
  });

  it("the operator's own scoped phrasings route to the mind, not to a kill", async () => {
    const s = structureOnly();
    // The exact messages measured as session-killers before the ruling landed.
    for (const message of ['stop the build please', 'stop deploying for now', 'stop the tests']) {
      const d = await s.decideInboundDisposition(message, 1);
      expect(d.disposition, `"${message}" must not be structure's call`).toBe('route-through');
    }
  });

  it('a pause phrasing that our own classifier prompt calls NORMAL is not consumed', async () => {
    // `/^hold on/i` consumed "hold on a sec" while the LLM prompt in this same
    // file states "hold on" is NORMAL unless directing the agent. Consuming an
    // operator message is the failure *The Operator Channel Is Sacred* was
    // earned from, so this arm is pinned separately from the property above.
    const d = await structureOnly().decideInboundDisposition('hold on a sec', 1);
    expect(d.disposition).not.toBe('pause');
  });

  it('RATCHET: the prefix pattern layers stay EMPTY — re-adding a regex floor fails here', () => {
    // The rule permits an enumerated list and nothing else. A future author
    // re-introducing a pattern layer would silently restore substring authority;
    // this is the arm that refuses it.
    expect(FAST_STOP_PATTERNS, 'a stop regex layer would give structure substring authority').toEqual([]);
    expect(FAST_PAUSE_PATTERNS, 'a pause regex layer would give structure substring authority').toEqual([]);
  });

  /**
   * SHRINK-ONLY floor. Found by injection while proving this very file: removing an
   * enumerated entry passed every other arm silently. The exactness rule bounds the
   * FORM of the exception, so nothing above notices the list getting SMALLER — and a
   * smaller list is a narrower safety floor, which is the direction that costs an
   * operator a halt they expected to work.
   *
   * This pins the committed core. Growing the list stays a reviewed diff (adding a
   * line here); SHRINKING it now requires deleting a line here too, in the open.
   */
  it('SHRINK-ONLY: the committed core of the enumerated stop floor may not silently disappear', () => {
    const COMMITTED_CORE = [
      'stop', 'stop!', 'stop now', 'stop immediately', 'stop everything', 'stop right now',
      'stop it', 'stop this', 'stop that', 'please stop', 'no stop',
      'abort', 'cancel', 'kill', 'kill it', 'cancel everything', 'abort everything',
      'cease', 'halt', 'quit', 'terminate', "don't do that", "don't do anything",
    ];
    const missing = COMMITTED_CORE.filter((e) => !FAST_STOP_EXACT.has(e));
    expect(missing, 'an enumerated halt phrasing was removed from the safety floor').toEqual([]);
  });

  /**
   * THE ARM THE FIRST VERSION OF THIS FILE LACKED.
   *
   * Every test above builds the sentinel with NO provider. Production builds one
   * WITH a provider, and a provider that is present-but-unavailable takes the
   * capacity-shed branch: the classifier falls back to `pause`, and a substring
   * rescue then upgraded that to KILL. So the exactness rule was satisfied on the
   * path the tests drove and violated on the path production uses.
   *
   * Reproduced before being fixed — all four of these killed the session.
   */
  it.each([
    ['stop the build please', 'a scoped request'],
    ['this was a non-stop session', '"non-stop" contains "stop"'],
    ['please do not cancel the review because it is complete', 'MEANING INVERTED — the operator says do NOT cancel'],
    ['/stop the build only', 'a slash-command PREFIX, not an exact command'],
  ])('CAPACITY SHED: %j must not be killed by structure (%s)', async (message) => {
    const d = await new MessageSentinel({ intelligence: shedProvider() }).decideInboundDisposition(message, 8100 + message.length);
    expect(d.disposition).not.toBe('kill');
  });

  it('CAPACITY SHED A-CASE: an EXACT stop still kills when the provider is unavailable', async () => {
    let topic = 8200;
    for (const m of ['stop', 'stop everything', '/stop', 'cancel everything']) {
      const d = await new MessageSentinel({ intelligence: shedProvider() }).decideInboundDisposition(m, topic++);
      expect(d.disposition, `exact "${m}" must still kill under shed`).toBe('kill');
    }
  });

  it('MODEL-PAUSE: an EXACT stop still kills; a non-exact message does not', async () => {
    // The second route into the same rescue: the model returns `pause`.
    const exact = await new MessageSentinel({ intelligence: pauseProvider() }).decideInboundDisposition('stop everything', 8300);
    expect(exact.disposition).toBe('kill');
    const inexact = await new MessageSentinel({ intelligence: pauseProvider() }).decideInboundDisposition('please stop warning me about memory', 8301);
    expect(inexact.disposition).not.toBe('kill');
  });

  it('DISCRIMINATOR: the harness can produce a kill, so the refusals above mean something', async () => {
    const d = await structureOnly().decideInboundDisposition('stop', 1);
    expect(d.disposition).toBe('kill');
  });
});
