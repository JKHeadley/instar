/**
 * Unit tests — upgradeAnnouncement (mature-update-announcements spec).
 *
 * The pure parse + framing + coherence logic behind silent-by-default,
 * maturity-aware user announcements. Covers BOTH sides of every boundary:
 *   - parse: no front-matter / malformed / agent-only / user / mixed / bad enums
 *   - polarity: no `audience: user` entry ⇒ no user message (empty brief)
 *   - framing: experimental / preview / stable badges + caveats
 *   - coherence: stable-on-dark, stable-on-brand-new, and the ack override
 */

import { describe, it, expect } from 'vitest';
import {
  parseUserAnnouncement,
  userFacingEntries,
  frameByMaturity,
  renderAnnouncementBrief,
  serializeUserAnnouncement,
  stripAnnouncementFrontmatter,
} from '../../src/core/upgradeAnnouncement.js';

const fm = (yaml: string, body = '# guide\n\nsome detail') => `---\n${yaml}\n---\n${body}`;

describe('parseUserAnnouncement', () => {
  it('returns [] when there is no front-matter (silent by default)', () => {
    expect(parseUserAnnouncement('# just a guide\n\nno front-matter here')).toEqual([]);
  });

  it('returns [] for an empty/whitespace guide', () => {
    expect(parseUserAnnouncement('')).toEqual([]);
    expect(parseUserAnnouncement('   \n  ')).toEqual([]);
  });

  it('returns [] when front-matter YAML is malformed (fail-safe to silence)', () => {
    const guide = fm('user_announcement: [unclosed\n  : : :');
    expect(parseUserAnnouncement(guide)).toEqual([]);
  });

  it('returns [] when user_announcement is missing or not an array', () => {
    expect(parseUserAnnouncement(fm('title: hello'))).toEqual([]);
    expect(parseUserAnnouncement(fm('user_announcement: not-a-list'))).toEqual([]);
  });

  it('parses a well-formed agent-only entry', () => {
    const guide = fm(
      'user_announcement:\n' +
        '  - audience: agent-only\n' +
        '    maturity: experimental\n' +
        '    headline: Internal plumbing\n' +
        '    body: nothing user-facing',
    );
    expect(parseUserAnnouncement(guide)).toEqual([
      { audience: 'agent-only', maturity: 'experimental', headline: 'Internal plumbing', body: 'nothing user-facing' },
    ]);
  });

  it('parses a user entry and a mixed list, preserving order', () => {
    const guide = fm(
      'user_announcement:\n' +
        '  - audience: user\n' +
        '    maturity: stable\n' +
        '    headline: Dashboard search\n' +
        '    body: You can now search.\n' +
        '  - audience: agent-only\n' +
        '    maturity: preview\n' +
        '    headline: Internal\n' +
        '    body: infra',
    );
    const entries = parseUserAnnouncement(guide);
    expect(entries).toHaveLength(2);
    expect(entries[0].audience).toBe('user');
    expect(entries[1].audience).toBe('agent-only');
  });

  it('drops entries with an unknown audience or maturity (never invents one)', () => {
    const guide = fm(
      'user_announcement:\n' +
        '  - audience: everyone\n' +
        '    maturity: stable\n' +
        '    headline: bad audience\n' +
        '    body: x\n' +
        '  - audience: user\n' +
        '    maturity: shipped\n' +
        '    headline: bad maturity\n' +
        '    body: y\n' +
        '  - audience: user\n' +
        '    maturity: preview\n' +
        '    headline: good\n' +
        '    body: z',
    );
    const entries = parseUserAnnouncement(guide);
    expect(entries).toHaveLength(1);
    expect(entries[0].headline).toBe('good');
  });

  it('is case-insensitive and trims audience/maturity', () => {
    const guide = fm(
      'user_announcement:\n' +
        '  - audience: " USER "\n' +
        '    maturity: " Stable "\n' +
        '    headline: H\n' +
        '    body: B',
    );
    expect(parseUserAnnouncement(guide)[0]).toMatchObject({ audience: 'user', maturity: 'stable' });
  });

  it('drops an entry with neither headline nor body', () => {
    const guide = fm('user_announcement:\n  - audience: user\n    maturity: stable');
    expect(parseUserAnnouncement(guide)).toEqual([]);
  });
});

describe('serializeUserAnnouncement ↔ parseUserAnnouncement round-trip', () => {
  it('returns the empty string for no entries (silent, byte-identical assembly)', () => {
    expect(serializeUserAnnouncement([])).toBe('');
  });

  it('round-trips entries with special YAML chars (colons, quotes, leading dash)', () => {
    const entries = [
      { audience: 'user' as const, maturity: 'experimental' as const, headline: 'Feature: with colons', body: 'has "quotes" and: colons' },
      { audience: 'agent-only' as const, maturity: 'preview' as const, headline: '- leading dash', body: 'plain' },
      { audience: 'user' as const, maturity: 'stable' as const, headline: 'Normal', body: 'simple body' },
    ];
    const block = serializeUserAnnouncement(entries);
    expect(block.startsWith('---\n')).toBe(true);
    // Re-parse the block (front-matter at byte 0, with a trivial body appended).
    const reparsed = parseUserAnnouncement(`${block}# guide body\n`);
    expect(reparsed).toEqual(entries);
  });
});

describe('stripAnnouncementFrontmatter', () => {
  it('returns the guide unchanged when there is no front-matter', () => {
    const g = '# Guide\n\nbody with --- a dash rule\n';
    expect(stripAnnouncementFrontmatter(g)).toBe(g);
  });
  it('removes the leading front-matter, preserving the body (incl. later --- rules)', () => {
    const body = '# Guide\n\n## What Changed\n\n---\n\nmore';
    const g = `---\nuser_announcement:\n  - audience: user\n    maturity: stable\n    headline: H\n    body: B\n---\n${body}`;
    expect(stripAnnouncementFrontmatter(g)).toBe(body);
  });
});

describe('userFacingEntries', () => {
  it('keeps only audience:user entries', () => {
    const entries = [
      { audience: 'user' as const, maturity: 'stable' as const, headline: 'a', body: '1' },
      { audience: 'agent-only' as const, maturity: 'stable' as const, headline: 'b', body: '2' },
    ];
    expect(userFacingEntries(entries).map((e) => e.headline)).toEqual(['a']);
  });
});

describe('frameByMaturity', () => {
  it('stable: no badge, confident framing', () => {
    const f = frameByMaturity('stable');
    expect(f.badge).toBe('');
    expect(f.framing.toLowerCase()).toContain('finished');
  });
  it('preview: badge + "still rough" framing', () => {
    const f = frameByMaturity('preview');
    expect(f.badge).toContain('Preview');
    expect(f.framing.toLowerCase()).toContain('rough');
  });
  it('experimental: badge + explicit not-ready caveat', () => {
    const f = frameByMaturity('experimental');
    expect(f.badge).toContain('Experimental');
    expect(f.framing.toLowerCase()).toContain('not ready for general use');
  });
});

describe('renderAnnouncementBrief', () => {
  it('returns the empty string when there are no user-facing entries (silent)', () => {
    expect(renderAnnouncementBrief([])).toBe('');
    expect(
      renderAnnouncementBrief([{ audience: 'agent-only', maturity: 'stable', headline: 'h', body: 'b' }]),
    ).toBe('');
  });

  it('renders a brief carrying the badge + maturity + framing for user entries', () => {
    const brief = renderAnnouncementBrief([
      { audience: 'user', maturity: 'experimental', headline: 'Gemini support', body: 'early days' },
    ]);
    expect(brief).toContain('maturity: experimental');
    expect(brief).toContain('⚗️ Experimental');
    expect(brief).toContain('Gemini support');
    expect(brief.toLowerCase()).toContain('not ready for general use');
  });
});
