#!/usr/bin/env node
/**
 * lint-registry-insertion-placement — every standard must state where it sits in the tree.
 *
 * Justin, 2026-08-13, ordering this as binding registry discipline:
 *
 *   "The tree structure itself should by default remove the possibility of duplicates since any new
 *    standard introduced has to find a proper place in the tree, whether that's updating a current
 *    standard becoming a child of a current standard or becoming a new route or foundational
 *    standard."
 *
 * And his diagnosis of why it matters, which is the whole reason this file exists: the 25 duplicate
 * standards the Window-12 audit found existed **because placement was never structurally enforced**.
 * A standard that never had to find its place could be written beside one that already covered it.
 * Documenting that expectation is what produced the duplicates; this is the enforcement.
 *
 * THE RULE. Every `###` article inside a standards family declares exactly one placement:
 *
 *   CHILD  — `**Merged into.**` or `**Derives from.**` naming a live parent
 *   ROOT   — `**Tree placement.** **ROOT / FOUNDATIONAL**`, a stated position, not an omission
 *   UPDATE — folded into an existing standard, so it is not a separate article at all and never
 *            reaches this lint. Named here because it is the third of Justin's three and a reader
 *            should not think it was forgotten.
 *
 * WHY THIS SHIPS WITH A BASELINE. 87 articles predate the rule. Enforcing it retroactively would
 * either block the change that introduces it or force 60+ placements to be invented in one pass by
 * resemblance — which is exactly the unconsidered placement the rule exists to prevent. So existing
 * articles are grandfathered into a baseline that MAY ONLY SHRINK: a NEW article must declare, and
 * a grandfathered one that gains a placement can never be removed from the declared set. The
 * ratchet is the enforcement; the baseline is the honesty about what is not yet placed.
 */
import fs from "node:fs";
import path from 'node:path';

const REGISTRY = process.env.STANDARDS_REGISTRY_PATH || path.join(process.cwd(), 'docs/STANDARDS-REGISTRY.md');
const BASELINE = path.join(process.cwd(), 'docs/standards-placement-baseline.json');

let raw;
try { raw = fs.readFileSync(REGISTRY, 'utf8'); } catch {
  console.log('lint-registry-insertion-placement: no registry at the resolved path — skipping');
  process.exit(0);
}

// Articles inside standards families (a `##` section with at least one Rule-bearing `###`).
const lines = raw.split('\n');
const arts = [];
let cur = null;
for (const l of lines) {
  const m = l.match(/^### (.+)$/);
  if (m) { cur = { title: m[1].trim(), body: [] }; arts.push(cur); continue; }
  if (/^## /.test(l)) { cur = null; continue; }
  if (cur) cur.body.push(l);
}
const articles = arts.filter((a) => a.body.some((l) => l.startsWith('**Rule.**')));

const declares = (a) =>
  a.body.some((l) => l.startsWith('**Merged into.**')) ||
  a.body.some((l) => l.startsWith('**Derives from.**')) ||
  a.body.some((l) => /^\*\*Tree placement\.\*\*/.test(l));

const placed = articles.filter(declares).map((a) => a.title);
const unplaced = articles.filter((a) => !declares(a)).map((a) => a.title);

let baseline;
try { baseline = JSON.parse(fs.readFileSync(BASELINE, 'utf8')); } catch { baseline = null; }

if (!baseline) {
  console.error('lint-registry-insertion-placement: FAILED — no baseline file at docs/standards-placement-baseline.json');
  console.error('  Write it with: { "grandfatheredUnplaced": [ ...titles... ] }  (this set may only shrink)');
  process.exit(1);
}

const grandfathered = new Set(baseline.grandfatheredUnplaced || []);
const errors = [];

// (1) A NEW article — one not in the grandfathered set — must declare its placement.
for (const t of unplaced) {
  if (!grandfathered.has(t)) {
    errors.push(
      `"${t}" declares no tree placement. Every standard must state where it sits: a child ` +
        `(**Merged into.** / **Derives from.** naming a live parent), or **Tree placement.** ` +
        `**ROOT / FOUNDATIONAL**. If it belongs inside an existing standard, update that one instead ` +
        `of adding an article — that is the third placement and it is why duplicates happened.`,
    );
  }
}

// (1b) A grandfathered article that is MATERIALLY CHANGED must declare its placement.
//
// Raised by an independent fidelity lens: shrink-only satisfies Justin's literal requirement for
// *newly introduced* standards, but not his broader claim that the tree "should by default remove
// the possibility of duplicates" — a grandfathered article could be rewritten indefinitely and never
// have to say where it sits. Touching a standard is the moment its placement is actually in mind, so
// that is the moment to require it.
//
// Diff-scoped, like the migration-consumer lint: with no --diff-base this clause is inert, so a
// plain local run never blocks on history it cannot see.
const diffBaseIdx = process.argv.indexOf('--diff-base');
if (diffBaseIdx !== -1 && process.argv[diffBaseIdx + 1]) {
  const base = process.argv[diffBaseIdx + 1];
  const ROOT = process.cwd();
  let changedBlock = new Set();
  try {
    const { execFileSync } = await import('node:child_process');
    const diff = execFileSync('git', ['diff', '-U0', `${base}...HEAD`, '--', path.relative(ROOT, REGISTRY)], {
      encoding: 'utf8', cwd: ROOT, maxBuffer: 32 * 1024 * 1024,
    });
    // Map CHANGED LINE NUMBERS onto article ranges in the current file.
    //
    // The first version scanned the diff body for a `### Title` line to know which article it was
    // inside. With `-U0` there are no context lines, so that heading never appears unless the
    // heading itself changed — the clause silently matched nothing and reported clean. A positive
    // control (edit a grandfathered article, expect a failure) is what exposed it; without one it
    // would have shipped looking green.
    const ranges = [];
    {
      let curTitle = null, start = 0;
      lines.forEach((l, i) => {
        const m = l.match(/^### (.+)$/);
        if (!m) return;
        if (curTitle) ranges.push({ title: curTitle, from: start, to: i });
        curTitle = m[1].trim(); start = i;
      });
      if (curTitle) ranges.push({ title: curTitle, from: start, to: lines.length });
    }
    const touched = [];
    for (const l of diff.split('\n')) {
      const h = l.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
      if (!h) continue;
      const startLine = parseInt(h[1], 10);
      const count = h[2] === undefined ? 1 : parseInt(h[2], 10);
      for (let n = startLine; n < startLine + Math.max(count, 1); n++) touched.push(n - 1);
    }
    for (const idx of touched) {
      const r = ranges.find((x) => idx >= x.from && idx < x.to);
      if (r) changedBlock.add(r.title);
    }
  } catch (err) {
    // A git failure (shallow clone, unknown base) is a legitimate reason to go inert. A programming
    // error is NOT, and swallowing both looked identical: the first version of this clause referenced
    // an undefined `ROOT`, threw, was caught here, and reported "clean" while checking nothing. A
    // guard that passes because it never ran is the exact defect this registry keeps finding.
    if (err instanceof ReferenceError || err instanceof TypeError) {
      console.error(`lint-registry-insertion-placement: the diff clause CRASHED — ${err.message}`);
      console.error('  This is a bug in the lint, not a clean result. Failing loudly rather than reporting a pass it did not earn.');
      process.exit(1);
    }
    changedBlock = new Set(); // unreadable history → inert, never a false block
  }
  for (const t of unplaced) {
    if (grandfathered.has(t) && changedBlock.has(t)) {
      errors.push(
        `"${t}" is grandfathered as unplaced but was MODIFIED in this change without declaring its ` +
          `tree placement. Editing a standard is when its place in the tree is actually in mind — ` +
          `declare it now (child / root / or fold this into the standard it belongs inside) rather ` +
          `than leaving it grandfathered forever.`,
      );
    }
  }
}

// (2) The baseline may only SHRINK. A title that has since been placed cannot go back.
for (const t of grandfathered) {
  if (placed.includes(t)) {
    errors.push(
      `"${t}" is listed as grandfathered-unplaced but now DECLARES a placement — remove it from ` +
        `docs/standards-placement-baseline.json. The baseline may only shrink.`,
    );
  }
  if (!articles.some((a) => a.title === t)) {
    errors.push(`"${t}" is in the baseline but is not an article in the registry — remove the stale entry.`);
  }
}

// (3) A declared parent must exist and must not be the article itself.
const titles = new Set(articles.map((a) => a.title));
for (const a of articles) {
  for (const l of a.body) {
    // Anchor on "subsection of *Parent*". A loose `.*?\*([^*]+)\*` matches the FIRST emphasis span
    // on the line, which is the bolded phrase "**named subsection**" — so the lint reported three
    // parents named "named subsection" and "or". An over-broad matcher inventing a defect is the
    // failure this registry keeps finding; the anchored form is the fix.
    const m = l.match(/\*\*named subsection\*\* of \*([^*]+)\*/);
    if (!m) continue;
    const parent = [...titles].find((t) => t === m[1] || t.startsWith(m[1]));
    if (!parent) errors.push(`"${a.title}" is merged into "${m[1]}", which is not a live article.`);
    else if (parent === a.title) errors.push(`"${a.title}" declares itself as its own parent.`);
  }
}

if (errors.length) {
  console.error('lint-registry-insertion-placement: FAILED');
  errors.forEach((e) => console.error('  ✗', e));
  process.exit(1);
}
console.log(
  `lint-registry-insertion-placement: clean — ${articles.length} article(s), ${placed.length} declaring a ` +
    `placement, ${grandfathered.size} grandfathered (shrink-only).`,
);
