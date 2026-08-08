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
 *               article across the whole registry; (4) no deferring article
 *               states the obligation in one of its DECLARED imperative forms.
 *   CERTIFIED — the obligation has exactly one declared owner, and no article
 *               in the population silently reacquires it in the ladder's own
 *               canonical form or in a declared order-giving form.
 *
 * Arm (4) was added 2026-08-08 because the re-review found the hole: *Notices
 * Route to the Alerts Topic* carried the disclaimer ("does NOT own the
 * aggregation obligation") in its Rule and then commanded "must AGGREGATE" in
 * its practice. Arms (1)-(3) all passed. **A disclaimer plus an imperative is
 * worse than plain duplication** — the reader who checks ownership finds the
 * denial and stops looking. The check that verified the deferral was declared
 * could not see that the deferral was untrue.
 *
 * It still does NOT certify that no article restates the obligation in words
 * outside the declared `imperatives` list. A fresh paraphrase is invisible
 * here. That limit is deliberate and is why this is a structural declaration
 * check rather than a prose scan: judging whether new prose MEANS the same
 * obligation is a semantic judgment, and *Intelligence Infers, Keywords Only
 * Guard* forbids a regex from making it (window-8 trap 4 — a proposed guard can
 * be forbidden by another standard). The `imperatives` rows are not an attempt
 * to infer meaning: each is a literal that was ACTUALLY found duplicating an
 * obligation, added after the fact, the way a regression test is. What is
 * checkable structurally is checked structurally; the rest belongs to family
 * review, which is where both of these findings came from.
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

/**
 * The obligation table. Each row is ONE obligation with ONE governing article and
 * the articles that DEFER to it. Generalised 2026-08-07 from a single hard-coded
 * obligation, because the external Building review found a second and a third
 * instance of the same defect — one obligation, several owners, no boundary.
 *
 *   governing   — the article that OWNS the obligation and states it.
 *   deferrers   — articles that touch the same ground and must disclaim it.
 *   declaration — the literal the governing article must carry.
 *   disclaimer  — the literal each deferrer must carry.
 *   canonical   — a phrase that IS the obligation's statement. It may appear in
 *                 exactly one article; a second copy is the duplication returning.
 *                 Optional: omit where the obligation has no single canonical form.
 */
const OBLIGATIONS = [
  {
    id: 'exhaust-before-escalating',
    governing: 'Self-Unblock Before Escalating',
    deferrers: ['A Wall Is a Hypothesis', 'Never a False Blocker'],
    declaration: 'THE SINGLE GOVERNING ARTICLE for exhaust-before-escalating',
    disclaimer: 'does NOT own the exhaust-before-escalating obligation',
    canonical: '**nothing** (resolve it yourself) → **an approval**',
  },
  {
    id: 'notification-volume',
    governing: 'Bounded Notification Surface',
    deferrers: ['Notices Route to the Alerts Topic, Never a New One'],
    declaration: 'THE SINGLE GOVERNING ARTICLE for notification VOLUME',
    disclaimer: 'does NOT own the aggregation obligation',
    canonical: null,
    imperatives: ['must aggregate'],
  },
  {
    id: 'self-action-convergence',
    governing: 'Capacity Safety',
    deferrers: ['No Unbounded Loops'],
    declaration: 'THE SINGLE GOVERNING ARTICLE for self-action convergence',
    disclaimer: 'does NOT own the convergence obligation',
    canonical: null,
  },
  {
    // Added 2026-08-08 (third pass). Draft 3 declared *Side-Effects Review Gate* the
    // owner of "pre-ship evidence validation" — a phrase that reads as owning the
    // EVIDENCE, colliding head-on with *Bug-Fix Evidence Bar*. Two rows, because
    // there are genuinely two obligations here and the collision came from one
    // phrase covering both: WHO may attest, and WHAT must be shown.
    id: 'pre-ship-evidence-standard',
    governing: 'Bug-Fix Evidence Bar',
    deferrers: ['Side-Effects Review Gate'],
    declaration: 'THE SINGLE GOVERNING ARTICLE for the pre-ship evidence STANDARD',
    disclaimer: 'does NOT own the evidence-standard obligation',
    canonical: null,
  },
  {
    id: 'pre-ship-evidence-validator',
    governing: 'Side-Effects Review Gate',
    deferrers: ['Bug-Fix Evidence Bar'],
    declaration: 'THE SINGLE GOVERNING ARTICLE for pre-ship evidence VALIDATION',
    disclaimer: 'does NOT own the validator obligation',
    canonical: null,
  },
  {
    // Added 2026-08-08 from the Shipping re-review, which read *A Dark Feature Guards
    // Nothing*'s "record explicit operator acceptance" as an EXIT from *Maturation
    // Path*'s mandatory ladder. Registering the boundary is what keeps the resolution
    // from being prose that the next author quietly re-opens.
    id: 'feature-graduation',
    governing: 'Maturation Path',
    deferrers: ['A Dark Feature Guards Nothing'],
    declaration: 'THE SINGLE GOVERNING ARTICLE for feature graduation',
    disclaimer: 'does NOT own the graduation obligation',
    canonical: null,
  },
  {
    // Added 2026-08-08. The floor/intelligence union was ratified into *Intelligence
    // Infers* on 2026-08-07, and the exact-match carve-out was added the next day
    // saying "this article is its whole extent" — so BOTH claimed the same
    // obligation. The re-review caught it. Registering it here is the point: the
    // fix for a duplicate-ownership defect reproduced the defect, which is exactly
    // the failure a declared table prevents and a careful author does not.
    id: 'emergency-stop-authority',
    governing: 'Structure Decides Alone Only on an Exact Match',
    // *The Operator Channel Is Sacred* was added 2026-08-08 (second pass). It named
    // the OLD owner and the first pass did not list it, so the row shipped and the
    // stale attribution survived it — the declared-population blind spot this file's
    // header names, biting on the change that introduced the row. Adding a deferrer
    // is cheap; noticing one is missing is the expensive part, and here the family
    // review did it, not the lint.
    deferrers: ['Intelligence Infers, Keywords Only Guard', 'The Operator Channel Is Sacred'],
    declaration: 'THIS ARTICLE OWNS EMERGENCY-STOP DECISION AUTHORITY',
    disclaimer: 'does NOT own emergency-stop decision authority',
    canonical: 'Stop = floor OR model, never floor AND model',
    imperatives: ['always stops', 'decides alone and is un-overridable'],
  },
];

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
  // Headings carry subtitles in several shapes: an em dash, a full stop, a comma,
  // or a parenthetical. The paren form was missing until 2026-08-08, so
  // "Bug-Fix Evidence Bar (verify before you claim)" resolved to nothing and the
  // lint reported a MISSING article rather than a real violation. Worth fixing in
  // the resolver rather than pasting the full heading into the table: the table
  // entry would have worked and left the next paren-suffixed article broken.
  const prefixed = articles.filter((a) => a.name.startsWith(`${name} —`)
    || a.name.startsWith(`${name}.`) || a.name.startsWith(`${name}, `) || a.name.startsWith(`${name} (`));
  return prefixed.length === 1 ? prefixed[0] : null;
}

const failures = [];
const relations = [];

for (const ob of OBLIGATIONS) {
  const governing = resolveArticle(ob.governing);
  if (!governing) {
    failures.push(
      `[${ob.id}] the governing article "${ob.governing}" resolves to no article. An obligation's single ` +
      `owner cannot be missing — if it was renamed, update OBLIGATIONS in this lint in the same change.`,
    );
  } else if (!governing.body.join('\n').includes(ob.declaration)) {
    failures.push(
      `${REGISTRY_REL}:${governing.lineNo} — [${ob.id}] "${governing.name}" no longer carries its governing ` +
      `declaration "${ob.declaration}". Without it the registry has an obligation with no declared owner.`,
    );
  }

  for (const name of ob.deferrers) {
    const a = resolveArticle(name);
    if (!a) {
      failures.push(
        `[${ob.id}] deferring article "${name}" resolves to no article. This population is declared, so a ` +
        `rename must be reflected in OBLIGATIONS in the same change rather than silently shrinking the check.`,
      );
      continue;
    }
    const text = a.body.join('\n');
    if (!text.includes(ob.disclaimer)) {
      failures.push(
        `${REGISTRY_REL}:${a.lineNo} — [${ob.id}] "${a.name}" does not carry the disclaimer "${ob.disclaimer}". ` +
        `An article that stops disclaiming an obligation has reacquired it, and the registry is back to one ` +
        `obligation with several owners and no boundary.`,
      );
    }
    if (!text.includes(ob.governing)) {
      failures.push(
        `${REGISTRY_REL}:${a.lineNo} — [${ob.id}] "${a.name}" does not name "${ob.governing}". A hand-off that ` +
        `does not say where it hands off to leaves the reader exactly where the reviewer found them.`,
      );
    }

    // A disclaimer says "not mine"; an imperative gives the order anyway. An article
    // that does both has not deferred — it has kept the obligation and added a
    // sentence denying it, which is strictly worse than the plain duplication because
    // the denial is what a reader (and this lint, until 2026-08-08) trusts.
    for (const imperative of ob.imperatives ?? []) {
      const hit = new RegExp(imperative.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').exec(text);
      if (hit) {
        failures.push(
          `${REGISTRY_REL}:${a.lineNo} — [${ob.id}] "${a.name}" disclaims the obligation but still states it as an ` +
          `order: "${hit[0]}". Delete the restatement — a deferral that keeps giving the command is not a deferral, ` +
          `and the disclaimer above it makes the duplication harder to see, not easier.`,
        );
      }
    }
  }

  if (ob.canonical) {
    const holders = articles.filter((a) => a.body.join('\n').includes(ob.canonical));
    if (holders.length === 0) {
      failures.push(`[${ob.id}] the canonical statement is present in NO article — it was reworded (update OBLIGATIONS) or lost.`);
    } else if (holders.length > 1) {
      failures.push(
        `[${ob.id}] the obligation is stated in ${holders.length} articles: ` +
        `${holders.map((a) => `"${a.name}" (:${a.lineNo})`).join(', ')}. It may be stated in exactly one. ` +
        `This is the duplication growing back — delete the copy, do not reconcile it.`,
      );
    } else if (governing && holders[0].name !== governing.name) {
      failures.push(
        `[${ob.id}] the obligation is stated in "${holders[0].name}", not in the governing article ` +
        `"${governing.name}". The owner of an obligation must be the article that states it.`,
      );
    }
  }

  relations.push({ id: ob.id, governing: ob.governing, deferrers: ob.deferrers });
}

const report = { articles: articles.length, obligations: relations, failures };

if (JSON_OUT) {
  console.log(JSON.stringify(report, null, 2));
} else if (failures.length === 0) {
  console.log(
    `lint-single-governing-obligation: clean — ${OBLIGATIONS.length} obligation(s), each with one declared ` +
    `governing article and ${OBLIGATIONS.reduce((n, o) => n + o.deferrers.length, 0)} deferring article(s).`,
  );
}

if (failures.length > 0) {
  console.error('\n❌ lint-single-governing-obligation failed:');
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
