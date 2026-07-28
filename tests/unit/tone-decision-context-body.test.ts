/**
 * Candidate-body capture on the tone gate's decision-quality provenance context.
 *
 * The meter exists to answer "was blocking this message correct?" retrospectively,
 * in bulk, with a strong model. A sha256 cannot be re-read, so an identity-only row
 * hands that judge nothing to judge. This covers the opt-in body capture that closes
 * the gap — and, just as importantly, that it stays OFF unless asked for.
 */

import { describe, it, expect } from 'vitest';
import {
  buildToneDecisionContext,
  TONE_CANDIDATE_BODY_MAX_CHARS,
} from '../../src/core/MessagingToneGate.js';
import { CONTENT_FULL_KEY } from '../../src/core/JudgmentProvenanceLog.js';

const ctx = { channel: 'telegram', messageKind: 'reply' as const };

const candidateOf = (c: Record<string, unknown>): Record<string, unknown> =>
  c.candidate as Record<string, unknown>;

const contentFullOf = (c: Record<string, unknown>): Record<string, unknown> =>
  (c[CONTENT_FULL_KEY] ?? {}) as Record<string, unknown>;

/**
 * Mirrors how JudgmentProvenanceLog builds the SERVED `contextRedacted` field:
 * strip the reserved machine-local key, then serialize. If a body can be found in
 * here it is readable on GET /judgment-provenance and travels to peer machines on a
 * pool merge.
 */
const servedProjection = (c: Record<string, unknown>): string => {
  const { [CONTENT_FULL_KEY]: _omit, ...redactable } = c;
  return JSON.stringify(redactable);
};

describe('buildToneDecisionContext — candidate body capture', () => {
  describe('the default is unchanged', () => {
    it('records no body when opts are omitted entirely', () => {
      const c = candidateOf(buildToneDecisionContext('hello there', ctx));
      expect(c.body).toBeUndefined();
      expect(c.bodyTruncated).toBeUndefined();
      expect(c.bodyRedactionKinds).toBeUndefined();
    });

    it('records no body when recordCandidateBody is explicitly false', () => {
      const c = candidateOf(buildToneDecisionContext('hello there', ctx, { recordCandidateBody: false }));
      expect(c.body).toBeUndefined();
    });

    it('produces a byte-identical context off vs. omitted — an agent that never sets the flag stores what it stored before', () => {
      const omitted = buildToneDecisionContext('some outbound message', ctx);
      const explicitOff = buildToneDecisionContext('some outbound message', ctx, { recordCandidateBody: false });
      expect(JSON.stringify(explicitOff)).toBe(JSON.stringify(omitted));
    });
  });

  describe('when enabled', () => {
    it('records the body verbatim for ordinary prose', () => {
      const text = 'I checked the scheduler and the job is queued behind two others.';
      const full = buildToneDecisionContext(text, ctx, { recordCandidateBody: true });
      expect(contentFullOf(full).candidateBody).toBe(text);
      expect(candidateOf(full).bodyTruncated).toBe(false);
    });

    it('keeps the sha256 identity alongside the body, so rows written before and after the flag flips stay correlatable', () => {
      const text = 'the same message';
      const off = candidateOf(buildToneDecisionContext(text, ctx));
      const on = candidateOf(buildToneDecisionContext(text, ctx, { recordCandidateBody: true }));
      expect(on.sha256).toBe(off.sha256);
      expect(on.bytes).toBe(off.bytes);
      expect(on.chars).toBe(off.chars);
    });
  });

  describe('credential scrubbing', () => {
    it('redacts a credential in the body and reports the KIND without the offset or the matched text', () => {
      const text = 'here is the token ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 for the deploy';
      const full = buildToneDecisionContext(text, ctx, { recordCandidateBody: true });
      const c = candidateOf(full);
      const body = String(contentFullOf(full).candidateBody);

      expect(body).not.toContain('ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789');
      expect(body).toContain('[REDACTED:');
      // Surrounding prose survives — a judge still sees what the message was about.
      expect(body).toContain('for the deploy');

      const kinds = c.bodyRedactionKinds as string[] | undefined;
      expect(Array.isArray(kinds)).toBe(true);
      expect(kinds!.length).toBeGreaterThan(0);
      // Kinds only: no positional metadata that would help reconstruct the secret.
      expect(JSON.stringify(c)).not.toMatch(/"(offset|start|index)"\s*:/);
    });

    it('omits bodyRedactionKinds entirely when nothing was redacted, rather than emitting an empty array', () => {
      const c = candidateOf(buildToneDecisionContext('nothing sensitive here', ctx, { recordCandidateBody: true }));
      expect(c.bodyRedactionKinds).toBeUndefined();
    });

    it('reports a credential that sits PAST the clamp, so a truncated row never reads cleaner than the message was', () => {
      // The credential is cut away by the clamp — correctly, it must not be stored —
      // but "did this message contain a credential?" is a question about the WHOLE
      // message. Kinds are therefore computed over the full text.
      const secret = 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
      // NOTE the space before the token: the scrubber's patterns are boundary-anchored,
      // so a token run directly onto preceding word characters does not match. That is a
      // property of the shared scrubber, not of this builder — but a fixture without the
      // boundary silently tests nothing, which is how a passing test starts lying.
      const text = `${'a'.repeat(300)} here is the token ${secret}`;
      const full = buildToneDecisionContext(text, ctx, { recordCandidateBody: true, maxBodyChars: 100 });
      const c = candidateOf(full);
      const body = String(contentFullOf(full).candidateBody);

      // The secret is absent from what is stored...
      expect(body).not.toContain(secret);
      expect(body).not.toContain('ghp_');
      // ...but its presence in the message is still recorded.
      const kinds = c.bodyRedactionKinds as string[] | undefined;
      expect(Array.isArray(kinds)).toBe(true);
      expect(kinds!.length).toBeGreaterThan(0);
      // And the row says plainly that the redaction lay beyond the stored fragment.
      expect(c.bodyRedactionsBeyondClamp).toBe(true);
    });

    it('does not set bodyRedactionsBeyondClamp when the credential is inside the stored fragment', () => {
      const text = 'token ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 here';
      const c = candidateOf(buildToneDecisionContext(text, ctx, { recordCandidateBody: true }));
      expect(c.bodyRedactionKinds).toBeDefined();
      expect(c.bodyRedactionsBeyondClamp).toBeUndefined();
    });
  });

  describe('length bound', () => {
    it('clamps to the ceiling and flags the row as a fragment', () => {
      const text = 'x'.repeat(TONE_CANDIDATE_BODY_MAX_CHARS + 500);
      const full = buildToneDecisionContext(text, ctx, { recordCandidateBody: true });
      const c = candidateOf(full);
      expect(String(contentFullOf(full).candidateBody).length).toBeLessThanOrEqual(TONE_CANDIDATE_BODY_MAX_CHARS);
      expect(c.bodyTruncated).toBe(true);
      // The identity fields still describe the WHOLE message, not the fragment.
      expect(c.chars).toBe(text.length);
    });

    it('clamps a caller-supplied maxBodyChars DOWN to the ceiling but never up', () => {
      const text = 'y'.repeat(TONE_CANDIDATE_BODY_MAX_CHARS + 5000);
      const full = buildToneDecisionContext(text, ctx, {
        recordCandidateBody: true,
        maxBodyChars: TONE_CANDIDATE_BODY_MAX_CHARS + 5000,
      });
      expect(String(contentFullOf(full).candidateBody).length).toBeLessThanOrEqual(TONE_CANDIDATE_BODY_MAX_CHARS);
    });

    it('honours a SMALLER caller-supplied bound', () => {
      const full = buildToneDecisionContext('z'.repeat(500), ctx, { recordCandidateBody: true, maxBodyChars: 100 });
      const c = candidateOf(full);
      expect(String(contentFullOf(full).candidateBody).length).toBeLessThanOrEqual(100);
      expect(c.bodyTruncated).toBe(true);
    });

    it('clamps BEFORE scrubbing, so truncation can never slice a redaction marker and leave secret bytes past the cut', () => {
      // The credential sits beyond the clamp point: it must be cut away by the clamp,
      // and must not appear in any form in the stored body.
      const secret = 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
      const text = `${'a'.repeat(200)}${secret}`;
      const full = buildToneDecisionContext(text, ctx, { recordCandidateBody: true, maxBodyChars: 100 });
      const body = String(contentFullOf(full).candidateBody);
      expect(body).not.toContain(secret);
      expect(body).not.toContain('ghp_');
      expect(body.length).toBeLessThanOrEqual(100);
    });
  });

  describe('the rest of the context is untouched', () => {
    it('still carries the code-derived features when the body is recorded', () => {
      const full = buildToneDecisionContext('a message', ctx, { recordCandidateBody: true });
      expect(full.channel).toBe('telegram');
      expect(full.messageKind).toBe('reply');
      expect(Array.isArray(full.gateSignalKinds)).toBe(true);
    });
  });
});

/**
 * CONTAINMENT — the highest-value property in this feature.
 *
 * `contextRedacted` is built from the context minus the reserved machine-local key,
 * is returned by readRedacted(), and is on the cross-machine field allowlist. Anything
 * reachable through it is readable on the served surface AND replicated to peers. The
 * scrubbers applied there are credential-shape scrubbers; they do not remove prose.
 *
 * The first implementation of this feature put the body on `candidate`, which is inside
 * that projection. It passed every other test in this file. These are the tests that
 * would have caught it.
 */
describe('buildToneDecisionContext — content containment', () => {
  const secretish = 'the quarterly figures are down and Dana is being let go';

  it('keeps the body OUT of the served projection', () => {
    const full = buildToneDecisionContext(secretish, ctx, { recordCandidateBody: true });
    expect(servedProjection(full)).not.toContain(secretish);
    expect(servedProjection(full)).not.toContain('Dana');
  });

  it('still carries the body in the machine-local key, so a later judge can read it', () => {
    const full = buildToneDecisionContext(secretish, ctx, { recordCandidateBody: true });
    expect(contentFullOf(full).candidateBody).toBe(secretish);
  });

  it('keeps trust-relevant metadata VISIBLE in the served projection', () => {
    // A reader must be able to tell a truncated or credential-carrying row from a clean
    // one without being handed the content itself.
    const text = `${'a'.repeat(300)} here is the token ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789`;
    const full = buildToneDecisionContext(text, ctx, { recordCandidateBody: true, maxBodyChars: 100 });
    const served = servedProjection(full);
    expect(served).toContain('bodyTruncated');
    expect(served).toContain('bodyRedactionKinds');
    expect(served).toContain('bodyRedactionsBeyondClamp');
  });

  it('attaches no machine-local key at all when body capture is off', () => {
    const off = buildToneDecisionContext('hello', ctx);
    expect(off[CONTENT_FULL_KEY]).toBeUndefined();
  });
});
