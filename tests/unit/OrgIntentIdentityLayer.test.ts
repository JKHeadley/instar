/**
 * Unit tests for OrgIntentIdentityLayer — layer 3 of the MTP Protocol (EXO 3.0).
 *
 * Covers both sides of every decision boundary:
 * - present vs absent `## Identity` section
 * - template-only / empty -> null
 * - `### Why People Stay` + alias subheadings -> bindingStatements
 * - `### What We're Not For` + alias subheadings -> disqualifiers
 * - bare list-item fallback (no subheadings)
 * - section present but no usable items -> null
 */

import { describe, it, expect } from 'vitest';
import { parseIdentityLayer } from '../../src/core/OrgIntentIdentityLayer.js';

describe('OrgIntentIdentityLayer.parseIdentityLayer', () => {
  it('returns null when there is no ## Identity section', () => {
    const md = `# ORG-INTENT\n\n## Constraints\n- Never wire funds without approval\n\n## Goals\n- Grow trust\n`;
    expect(parseIdentityLayer(md)).toBeNull();
  });

  it('returns null for a template-only Identity section (comments/headings only)', () => {
    const md = `## Identity\n<!-- Describe why high-judgment people stay here -->\n`;
    expect(parseIdentityLayer(md)).toBeNull();
  });

  it('returns null when the section has prose but no list items', () => {
    const md = `## Identity\nWe value our people deeply.\n`;
    expect(parseIdentityLayer(md)).toBeNull();
  });

  it('parses binding statements under "### Why People Stay"', () => {
    const md = [
      '## Identity',
      '### Why People Stay',
      '- Their judgment visibly shapes outcomes',
      '- They own the hard calls, not the busywork',
      '',
    ].join('\n');
    const id = parseIdentityLayer(md);
    expect(id).not.toBeNull();
    expect(id!.bindingStatements).toEqual([
      'Their judgment visibly shapes outcomes',
      'They own the hard calls, not the busywork',
    ]);
    expect(id!.disqualifiers).toEqual([]);
  });

  it('parses disqualifiers under "### What We\'re Not For"', () => {
    const md = [
      '## Identity',
      "### What We're Not For",
      '- We are not a feature factory',
      '- We do not optimize for vanity metrics',
    ].join('\n');
    const id = parseIdentityLayer(md);
    expect(id!.disqualifiers).toEqual([
      'We are not a feature factory',
      'We do not optimize for vanity metrics',
    ]);
  });

  it('parses both binding statements and disqualifiers together', () => {
    const md = [
      '## Identity',
      '### What Binds Us',
      '- Shared purpose over hierarchy',
      "### Not For",
      '- Empire-building',
      '## Goals',
      '- (this belongs to a different section)',
    ].join('\n');
    const id = parseIdentityLayer(md)!;
    expect(id.bindingStatements).toEqual(['Shared purpose over hierarchy']);
    expect(id.disqualifiers).toEqual(['Empire-building']);
    // The trailing ## Goals section must not bleed in.
    expect(id.raw).not.toContain('different section');
  });

  it('falls back to bare list items as binding statements when no subheadings are used', () => {
    const md = [
      '## Identity',
      '- Judgment is the job',
      '- Recognition is real and specific',
    ].join('\n');
    const id = parseIdentityLayer(md)!;
    expect(id.bindingStatements).toEqual([
      'Judgment is the job',
      'Recognition is real and specific',
    ]);
  });

  it('recognizes the "Identity Disqualifiers" alias', () => {
    const md = ['## Identity', '### Identity Disqualifiers', '- Status games', ''].join('\n');
    const id = parseIdentityLayer(md)!;
    expect(id.disqualifiers).toEqual(['Status games']);
  });

  it('is case-insensitive on the section heading', () => {
    const md = ['## identity', '- We stay for the mission', ''].join('\n');
    expect(parseIdentityLayer(md)!.bindingStatements).toEqual(['We stay for the mission']);
  });

  it('does not pull list items from sibling sections into binding statements', () => {
    const md = [
      '## Identity',
      '### Why People Stay',
      '- Real ownership',
      '## Constraints',
      '- Never share secrets',
    ].join('\n');
    const id = parseIdentityLayer(md)!;
    expect(id.bindingStatements).toEqual(['Real ownership']);
    expect(id.bindingStatements).not.toContain('Never share secrets');
  });
});
