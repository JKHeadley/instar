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
  // A title of 12 characters or fewer ("Self-Hosting") is too short to trust as a bare substring:
  // it can appear in ordinary prose. It counts only in the emphasised form the registry itself
  // uses for an article name (`*Self-Hosting*`). Before this, a file governed only by a
  // short-titled article could never leave the baseline, whatever it wrote.
  const namesArticle = titles.some((t) => (t.length > 12
    ? head.includes(t) || head.includes(t.split(' — ')[0])
    : head.includes(`*${t}*`)));
  if (namesArticle) { ok++; continue; }
  if (MARKER.test(head)) markerWithoutArticle.push(rel); // a marker naming nothing real
  missing.push(rel);
}

// ── The widened population (STD-SUBCOUNTDOWN-backreference-completion, second half) ──────────
// The rule says ALL infrastructure names its standard; the registry-cited set above is only the
// part the registry already knows about. The widened population is the decision infrastructure
// Instar ships: every file whose name says it guards or decides (a Guard, Gate, Sentinel, ...),
// every `scripts/lint-*` check, and every hook source. It is chosen by NAME, mechanically. Stated
// rather than implied: a file that guards something without being named like a guard is outside it.
// Its pre-existing gaps live in their own shrink-only baseline. An absent baseline counts as EMPTY,
// so deleting the file cannot switch the check off.
const INFRA_BASELINE = path.join(ROOT, 'docs/standards-backreference-infrastructure-baseline.json');
const INFRA_NAME = /(Guard|Gate|Sentinel|Watchdog|Ratchet|Breaker|Reaper|Limiter|Governor|Authority|Verifier|Arbiter|Fence|Detector)/i;
function isInfrastructurePath(rel) {
  if (!/^(src|scripts)\//.test(rel)) return false;
  if (rel.includes('/templates/') || rel.endsWith('.d.ts') || /(^|\/)__tests__\//.test(rel)) return false;
  if (!/\.(ts|mjs|cjs|js)$/.test(rel)) return false;
  const base = rel.split('/').pop();
  if (rel.startsWith('scripts/') && base.startsWith('lint-')) return true;
  if (/\/hooks\//.test(rel) || /Hook/.test(base)) return true;
  return INFRA_NAME.test(base);
}
function walk(dir, out = []) {
  let entries;
  try { entries = fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const rel = `${dir}/${e.name}`;
    if (e.isDirectory()) walk(rel, out); else if (isInfrastructurePath(rel)) out.push(rel);
  }
  return out;
}
const infraMissing = [];
let infraOk = 0;
const infraPopulation = [...walk('src'), ...walk('scripts')].filter((rel) => !cited.has(rel)).sort();
for (const rel of infraPopulation) {
  let body;
  try { body = fs.readFileSync(path.join(ROOT, rel), 'utf8'); } catch { continue; }
  const head = body.slice(0, 4000);
  const namesArticle = titles.some((t) => (t.length > 12
    ? head.includes(t) || head.includes(t.split(' — ')[0])
    : head.includes(`*${t}*`)));
  if (namesArticle) infraOk++; else infraMissing.push(rel);
}
if (process.argv.includes('--write-infrastructure-baseline')) {
  if (fs.existsSync(INFRA_BASELINE)) {
    console.error('lint-standard-code-backreference: refusing --write-infrastructure-baseline — the baseline exists and may only shrink. Remove entries by adding back-references.');
    process.exit(1);
  }
  fs.writeFileSync(INFRA_BASELINE, `${JSON.stringify({ $comment: 'Shrink-only: infrastructure files (named as guards/gates/sentinels/lints/hooks) that predate the widened back-reference check. A file leaves this list by naming its standard in its header; nothing may be added. See scripts/lint-standard-code-backreference.mjs.', grandfatheredInfrastructure: infraMissing }, null, 2)}\n`);
  console.log(`lint-standard-code-backreference: wrote ${infraMissing.length} infrastructure baseline entries.`);
  process.exit(0);
}
let infraBaseline;
try { infraBaseline = JSON.parse(fs.readFileSync(INFRA_BASELINE, 'utf8')); } catch { infraBaseline = { grandfatheredInfrastructure: [] }; }
const infraGrandfathered = new Set(infraBaseline.grandfatheredInfrastructure || []);

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

for (const rel of infraMissing) {
  if (!infraGrandfathered.has(rel)) {
    errors.push(
      `${rel} is decision infrastructure (its name marks it as a guard, gate, sentinel, lint or hook) but ` +
        `names NO standard back. Add a header comment naming the standard(s) that govern it — ` +
        `"Governed by: <exact article title>" — within its first 4,000 characters.`,
    );
  }
}
const infraPresent = new Set(infraPopulation);
for (const rel of infraGrandfathered) {
  if (infraPresent.has(rel) && !infraMissing.includes(rel)) {
    errors.push(`${rel} is in the infrastructure baseline but now names a standard — remove it from docs/standards-backreference-infrastructure-baseline.json. The baseline may only shrink.`);
  }
}

if (errors.length) {
  console.error('lint-standard-code-backreference: FAILED');
  errors.forEach((e) => console.error('  ✗', e));
  process.exit(1);
}
console.log(
  `lint-standard-code-backreference: clean — ${cited.size} cited file(s), ${ok} naming a standard back, ` +
    `${missing.length} grandfathered (shrink-only)${gone.length ? `, ${gone.length} cited-but-absent (the dangling-ref floor owns those)` : ''}; ` +
    `${infraPopulation.length} further infrastructure file(s), ${infraOk} naming a standard back, ${infraMissing.length} grandfathered (shrink-only).`,
);
