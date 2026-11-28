/**
 * The B27 detector (docs/specs/spec-review-link-at-delivery.md §1): fixed text tests carried over
 * from the retired hook check 8, returned as SEPARATE facts. It decides nothing, so these tests pin
 * each fact on both sides; the judgment is the gate's.
 */
import { describe, it, expect } from 'vitest';
import { detectSpecReviewHandoff, linkShapesString, SPEC_REVIEW_DETECTOR_MAX_CHARS } from '../../src/core/specReviewHandoff.js';

describe('spec reference', () => {
  it('finds a docs/specs path', () => {
    expect(detectSpecReviewHandoff('Please sign off on docs/specs/FOO-SPEC.md when you can.').reference).toBe('docs/specs/FOO-SPEC.md');
  });
  it('finds a pull request only beside the word spec', () => {
    expect(detectSpecReviewHandoff('Spec is up: https://github.com/JKHeadley/instar/pull/670').reference).toBe('github.com/JKHeadley/instar/pull/670');
    expect(detectSpecReviewHandoff('Can you review https://github.com/JKHeadley/instar/pull/500?').reference).toBeNull();
  });
  it('is null for ordinary prose', () => {
    expect(detectSpecReviewHandoff('The build is green and the release went out.').reference).toBeNull();
  });
});

describe('handoff wording', () => {
  it('matches the review and approval words, including "approve"', () => {
    for (const t of ['ready for your review', 'please approve this', 'sign-off needed', 'take a look', 'ready for build', 'reviewed and approved']) {
      expect(detectSpecReviewHandoff(t).handoffWording).toBe(true);
    }
  });
  it('is false without them', () => {
    expect(detectSpecReviewHandoff('docs/specs/foo.md is merged.').handoffWording).toBe(false);
  });
});

describe('links', () => {
  it('classifies document, page and other links, with ids and hosts', () => {
    const f = detectSpecReviewHandoff('Read it: https://echo.example.dev/docs/abc12345-c4e6-4636-b97f-2e6ea4e32af9, old page http://localhost:4040/view/deadbeef01 and https://github.com/x/y/blob/main/docs/specs/a.md.');
    expect(f.links).toEqual([
      { shape: 'doc', id: 'abc12345-c4e6-4636-b97f-2e6ea4e32af9', host: 'echo.example.dev' },
      { shape: 'view', id: 'deadbeef01', host: 'localhost:4040' },
      { shape: 'other', host: 'github.com' },
    ]);
    expect(linkShapesString(f.links)).toBe('doc,view,other');
  });
  it('counts a bare /docs/<id> path once', () => {
    const f = detectSpecReviewHandoff('See /docs/abc12345-c4e6-4636-b97f-2e6ea4e32af9 for the plain version.');
    expect(f.links).toEqual([{ shape: 'doc', id: 'abc12345-c4e6-4636-b97f-2e6ea4e32af9' }]);
  });
  it('reports none when there are no links', () => {
    const f = detectSpecReviewHandoff('Ready for your review: docs/specs/a.md');
    expect(f.links).toEqual([]);
    expect(linkShapesString(f.links)).toBe('none');
  });
  it('never combines the facts: a link does not clear the reference or the wording', () => {
    const f = detectSpecReviewHandoff('Ready for your review: docs/specs/a.md at https://example.com/unrelated');
    expect(f.reference).toBe('docs/specs/a.md');
    expect(f.handoffWording).toBe(true);
    expect(f.links).toHaveLength(1);
  });
});

describe('totality', () => {
  it('never throws and is bounded', () => {
    expect(() => detectSpecReviewHandoff(undefined as unknown as string)).not.toThrow();
    const big = 'x'.repeat(SPEC_REVIEW_DETECTOR_MAX_CHARS + 10) + ' docs/specs/late.md review';
    expect(detectSpecReviewHandoff(big).reference).toBeNull();
  });
});
