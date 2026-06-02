/**
 * upgradeAnnouncement — pure parsing + maturity-framing for the user-facing
 * announcement block of a release upgrade guide
 * (MATURE-UPDATE-ANNOUNCEMENTS spec). No I/O, no spawn, no config — just the
 * deterministic mapping from a guide's `user_announcement` front-matter to the
 * announcement decision, so every rule is unit-testable in isolation.
 *
 * THE polarity invariant: a guide with no parseable `audience: user` entry
 * yields NO user message. Silence is the fail-safe — a parse error, a missing
 * block, or an entry with an unknown audience/maturity all collapse to "do not
 * announce" rather than to a malformed or misleading message. The detailed prose
 * BELOW the front-matter is the agent-facing guide and is never touched here.
 */

import yaml from 'js-yaml';

export type AnnouncementAudience = 'user' | 'agent-only';
export type AnnouncementMaturity = 'experimental' | 'preview' | 'stable';

/** One authored announcement decision for a notable change in a release. */
export interface AnnouncementEntry {
  /** `user` ⇒ eligible to compose into a user message; `agent-only` ⇒ never. */
  audience: AnnouncementAudience;
  /** Drives the framing + badge applied when composing the user message. */
  maturity: AnnouncementMaturity;
  /** Short user-facing title for the change. */
  headline: string;
  /** User-facing body sentence(s) for the change. */
  body: string;
}

/** Prompt-injection guidance derived from an entry's maturity. */
export interface MaturityFraming {
  /** Badge prefix for the headline (empty for `stable`). */
  badge: string;
  /** One-line instruction to the composer about tone + required caveat. */
  framing: string;
}

const AUDIENCES = new Set<AnnouncementAudience>(['user', 'agent-only']);
const MATURITIES = new Set<AnnouncementMaturity>(['experimental', 'preview', 'stable']);

/** Front-matter splitter matching the house pattern (retroHarvestValidator):
 *  optional BOM, `---` line, captured YAML, closing `---`, then the body. */
const FRONTMATTER_RE = /^﻿?---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

/**
 * Parse the `user_announcement` block from an upgrade guide. Returns the valid
 * entries (any shape may be present; invalid entries are dropped). Returns `[]`
 * for: no front-matter, a YAML error, a missing/`non-array` `user_announcement`,
 * or entries failing schema. Never throws.
 */
export function parseUserAnnouncement(guide: string): AnnouncementEntry[] {
  if (!guide) return [];
  const m = FRONTMATTER_RE.exec(guide);
  if (!m) return [];

  let fm: unknown;
  try {
    fm = yaml.load(m[1]);
  } catch {
    // @silent-fallback-ok — malformed front-matter ⇒ silent (no user message)
    return [];
  }
  if (!fm || typeof fm !== 'object') return [];

  const raw = (fm as Record<string, unknown>).user_announcement;
  if (!Array.isArray(raw)) return [];

  const entries: AnnouncementEntry[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    const audience = typeof o.audience === 'string' ? o.audience.trim().toLowerCase() : '';
    const maturity = typeof o.maturity === 'string' ? o.maturity.trim().toLowerCase() : '';
    const headline = typeof o.headline === 'string' ? o.headline.trim() : '';
    const body = typeof o.body === 'string' ? o.body.trim() : '';

    // Fail-safe: an unknown audience or maturity drops the entry rather than
    // guessing — we never invent a user-facing announcement from a malformed one.
    if (!AUDIENCES.has(audience as AnnouncementAudience)) continue;
    if (!MATURITIES.has(maturity as AnnouncementMaturity)) continue;
    if (!headline && !body) continue; // nothing to actually say

    entries.push({
      audience: audience as AnnouncementAudience,
      maturity: maturity as AnnouncementMaturity,
      headline,
      body,
    });
  }
  return entries;
}

/** The subset of entries that are eligible to reach the user. */
export function userFacingEntries(entries: AnnouncementEntry[]): AnnouncementEntry[] {
  return entries.filter((e) => e.audience === 'user');
}

/**
 * Return the guide body with its leading `user_announcement` front-matter
 * removed. If there is no front-matter, the guide is returned unchanged. Used by
 * UpgradeGuideProcessor to keep the agent-facing prose while it hoists the
 * announcement block to the top of the concatenated pending guide.
 */
export function stripAnnouncementFrontmatter(guide: string): string {
  if (!guide) return guide;
  const m = FRONTMATTER_RE.exec(guide);
  if (!m) return guide;
  return m[2];
}

/**
 * Serialize entries into a `---`-delimited `user_announcement` front-matter
 * block (ending in a trailing newline). Returns the empty string for an empty
 * list — so a guide-set with NO announcements produces NO front-matter, leaving
 * the assembled guide byte-identical to the pre-feature behavior.
 */
export function serializeUserAnnouncement(entries: AnnouncementEntry[]): string {
  if (!entries.length) return '';
  const yamlBody = yaml.dump(
    { user_announcement: entries },
    { lineWidth: -1, noRefs: true },
  );
  return `---\n${yamlBody}---\n`;
}

/** Badge + framing instruction for a maturity rung. */
export function frameByMaturity(maturity: AnnouncementMaturity): MaturityFraming {
  switch (maturity) {
    case 'stable':
      return {
        badge: '',
        framing:
          'Stable — speak confidently: this is a finished feature the user can use right now. No maturity caveat needed.',
      };
    case 'preview':
      return {
        badge: '🧪 Preview',
        framing:
          'Preview — say it is available to try but still rough around the edges; invite feedback. Prefix the headline with the "🧪 Preview" badge.',
      };
    case 'experimental':
      return {
        badge: '⚗️ Experimental',
        framing:
          'Experimental — be explicit that this is EARLY and NOT ready for general use yet, and that you will tell them when it is. NEVER imply it is finished or "more reliable". Prefix the headline with the "⚗️ Experimental" badge.',
      };
  }
}

/**
 * Render the announcement brief injected into the compose prompt. Returns the
 * empty string when there is nothing user-facing — the caller treats `''` as
 * "skip the user message entirely". Each entry becomes a labeled block carrying
 * its badge + maturity framing so the composer cannot overstate readiness.
 */
export function renderAnnouncementBrief(entries: AnnouncementEntry[]): string {
  const userEntries = userFacingEntries(entries);
  if (userEntries.length === 0) return '';

  const blocks = userEntries.map((e, i) => {
    const { badge, framing } = frameByMaturity(e.maturity);
    const title = badge ? `${badge} — ${e.headline}` : e.headline;
    return [
      `Announcement ${i + 1} (maturity: ${e.maturity}):`,
      `  Headline: ${title}`,
      `  What it is: ${e.body}`,
      `  Framing: ${framing}`,
    ].join('\n');
  });

  return blocks.join('\n\n');
}
