#!/usr/bin/env node
/**
 * lint-registry-tree-parentage.mjs — an article that CLAIMS a parent must be
 * claimed back by that parent, and the parent must exist.
 *
 * ── Why this exists ────────────────────────────────────────────────────────
 * The standards registry has no nesting syntax: every article is an `###`
 * heading, so a "tree node under X" and its parent render as PEERS. Parentage
 * therefore lives entirely in prose — and prose claiming a structure the file
 * does not have is a symbol standing in for a state (*Verify the State, Not Its
 * Symbol*).
 *
 * An external reviewer of the amended family found exactly this on 2026-08-06:
 * *"articles explicitly described as 'A tree node under' another article … are
 * presented as peer headings, not children."* The finding is correct. Changing
 * heading levels is not available — the registry parser matches `###` exactly,
 * so a `####` child would silently vanish from the registry's own accounting,
 * which is a worse defect than the one being fixed. So the relation stays in
 * prose and this check makes the prose TRUE rather than merely asserted.
 *
 * ── What this measures, and what it certifies ──────────────────────────────
 * Declared explicitly, per *Verify the State, Not Its Symbol* tooth (D):
 *
 *   MEASURED  — for every article whose text declares "a tree node under *X*",
 *               X resolves to a real article in the registry, X is not the
 *               article itself, and X's own text names the child back.
 *   CERTIFIED — a declared parent-child relation is REAL and BIDIRECTIONAL: it
 *               cannot point at an article that does not exist, and a parent
 *               cannot be silently unaware of a child that claims it.
 *
 * It does NOT certify that the placement is correct — whether an article
 * BELONGS under its declared parent is a judgment call that placement review
 * makes, not a lint. It certifies only that the declared relation is not a
 * dangling or one-sided assertion.
 *
 * What input passes this check while failing the claim? An article that is
 * genuinely a child but declares no parent at all — invisible here, because the
 * check is driven by the declaration. Naming that, not hiding it.
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

/** "A tree node under *Parent Name*" / "a tree node under **Parent Name**" */
const PARENT_CLAIM_RE = /\ba tree node (?:under|beneath) \*{1,2}([^*]+?)\*{1,2}/gi;
/** "Tree node beneath it: *Child Name*" — the parent's acknowledgement. */
const CHILD_CLAIM_RE = /\btree nodes? (?:beneath|under) it:?\s*\*{1,2}([^*]+?)\*{1,2}/gi;

const abs = path.join(ROOT, REGISTRY_REL);
if (!fs.existsSync(abs)) {
  console.error(`[registry-tree-parentage] ${REGISTRY_REL} is missing — refusing to report clean.`);
  process.exit(1);
}

// Split into articles: heading → body.
const lines = fs.readFileSync(abs, 'utf-8').split('\n');
const articles = [];
let current = null;
let fence = null;
let family = null;
for (let i = 0; i < lines.length; i++) {
  const line = lines[i];
  const t = line.trimStart();
  const f = t.match(/^(`{3,}|~{3,})/);
  if (fence === null && f) { fence = f[1]; if (current) current.body.push(line); continue; }
  if (fence !== null) { if (new RegExp(`^${fence[0]}{${fence.length},}\\s*$`).test(t)) fence = null; if (current) current.body.push(line); continue; }
  const fam = line.match(/^##\s+(.+?)\s*$/);
  if (fam) { family = fam[1].trim(); current = null; continue; }
  const h = line.match(/^###\s+(.+?)\s*$/);
  if (h) { current = { name: h[1].trim(), lineNo: i + 1, family, body: [] }; articles.push(current); continue; }
  if (current) current.body.push(line);
}

const failures = [];
if (articles.length === 0) {
  console.error(`[registry-tree-parentage] parsed ZERO articles — the matcher is broken; refusing to report clean.`);
  process.exit(1);
}

const byName = new Map(articles.map((a) => [a.name, a]));
/** Match a claimed name against real article headings (headings carry subtitles after an em dash). */
function resolveArticle(claim) {
  const c = claim.trim();
  if (byName.has(c)) return byName.get(c);
  const prefix = articles.filter((a) => a.name === c || a.name.startsWith(`${c} —`) || a.name.startsWith(`${c}.`));
  return prefix.length === 1 ? prefix[0] : null;
}

const relations = [];
for (const a of articles) {
  const text = a.body.join('\n');
  // ALL parent claims, not just the first. Taking only the first silently reduced
  // a two-parent declaration to one, which made the "an article has two parents"
  // diagnostic in generate-standards-hierarchy.mjs unreachable — a guard that
  // cannot fire is a guarantee that is not being given (2026-08-08).
  const claims = [...text.matchAll(PARENT_CLAIM_RE)].map((m) => m[1].trim());
  for (const claimed of claims) {
  const parent = resolveArticle(claimed);
  if (!parent) {
    failures.push(`${REGISTRY_REL}:${a.lineNo} — "${a.name}" declares a tree node under "${claimed}", which resolves to no article. A parent that does not exist is a dangling relation.`);
    continue;
  }
  if (parent.name === a.name) {
    failures.push(`${REGISTRY_REL}:${a.lineNo} — "${a.name}" declares itself its own parent.`);
    continue;
  }
  const parentText = parent.body.join('\n');
  const acknowledged = [...parentText.matchAll(CHILD_CLAIM_RE)].some(([, child]) => {
    const c = child.trim();
    return a.name === c || a.name.startsWith(`${c} —`) || a.name.startsWith(`${c}.`) || c.startsWith(a.name);
  });
  if (!acknowledged) {
    failures.push(
      `${REGISTRY_REL}:${a.lineNo} — "${a.name}" claims "${parent.name}" as its parent, but that article does not name it back. ` +
      `The registry renders every article as a peer heading, so an unacknowledged parentage claim is prose asserting a structure the file does not have. ` +
      `Add "Tree node beneath it: *${a.name}*" to "${parent.name}".`,
    );
    continue;
  }
  relations.push({ child: a.name, parent: parent.name });
  }
}

const report = {
  articles: articles.length,
  relations,
  failures,
  // Emitted so a CONSUMER (the hierarchy generator) can render from this
  // extraction instead of parsing the registry a second time. Two parsers of
  // one structure is the drift defect this whole area keeps producing.
  articleList: articles.map((a) => ({ name: a.name, family: a.family, lineNo: a.lineNo })),
};

if (JSON_OUT) {
  console.log(JSON.stringify(report, null, 2));
} else if (failures.length === 0) {
  console.log(
    `lint-registry-tree-parentage: clean — ${articles.length} article(s), ${relations.length} declared parent-child relation(s), all resolving and bidirectional.`,
  );
}

if (failures.length > 0) {
  console.error('\n❌ lint-registry-tree-parentage failed:');
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
