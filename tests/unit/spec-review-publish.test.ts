/**
 * Unit tests for the spec-review ELI16-tunnel-link delivery tooling.
 *
 * Covers the pure logic of:
 *  - the backstop detector (scripts/check-spec-review-link.mjs)
 *  - the publisher's message composition + frontmatter/title parsing
 *    (skills/spec-converge/scripts/publish-spec-review.mjs)
 *
 * The I/O paths (POST /view, link verification, telegram send) need a running
 * server and are exercised by dogfooding, not unit-mocked here.
 */

import { describe, it, expect } from 'vitest';
import { messageLacksReviewLink } from '../../scripts/check-spec-review-link.mjs';
import {
  composeReviewMessage,
  extractFrontmatter,
  specTitle,
} from '../../skills/spec-converge/scripts/publish-spec-review.mjs';

describe('messageLacksReviewLink — backstop detector', () => {
  it('flags a PR handed over for review with no rendered view link', () => {
    const text =
      'Spec is up for your review — PR https://github.com/JKHeadley/instar/pull/670. ' +
      'Nothing builds until you approve it.';
    expect(messageLacksReviewLink(text)).toBe(true);
  });

  it('passes when a rendered tunnel /view link IS present', () => {
    const text =
      'Spec ready for review.\n' +
      'ELI16: https://echo.dawn-tunnel.dev/view/b0df2aa3-c4e6-4636-b97f-2e6ea4e32af9?sig=abc\n' +
      'Full spec: https://github.com/JKHeadley/instar/pull/670';
    expect(messageLacksReviewLink(text)).toBe(false);
  });

  it('flags a docs/specs file referenced for sign-off without a view link', () => {
    const text = 'Please sign off on docs/specs/FOO-SPEC.md when you get a chance.';
    expect(messageLacksReviewLink(text)).toBe(true);
  });

  it('ignores ordinary messages that merely mention a PR (no review intent)', () => {
    const text = 'CI is green on https://github.com/JKHeadley/instar/pull/670, merging now.';
    // mentions a PR but no review/approve/spec/eli16 intent word
    expect(messageLacksReviewLink(text)).toBe(false);
  });

  it('does NOT fire on an ordinary code-PR review (no spec involved)', () => {
    const text = 'Can you please review https://github.com/JKHeadley/instar/pull/500 when you get a chance?';
    // a PR for review, but not a spec — narrow scope must not over-block
    expect(messageLacksReviewLink(text)).toBe(false);
  });

  it('ignores messages with neither a PR nor a spec-file reference', () => {
    expect(messageLacksReviewLink('Please review my approach to the cache.')).toBe(false);
  });

  it('is safe on empty / undefined input', () => {
    expect(messageLacksReviewLink('')).toBe(false);
    // @ts-expect-error testing defensive guard
    expect(messageLacksReviewLink(undefined)).toBe(false);
  });
});

describe('composeReviewMessage — operator-facing review message', () => {
  it('leads with the rendered ELI16 link and includes the PR', () => {
    const msg = composeReviewMessage({
      title: 'Threadline A2A Coherence',
      eli16Url: 'https://echo.dawn-tunnel.dev/view/abc?sig=x',
      prUrl: 'https://github.com/JKHeadley/instar/pull/670',
    });
    expect(msg).toContain('Threadline A2A Coherence');
    expect(msg).toContain('https://echo.dawn-tunnel.dev/view/abc?sig=x');
    expect(msg).toContain('https://github.com/JKHeadley/instar/pull/670');
    // ELI16 link appears before the PR link
    expect(msg.indexOf('view/abc')).toBeLessThan(msg.indexOf('/pull/670'));
    expect(msg).toContain('Nothing builds until you approve');
  });

  it('omits the PR line gracefully when no PR is given', () => {
    const msg = composeReviewMessage({
      title: 'X',
      eli16Url: 'https://echo.dawn-tunnel.dev/view/abc?sig=x',
    });
    expect(msg).toContain('view/abc');
    expect(msg).not.toContain('Full spec');
  });
});

describe('frontmatter + title parsing', () => {
  it('extracts the frontmatter body between the --- fences', () => {
    const spec = '---\ntitle: My Spec\napproved: false\n---\n\n# My Spec\nbody';
    expect(extractFrontmatter(spec)).toContain('title: My Spec');
    expect(extractFrontmatter(spec)).toContain('approved: false');
  });

  it('prefers the frontmatter title, falls back to the H1, then the fallback', () => {
    expect(specTitle('---\ntitle: FM Title\n---\n# H1 Title', 'fb')).toBe('FM Title');
    expect(specTitle('# H1 Title\nbody', 'fb')).toBe('H1 Title');
    expect(specTitle('no title here', 'fb')).toBe('fb');
  });
});
