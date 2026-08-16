#!/usr/bin/env node
/**
 * Flag a framework list that is narrower than its OWN type annotation.
 *
 * WHY THIS EXISTS
 * ---------------
 * Round-21 of the grok-build review found this, and it had survived seventeen
 * prior review rounds:
 *
 *     export const KNOWN_FRAMEWORKS:
 *       ReadonlyArray<'claude-code'|'codex-cli'|'gemini-cli'|'pi-cli'|'grok-build'> = [
 *         'claude-code', 'codex-cli', 'gemini-cli',      // <- two members missing
 *       ];
 *
 * TypeScript accepts a subset of a union, so the TYPE reads as complete while
 * the VALUE is stale, and exhaustiveness checking never fires (it only helps a
 * `switch` with no `default`). The residue is what hurt: `filter(isKnown)`
 * silently dropped the newer frameworks and fell back to Claude's behaviour,
 * so a grok-only agent had Claude scaffolding installed into it on every
 * update — the identical bug this constant's own comment claimed to have made
 * "drift-proof as new frameworks are added".
 *
 * WHY THIS SHAPE OF CHECK, AND NOT A CANONICAL-LIST DIFF
 * ------------------------------------------------------
 * The obvious lint — diff every framework list against the canonical union —
 * was built first and produced 53 findings, most of them deliberate. Many
 * exclusions here are load-bearing (grok-build is kept out of the internal
 * routing preference on purpose), so that version needed a suppression marker
 * on roughly thirty sites. A lint that must be suppressed thirty times teaches
 * authors to reach for the marker, and the next real defect gets marked too.
 *
 * Comparing a list against its own annotation needs no markers at all: a
 * deliberate exclusion is written with a narrower annotation, so it is not a
 * finding. Every report is a place where the author's own declared intent and
 * their value disagree. High precision, and nothing to suppress.
 *
 * It therefore does NOT catch a hand-written list with no annotation (the
 * `const valid = ['claude-code', 'codex-cli']` shape). That is a real gap,
 * recorded honestly rather than papered over: those sites are found by review,
 * and this catches the one that review demonstrably cannot hold.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(REPO_ROOT, 'src');

function* walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;
      yield* walk(p);
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
      yield p;
    }
  }
}

/**
 * A declaration whose type annotation enumerates >=2 string-literal members
 * and whose initialiser is an array literal. Both halves are read from the
 * same statement, so the comparison is self-contained.
 */
const DECL = /(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*:\s*([^=]*?<[^=]*?>|[^=]*?\[\])\s*=\s*\[([^\]]*)\]/g;

const LITERAL = /'([a-z][a-z0-9-]*)'|"([a-z][a-z0-9-]*)"/g;

/**
 * The canonical union, read from its own declaration rather than duplicated
 * here — a lint against stale hand-written framework lists must not contain
 * one. Used only to decide whether a declaration is ABOUT frameworks; the
 * completeness comparison is still against the declaration's own annotation.
 */
const FRAMEWORK_UNIVERSE = (() => {
  const raw = fs.readFileSync(path.join(SRC, 'core', 'TopicFrameworksStore.ts'), 'utf8');
  const start = raw.indexOf('export const SUPPORTED_FRAMEWORKS');
  const end = raw.indexOf('];', start);
  if (start === -1 || end === -1) {
    throw new Error('SUPPORTED_FRAMEWORKS declaration not found — lint cannot run');
  }
  const members = [...raw.slice(start, end).matchAll(/'([a-z][a-z0-9-]*)'/g)].map((m) => m[1]);
  if (members.length < 2) throw new Error('SUPPORTED_FRAMEWORKS parsed to <2 members');
  return new Set(members);
})();

function membersOf(text) {
  const out = new Set();
  for (const m of text.matchAll(LITERAL)) out.add(m[1] ?? m[2]);
  return out;
}

/**
 * A declaration whose annotation NAMES the canonical type rather than
 * enumerating it — `ReadonlyArray<IntelligenceFramework>`, `IntelligenceFramework[]`,
 * `ReadonlySet<IntelligenceFramework>` — with a literal array initialiser.
 *
 * ROUND-22, and this is the finding that produced it: the literal-union detector
 * above shipped, ran clean, and reported `compared 0 literal-annotated framework
 * list(s)`. Zero. The defect it was built from was fixed by DERIVING the list
 * from the canonical union, which removed the only instance of the shape it can
 * see — and every remaining framework list in this codebase uses the NAMED type,
 * which the literal detector is blind to by construction. So the guard was alive
 * (its self-test proves the detector fires) and guarding nothing.
 *
 * A named annotation is a STRONGER completeness claim than a literal union, not a
 * weaker one: the author wrote "any framework" and then enumerated some. That is
 * the exact drift signature — `KNOWN` in frameworkSessionLaunch.ts is hand-written
 * and complete today purely because someone remembered twice.
 *
 * The deliberate-subset escape is a marker on or above the declaration, because
 * several exclusions here are load-bearing (grok-build is kept OUT of the internal
 * routing preference on purpose). The header's objection to markers was to needing
 * ~30 of them; this detector needs 3, which is a population a reader can hold.
 */
/**
 * The type NAMES that mean "a framework". `IntelligenceFramework` is canonical;
 * the others are aliases of it.
 *
 * ROUND-22 found why the alternation is needed rather than just the canonical
 * name: `ESCALATION_FRAMEWORKS: readonly EscalationFramework[]` is a framework
 * list annotated with an ALIAS, so a detector keyed on the canonical name alone
 * walks straight past it. The alias is not a trick — it is the correct fix for a
 * duplicate union — which means aliases will keep appearing, and each one is a
 * fresh blind spot for a name-matching detector.
 *
 * Kept as an explicit list rather than resolved through the type graph: a regex
 * lint cannot follow `type A = B` reliably, and a list of three that fails loudly
 * when a fourth alias appears is more honest than a resolver that quietly
 * half-works. A new alias joins this list in the change that creates it.
 */
const FRAMEWORK_TYPE_NAMES = ['IntelligenceFramework', 'EscalationFramework', 'SessionFramework'];

const NAMED_DECL = new RegExp(
  '(?:export\\s+)?const\\s+([A-Za-z_$][\\w$]*)\\s*:\\s*[^=]*?\\b(?:'
    + FRAMEWORK_TYPE_NAMES.join('|')
    + ')\\b[^=]*?=\\s*(?:new\\s+(?:Readonly)?Set(?:<[^>]*>)?\\(\\s*)?\\[([^\\]]*)\\]',
  'g',
);

/** Marker opting a declaration out of the named-annotation completeness check. */
const SUBSET_MARKER = 'framework-list-subset-ok';

/**
 * True when the marker appears on the declaration line or anywhere in the comment
 * block ATTACHED to it.
 *
 * A fixed line window was the first cut and it silently missed both real markers:
 * they sit inside a JSDoc block whose reason needs several lines to state, and the
 * window cut them off — a suppression that does not suppress, which turns a
 * deliberate exclusion into a permanent false alarm and teaches the next author to
 * delete the lint. Walking back over contiguous comment lines instead stops at the
 * previous statement, so a marker can never leak onto an unrelated declaration
 * however long the comment is.
 */
function hasSubsetMarker(source, index) {
  const declLine = source.slice(index).split('\n')[0];
  if (declLine.includes(SUBSET_MARKER)) return true;
  const before = source.slice(0, index).split('\n');
  // `before` ends with the partial text preceding the declaration on its own line.
  for (let i = before.length - 2; i >= 0; i -= 1) {
    const trimmed = before[i].trim();
    if (trimmed === '') continue;                    // blank lines inside a doc block
    const isComment = trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*');
    if (!isComment) return false;                    // hit real code — stop
    if (trimmed.includes(SUBSET_MARKER)) return true;
  }
  return false;
}

/**
 * Detect stale annotated framework lists in one source string.
 *
 * ROUND-22: this function is now the ONLY implementation. The file loop used to
 * re-implement the same matching inline, so the self-test below was proving a
 * function the real scan never called — two copies that could drift, with the
 * proof attached to the copy that did no work. Same shape as the round-20 finding
 * where a verdict was returned and the only caller ignored it.
 */
function scanSource(source) {
  const found = [];

  // Detector A — annotation enumerates the members literally.
  for (const m of source.matchAll(DECL)) {
    const [, name, annotation, initialiser] = m;
    const declared = membersOf(annotation);
    if (declared.size < 2) continue;
    const frameworkMembers = [...declared].filter((d) => FRAMEWORK_UNIVERSE.has(d));
    if (frameworkMembers.length < 2) continue;
    const actual = membersOf(initialiser);
    if (actual.size === 0) continue;
    const missing = [...declared].filter((d) => !actual.has(d));
    found.push({ name, kind: 'literal', declared: [...declared], missing, index: m.index });
  }

  // Detector B — annotation names IntelligenceFramework; the union IS the claim.
  for (const m of source.matchAll(NAMED_DECL)) {
    const [, name, initialiser] = m;
    const actual = membersOf(initialiser);
    if (actual.size === 0) continue;
    // Must be a list OF frameworks, not a list that merely mentions one.
    const frameworkMembers = [...actual].filter((a) => FRAMEWORK_UNIVERSE.has(a));
    if (frameworkMembers.length < 2) continue;
    if (hasSubsetMarker(source, m.index)) {
      // Reported as a distinct kind rather than dropped. A suppressed list that
      // simply vanishes makes the population count smaller for a reason the
      // reader cannot see — the same "is it clean or did it look at nothing?"
      // ambiguity this lint's zero-population history is about. Deliberate
      // exclusions are part of the inventory and should be countable.
      found.push({ name, kind: 'suppressed', declared: [...FRAMEWORK_UNIVERSE], missing: [], index: m.index });
      continue;
    }
    const declared = [...FRAMEWORK_UNIVERSE];
    const missing = declared.filter((d) => !actual.has(d));
    // Pushed even when complete: the caller counts comparable declarations to
    // prove the scan had a population. A detector that only emits on failure
    // cannot distinguish "nothing wrong" from "nothing looked at" — which is
    // the exact ambiguity that let this lint ship guarding zero lists.
    found.push({ name, kind: 'named', declared, missing, index: m.index });
  }

  return found;
}

/**
 * Prove the detector can still fire, on every run, before trusting a clean
 * result.
 *
 * This is not ceremony. The defect this lint exists for was found alongside
 * eleven separate instances of "a passing condition narrower than what it
 * certifies", and the first cut of this very script reported OK because a
 * constraint I added had quietly reduced it to zero inputs. A clean scan is
 * only meaningful if the thing producing it is alive, and the honest way to
 * know that is to hand it a known defect and require it to complain.
 *
 * The fixture is the real pre-fix shape of `KNOWN_FRAMEWORKS` from
 * `src/commands/init.ts`, which shipped Claude scaffolding into grok-only and
 * pi-only agents on every update.
 */
const SELF_TEST_SOURCE = `
export const KNOWN_FRAMEWORKS: ReadonlyArray<'claude-code' | 'codex-cli' | 'gemini-cli' | 'pi-cli' | 'grok-build'> = [
  'claude-code',
  'codex-cli',
  'gemini-cli',
];
`;

/**
 * Detector B's fixture is the REAL current shape of `KNOWN` in
 * frameworkSessionLaunch.ts with one member removed — i.e. what that hand-written
 * list becomes the day a sixth framework is added and someone forgets it.
 */
const SELF_TEST_NAMED_STALE = `
  const KNOWN: ReadonlyArray<IntelligenceFramework> = [
    'claude-code', 'codex-cli', 'gemini-cli', 'pi-cli',
  ];
`;

/** The same list with the deliberate-subset marker: must NOT be reported. */
const SELF_TEST_NAMED_MARKED = `
  // ${SUBSET_MARKER}: routing preference deliberately excludes grok-build.
  const PREFERENCE: readonly IntelligenceFramework[] = [
    'claude-code', 'codex-cli', 'gemini-cli',
  ];
`;

{
  const failures = [];

  const litFound = scanSource(SELF_TEST_SOURCE);
  const litMissing = litFound[0]?.missing ?? [];
  if (
    litFound.length !== 1
    || !litMissing.includes('pi-cli')
    || !litMissing.includes('grok-build')
    || litMissing.includes('claude-code')
  ) {
    failures.push(`detector A (literal union) did not flag a known-stale list: ${JSON.stringify(litFound)}`);
  }

  const namedFound = scanSource(SELF_TEST_NAMED_STALE);
  const namedMissing = namedFound[0]?.missing ?? [];
  if (namedFound.length !== 1 || namedFound[0]?.kind !== 'named' || !namedMissing.includes('grok-build')) {
    failures.push(`detector B (named type) did not flag a stale list: ${JSON.stringify(namedFound)}`);
  }

  // A marked list must be COUNTED (kind 'suppressed', so the population stays
  // honest) but must never be a VIOLATION. Asserting "zero findings" here was
  // wrong once the suppressed kind started being reported, and it failed loudly
  // rather than silently — which is the behaviour a self-test should have.
  const markedFound = scanSource(SELF_TEST_NAMED_MARKED);
  const markedViolations = markedFound.filter((f) => f.missing.length > 0);
  if (markedViolations.length !== 0 || markedFound.length !== 1 || markedFound[0]?.kind !== 'suppressed') {
    failures.push(
      `the deliberate-subset marker did not suppress a marked list: ${JSON.stringify(markedFound)}. `
        + 'An escape hatch that does not work turns every intentional subset into a false alarm.',
    );
  }

  if (failures.length > 0) {
    console.error(
      '[framework-list] SELF-TEST FAILED:\n'
        + failures.map((f) => `  - ${f}`).join('\n')
        + '\nRefusing to report on real files: a detector that cannot fail certifies nothing.',
    );
    process.exit(2);
  }
}

const violations = [];
let filesInspected = 0;
let declsInspected = 0;
const byKind = { literal: 0, named: 0, suppressed: 0 };

for (const file of walk(SRC)) {
  filesInspected += 1;
  const source = fs.readFileSync(file, 'utf8');
  // ONE implementation, shared with the self-test above — see scanSource's note.
  for (const finding of scanSource(source)) {
    declsInspected += 1;
    byKind[finding.kind] += 1;
    if (finding.missing.length === 0) continue;
    violations.push({
      file: path.relative(REPO_ROOT, file),
      line: source.slice(0, finding.index).split('\n').length,
      name: finding.name,
      kind: finding.kind,
      declared: finding.declared,
      missing: finding.missing,
    });
  }
}

// A lint that inspected nothing must never report clean. A scoping bug that
// silently narrowed a gate to zero inputs has read as a pass in this repo
// before, so absence of findings is only meaningful alongside evidence that
// the scan actually ran.
if (filesInspected === 0) {
  console.error(
    '[framework-list] REFUSING to report clean: inspected 0 files. The scan is misrouted.',
  );
  process.exit(2);
}

// ZERO comparable declarations is a legitimate result here, and saying so
// plainly matters: the fix for the defect that motivated this lint was to
// DERIVE the list from the canonical union, which removes the annotated-array
// shape entirely. A codebase with none left is the goal state, not a broken
// scan — and the self-test above, not a nonzero count, is what proves the
// detector is alive.
console.log(
  `[framework-list] self-test passed (both detectors fire on a known-stale list; the `
    + `subset marker suppresses); compared ${declsInspected} framework list(s) `
    + `(${byKind.literal} literal-union, ${byKind.named} named-type, `
    + `${byKind.suppressed} declared-subset) across ${filesInspected} files.`,
);

if (violations.length > 0) {
  console.error(`\n[framework-list] ${violations.length} list(s) narrower than their own type:\n`);
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line}  ${v.name}`);
    console.error(`    type allows : ${v.declared.join(', ')}`);
    console.error(`    value omits : ${v.missing.join(', ')}`);
  }
  console.error(
    '\nA value narrower than its own annotation is almost always staleness, not intent:\n'
      + 'TypeScript accepts the subset silently, so nothing else will tell you.\n'
      + 'Either add the missing member(s), derive the value from the canonical list,\n'
      + 'or narrow the ANNOTATION so it states what you actually mean.\n',
  );
  process.exit(1);
}

console.log('[framework-list] OK — every annotated list covers its own declared type.');
