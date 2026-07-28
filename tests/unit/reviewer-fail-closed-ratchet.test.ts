/**
 * CI RATCHET (reviewer-fail-closed-on-abstain §9, CMT-1794) — No Silent
 * Degradation for the coherence reviewers.
 *
 * The invariant: EVERY reviewer subclass, when its LLM call errors/times out/
 * returns nothing usable, must report an ABSTAIN (`abstained: true`) — NEVER a
 * silent permissive verdict. The base CoherenceReviewer.review() tags abstains;
 * a subclass that OVERRIDES review() (escalation-resolution does) must tag them
 * itself. This ratchet drives every registered reviewer through a forced error
 * and fails the build if any returns a verdict without the abstain tag — so a
 * future reviewer (or a future override) cannot silently reintroduce the
 * fail-open this work removed.
 */

import { describe, it, expect } from 'vitest';
import type { IntelligenceProvider, ReviewContext } from '../../src/core/CoherenceReviewer.js';
import { CoherenceReviewer } from '../../src/core/CoherenceReviewer.js';
import { ConversationalToneReviewer } from '../../src/core/reviewers/conversational-tone.js';
import { ClaimProvenanceReviewer } from '../../src/core/reviewers/claim-provenance.js';
import { SettlingDetectionReviewer } from '../../src/core/reviewers/settling-detection.js';
import { ContextCompletenessReviewer } from '../../src/core/reviewers/context-completeness.js';
import { CapabilityAccuracyReviewer } from '../../src/core/reviewers/capability-accuracy.js';
import { UrlValidityReviewer } from '../../src/core/reviewers/url-validity.js';
import { ValueAlignmentReviewer } from '../../src/core/reviewers/value-alignment.js';
import { InformationLeakageReviewer } from '../../src/core/reviewers/information-leakage.js';
import { EscalationResolutionReviewer } from '../../src/core/reviewers/escalation-resolution.js';

// A provider that always throws a generic (non-capacity) error → the reviewer
// must ABSTAIN, never silently pass.
const throwingProvider: IntelligenceProvider = {
  async evaluate() {
    throw new Error('transport flake');
  },
} as unknown as IntelligenceProvider;

const REVIEWER_CLASSES: Array<{ name: string; cls: new (o?: any) => CoherenceReviewer }> = [
  { name: 'conversational-tone', cls: ConversationalToneReviewer },
  { name: 'claim-provenance', cls: ClaimProvenanceReviewer },
  { name: 'settling-detection', cls: SettlingDetectionReviewer },
  { name: 'context-completeness', cls: ContextCompletenessReviewer },
  { name: 'capability-accuracy', cls: CapabilityAccuracyReviewer },
  { name: 'url-validity', cls: UrlValidityReviewer },
  { name: 'value-alignment', cls: ValueAlignmentReviewer },
  { name: 'information-leakage', cls: InformationLeakageReviewer },
  { name: 'escalation-resolution', cls: EscalationResolutionReviewer },
];

const ctx: ReviewContext = {
  message: 'A normal status update message used to drive the reviewers under a forced LLM error.',
  recentMessages: [],
} as unknown as ReviewContext;

describe('reviewer-fail-closed ratchet — every reviewer abstains on LLM error (never silent pass)', () => {
  for (const { name, cls } of REVIEWER_CLASSES) {
    it(`${name}: a forced LLM error → abstained:true (NOT a silent permissive pass)`, async () => {
      const reviewer = new cls({ model: 'haiku', mode: 'block', timeoutMs: 500, intelligence: throwingProvider });
      const result = await reviewer.review(ctx);
      expect(
        result.abstained,
        `${name} returned a verdict without abstained:true on a forced LLM error — a silent fail-open (No Silent Degradation violation)`,
      ).toBe(true);
    });
  }

  it('the review()-overriding subclasses are the KNOWN set (a new override is a deliberate, reviewed choice)', () => {
    // Structural guard: the per-reviewer forced-error test above proves every
    // CURRENT override tags abstains (information-leakage delegates to
    // super.review(); escalation-resolution tags in its own catch). This asserts
    // the override SET so a FUTURE subclass overriding review() trips this and is
    // forced through review — preventing a silent fail-open from a new override.
    const overriders = REVIEWER_CLASSES.filter(
      ({ cls }) => Object.prototype.hasOwnProperty.call(cls.prototype, 'review'),
    ).map((r) => r.name).sort();
    expect(overriders).toEqual(['escalation-resolution', 'information-leakage']);
  });
});
