/**
 * Unit tests — ELI16-on-every-PR gate (the pure check).
 *
 * The CI gate fails any PR whose DESCRIPTION lacks a plain-English ELI16 overview
 * (Justin's standard: the description is the review surface). Because the gate
 * blocks EVERY PR, the check must be exhaustively correct on both sides + honour
 * its exemptions — a false-fail would block the whole fleet's PRs.
 */

import { describe, it, expect } from 'vitest';
// @ts-expect-error — .mjs, no type declarations; runtime import is fine under vitest
import { checkPrDescriptionEli16, MIN_ELI16_DESCRIPTION_CHARS } from '../../scripts/eli16-pr-description-check.mjs';

const longOverview =
  'In plain English: this change makes the widget read its config from the project ' +
  'directory instead of a temp folder, so agents that run in a sandbox can actually ' +
  'find it. Nothing about how you talk to your agent changes; it just stops a silent ' +
  'failure that only showed up for sandboxed runtimes.';

describe('checkPrDescriptionEli16', () => {
  it('PASSES when the body has an ## ELI16 heading with enough content', () => {
    const body = `## What\n\nSome change.\n\n## ELI16 — what this means\n\n${longOverview}\n\n## Tests\n\nAll pass.`;
    expect(checkPrDescriptionEli16({ body, title: 'fix(x): something', authorType: 'User' })).toEqual({ ok: true });
  });

  it('accepts ELI16 / ELI-16 / ELI 16 spellings, any heading level', () => {
    for (const h of ['## ELI16', '### ELI-16 overview', '# ELI 16 — plain english', '#### eli16']) {
      const body = `${h}\n\n${longOverview}`;
      expect(checkPrDescriptionEli16({ body, title: 't', authorType: 'User' }).ok).toBe(true);
    }
  });

  it('FAILS when the body has no ELI16 heading at all', () => {
    const body = `## What\n\nA change with a perfectly good description but no ELI16 section.\n\n## Tests\n\nPass.`;
    const r = checkPrDescriptionEli16({ body, title: 'feat(x): y', authorType: 'User' });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('no-eli16-heading');
  });

  it('FAILS when the ELI16 section is present but too short (a one-liner)', () => {
    const body = `## ELI16\n\nIt fixes a bug.\n\n## Tests\n\nPass.`;
    const r = checkPrDescriptionEli16({ body, title: 'fix: z', authorType: 'User' });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('eli16-too-short');
    expect(r.min).toBe(MIN_ELI16_DESCRIPTION_CHARS);
  });

  it('measures content only up to the NEXT heading (does not borrow other sections)', () => {
    // ELI16 section itself is short; the long content belongs to the next section.
    const body = `## ELI16\n\nShort.\n\n## What Changed\n\n${longOverview}`;
    expect(checkPrDescriptionEli16({ body, title: 't', authorType: 'User' }).ok).toBe(false);
  });

  it('ignores HTML comments when measuring the ELI16 content', () => {
    const body = `## ELI16\n\n<!-- ${'x'.repeat(500)} -->\n\nShort.`;
    expect(checkPrDescriptionEli16({ body, title: 't', authorType: 'User' }).ok).toBe(false);
  });

  it('EXEMPTS bot-authored PRs', () => {
    expect(checkPrDescriptionEli16({ body: '', title: 'Bump deps', authorType: 'Bot' })).toEqual({ ok: true, exempt: 'bot-author' });
  });

  it('EXEMPTS the automated release-cut PR', () => {
    expect(checkPrDescriptionEli16({ body: '', title: 'chore: release v1.3.300 [skip ci]', authorType: 'User' })).toEqual({ ok: true, exempt: 'release-cut' });
  });

  it('does NOT exempt a normal fix/feat PR just because the title mentions release', () => {
    const r = checkPrDescriptionEli16({ body: '## What\n\nx', title: 'feat: prep the release pipeline', authorType: 'User' });
    expect(r.ok).toBe(false);
  });

  it('handles null/empty body and title without throwing', () => {
    expect(checkPrDescriptionEli16({ body: null, title: null, authorType: null }).ok).toBe(false);
    expect(checkPrDescriptionEli16({}).ok).toBe(false);
  });
});
