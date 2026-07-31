#!/usr/bin/env node
/**
 * generate-standards-registry-asset — ship the constitution with the code that reads it.
 *
 * Reads the authored registry and the real source checkout, then writes four artifacts:
 *
 *   dist/data/standards-registry.md        — a VERBATIM byte copy
 *   dist/data/standards-registry.meta.json — { sha256, articleCount, generatedFrom }
 *   dist/data/standards-guard-index.json    — deterministic guard evidence from ROOT
 *   dist/data/standards-guard-index.meta.json — same-build sha/registry/version stamp
 *
 * Deterministic, no network. Runs AFTER `tsc` in the build chain: after compile
 * (so `dist/` and the shared parser exist) and before packaging. A clean step
 * running LATER would delete `dist/data` and the artifact would be silently
 * missing from the package — this change's own defect, reintroduced through build
 * ordering — which is why the ordering is asserted by a test that runs the REAL
 * build, never by reading this script.
 *
 * The article count uses the SAME exported parser the runtime resolver and the
 * release verifier use (imported from the freshly-compiled `dist/`), so a
 * hash-match/count-mismatch state is unreachable and parser drift cannot produce
 * a spurious diagnostic.
 *
 * Spec: docs/specs/standards-registry-snapshot-refresh.md §3.2.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const SOURCE_REL = 'docs/STANDARDS-REGISTRY.md';
const SOURCE = path.join(ROOT, SOURCE_REL);

/**
 * TWO output locations, deliberately — `src/data/` and `dist/data/`.
 *
 * The resolver locates the asset module-relative (`../data/…` from its own
 * directory), which is what makes it need no discovery logic. But that directory
 * differs by execution layout:
 *
 *   compiled production   dist/core/standardsRegistryPath.js  → dist/data/
 *   vitest (TS source)    src/core/standardsRegistryPath.ts   → src/data/
 *
 * Writing both keeps ONE resolution rule correct everywhere instead of adding
 * fallbacks. Found the hard way: with only `dist/data/`, every test resolved
 * `broken-install` because vitest runs the TypeScript directly.
 *
 * Both directories are already in package.json `files`, so both ship. Both copies
 * are gitignored build output; neither is committed.
 *
 * (Note: `src/data/builtin-manifest.json` has the same module-relative reader and
 * is generated ONLY into `src/data/`, so its production read from `dist/data/`
 * cannot succeed. Same defect class, different feature — not fixed here.)
 */
const OUT_DIRS = [path.join(ROOT, 'src', 'data'), path.join(ROOT, 'dist', 'data')];

/** Fail closed and loudly — a generator that silently produces nothing is the bug. */
function die(msg) {
  console.error(`\n✖ generate-standards-registry-asset: ${msg}\n`);
  process.exit(1);
}

if (!fs.existsSync(SOURCE)) {
  die(`the authored constitution is missing at ${SOURCE_REL}. Nothing to ship.`);
}

const bytes = fs.readFileSync(SOURCE);
const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');

// One parser, three consumers. Imported from dist/ because this runs after tsc;
// reimplementing the heading rule here is what would let the diagnostic drift.
//
// NO env override on the parser location. One existed briefly (`INSTAR_REGISTRY_PARSER_DIST`)
// so the e2e job could bootstrap the asset without a compiled `dist`; that whole bootstrap was
// removed in round 10 after producing a design defect in four consecutive review rounds, and
// this knob went with it. Its only caller is gone, and a production script carrying a
// configuration point that exists solely for a deleted test setup is exactly the kind of
// vestigial surface this change is about removing rather than accumulating.
const parserRel = path.join('dist', 'core', 'StandardsRegistryParser.js');
const parserUrl = pathToFileURL(path.join(ROOT, parserRel)).href;
let articleCount;
try {
  const { parseStandardsRegistryDetailed } = await import(parserUrl);
  articleCount = parseStandardsRegistryDetailed(bytes.toString('utf-8')).diagnostics.articleHeadings;
} catch (err) {
  die(
    `could not load the shared registry parser from ${parserRel} — ` +
      `this script must run AFTER tsc in the build chain. (${err instanceof Error ? err.message : String(err)})`,
  );
}

if (!Number.isFinite(articleCount) || articleCount <= 0) {
  die(`the shared parser found ${articleCount} article headings in ${SOURCE_REL} — refusing to ship an empty constitution.`);
}

// RUN THE CANARY AT GENERATE TIME, not only at read time.
//
// Review's answer to "can a 22-of-81 constitution read as healthy?" was YES, and more
// confidently than before: this script refused only `count <= 0`, the runtime canary
// floor is 15, and the five anchor articles all sit in EARLY families — so a
// truncation that drops the tail (the exact historical failure, the Fractal family)
// keeps every anchor. A packed 22-article registry paired with its own meta passed the
// canary, matched its meta, and reported `verified`.
//
// The floor belongs HERE because this is the last point before the bytes become an
// artifact. A floor that lives only in a unit test does not run on the publish path
// (`prepublishOnly` is build + two checks, no tests), so it guards the developer and
// not the release.
try {
  const { runRegistryCanary, parseStandardsRegistryDetailed: parseDetailed } = await import(parserUrl);
  const parsed = parseDetailed(bytes.toString('utf-8'));
  const canary = runRegistryCanary(parsed.articles, parsed.diagnostics);
  if (!canary.ok) {
    die(
      `the registry canary objected to ${SOURCE_REL}: ${canary.failures.join('; ')} — refusing to ship a ` +
        'constitution that the runtime would classify as untrustworthy.',
    );
  }
} catch (err) {
  if (err instanceof Error && /refusing to ship/.test(err.message)) throw err;
  die(`could not run the registry canary over ${SOURCE_REL}: ${err instanceof Error ? err.message : String(err)}`);
}

// A MONOTONIC floor, anchored to a COMMITTED expectation.
//
// The first version of this read the prior meta from `src/data/` — which this change
// gitignores. Review's verdict was exact: on the fresh CI checkout `publish.yml` uses,
// there is no prior meta, so the floor silently no-ops, and `prepublishOnly`'s build then
// compares against the artifact the first build just wrote from the same source. Self-
// equal, always passing. The comment justifying its location said "a floor that lives only
// in a unit test does not run on the publish path" — and it had put the floor on the one
// path where it never fires.
//
// `docs/standards-registry-floor.json` is git-tracked, so the expectation survives a clean
// checkout and lowering it is a reviewable diff rather than a side effect of a build.
const FLOOR_REL = 'docs/standards-registry-floor.json';
const floorPath = path.join(ROOT, FLOOR_REL);
let floor = null;
try {
  floor = JSON.parse(fs.readFileSync(floorPath, 'utf-8')).minArticleCount;
} catch {
  die(
    `${FLOOR_REL} is missing or unreadable. It is the committed expectation for how many articles ` +
      'the constitution must carry, and its absence is exactly the state that made the previous ' +
      'floor vacuous. Create it with {"minArticleCount": N}.',
  );
}
if (typeof floor !== 'number' || !Number.isFinite(floor) || floor <= 0) {
  die(`${FLOOR_REL} carries no usable minArticleCount.`);
}
if (articleCount < floor) {
  die(
    `${SOURCE_REL} now parses to ${articleCount} articles, BELOW the committed floor of ${floor} ` +
      `in ${FLOOR_REL}. A shrinking constitution is how a truncated rulebook ships looking healthy. ` +
      'If the reduction is intentional, lower the floor in the same commit — that diff is the review.',
  );
}
// Growth is REPORTED, not written.
//
// The first version auto-raised the floor whenever the count grew — writing a git-tracked
// file on every `npm run build`, including inside `prepublishOnly` in the publish job.
// Review caught that against the comment three lines above, which justifies the file's
// location as "a reviewable diff rather than a side effect of a build". Auto-writing made
// it exactly the side effect it was moved to stop being.
//
// So it prints and continues. The raise is a one-line commit a human makes deliberately,
// and until they do the floor simply sits lower than it could — which costs nothing except
// a slightly weaker guard, and never surprises anyone with a dirty working tree.
if (articleCount > floor) {
  console.log(
    `  note: ${articleCount} articles, above the committed floor of ${floor}. Raise it in ` +
      `${FLOOR_REL} when convenient — this script will not write it for you.`,
  );
}

// The package version this asset was generated FOR.
//
// It is the ONE operand in the runtime basis that is not derived from the registry bytes.
// Narrow, and worth being precise about: it disagrees only when a version bump lands
// without a rebuild. The dev scenario (`tsc` watch recompiling the reader without
// re-running this script) does NOT move it, and neither does the publish path. The
// operand that covers those is `compareAgainstAuthoredSource` in the auditor.
let packageVersion;
try {
  packageVersion = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8')).version;
} catch (err) {
  die(`could not read package.json to stamp the asset version: ${err instanceof Error ? err.message : String(err)}`);
}
if (typeof packageVersion !== 'string' || packageVersion.length === 0) {
  die('package.json carries no usable version string — refusing to ship an unstamped constitution.');
}

const meta = `${JSON.stringify({ sha256, articleCount, generatedFrom: SOURCE_REL, packageVersion }, null, 2)}\n`;
let guardIndex;
try {
  const auditorUrl = pathToFileURL(path.join(ROOT, 'dist', 'core', 'StandardsEnforcementAuditor.js')).href;
  const { buildGuardTreeIndex } = await import(auditorUrl);
  guardIndex = buildGuardTreeIndex(ROOT, bytes.toString('utf-8'), packageVersion);
} catch (err) {
  die(
    `could not build the guard evidence index from the real source tree — ` +
      `${err instanceof Error ? err.message : String(err)}`,
  );
}
const guardIndexBytes = Buffer.from(`${JSON.stringify(guardIndex, null, 2)}\n`, 'utf-8');
const guardIndexSha256 = crypto.createHash('sha256').update(guardIndexBytes).digest('hex');
const guardIndexMeta = `${JSON.stringify({
  sha256: guardIndexSha256,
  registrySha256: sha256,
  packageVersion,
}, null, 2)}\n`;
for (const dir of OUT_DIRS) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'standards-registry.md'), bytes);
  fs.writeFileSync(path.join(dir, 'standards-registry.meta.json'), meta);
  fs.writeFileSync(path.join(dir, 'standards-guard-index.json'), guardIndexBytes);
  fs.writeFileSync(path.join(dir, 'standards-guard-index.meta.json'), guardIndexMeta);
}

console.log(
  `✓ standards registry asset: ${articleCount} articles, registry ${sha256.slice(0, 12)}…, ` +
    `guards ${guardIndexSha256.slice(0, 12)}… → ` +
    OUT_DIRS.map((d) => path.relative(ROOT, d)).join(' + '),
);
