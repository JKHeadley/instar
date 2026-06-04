#!/usr/bin/env node
/**
 * assemble-next-md — fold per-PR release-note FRAGMENTS into a single NEXT.md.
 *
 * ── Why this exists ───────────────────────────────────────────────────
 * The release pipeline consumes a single shared `upgrades/NEXT.md` per merge.
 * With many agents merging concurrently, EVERY PR rewrote that one file, so
 * every PR collided on it within minutes — the release notes became an
 * un-landable hot file. The fix is per-PR FRAGMENTS: each PR ships its note as
 * `upgrades/next/<slug>.md`, touching a distinct file, so two PRs never
 * collide. This script concatenates the fragments into `upgrades/NEXT.md`
 * BEFORE the existing publish pipeline runs, leaving everything downstream
 * unchanged.
 *
 * ── What it does ──────────────────────────────────────────────────────
 *   1. Reads every `upgrades/next/*.md` fragment (deterministic filename sort).
 *   2. Folds in a legacy `upgrades/NEXT.md` too, if one exists (backward compat).
 *   3. Merges by section: the result has ONE "## What Changed", ONE
 *      "## Summary of New Capabilities", ONE "## What to Tell Your User", ONE
 *      "## Evidence" — each section is the concatenation of that section across
 *      all inputs (in source order). Any non-canonical H2 section is preserved
 *      and appended after the canonical ones (also concatenated by title).
 *   4. The bump directive is the HIGHEST tier among the inputs
 *      (major > minor > patch), emitted as `<!-- bump: X -->`. This is a
 *      documentation hint only — the REAL release tier is
 *      `.instar/release-tier.json`, which this script never touches.
 *   5. Writes the merged result to `upgrades/NEXT.md`.
 *
 * ── No-op / failure semantics ─────────────────────────────────────────
 *   - NO fragments AND NO legacy NEXT.md → does nothing, exits 0 quietly. The
 *     existing publish "skip if no NEXT.md" logic then fires unchanged.
 *   - A real malformation (a fragment with content but no parseable H2 section
 *     at all) → exits non-zero with a clear message, so the workflow fails
 *     loudly rather than shipping a broken guide.
 *   - Idempotent: running twice produces the same NEXT.md. (When a generated
 *     NEXT.md is the ONLY input — no fragments — it is re-emitted byte-stable.)
 *
 * The core `assembleNextMd()` function is pure (string in / string out) and is
 * exported for unit testing. The CLI wrapper at the bottom handles I/O.
 *
 * Usage:
 *   node scripts/assemble-next-md.mjs            # assemble + write upgrades/NEXT.md
 *   node scripts/assemble-next-md.mjs --upgrades-dir <path>   # override (tests)
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// ── Canonical section order ───────────────────────────────────────────
// These four are the sections check-upgrade-guide.js / upgrade-guide-validator
// know about. We emit them in this order; any other H2 is appended after.
export const CANONICAL_SECTIONS = [
  'What Changed',
  'What to Tell Your User',
  'Summary of New Capabilities',
  'Evidence',
];

const BUMP_RANK = { patch: 0, minor: 1, major: 2 };
const RANK_BUMP = ['patch', 'minor', 'major'];

const H1_HEADER = '# Upgrade Guide — vNEXT';

// Stable marker stamped into every machine-assembled NEXT.md. It lets us
// recognize (and skip re-folding) a NEXT.md that this script generated, which
// is what keeps the on-disk assemble idempotent: a second run shouldn't fold
// the previous run's output back in on top of the still-present fragments. A
// hand-authored legacy NEXT.md (no marker) is still folded for backward compat.
export const GENERATED_MARKER = '<!-- assembled-by: assemble-next-md -->';

/** True when content was produced by this assembler (carries the marker). */
export function isAssembledOutput(content) {
  return String(content).includes(GENERATED_MARKER);
}

/**
 * Parse the declared bump type from a fragment's `<!-- bump: TYPE -->` comment.
 * Returns 'patch' | 'minor' | 'major' | null.
 */
export function parseBumpType(content) {
  const match = /<!--\s*bump:\s*(patch|minor|major)\s*-->/i.exec(content);
  return match ? match[1].toLowerCase() : null;
}

/**
 * Does this fragment opt into the internal-only ship lane via an
 * `<!-- internal-only -->` marker? Such a fragment has no user-facing surface,
 * so it may omit the "What to Tell Your User" / "Summary of New Capabilities"
 * sections — the assembler auto-fills them ONLY when EVERY contributing fragment
 * is internal-only (see assembleNextMd). The pre-push gate independently verifies
 * the marker against the staged diff (an internal-only fragment whose PR touches
 * runtime `src/` is rejected), so the marker cannot be misused.
 */
export function hasInternalOnlyMarker(content) {
  return /<!--\s*internal-only\s*-->/i.test(String(content));
}

/** Canonical text auto-filled into the user-facing sections of an all-internal release. */
export const INTERNAL_ONLY_FILL = 'None — internal change (no user-facing surface).';

/**
 * Split a fragment body into H2 sections: [{ title, body }] in source order.
 * `body` excludes the heading line itself and is right-trimmed.
 * Content before the first H2 (H1 header, bump comment, stray prose) is dropped
 * from the section map — the assembler synthesizes a fresh H1 + bump comment.
 */
export function parseSections(content) {
  const out = [];
  const lines = String(content).replace(/\r\n/g, '\n').split('\n');
  let current = null;
  for (const line of lines) {
    const m = /^##\s+(.+?)\s*$/.exec(line);
    if (m) {
      if (current) out.push(current);
      current = { title: m[1].trim(), lines: [] };
    } else if (current) {
      current.lines.push(line);
    }
  }
  if (current) out.push(current);
  return out.map((s) => ({ title: s.title, body: s.lines.join('\n').replace(/\s+$/, '') }));
}

/**
 * Is this fragment content "empty" for assembly purposes? True when stripping
 * HTML comments and whitespace leaves nothing.
 */
function isEffectivelyEmpty(content) {
  return String(content).replace(/<!--[\s\S]*?-->/g, '').trim().length === 0;
}

/**
 * Core assembler. Pure: takes named fragment inputs, returns the merged NEXT.md
 * string (or throws on a real malformation).
 *
 * @param {Array<{ name: string, content: string }>} fragments
 *   Each input fragment, in the order they should be concatenated. `name` is
 *   used only for error messages.
 * @returns {string} the assembled NEXT.md content (with trailing newline).
 * @throws {Error} when a fragment has content but no parseable H2 section.
 */
export function assembleNextMd(fragments) {
  // Idempotency guard: a previously-assembled NEXT.md (carrying GENERATED_MARKER)
  // is the FOLD of the current fragments — folding it again on top of the same
  // fragments would duplicate every section. So when at least one non-generated
  // input is present, drop the generated one(s). When a generated output is the
  // SOLE input (no fragments), keep it: parse→emit is stable, so it re-emits
  // identically.
  const nonGenerated = fragments.filter((f) => !isAssembledOutput(f.content ?? ''));
  const effective = nonGenerated.length > 0 ? nonGenerated : fragments;

  // Map title -> array of section bodies (in source order).
  const merged = new Map();
  // Preserve first-seen order of non-canonical titles.
  const extraOrder = [];
  let maxBumpRank = 0;
  let sawAnyBump = false;
  // The internal-only lane auto-fills the user-facing sections ONLY when every
  // contributing fragment opts in. Starts true for a non-empty input set and is
  // cleared by the first fragment WITHOUT an <!-- internal-only --> marker, so a
  // single user-facing fragment keeps the full user-section requirement.
  let allInternal = effective.length > 0;

  for (const frag of effective) {
    const content = frag.content ?? '';
    if (!hasInternalOnlyMarker(content)) allInternal = false;
    const bump = parseBumpType(content);
    if (bump) {
      sawAnyBump = true;
      maxBumpRank = Math.max(maxBumpRank, BUMP_RANK[bump]);
    }

    const sections = parseSections(content);
    if (sections.length === 0) {
      // No H2 sections. An effectively-empty fragment (only comments/whitespace)
      // is malformed — a fragment file should always carry real notes.
      // A fragment with real prose but no headings is also malformed: we can't
      // place its content under a known section.
      throw new Error(
        `release-note fragment "${frag.name}" has no recognizable "## " section. ` +
        `Every fragment must contain at least one section heading ` +
        `(e.g. "## What Changed"). Fix or remove this fragment.`,
      );
    }

    for (const sec of sections) {
      const body = sec.body.trim();
      // Skip a section whose body is only whitespace/comments — nothing to fold.
      if (isEffectivelyEmpty(body)) continue;
      if (!merged.has(sec.title)) {
        merged.set(sec.title, []);
        if (!CANONICAL_SECTIONS.includes(sec.title)) extraOrder.push(sec.title);
      }
      merged.get(sec.title).push(body);
    }
  }

  // If after folding there is genuinely nothing to say, that's a malformation
  // for a non-empty input set (every fragment was comments-only).
  if (merged.size === 0) {
    throw new Error(
      'release-note fragments produced no content — every section was empty. ' +
      'Fill in at least "## What Changed" in one fragment.',
    );
  }

  // Internal-only lane: when EVERY contributing fragment is marked
  // <!-- internal-only -->, the change has no user-facing surface, so the two
  // user-facing sections are auto-filled rather than hand-written. This keeps the
  // shared validator (pre-push AND publish) satisfied without forcing
  // "None — internal" boilerplate by hand. We auto-fill ONLY missing sections, so
  // an internal fragment that DOES say something user-facing is preserved as-is;
  // and because `allInternal` is false whenever any fragment lacks the marker, a
  // genuinely user-facing change that omits these sections still fails validation.
  if (allInternal) {
    for (const title of ['What to Tell Your User', 'Summary of New Capabilities']) {
      if (!merged.has(title)) merged.set(title, [INTERNAL_ONLY_FILL]);
    }
  }

  // Emit canonical sections first (only when present), then extras in
  // first-seen order.
  const titleOrder = [
    ...CANONICAL_SECTIONS.filter((t) => merged.has(t)),
    ...extraOrder,
  ];

  const bump = sawAnyBump ? RANK_BUMP[maxBumpRank] : 'patch';

  const parts = [];
  parts.push(H1_HEADER);
  parts.push('');
  parts.push(GENERATED_MARKER);
  parts.push(`<!-- bump: ${bump} -->`);
  parts.push('');
  for (const title of titleOrder) {
    const bodies = merged.get(title);
    parts.push(`## ${title}`);
    parts.push('');
    // Concatenate each fragment's body for this section, separated by a blank
    // line. Bodies were already trimmed.
    parts.push(bodies.join('\n\n'));
    parts.push('');
  }

  // Single trailing newline, no duplicate blank lines at EOF.
  return parts.join('\n').replace(/\n+$/, '\n');
}

// ── CLI entry point ────────────────────────────────────────────────────

/**
 * Gather fragment inputs from disk in deterministic order: legacy NEXT.md first
 * (so its content leads), then `next/*.md` sorted by filename.
 */
export function gatherFragmentInputs(upgradesDir) {
  const inputs = [];

  const legacyPath = path.join(upgradesDir, 'NEXT.md');
  const fragmentsDir = path.join(upgradesDir, 'next');

  let legacyContent = null;
  if (fs.existsSync(legacyPath)) {
    legacyContent = fs.readFileSync(legacyPath, 'utf-8');
  }

  let fragmentFiles = [];
  if (fs.existsSync(fragmentsDir)) {
    fragmentFiles = fs
      .readdirSync(fragmentsDir)
      .filter((f) => f.endsWith('.md'))
      .sort((a, b) => a.localeCompare(b, 'en'));
  }

  // Fold the legacy NEXT.md in first — only when it carries real content
  // (skip a bare template/empty file so re-runs are idempotent and a fresh
  // template doesn't masquerade as content).
  if (legacyContent !== null && !isEffectivelyEmpty(legacyContent)) {
    inputs.push({ name: 'NEXT.md', content: legacyContent });
  }

  for (const file of fragmentFiles) {
    const content = fs.readFileSync(path.join(fragmentsDir, file), 'utf-8');
    inputs.push({ name: `next/${file}`, content });
  }

  return { inputs, hadLegacy: legacyContent !== null, fragmentCount: fragmentFiles.length };
}

function main() {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const ROOT = path.resolve(__dirname, '..');

  // Allow tests / callers to point at an alternate upgrades dir.
  const argIdx = process.argv.indexOf('--upgrades-dir');
  const upgradesDir =
    argIdx !== -1 && process.argv[argIdx + 1]
      ? path.resolve(process.argv[argIdx + 1])
      : path.join(ROOT, 'upgrades');

  const { inputs, hadLegacy, fragmentCount } = gatherFragmentInputs(upgradesDir);

  if (inputs.length === 0) {
    // No fragments and no (content-bearing) legacy NEXT.md. Do nothing — the
    // existing publish skip logic handles the "nothing to publish" case.
    console.log(
      `[assemble-next-md] no fragments in ${path.join(upgradesDir, 'next')} ` +
      `and no content-bearing NEXT.md — nothing to assemble.`,
    );
    process.exit(0);
  }

  let assembled;
  try {
    assembled = assembleNextMd(inputs);
  } catch (err) {
    console.error(`[assemble-next-md] ERROR: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  const nextPath = path.join(upgradesDir, 'NEXT.md');
  fs.mkdirSync(upgradesDir, { recursive: true });
  fs.writeFileSync(nextPath, assembled);

  console.log(
    `[assemble-next-md] assembled ${fragmentCount} fragment(s)` +
    `${hadLegacy ? ' + legacy NEXT.md' : ''} → ${path.relative(ROOT, nextPath)}`,
  );
  process.exit(0);
}

// Only run main() when invoked directly (not when imported by tests).
// Compare resolved file URLs rather than string-concatenating argv[1] — that
// naive form breaks on relative paths and paths containing spaces.
function invokedDirectly() {
  if (!process.argv[1]) return false;
  try {
    return import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href;
  } catch {
    return import.meta.url === pathToFileURL(process.argv[1]).href;
  }
}

if (invokedDirectly()) {
  main();
}
