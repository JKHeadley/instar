// Pure validation logic for upgrade guides — no filesystem side effects.
// The CLI entry point (check-upgrade-guide.js) wraps this with I/O.
// Extracted for unit testability.

import crypto from 'node:crypto';

export const REQUIRED_SECTIONS = [
  '## What Changed',
  '## What to Tell Your User',
  '## Summary of New Capabilities',
];

export const MIN_LENGTH = 200;

// Keywords that indicate the guide is claiming to fix a bug. When any of these
// appear inside "## What Changed", the Evidence section becomes mandatory.
// Limited to "What Changed" (not the whole doc) to reduce false positives from
// marketing language in "What to Tell Your User".
const FIX_PATTERNS = [
  /\bfix(es|ed|ing)?\b/i,
  /\bbug(fix)?\b/i,
  /\bregression\b/i,
  /\bresolves?\s+(?:an?\b|the\b)/i,
  /\bresolved\b(?!-)/i,
  /\bcrashes?\b/i,
  /\bcrashing\b/i,
  /\b(?:was|were)\s+broken\b/i,
  /\bstall(s|ed|ing)?\b/i,
];

export const NEXT_TEMPLATE = `# Upgrade Guide — vNEXT

<!-- bump: patch -->
<!-- Valid values: patch, minor, major -->
<!-- patch = bug fixes, refactors, test additions, doc updates -->
<!-- minor = new features, new APIs, new capabilities (backwards-compatible) -->
<!-- major = breaking changes to existing APIs or behavior -->

## What Changed

<!-- Describe what changed technically. What new features, APIs, behavioral changes? -->
<!-- Write this for the AGENT — they need to understand the system deeply. -->

## What to Tell Your User

<!-- Write talking points the agent should relay to their user. -->
<!-- This should be warm, conversational, user-facing — not a changelog. -->
<!-- Focus on what THEY can now do, not internal plumbing. -->
<!--                                                                    -->
<!-- PROHIBITED in this section (will fail validation):                 -->
<!--   camelCase config keys: silentReject, maxRetries, telegramNotify -->
<!--   Inline code backtick references like silentReject: false        -->
<!--   Fenced code blocks                                              -->
<!--   Instructions to edit files or run commands                      -->
<!--                                                                    -->
<!-- CORRECT style: "I can turn that on for you" not "set X to false"  -->
<!-- The agent relays this to their user — keep it human.              -->

- **[Feature name]**: "[Brief, friendly description of what this means for the user]"

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| [Capability] | [Endpoint, command, or "automatic"] |

## Evidence

<!-- REQUIRED if this release claims to fix a bug. -->
<!-- Unit tests passing is NOT evidence. Provide ONE of: -->
<!--   (a) Reproduction steps + observed before/after on a live system. -->
<!--       Include log excerpts, observed command output, or behavior -->
<!--       description. Make it specific enough that a future reader can -->
<!--       re-run it and see the same thing. -->
<!--   (b) "Not reproducible in dev — [concrete reason]" if the failure -->
<!--       mode truly can't be exercised locally (race conditions, -->
<!--       event-driven paths requiring external signals, etc). -->
<!--                                                                 -->
<!-- If this release doesn't claim a bug fix (pure feature / refactor), -->
<!-- leave this section blank or delete it — it's only enforced when -->
<!-- "What Changed" describes a fix. -->

[Describe reproduction + verified fix, OR "Not reproducible in dev — [concrete reason]"]
`;

/**
 * Extract the content of a markdown H2 section by title. Returns the section
 * body (between `## Title` and the next `## ` or end of file), or null if the
 * section isn't present.
 */
export function extractSection(content, title) {
  const pattern = new RegExp(`## ${title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([\\s\\S]*?)(?:\\n## |$)`);
  const m = content.match(pattern);
  return m ? m[1] : null;
}

/**
 * Does the guide claim to fix a bug? Scans "## What Changed" for fix-indicating
 * keywords. Returns true when any pattern matches.
 */
export function claimsFix(content) {
  const section = extractSection(content, 'What Changed');
  if (!section) return false;
  return FIX_PATTERNS.some(p => p.test(section));
}

/**
 * Validate the Evidence section when a fix is claimed. Returns an array of
 * issue strings (empty when valid).
 */
export function evidenceIssues(content) {
  const issues = [];
  const section = extractSection(content, 'Evidence');
  if (section === null) {
    issues.push(
      '"What Changed" claims a bug fix, but the guide has no "## Evidence" section. ' +
      'Add one with reproduction + observed before/after, or "Not reproducible in dev — [reason]". ' +
      'Unit tests passing is not evidence.'
    );
    return issues;
  }
  // Strip HTML comments and trim
  const stripped = section.replace(/<!--[\s\S]*?-->/g, '').trim();
  if (!stripped) {
    issues.push(
      '"## Evidence" section is empty (only template comments). ' +
      'Fill it in with reproduction + verified fix, or "Not reproducible in dev — [reason]".'
    );
    return issues;
  }
  // Reject obvious placeholder text
  if (
    /\[Describe reproduction/i.test(stripped) ||
    /\[evidence goes here\]/i.test(stripped) ||
    /TODO\b/.test(stripped) ||
    /FIXME\b/.test(stripped)
  ) {
    issues.push(
      '"## Evidence" section still contains placeholder text. ' +
      'Replace it with a real reproduction + verification, or explicit "Not reproducible in dev — [reason]".'
    );
    return issues;
  }
  // Require at least 80 chars of real content — any less and it can't describe
  // a reproduction meaningfully.
  if (stripped.length < 80) {
    issues.push(
      `"## Evidence" section is too short (${stripped.length} chars). ` +
      'Include concrete reproduction + observed before/after, or "Not reproducible in dev" with a concrete reason.'
    );
  }
  return issues;
}

/**
 * Full structural validation of a guide's content. Returns issue strings.
 */
export function validateGuideContent(content) {
  const issues = [];

  for (const section of REQUIRED_SECTIONS) {
    if (!content.includes(section)) {
      issues.push(`missing "${section}" section`);
    }
  }

  if (content.length < MIN_LENGTH) {
    issues.push(`guide is too short (${content.length} chars, minimum ${MIN_LENGTH}) — probably incomplete`);
  }

  // Template placeholders that were never filled in
  if (content.includes('<!-- Describe what changed')) {
    issues.push('"What Changed" section still contains template placeholder — fill it in');
  }
  if (content.includes('[Feature name]') || content.includes('[Brief, friendly description')) {
    issues.push('"What to Tell Your User" section still contains template placeholder — fill it in');
  }
  if (content.includes('[Capability]') && content.includes('[Endpoint, command')) {
    issues.push('"Summary of New Capabilities" section still contains template placeholder — fill it in');
  }

  // "What to Tell Your User" technical-leakage checks
  const userSection = extractSection(content, 'What to Tell Your User');
  if (userSection) {
    const camelCaseConfigKey = /\b[a-z]+[A-Z][a-zA-Z]+\s*(?::|=)/.test(userSection);
    if (camelCaseConfigKey) {
      issues.push(
        '"What to Tell Your User" contains a camelCase config key reference (e.g. "silentReject: false"). ' +
        'Users should never be told to edit config directly. ' +
        'Rephrase conversationally: "I can turn that on for you" not "set silentReject: false".'
      );
    }
    if (/`[^`]+`/.test(userSection)) {
      issues.push(
        '"What to Tell Your User" contains inline code (`...`). ' +
        'Remove code formatting — user-facing language should be plain and conversational.'
      );
    }
    if (/```/.test(userSection)) {
      issues.push(
        '"What to Tell Your User" contains a fenced code block. ' +
        'This section is for user-facing narrative — move technical examples to "What Changed".'
      );
    }
  }

  // Evidence bar — when the guide claims a fix, require an Evidence section.
  if (claimsFix(content)) {
    issues.push(...evidenceIssues(content));
  }

  // Auto-draft review gate — unreviewed markers + receipt validity.
  issues.push(...autoDraftReviewIssues(content));

  return issues;
}

/**
 * Parse the declared bump type from a guide's <!-- bump: TYPE --> comment.
 * Returns 'patch' | 'minor' | 'major' | null.
 */
export function parseBumpType(content) {
  const match = /<!--\s*bump:\s*(patch|minor|major)\s*-->/.exec(content);
  return match ? match[1] : null;
}

// ── Auto-draft review gate (release-readiness-visibility spec §4.1.1) ──
//
// Layer A auto-drafts NEXT.md from the classified commit range. Every drafted
// section carries an `auto-draft-unreviewed` marker. The publish gate refuses
// to ship a guide while any such marker remains, so auto-fill removes the
// "blank guide" root cause WITHOUT shipping un-reviewed notes. A human signals
// review by REPLACING a section's marker with a hash-locked `reviewed-by`
// receipt; editing the section afterward invalidates the hash and re-blocks.

export const REVIEW_RECEIPT_MAX_AGE_DAYS = 30;

const UNREVIEWED_MARKER_RE = /<!--\s*auto-draft-unreviewed(?:-block)?(?::[^>]*?)?\s*-->/g;
const REVIEW_RECEIPT_RE = /<!--\s*reviewed-by:\s*(.+?)\s*@\s*([0-9T:.+\-Z]+)\s*:hash=([a-f0-9]{64})\s*-->/gi;
// A `reviewed-by` comment that does NOT match the strict form above — used to
// catch receipts missing the required :hash= (the iter-3 V2 fix).
const REVIEW_RECEIPT_LOOSE_RE = /<!--\s*reviewed-by:[^>]*-->/gi;

/**
 * Canonicalize a section body for hashing: LF line endings, drop the receipt
 * line itself, strip trailing whitespace per line, trim. Mirrors the rule in
 * RELEASE-READINESS-VISIBILITY-SPEC §4.1.1.
 */
export function canonicalizeSectionForHash(body) {
  return String(body)
    .replace(/\r\n/g, '\n')
    .split('\n')
    .filter((l) => !/<!--\s*reviewed-by:/i.test(l))
    .map((l) => l.replace(/\s+$/, ''))
    .join('\n')
    .trim();
}

export function sectionReviewHash(body) {
  return crypto.createHash('sha256').update(canonicalizeSectionForHash(body)).digest('hex');
}

/** Split content into H2 sections: [{ title, body }]. */
function h2Sections(content) {
  const out = [];
  const re = /^## (.+)$/gm;
  let m;
  const heads = [];
  while ((m = re.exec(content)) !== null) heads.push({ title: m[1].trim(), idx: m.index, after: re.lastIndex });
  for (let i = 0; i < heads.length; i++) {
    const end = i + 1 < heads.length ? heads[i + 1].idx : content.length;
    out.push({ title: heads[i].title, body: content.slice(heads[i].after, end) });
  }
  return out;
}

/**
 * Gate issues for the auto-draft review state. Returns issue strings (empty = ok):
 *   1. Any remaining `auto-draft-unreviewed` marker blocks publish.
 *   2. A `reviewed-by` receipt missing the required `:hash=` blocks.
 *   3. A receipt whose hash doesn't match its (canonicalized) section blocks
 *      — i.e. the section was edited after review.
 *   4. A receipt older than REVIEW_RECEIPT_MAX_AGE_DAYS blocks.
 * (Full "marker stripped without a receipt" detection needs a git-diff and is
 * the tracked Phase-2 CI check per §4.1.1 — out of scope for this snapshot gate.)
 */
export function autoDraftReviewIssues(content, now = Date.now()) {
  const issues = [];

  const unreviewed = content.match(UNREVIEWED_MARKER_RE) || [];
  if (unreviewed.length > 0) {
    issues.push(
      `guide has ${unreviewed.length} unreviewed auto-draft marker(s) — a human must review each section and ` +
      `replace its 'auto-draft-unreviewed' marker with a 'reviewed-by: <name> @ <ISO-date> :hash=<sha256>' receipt ` +
      `before this guide can publish (RELEASE-READINESS-VISIBILITY-SPEC §4.1.1)`,
    );
  }

  // Loose receipts that don't match the strict (with :hash=) form.
  const looseAll = content.match(REVIEW_RECEIPT_LOOSE_RE) || [];
  for (const loose of looseAll) {
    REVIEW_RECEIPT_RE.lastIndex = 0;
    if (!REVIEW_RECEIPT_RE.test(loose)) {
      issues.push(
        `malformed reviewed-by receipt (missing required ':hash=<sha256>' or bad date): ${loose.trim()}. ` +
        `Required form: <!-- reviewed-by: <name> @ <ISO-date> :hash=<sha256> -->`,
      );
    }
  }

  // Strict receipts: validate hash-match against their section + age window.
  for (const section of h2Sections(content)) {
    REVIEW_RECEIPT_RE.lastIndex = 0;
    let r;
    while ((r = REVIEW_RECEIPT_RE.exec(section.body)) !== null) {
      const [, , dateStr, hash] = r;
      const ts = Date.parse(dateStr);
      if (Number.isNaN(ts)) {
        issues.push(`reviewed-by receipt in "## ${section.title}" has an unparseable date: "${dateStr}"`);
        continue;
      }
      const ageDays = (now - ts) / (24 * 60 * 60 * 1000);
      if (ageDays > REVIEW_RECEIPT_MAX_AGE_DAYS) {
        issues.push(
          `reviewed-by receipt in "## ${section.title}" is ${Math.floor(ageDays)} days old ` +
          `(max ${REVIEW_RECEIPT_MAX_AGE_DAYS}) — re-review the section and refresh the receipt`,
        );
      }
      const actual = sectionReviewHash(section.body);
      if (actual !== hash) {
        issues.push(
          `reviewed-by receipt in "## ${section.title}" hash mismatch — the section was edited after review. ` +
          `Re-review and update :hash= to ${actual}`,
        );
      }
    }
  }

  return issues;
}
