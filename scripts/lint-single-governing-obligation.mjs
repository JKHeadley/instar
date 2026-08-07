#!/usr/bin/env node
/**
 * lint-single-governing-obligation.mjs — one obligation, one owner.
 *
 * ── Why this exists ────────────────────────────────────────────────────────
 * An external reviewer of the Substrate family found on 2026-08-06:
 * *"A Wall Is a Hypothesis, Never a False Blocker, and Self-Unblock Before
 * Escalating all require inventorying and exhausting existing means before
 * declaring a blocker or involving a human … Their feasibility/agency/resolution
 * labels do not establish a clear governing boundary for an ordinary
 * escalation."*
 *
 * Justin ruled 2026-08-07: fold them into the self-unblock ladder as the single
 * governing article — *"Remove what demands attention — delete the duplication,
 * do not reconcile it."*
 *
 * The duplication was deleted. This check is what stops it growing back. Prose
 * saying "one owner" is exactly the class of claim that rots: the next author to
 * strengthen a sibling article will restate the ladder there in good faith, and
 * nothing would notice. *Remove What Demands Attention* is the standard this
 * enforces, applied to the registry that ratified it.
 *
 * ── What this measures, and what it certifies ──────────────────────────────
 * Declared explicitly, per *Verify the State, Not Its Symbol* tooth (D):
 *
 *   MEASURED  — (1) the governing article carries the literal governing
 *               declaration; (2) each detection-surface article carries the
 *               literal disclaimer AND names the governing article; (3) the
 *               ladder's canonical rung enumeration appears in EXACTLY ONE
 *               article across the whole registry.
 *   CERTIFIED — the obligation has exactly one declared owner, and no article
 *               in the population silently reacquires it in the ladder's own
 *               canonical form.
 *
 * It does NOT certify that no article restates the obligation in DIFFERENT
 * words. A paraphrase is invisible here. That limit is deliberate and is why
 * this is a structural declaration check rather than a prose scan: judging
 * whether new prose MEANS the same obligation is a semantic judgment, and
 * *Intelligence Infers, Keywords Only Guard* forbids a regex from making it
 * (window-8 trap 4 — a proposed guard can be forbidden by another standard).
 * What is checkable structurally is checked structurally; the rest belongs to
 * family review, which is where this finding came from in the first place.
 *
 * What input passes this check while failing the claim? An article outside the
 * declared population that invents a fourth surrender surface and states the
 * obligation for it. The population is declared, not discovered — naming that,
 * not hiding it.
 *
 * Exit codes: 0 — clean; 1 — at least one violation.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(__filename), '..');
const JSON_OUT = process.argv.includes('--json');
const REGISTRY_REL = 'docs/STANDARDS-REGISTRY.md';

/** The single governing article for the exhaust-before-escalating obligation. */
const GOVERNING = 'Self-Unblock Before Escalating';

/**
 * The detection-surface articles that hand off to the governing article. This
 * population is DECLARED, deliberately: the check must fail closed if one of
 * them is renamed or removed, rather than silently shrinking to nothing.
 */
const DETECTION_SURFACES = ['A Wall Is a Hypothesis', 'Never a False Blocker'];

/** The governing article's own declaration that it owns the obligation. */
const GOVERNING_DECLARATION = 'THE SINGLE GOVERNING ARTICLE for exhaust-before-escalating';

/** A detection-surface article's disclaimer that it does NOT own the obligation. */
const SURFACE_DISCLAIMER = 'does NOT own the exhaust-before-escalating obligation';

/**
 * The ladder's canonical rung enumeration. This exact form may exist in exactly
 * one article — it IS the obligation's statement, and a second copy is the
 * duplication returning.
 */
const LADDER_CANONICAL = '**nothing** (resolve it yourself) → **an approval**';

const abs = path.join(ROOT, REGISTRY_REL);
if (!fs.existsSync(abs)) {
  console.error(`[single-governing-obligation] ${REGISTRY_REL} is missing — refusing to report clean.`);
  process.exit(1);
}

// Split into articles: heading → body. (Same shape as lint-registry-tree-parentage.)
const lines = fs.readFileSync(abs, 'utf-8').split('\n');
const articles = [];
let current = null;
let fence = null;
for (let i = 0; i < lines.length; i++) {
  const line = lines[i];
  const t = line.trimStart();
  const f = t.match(/^(`{3,}|~{3,})/);
  if (fence === null && f) { fence = f[1]; if (current) current.body.push(line); continue; }
  if (fence !== null) { if (new RegExp(`^${fence[0]}{${fence.length},}\\s*$`).test(t)) fence = null; if (current) current.body.push(line); continue; }
  const h = line.match(/^###\s+(.+?)\s*$/);
  if (h) { current = { name: h[1].trim(), lineNo: i + 1, body: [] }; articles.push(current); continue; }
  if (current) current.body.push(line);
}

if (articles.length === 0) {
  console.error('[single-governing-obligation] parsed ZERO articles — the matcher is broken; refusing to report clean.');
  process.exit(1);
}

/** Headings carry subtitles after an em dash, so match on the leading name. */
function resolveArticle(name) {
  const exact = articles.find((a) => a.name === name);
  if (exact) return exact;
  const prefixed = articles.filter((a) => a.name.startsWith(`${name} —`) || a.name.startsWith(`${name}.`));
  return prefixed.length === 1 ? prefixed[0] : null;
}

const failures = [];

// (1) The governing article exists and declares that it governs.
const governing = resolveArticle(GOVERNING);
if (!governing) {
  failures.push(
    `the governing article "${GOVERNING}" resolves to no article. The obligation's single owner cannot be missing — ` +
    `if it was renamed, update GOVERNING in this lint in the same change.`,
  );
} else if (!governing.body.join('\n').includes(GOVERNING_DECLARATION)) {
  failures.push(
    `${REGISTRY_REL}:${governing.lineNo} — "${governing.name}" no longer carries the governing declaration ` +
    `"${GOVERNING_DECLARATION}". Without it the registry has an obligation with no declared owner, which is the ` +
    `pre-2026-08-07 state the operator ruled against.`,
  );
}

// (2) Each detection surface disclaims the obligation and names the governing article.
for (const name of DETECTION_SURFACES) {
  const a = resolveArticle(name);
  if (!a) {
    failures.push(
      `detection-surface article "${name}" resolves to no article. This population is declared, so a rename or ` +
      `removal must be reflected in DETECTION_SURFACES in the same change rather than silently shrinking the check.`,
    );
    continue;
  }
  const text = a.body.join('\n');
  if (!text.includes(SURFACE_DISCLAIMER)) {
    failures.push(
      `${REGISTRY_REL}:${a.lineNo} — "${a.name}" does not carry the disclaimer "${SURFACE_DISCLAIMER}". ` +
      `A detection-surface article that stops disclaiming the obligation has reacquired it, and the registry is ` +
      `back to one obligation with several owners and no boundary.`,
    );
  }
  if (!text.includes(GOVERNING)) {
    failures.push(
      `${REGISTRY_REL}:${a.lineNo} — "${a.name}" does not name "${GOVERNING}". A hand-off that does not say where ` +
      `it hands off to leaves the reader exactly where the external reviewer found them.`,
    );
  }
}

// (3) The ladder is stated in exactly one article.
const ladderHolders = articles.filter((a) => a.body.join('\n').includes(LADDER_CANONICAL));
if (ladderHolders.length === 0) {
  failures.push(
    `the ladder's canonical rung enumeration is present in NO article. Either the ladder was reworded — in which ` +
    `case update LADDER_CANONICAL in the same change — or the obligation lost its statement entirely.`,
  );
} else if (ladderHolders.length > 1) {
  failures.push(
    `the ladder is stated in ${ladderHolders.length} articles: ${ladderHolders.map((a) => `"${a.name}" (:${a.lineNo})`).join(', ')}. ` +
    `It may be stated in exactly one. This is the duplication growing back — delete the copy, do not reconcile it.`,
  );
} else if (governing && ladderHolders[0].name !== governing.name) {
  failures.push(
    `the ladder is stated in "${ladderHolders[0].name}" (:${ladderHolders[0].lineNo}), not in the governing article ` +
    `"${governing.name}". The owner of the obligation must be the article that states it.`,
  );
}

const report = {
  articles: articles.length,
  governing: governing?.name ?? null,
  detectionSurfaces: DETECTION_SURFACES,
  ladderHolders: ladderHolders.map((a) => a.name),
  failures,
};

if (JSON_OUT) {
  console.log(JSON.stringify(report, null, 2));
} else if (failures.length === 0) {
  console.log(
    `lint-single-governing-obligation: clean — "${governing.name}" governs; ` +
    `${DETECTION_SURFACES.length} detection surface(s) disclaim and hand off; ladder stated exactly once.`,
  );
}

if (failures.length > 0) {
  console.error('\n❌ lint-single-governing-obligation failed:');
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
