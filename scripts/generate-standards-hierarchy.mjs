#!/usr/bin/env node
/**
 * generate-standards-hierarchy.mjs — render the DECLARED registry tree, and keep it true.
 *
 * ── Why this exists ────────────────────────────────────────────────────────
 * The 2026-08-08 family re-review raised the same finding in all three families
 * independently. Articles declare in their own text "this is a tree node under
 * X" — and render as ordinary peer headings, often many sections from X:
 *
 *   Substrate:  "*Quantitative Claims* declares itself a tree node under *Verify
 *                the State* but is presented independently before its parent."
 *   Shipping:   "*User-Facing Fixes Ship Live* declares itself a tree node under
 *                *Maturation Path*, yet it is formatted and located as a peer."
 *   Building:   "*Scrape/Parser Fixture Realness* declares itself a tree node
 *                under *Testing Integrity* but remains rendered as a peer …
 *                These are acknowledged structural-placement defects, not merely
 *                stylistic relationships."
 *
 * And the Substrate review named what it saw underneath: the registry "repeatedly
 * asserts relationships such as 'tree node under', but supplies no structural
 * hierarchy that resolves them."
 *
 * Designed by Codey under a brief that asked him to argue FOR or AGAINST
 * generation (`docs/proposals/standard-proposal-rendered-standards-hierarchy.md`).
 * He argued for it, and made the case this file implements: the declarations stay
 * the source of truth, the rendered tree is a READ SURFACE generated from them,
 * and a check refuses a stale block — so it cannot become a second hand-maintained
 * taxonomy that disagrees with the articles.
 *
 * ── Why not just deepen the headings ───────────────────────────────────────
 * Because it would silently rewrite enforcement classification. The article
 * parser keys on `###`, and family floors count articles; promoting nine children
 * to `####` would remove nine articles from the census and move every ratio that
 * CI ratchets. A rendering fix must not move the numbers that decide whether the
 * build passes.
 *
 * ── One extraction, two consumers ──────────────────────────────────────────
 * The relations come from `lint-registry-tree-parentage.mjs --json`, which
 * already resolves and bidirectionally validates every claim. This file does NOT
 * re-parse the registry for relations — Codey's point, and it is right: two
 * parsers of one structure is exactly the drift this area keeps producing.
 *
 * ── What this measures, and what it certifies ──────────────────────────────
 * Declared explicitly, per *Verify the State, Not Its Symbol* tooth (D):
 *
 *   MEASURED  — the declared relation set; tree-shape diagnostics over it
 *               (cycles, an article claiming two parents, a parent that is
 *               itself a child of its own child); the canonical rendered text;
 *               and whether the block checked into the registry matches it byte
 *               for byte.
 *   CERTIFIED — a reader can see the declared tree, and what they see is what the
 *               articles actually declare.
 *
 * It does NOT certify that any article BELONGS under its declared parent, that
 * every real relationship was declared, or that the parent rule is adequate.
 * Codey named this failure mode in the proposal and it is worth quoting, because
 * it is the honest bound of the whole surface: an author declares a resolvable,
 * bidirectional relation that files a deployment-specific child under a
 * foundational substrate article; every mechanical check passes and *the
 * generated view makes the relation look official*. That is why the rendered
 * block is labelled **declared** and never *canonical* or *approved* — a
 * generated graph makes a bad declaration more VISIBLE, not more correct, and the
 * remedy is placement review rejecting the declaration.
 *
 * Usage:
 *   node scripts/generate-standards-hierarchy.mjs           # rewrite the block
 *   node scripts/generate-standards-hierarchy.mjs --check   # fail if stale
 *   node scripts/generate-standards-hierarchy.mjs --json    # report only
 *
 * Exit codes: 0 — clean; 1 — stale block, bad graph, or a broken extraction.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(__filename), '..');
const REGISTRY_REL = 'docs/STANDARDS-REGISTRY.md';
const CHECK = process.argv.includes('--check');
const JSON_OUT = process.argv.includes('--json');

const BEGIN = '<!-- BEGIN GENERATED STANDARDS HIERARCHY -->';
const END = '<!-- END GENERATED STANDARDS HIERARCHY -->';

const abs = path.join(ROOT, REGISTRY_REL);
if (!fs.existsSync(abs)) {
  console.error(`[standards-hierarchy] ${REGISTRY_REL} is missing — refusing to report clean.`);
  process.exit(1);
}

/**
 * The single extraction. A failure here is fatal rather than degraded: rendering
 * a hierarchy from a half-read registry would publish a confident wrong tree,
 * which is worse than publishing none.
 */
let extraction;
try {
  const out = execFileSync('node', [path.join(ROOT, 'scripts/lint-registry-tree-parentage.mjs'), '--json'], {
    cwd: ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'],
  });
  extraction = JSON.parse(out);
} catch (err) {
  console.error(
    '[standards-hierarchy] could not obtain relations from lint-registry-tree-parentage.mjs --json. ' +
    'That lint failing means the declared relations are themselves broken; fix them before rendering a tree from them.',
  );
  process.exit(1);
}

const { relations = [], articleList = [] } = extraction;
if (articleList.length === 0) {
  console.error('[standards-hierarchy] the extraction returned ZERO articles — refusing to render an empty tree over a non-empty registry.');
  process.exit(1);
}

// ── Graph diagnostics ──────────────────────────────────────────────────────
// The parentage lint proves each relation resolves and is acknowledged. It does
// NOT prove the relation SET forms a tree — these are the shape checks a renderer
// needs before it may honestly call its output a hierarchy.
const diagnostics = [];
const parentOf = new Map();
const childrenOf = new Map();

for (const { child, parent } of relations) {
  if (parentOf.has(child) && parentOf.get(child) !== parent) {
    diagnostics.push(
      `"${child}" declares TWO parents ("${parentOf.get(child)}" and "${parent}"). An article with two parents has no ` +
      `place in a tree, and the reader cannot tell which parent's constraints qualify it.`,
    );
    continue;
  }
  parentOf.set(child, parent);
  if (!childrenOf.has(parent)) childrenOf.set(parent, []);
  childrenOf.get(parent).push(child);
}

for (const start of parentOf.keys()) {
  const seen = new Set([start]);
  let node = parentOf.get(start);
  while (node) {
    if (seen.has(node)) {
      diagnostics.push(`"${start}" sits in a parentage CYCLE (…→ ${[...seen].join(' → ')} → ${node}). A cycle has no root, so no tree can be rendered from it.`);
      break;
    }
    seen.add(node);
    node = parentOf.get(node);
  }
}

// ── Render ─────────────────────────────────────────────────────────────────
const order = new Map(articleList.map((a, i) => [a.name, i]));
const familyOf = new Map(articleList.map((a) => [a.name, a.family]));
const familiesInOrder = [...new Set(articleList.map((a) => a.family))];

function shortFamily(f) {
  return String(f ?? '').split(' — ')[0];
}
/** GitHub-style anchor for an article heading, so each row is a working link. */
function anchor(name) {
  return `#${name.toLowerCase().replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '-')}`;
}

const lines = [];
lines.push(BEGIN);
lines.push('');
lines.push('**Declared hierarchy — mechanical relations only; conceptual placement remains review.**');
lines.push('');
lines.push(
  'Generated by `scripts/generate-standards-hierarchy.mjs` from the parent/child declarations inside the articles ' +
  'themselves. **Do not edit this block by hand** — edit the declaration in the article and regenerate; a stale block ' +
  'fails the build. A row here means an article DECLARED a parent and that parent named it back. It does **not** mean ' +
  'the placement was reviewed and approved: a technically valid relation can still be conceptually wrong, and this ' +
  'view would render it just as confidently. Articles with no declared parent are omitted rather than listed as roots, ' +
  'because "no declared parent" and "top-level by design" are different facts and only the first one is known here.',
);
lines.push('');

let rendered = 0;
for (const family of familiesInOrder) {
  const parents = [...childrenOf.keys()]
    .filter((p) => familyOf.get(p) === family)
    .sort((a, b) => order.get(a) - order.get(b));
  if (parents.length === 0) continue;
  lines.push(`**${shortFamily(family)}**`);
  lines.push('');
  for (const p of parents) {
    lines.push(`- [${p}](${anchor(p)})`);
    for (const c of childrenOf.get(p).sort((a, b) => order.get(a) - order.get(b))) {
      const cf = shortFamily(familyOf.get(c));
      const crossFamily = familyOf.get(c) !== family ? ` — *declared from ${cf}*` : '';
      lines.push(`  - [${c}](${anchor(c)})${crossFamily}`);
      rendered += 1;
    }
  }
  lines.push('');
}

lines.push(
  `*${rendered} declared parent-child relation(s) across ${childrenOf.size} parent article(s). ` +
  `The other ${articleList.length - rendered} articles declare no parent.*`,
);
lines.push('');
lines.push(END);

const canonical = lines.join('\n');

// ── Compare / write ────────────────────────────────────────────────────────
const source = fs.readFileSync(abs, 'utf-8');
const bi = source.indexOf(BEGIN);
const ei = source.indexOf(END);
const present = bi !== -1 && ei !== -1 && ei > bi;
const current = present ? source.slice(bi, ei + END.length) : null;
const stale = !present || current !== canonical;

const report = {
  relations: relations.length,
  rendered,
  parents: childrenOf.size,
  articles: articleList.length,
  blockPresent: present,
  stale,
  diagnostics,
};

if (JSON_OUT) {
  console.log(JSON.stringify(report, null, 2));
  process.exit(diagnostics.length > 0 ? 1 : 0);
}

if (diagnostics.length > 0) {
  console.error('\n❌ generate-standards-hierarchy: the declared relation set is not a tree:');
  for (const d of diagnostics) console.error(`  - ${d}`);
  console.error('\nFix the declarations in the articles. Rendering a "hierarchy" from a non-tree would publish a confident wrong structure.');
  process.exit(1);
}

if (CHECK) {
  if (!present) {
    console.error(
      `\n❌ generate-standards-hierarchy --check: ${REGISTRY_REL} has no generated hierarchy block.\n` +
      `  Run: node scripts/generate-standards-hierarchy.mjs`,
    );
    process.exit(1);
  }
  if (stale) {
    console.error(
      `\n❌ generate-standards-hierarchy --check: the checked-in hierarchy block is STALE or hand-edited.\n` +
      `  A relation was declared, removed, or renamed in an article without regenerating the view — so the registry\n` +
      `  now shows a reader a tree its own articles no longer declare. That is the drift this generator exists to\n` +
      `  prevent, and it is exactly why the block is generated rather than maintained.\n` +
      `  Run: node scripts/generate-standards-hierarchy.mjs`,
    );
    process.exit(1);
  }
  console.log(`generate-standards-hierarchy --check: clean — ${rendered} declared relation(s) rendered, block current.`);
  process.exit(0);
}

if (!present) {
  console.error(
    `[standards-hierarchy] no ${BEGIN} … ${END} block found in ${REGISTRY_REL}. ` +
    `Insert the two markers where the view should render, then run this again.`,
  );
  process.exit(1);
}

if (stale) {
  fs.writeFileSync(abs, source.slice(0, bi) + canonical + source.slice(ei + END.length));
  console.log(`generate-standards-hierarchy: rewrote the block — ${rendered} declared relation(s) across ${childrenOf.size} parent(s).`);
} else {
  console.log(`generate-standards-hierarchy: already current — ${rendered} declared relation(s).`);
}
