#!/usr/bin/env node
/**
 * lint-standard-code-backreference — the return half of the reference graph.
 *
 * Governed by: *References Run From Both Ends — the Registry Names the Code, the Code Names the
 * Standard* (docs/STANDARDS-REGISTRY.md). This file is itself an instance of the rule it enforces:
 * the line above is its own back-reference.
 *
 * Justin, 2026-08-13, ordering it:
 *
 *   "all infrastructure should have documentation and or comments is maintained with the code that
 *    states what standards rule over that part of the infrastructure or which standard apply. That
 *    way we have references from both ends meaning the registry itself list what parts the code
 *    enforce the standards and the code references back to which standards they are derived from."
 *
 * WHAT IT CHECKS. For every repo file the registry cites in an enforcement field, the file must name
 * at least one standard back — by quoting a real article title, or by a `Governed by:` /
 * `Enforces:` / `Standard:` marker. One-way references decay silently: the registry can cite a guard
 * that was deleted (the dangling-ref floor catches that), and a guard can be deleted by someone with
 * no way to know a standard depended on it (this catches that).
 *
 * WHY A SHRINK-ONLY BASELINE. The registry cites many files that predate the rule. Demanding all of
 * them at once would mean writing back-references by resemblance instead of by knowledge — the exact
 * unconsidered-linkage failure the article is about. So the un-back-referenced set is baselined and
 * MAY ONLY SHRINK.
 *
 * WHAT IT DOES NOT CHECK, stated rather than implied: that the named standard is the RIGHT one. That
 * is a reading, and it is carried as a named sub-obligation on the article with a countdown.
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const REGISTRY = process.env.STANDARDS_REGISTRY_PATH || path.join(ROOT, 'docs/STANDARDS-REGISTRY.md');
const BASELINE = path.join(ROOT, 'docs/standards-backreference-baseline.json');

let raw;
try { raw = fs.readFileSync(REGISTRY, 'utf8'); } catch {
  console.log('lint-standard-code-backreference: no registry at the resolved path — skipping');
  process.exit(0);
}

const lines = raw.split('\n');
const titles = lines.filter((l) => /^### /.test(l)).map((l) => l.slice(4).trim());

// Files cited in an enforcement field. Kept to the enforcement fields deliberately: provenance and
// narrative fields also contain paths, and a postmortem is not a guard.
const ENFORCEMENT = /^\*\*(Applied through|Enforced by \(structure, not willpower\)|Enforcement)\.\*\*/;
const cited = new Set();
for (const l of lines) {
  if (!ENFORCEMENT.test(l)) continue;
  for (const m of l.matchAll(/`([^`]+\.(?:ts|mjs|cjs|js))`/g)) {
    const p = m[1].trim();
    if (p.startsWith('src/') || p.startsWith('scripts/') || p.startsWith('skills/')) cited.add(p);
  }
}

/**
 * A back-reference must name a REAL article, not merely look like one.
 *
 * The first version accepted `namesArticle || MARKER.test(head)` — so a bare `Governed by:` with
 * nothing resolvable after it counted as a back-reference. An independent review called that out:
 * it is a paperwork gate, checking that the *form* of a reference was written rather than that a
 * reference *exists*. That is the precise defect the ruling this lint serves was raised against, so
 * having it inside the enforcement was not a small irony.
 *
 * Measured before tightening: of 50 cited files, 23 name a real article title and **zero** were
 * passing on a bare marker. So closing the hole costs nothing today and removes the shortcut before
 * anyone reaches for it.
 *
 * A marker is still useful — it makes the reference greppable — but it is no longer sufficient on
 * its own. What counts is a real registry article title appearing in the file header.
 */
const MARKER = /(Governed by:|Enforces:|Standard:|governed by the standard)/i;
const missing = [];
const markerWithoutArticle = [];
const gone = [];
let ok = 0;

for (const rel of [...cited].sort()) {
  const abs = path.join(ROOT, rel);
  let body;
  try { body = fs.readFileSync(abs, 'utf8'); } catch { gone.push(rel); continue; }
  const head = body.slice(0, 4000); // the header is where a governing reference belongs
  const namesArticle = titles.some((t) => t.length > 12 && (head.includes(t) || head.includes(t.split(' — ')[0])));
  if (namesArticle) { ok++; continue; }
  if (MARKER.test(head)) markerWithoutArticle.push(rel); // a marker naming nothing real
  missing.push(rel);
}

let baseline;
try { baseline = JSON.parse(fs.readFileSync(BASELINE, 'utf8')); } catch { baseline = null; }
if (!baseline) {
  console.error('lint-standard-code-backreference: FAILED — no baseline at docs/standards-backreference-baseline.json');
  console.error('  Write it with: { "grandfatheredNoBackreference": [ ...paths... ] }  (may only shrink)');
  process.exit(1);
}

const grandfathered = new Set(baseline.grandfatheredNoBackreference || []);
const errors = [];

for (const rel of missing) {
  if (!grandfathered.has(rel)) {
    const marker = markerWithoutArticle.includes(rel);
    errors.push(
      marker
        ? `${rel} carries a back-reference MARKER that names no real registry article. A marker ` +
            `without a resolvable standard is the form of a reference without the reference — name ` +
            `the actual article title, exactly as it appears in the registry.`
        : `${rel} is cited by the registry as enforcement but names NO standard back. Add a header ` +
            `comment naming the standard(s) it enforces — "Governed by: <exact article title>". A ` +
            `one-way reference lets this guard be deleted by someone with no way to know a standard ` +
            `depends on it.`,
    );
  }
}
for (const rel of grandfathered) {
  if (!missing.includes(rel) && !gone.includes(rel)) {
    errors.push(`${rel} is baselined as lacking a back-reference but now has one — remove it from the baseline. The baseline may only shrink.`);
  }
}

if (errors.length) {
  console.error('lint-standard-code-backreference: FAILED');
  errors.forEach((e) => console.error('  ✗', e));
  process.exit(1);
}
console.log(
  `lint-standard-code-backreference: clean — ${cited.size} cited file(s), ${ok} naming a standard back, ` +
    `${missing.length} grandfathered (shrink-only)${gone.length ? `, ${gone.length} cited-but-absent (the dangling-ref floor owns those)` : ''}.`,
);
