/**
 * Unit tests — auto-draft review gate (upgrade-guide-validator.mjs).
 *
 * Release-readiness-visibility spec §4.1.1: a guide with `auto-draft-unreviewed`
 * markers cannot publish; a human clears each by replacing the marker with a
 * hash-locked `reviewed-by` receipt; editing the section afterward (or a stale /
 * hashless receipt) re-blocks.
 */

import { describe, it, expect } from 'vitest';
import {
  autoDraftReviewIssues,
  sectionReviewHash,
  validateGuideContent,
} from '../../scripts/upgrade-guide-validator.mjs';

const today = () => new Date().toISOString().slice(0, 10);

describe('auto-draft review gate', () => {
  it('blocks while any auto-draft-unreviewed marker remains', () => {
    const md = `## What Changed\n\n<!-- auto-draft-unreviewed: what-changed -->\n- **feature**: GET /foo\n`;
    const issues = autoDraftReviewIssues(md);
    expect(issues.length).toBeGreaterThan(0);
    expect(issues[0]).toContain('unreviewed auto-draft marker');
  });

  it('blocks the block-level marker too', () => {
    const md = `<!-- auto-draft-unreviewed-block -->\n## What Changed\n- x\n`;
    expect(autoDraftReviewIssues(md).length).toBeGreaterThan(0);
  });

  it('passes when a section carries a correct hash-locked receipt', () => {
    const body = `\n<!-- reviewed-by: echo @ ${today()} :hash=PLACEHOLDER -->\n- **feature**: GET /foo\n`;
    const hash = sectionReviewHash(body); // hash excludes the receipt line
    const md = `## What Changed${body.replace('PLACEHOLDER', hash)}`;
    expect(autoDraftReviewIssues(md)).toEqual([]);
  });

  it('blocks a receipt whose hash no longer matches the section (edited after review)', () => {
    const md = `## What Changed\n<!-- reviewed-by: echo @ ${today()} :hash=${'0'.repeat(64)} -->\n- edited content\n`;
    expect(autoDraftReviewIssues(md).some((i) => i.includes('hash mismatch'))).toBe(true);
  });

  it('blocks a receipt missing the required :hash=', () => {
    const md = `## What Changed\n<!-- reviewed-by: echo @ ${today()} -->\n- x\n`;
    expect(autoDraftReviewIssues(md).some((i) => i.includes('missing required'))).toBe(true);
  });

  it('blocks a receipt older than the 30-day window', () => {
    const body = `\n- y\n`;
    const md = `## What Changed${body}<!-- reviewed-by: echo @ 2020-01-01 :hash=${sectionReviewHash(`## What Changed${body}`.split('\n').slice(1).join('\n'))} -->\n`;
    // Simpler: construct a section whose hash matches but date is ancient.
    const sec = `\n- y\n<!-- reviewed-by: echo @ 2020-01-01 :hash=HASH -->\n`;
    const h = sectionReviewHash(sec);
    const guide = `## What Changed${sec.replace('HASH', h)}`;
    expect(autoDraftReviewIssues(guide).some((i) => i.includes('days old'))).toBe(true);
  });

  it('validateGuideContent surfaces the unreviewed-marker block', () => {
    const md = `# Upgrade Guide — vNEXT
<!-- bump: minor -->
## What Changed
<!-- auto-draft-unreviewed: what-changed -->
- **feature**: GET /foo endpoint added
## What to Tell Your User
- You can now use the foo feature.
## Summary of New Capabilities
| foo | GET /foo |
`;
    const issues = validateGuideContent(md);
    expect(issues.some((i) => i.includes('unreviewed auto-draft marker'))).toBe(true);
  });
});
