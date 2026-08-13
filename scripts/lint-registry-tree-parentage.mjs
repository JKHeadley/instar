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

/**
 * THE MERGE SYNTAX (operator re-ruling of 4a, 2026-08-13) — a second way to declare parentage.
 *
 * A superseded standard is not retired; it becomes a **named subsection** of its parent and stays
 * live. That relation is declared with `**Merged into.** … **named subsection** of *Parent*` on the
 * child and `**Merged subsections.** … **Child** — <tripwire>` on the parent.
 *
 * Why this is here rather than in a separate lint: an independent review found the 25 merged
 * relations were INVISIBLE to this lint, which matched only the legacy "tree node under" wording. A
 * parent's backlink or a child's tripwire could be deleted and every required check stayed green —
 * a bidirectionality guard that cannot see most of the tree it guards. The merge model's whole
 * premise is that the specificity survives at both ends, so both ends have to be checked here, by
 * the lint that already owns "a declared relation must be real and bidirectional".
 */
const MERGED_INTO_RE = /\*\*named subsection\*\* of \*(.+?)\*, merged /gi;
/** The parent's side: each child is named in bold inside the `**Merged subsections.**` line. */
const MERGED_SUBSECTION_LINE = /^\*\*Merged subsections\.\*\*/;

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

  // ── MERGED-SUBSECTION relations: the same bidirectional bar, plus the tripwire on both ends ──
  const mergedClaims = [...text.matchAll(MERGED_INTO_RE)].map((m) => m[1].trim());
  for (const claimed of mergedClaims) {
    const parent = resolveArticle(claimed);
    if (!parent) {
      failures.push(`${REGISTRY_REL}:${a.lineNo} — "${a.name}" declares itself a merged subsection of "${claimed}", which resolves to no article. A parent that does not exist is a dangling relation.`);
      continue;
    }
    if (parent.name === a.name) {
      failures.push(`${REGISTRY_REL}:${a.lineNo} — "${a.name}" declares itself its own parent.`);
      continue;
    }
    // The child must state the tripwire it contributes. Without it the merge is a pointer, and the
    // operator's whole objection to retirement was losing the specificity a pointer cannot carry.
    if (!/\*\*The tripwire it contributes to its parent:\*\*\s*\S/.test(text)) {
      failures.push(
        `${REGISTRY_REL}:${a.lineNo} — "${a.name}" is merged into "${parent.name}" but states NO tripwire it contributes. ` +
        `A merged subsection without its tripwire is a pointer, and the ruling exists because a pointer does not carry the ` +
        `specificity the development process needs.`,
      );
      continue;
    }
    // The parent must name this child in its **Merged subsections.** line — the backlink.
    const subsLine = parent.body.find((l) => MERGED_SUBSECTION_LINE.test(l));
    if (!subsLine) {
      failures.push(
        `${REGISTRY_REL}:${a.lineNo} — "${a.name}" is merged into "${parent.name}", but that article has no ` +
        `**Merged subsections.** line naming it back. Every article renders as a peer heading, so an unacknowledged ` +
        `merge is prose asserting a structure the file does not have.`,
      );
      continue;
    }
    const shortChild = a.name.split(' — ')[0];
    if (!subsLine.includes(shortChild)) {
      failures.push(
        `${REGISTRY_REL}:${a.lineNo} — "${parent.name}" has a **Merged subsections.** line that does NOT name "${shortChild}". ` +
        `The backlink is the half that can silently disappear; a merge named in only one direction is not a relation.`,
      );
      continue;
    }
    // And the parent's entry for this child must carry that child's tripwire, not just its name.
    //
    // Bounded to THIS child's entry. The first version looked 400 characters past the name for an
    // em-dash, which on a multi-child line found the NEXT child's tripwire and passed — a guard that
    // could not fail, found by removing a tripwire and watching it stay green. Entries are separated
    // by "; ", so the child's own span ends at the next separator.
    const nameAt = subsLine.indexOf(shortChild);
    const afterName = subsLine.slice(nameAt + shortChild.length);
    const entry = afterName.split(/;\s/)[0];
    if (!/—\s*\S/.test(entry)) {
      failures.push(
        `${REGISTRY_REL}:${a.lineNo} — "${parent.name}" names "${shortChild}" as a merged subsection but records no ` +
        `tripwire for it. The parent listing a child's NAME without what it actually trips on is the summarisation ` +
        `the operator ruled against.`,
      );
      continue;
    }
    relations.push({ child: a.name, parent: parent.name, kind: 'merged-subsection' });
  }
}

const report = {
  articles: articles.length,
  relations,
  failures,
  // Emitted so a CONSUMER (the hierarchy generator) can render from this
  // extraction instead of parsing the registry a second time. Two parsers of
  // one structure is the drift defect this whole area keeps producing.
  // `pendingRatification` is emitted so the hierarchy renderer can MARK a parent
  // whose own constitutional status is unsettled. The 2026-08-08 fifth-pass review
  // found *Observable Intelligence* "pending operator ratification" while already
  // parenting a child in the generated tree — an unratified article acting as
  // structural authority, silently. Discovered from the article's own text rather
  // than a maintained list, per the lesson of this same session.
  articleList: articles.map((a) => ({
    name: a.name,
    family: a.family,
    lineNo: a.lineNo,
    pendingRatification: /pending operator ratification/i.test(a.body.join('\n')),
  })),
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
