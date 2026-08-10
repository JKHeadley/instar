/**
 * BEHAVIOURAL tests for the four window-10 registry guards.
 *
 * ── Why this file exists, and why it did not until pass 17 ─────────────────────────────────────────
 * Review pass 17 found what sixteen adversarial passes had not looked for: **none of these four guards
 * had a single behavioural test.** The only references to them anywhere under `tests/` were
 * list-membership assertions in `lint-chain-completeness.test.ts` — checks that the scripts appear in
 * the lint chain, which is an EXISTENCE check, not a check that any refusal arm fires.
 *
 * That absence is the structural explanation for this branch's defining failure. Eleven consecutive
 * review passes each found a new defect introduced by the previous pass's repair, and the reason is
 * mechanical rather than moral: **nothing in this repository could fail when a repair broke a guard**,
 * so every fix's correctness rested entirely on the next external reviewer noticing. Pass 17 put it
 * plainly — *"that is why this streak has run eleven passes, and it will not end by finding defects
 * faster."* ONE of those eleven was an arm I made unreachable, and one was an arm I unbounded; a third
 * unreachable arm (the gap guard's leg 4) belongs to the pass-3 repair, not the streak — pass15-verdict.md
 * finding 5 ends "Introduced at the pass-3 repair; eleven subsequent passes did not reach it". All three
 * would have been caught here in seconds.
 *
 * It is also, precisely, the registry's own recorded `alive-but-inert` shape — a guard whose working
 * and broken states are indistinguishable to every surface that watches it — sitting in the test suite
 * of the change that records that shape.
 *
 * ── What these tests do, and the two rules they follow ─────────────────────────────────────────────
 * Each guard gets a fixture repository, an injected violation, and an assertion. Two disciplines are
 * load-bearing here, both earned the hard way during this window:
 *
 *   1. **ASSERT THE REASON, NEVER THE EXIT CODE ALONE.** A broken guard fails identically to a working
 *      one. During pass 16's repair my own three-direction probe reported all three arms "failing" —
 *      all three for the SAME wrong reason (a quoting slip fed a placeholder instead of a date), and
 *      reading exit codes alone would have recorded three proven arms. Every refusal below is matched
 *      against its specific message.
 *   2. **ALWAYS RUN THE CLEAN CASE.** An arm that fires on everything is not a guard. Every describe
 *      block asserts the untouched fixture passes, so a refusal proves discrimination rather than noise.
 *
 * The fixture copies `scripts/` because these guards resolve their root from their own file location,
 * not from the working directory — so pointing `cwd` at a temp repo is not enough, and discovering that
 * is why the harness looks like this rather than like `standards-coverage-ratchet.test.ts`'s.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { COUNTDOWN_HORIZON_DAYS } from '../../scripts/lib/baseline-history.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

let fixture: string;

/** Copy the guards plus the registry artifacts they read. */
function buildFixture(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'w10-guards-'));
  fs.cpSync(path.join(REPO, 'scripts'), path.join(dir, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'docs'), { recursive: true });
  // The countdown guard shells out to `standards-coverage.mjs --json` for the gap set and FAILS CLOSED
  // when it cannot get one — correctly, and it caught this fixture being too thin on first run. So the
  // fixture carries what that script needs: the area-audit ledger, the audit evidence it references, a
  // package.json, a src/ file so root resolution lands here, and a node_modules symlink for its parser.
  // Recorded because a thin fixture would otherwise have looked like a guard defect.
  fs.copyFileSync(path.join(REPO, 'package.json'), path.join(dir, 'package.json'));
  // Review pass 21 finding 6: the fixture carried no `upgrades/`, no `docs/specs/`, no `tests/`, so
  // `passes on the untouched tree` exercised ARM 1 and the figure-authority check ONLY — a clean-case
  // control that proved nothing for the other three arms while the file's own header claimed every
  // describe block asserts the untouched fixture passes. Copy the real surfaces so the control is real.
  for (const rel of [
    'upgrades/next/deferral-tracking-verified-not-assumed.md',
    'upgrades/side-effects/window10-deep-property-guards.md',
    'docs/specs/window10-deep-property-guards.eli16.md',
  ]) {
    const src = path.join(REPO, rel);
    if (!fs.existsSync(src)) continue;
    fs.mkdirSync(path.join(dir, path.dirname(rel)), { recursive: true });
    fs.copyFileSync(src, path.join(dir, rel));
  }
  const arch = path.join(REPO, 'docs', 'specs', 'reports', 'window10-external-passes');
  if (fs.existsSync(arch)) {
    fs.cpSync(arch, path.join(dir, 'docs', 'specs', 'reports', 'window10-external-passes'), { recursive: true });
  }
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'stub.ts'), 'export const x = 1;\n');
  fs.symlinkSync(path.join(REPO, 'node_modules'), path.join(dir, 'node_modules'));
  const audits = path.join(REPO, 'docs', 'audits');
  if (fs.existsSync(audits)) fs.cpSync(audits, path.join(dir, 'docs', 'audits'), { recursive: true });
  const ledger = path.join(REPO, 'docs', 'standards-registry-area-audits.json');
  if (fs.existsSync(ledger)) fs.copyFileSync(ledger, path.join(dir, 'docs', 'standards-registry-area-audits.json'));
  for (const f of [
    'STANDARDS-REGISTRY.md',
    'enforcement-gaps.json',
    'enforcement-gaps-floor.json',
    'enforcement-fingerprint-baseline.json',
    'deferral-referent-baseline.json',
  ]) {
    const src = path.join(REPO, 'docs', f);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(dir, 'docs', f));
  }
  return dir;
}

function run(script: string): { code: number; out: string } {
  try {
    const out = execFileSync('node', [path.join(fixture, 'scripts', script)], {
      cwd: fixture, encoding: 'utf8',
    });
    return { code: 0, out };
  } catch (e) {
    const err = e as { status?: number; stderr?: string; stdout?: string };
    return { code: err.status ?? 1, out: `${err.stderr ?? ''}${err.stdout ?? ''}` };
  }
}

const registry = () => path.join(fixture, 'docs', 'STANDARDS-REGISTRY.md');
const readRegistry = () => fs.readFileSync(registry(), 'utf8');
const writeRegistry = (s: string) => fs.writeFileSync(registry(), s);

const gapsPath = () => path.join(fixture, 'docs', 'enforcement-gaps.json');
const readGaps = () => JSON.parse(fs.readFileSync(gapsPath(), 'utf8'));
function writeGaps(doc: unknown): void {
  fs.writeFileSync(gapsPath(), `${JSON.stringify(doc, null, 2)}\n`);
}

/** A syntactically complete probe gap, so a test exercises the arm it names and not a schema arm. */
function probeGap(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'GAP-behaviour-probe',
    discoveredAt: '2026-08-09',
    recordedAt: '2026-08-09',
    shape: 'behaviour-probe',
    shapeDescription: 'A probe record used only by the behavioural test suite to exercise one arm at a time.',
    evaded: {
      standard: 'Deferral = Deletion',
      atMoment: 'ci-time',
      how: 'Probe only — this record exercises a guard arm under test and asserts no real evasion whatsoever.',
      hadNoFingerprint: false,
    },
    sweep: null,
    countdown: '2026-09-07',
    trackedAs: 'STD-SUBCOUNTDOWN-behaviour-probe',
    residual: 'probe',
    ...over,
  };
}

function addProbeGap(over: Record<string, unknown> = {}): void {
  const doc = readGaps();
  doc.gaps.push(probeGap(over));
  writeGaps(doc);
  const floorPath = path.join(fixture, 'docs', 'enforcement-gaps-floor.json');
  const floor = JSON.parse(fs.readFileSync(floorPath, 'utf8'));
  floor.knownGapIds = [...new Set([...(floor.knownGapIds ?? []), 'GAP-behaviour-probe'])].sort();
  fs.writeFileSync(floorPath, `${JSON.stringify(floor, null, 2)}\n`);
}

beforeEach(() => { fixture = buildFixture(); });
afterEach(() => {
  SafeFsExecutor.safeRmSync(fixture, {
    recursive: true, force: true, operation: 'tests/unit/window10-guards-behaviour.test.ts',
  });
});

describe('lint-enforcement-fingerprint — the article population must partition', () => {
  it('passes on the untouched registry', () => {
    const r = run('lint-enforcement-fingerprint.mjs');
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain('fingerprinted');
  });

  // The pass-12 collision, both halves. The partition arithmetic is the single refusal; the message
  // names the duplicate headings because today they are always the cause.
  it('refuses a duplicate heading whose copy ALSO carries a fingerprint', () => {
    writeRegistry(`${readRegistry()}\n### Deferral = Deletion\n\n**Rule.** dup. **Enforcement fingerprint.** moments: ci-time; surfaces: none.\n`);
    const r = run('lint-enforcement-fingerprint.mjs');
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/PARTITION BROKEN/);
  });

  // Attack B — the half the first repair missed and pass 10 walked through.
  it('refuses a duplicate heading whose copy carries NO fingerprint', () => {
    writeRegistry(`${readRegistry()}\n### Deferral = Deletion\n\n**Rule.** dup with no declaration at all.\n`);
    const r = run('lint-enforcement-fingerprint.mjs');
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/PARTITION BROKEN/);
  });

  // The pass-11 dialect evasion: CommonMark allows up to three leading spaces.
  it.each([1, 2, 3])('refuses a heading indented by %i space(s)', (n) => {
    writeRegistry(`${readRegistry()}\n${' '.repeat(n)}### Hidden Standard\n\n**Rule.** hidden.\n`);
    const r = run('lint-enforcement-fingerprint.mjs');
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/INDENTED heading/);
  });

  // The false-positive control: a fenced example is not a heading.
  it('does NOT refuse an indented heading inside a fenced example', () => {
    writeRegistry(`${readRegistry()}\n\`\`\`\n   ### an indented heading inside a fence\n\`\`\`\n`);
    const r = run('lint-enforcement-fingerprint.mjs');
    expect(r.code, r.out).toBe(0);
  });
});

describe('lint-enforcement-gap-records — leg 4, the unswept-but-dated gap', () => {
  it('passes on the untouched records', () => {
    const r = run('lint-enforcement-gap-records.mjs');
    expect(r.code, r.out).toBe(0);
    expect(r.out).toMatch(/\d+ gap\(s\), \d+ swept/);
  });

  // Reachability. Pass 15 found this arm could not fire at all: a history validator guarded a
  // deadline, so the only admissible countdown was today's date.
  it('ACCEPTS an unswept gap dated inside the horizon, and says so', () => {
    addProbeGap();
    const r = run('lint-enforcement-gap-records.mjs');
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain('1 unswept (dated)');
  });

  // Boundedness. Pass 16 found the reachability fix had removed the deadline's teeth.
  it('refuses an unswept gap dated beyond the horizon', () => {
    addProbeGap({ countdown: '9999-12-31' });
    const r = run('lint-enforcement-gap-records.mjs');
    expect(r.code).toBe(1);
    // The NUMBER, not `\d+` — review pass 18 found the previous assertion matched any value, so the
    // two guards could drift apart with the suite green, which is precisely what had happened.
    expect(r.out).toContain(`beyond the ${COUNTDOWN_HORIZON_DAYS}-day horizon`);
  });

  it('refuses an unswept gap whose countdown has expired', () => {
    addProbeGap({ countdown: '2020-01-01' });
    const r = run('lint-enforcement-gap-records.mjs');
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/has expired/);
  });

  // The pass-11 partition arm: a sweep that silently skips a standard reads as a clean one.
  it('refuses a sweep that reaches no verdict on part of its population', () => {
    const doc = readGaps();
    const swept = doc.gaps.find((g: { sweep?: { unmatched?: unknown[] } }) => g.sweep?.unmatched?.length);
    swept.sweep.unmatched.pop();
    writeGaps(doc);
    const r = run('lint-enforcement-gap-records.mjs');
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/reaches no verdict/);
  });
});

describe('lint-deferral-referent-resolves — a promise must point at executable evidence', () => {
  function trackMarker(id: string): void {
    fs.mkdirSync(path.join(fixture, 'docs', 'specs'), { recursive: true });
    fs.writeFileSync(path.join(fixture, 'docs', 'specs', `probe-${id}.md`), `A promise. <!-- tracked: ${id} -->\n`);
    fs.writeFileSync(path.join(fixture, 'docs', 'deferral-referent-baseline.json'), '{"orphans":[]}\n');
    execFileSync('git', ['init', '-q', '.'], { cwd: fixture });
  }
  function commitAll(): void {
    execFileSync('git', ['add', '-A'], { cwd: fixture });
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'fixture'], { cwd: fixture });
  }

  // Each of these is a hole a review pass walked through, one file type at a time.
  it.each([
    ['a TypeScript line comment', 'src/probe.ts', '// ZZZ-90001 lives only in a comment\nexport const x = 1;\n'],
    ['a JSON comment key', 'src/probe.json', '{\n  "// ZZZ-90001": "lives only in a JSON comment"\n}\n'],
    ['a shell comment after punctuation', 'src/probe.sh', 'true;# ZZZ-90001\n'],
  ])('does NOT let %s resolve a marker', (_label, file, body) => {
    trackMarker('ZZZ-90001');
    fs.mkdirSync(path.join(fixture, path.dirname(file)), { recursive: true });
    fs.writeFileSync(path.join(fixture, file), body);
    commitAll();
    const r = run('lint-deferral-referent-resolves.mjs');
    expect(r.code).toBe(1);
    expect(r.out).toContain('ZZZ-90001');
  });

  // The direction that matters most: over-refusal would report kept promises as broken.
  it('DOES let a genuine code referent resolve a marker', () => {
    trackMarker('ZZZ-90002');
    fs.mkdirSync(path.join(fixture, 'src'), { recursive: true });
    fs.writeFileSync(path.join(fixture, 'src', 'real.ts'), 'export const TICKET = "ZZZ-90002";\n');
    commitAll();
    const r = run('lint-deferral-referent-resolves.mjs');
    expect(r.code, r.out).toBe(0);
  });
});

describe('lint-documented-only-countdown — a countdown must be a deadline', () => {
  it('passes on the untouched registry', () => {
    const r = run('lint-documented-only-countdown.mjs');
    expect(r.code, r.out).toBe(0);
  });

  // Swept here by pass 17, which found the horizon had been added to the sibling guard only.
  it('refuses a countdown beyond the horizon', () => {
    writeRegistry(readRegistry().replace(/2026-09-07/g, '9999-12-31'));
    const r = run('lint-documented-only-countdown.mjs');
    expect(r.code).toBe(1);
    expect(r.out).toContain(`beyond the ${COUNTDOWN_HORIZON_DAYS}-day horizon`);
  });

  // BOTH guards must track the SAME constant.
  //
  // SCOPE, corrected by review pass 19, which falsified the sentence that stood here. It claimed this
  // was "the test that would have caught pass 18's finding". It would NOT have. Pass 18's defect was a
  // private literal equal to the shared value, and this test compares each guard's PRINTED number — so
  // a duplicate at the SAME value is invisible. Verified: the whole suite passes 23/23 against the exact
  // pre-repair code pass 18 rejected. What this test catches is a DIVERGENT literal, which is a real but
  // narrower thing.
  //
  // The same-value case is unclosable behaviourally and is closed statically instead, by
  // `scripts/lint-account-matches-tree.mjs`, which reads the guards' SOURCE for the shared import and
  // for numeric horizon literals. Naming the division here because a test whose stated reach exceeds
  // what it checks is precisely the defect this file exists to prevent — and it was in this file.
  // the gap guard kept a private `const HORIZON_DAYS = 180` while the shared export was wired only into
  // its sibling, and every existing assertion passed because it matched any digits.
  it('both countdown guards report the SAME horizon, so they cannot drift apart', () => {
    addProbeGap({ countdown: '9999-12-31' });
    writeRegistry(readRegistry().replace(/2026-09-07/g, '9999-12-31'));
    const gap = run('lint-enforcement-gap-records.mjs');
    const countdown = run('lint-documented-only-countdown.mjs');
    const phrase = `beyond the ${COUNTDOWN_HORIZON_DAYS}-day horizon`;
    expect(gap.out, 'gap guard').toContain(phrase);
    expect(countdown.out, 'countdown guard').toContain(phrase);
  });

  it('refuses an expired countdown, for the expiry reason and not the horizon one', () => {
    writeRegistry(readRegistry().replace('2026-09-07', '2020-01-01'));
    const r = run('lint-documented-only-countdown.mjs');
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/EXPIRED on 2020-01-01/);
    expect(r.out).not.toMatch(/beyond the \d+-day horizon/);
  });

  // The ARTICLE-level arms, which review pass 18 found uncovered: the tests above rewrite EVERY date,
  // so the sub-obligation arm alone satisfied the assertion and disabling the article arm left the suite
  // green. These target a single article countdown so the article arm is the only thing that can fire.
  it('refuses an ARTICLE countdown beyond the horizon', () => {
    const src = readRegistry();
    const article = /\*\*Documented-only until\.\*\* `2026-09-07`/;
    expect(article.test(src), 'fixture must contain an article-level countdown').toBe(true);
    writeRegistry(src.replace(article, '**Documented-only until.** `9999-12-31`'));
    const r = run('lint-documented-only-countdown.mjs');
    expect(r.code).toBe(1);
    expect(r.out).toContain('is documented-only and its countdown 9999-12-31');
  });

  it('refuses an ARTICLE countdown that has expired', () => {
    const src = readRegistry();
    writeRegistry(src.replace(/\*\*Documented-only until\.\*\* `2026-09-07`/, '**Documented-only until.** `2020-01-01`'));
    const r = run('lint-documented-only-countdown.mjs');
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/is STILL documented-only and its countdown EXPIRED on 2020-01-01/);
  });

  // Pass 11: a duplicated tracked id means closing either reads as closing both.
  it('refuses a duplicated tracked countdown id', () => {
    writeRegistry(readRegistry().replace(
      'STD-SUBCOUNTDOWN-stale-family-area-audits',
      'STD-SUBCOUNTDOWN-audit-never-started',
    ));
    const r = run('lint-documented-only-countdown.mjs');
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/declared MORE THAN ONCE/);
  });
});

describe('lint-account-matches-tree — the account must match the tree', () => {
  const SE = () => path.join(fixture, 'upgrades', 'side-effects', 'window10-deep-property-guards.md');
  const ARCHIVE = () => path.join(fixture, 'docs', 'specs', 'reports', 'window10-external-passes');
  const write = (p: string, s: string) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, s); };
  const append = (p: string, s: string) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.appendFileSync(p, s); };
  // The fixture now carries the REAL archive (review pass 21 finding 6), so a test about archive SHAPE
  // has to establish its own shape rather than assume an empty directory.
  const clearArchive = () => {
    const d = ARCHIVE();
    if (fs.existsSync(d)) for (const f of fs.readdirSync(d)) fs.rmSync(path.join(d, f));
    fs.mkdirSync(d, { recursive: true });
  };

  it('passes on the untouched tree', () => {
    const r = run('lint-account-matches-tree.mjs');
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain('declare no horizon-named numeric literal');
  });

  // ARM 1 — the arm review pass 18's defect proved a behavioural test structurally cannot cover: a private
  // literal EQUAL to the shared value prints identically, so only source inspection distinguishes a shared
  // bound from a coincidentally-equal copy.
  it('refuses a guard that declares its own horizon literal EQUAL to the shared value', () => {
    const g = path.join(fixture, 'scripts', 'lint-enforcement-gap-records.mjs');
    fs.writeFileSync(g, fs.readFileSync(g, 'utf8')
      .replace('const HORIZON_DAYS = COUNTDOWN_HORIZON_DAYS;', 'const HORIZON_DAYS = 180;'));
    const r = run('lint-account-matches-tree.mjs');
    expect(r.code).toBe(1);
    expect(r.out).toContain('declares a NUMERIC horizon literal');
  });

  it('refuses a guard that stops importing the shared symbol', () => {
    const g = path.join(fixture, 'scripts', 'lint-documented-only-countdown.mjs');
    fs.writeFileSync(g, fs.readFileSync(g, 'utf8').split('COUNTDOWN_HORIZON_DAYS').join('LOCAL_DAYS'));
    const r = run('lint-account-matches-tree.mjs');
    expect(r.code).toBe(1);
    expect(r.out).toContain('does not reference COUNTDOWN_HORIZON_DAYS');
  });

  // Review pass 20 finding 10: the fail-closed arm no sabotage reached.
  it('refuses when a countdown guard file is missing entirely', () => {
    fs.rmSync(path.join(fixture, 'scripts', 'lint-documented-only-countdown.mjs'));
    const r = run('lint-account-matches-tree.mjs');
    expect(r.code).toBe(1);
    expect(r.out).toContain('refusing to report clean over a guard that is not there');
  });

  // ── The populations are DERIVED. These are the tests that make that real rather than asserted. ──

  // Review pass 20 finding 1: the hand-written figure list held four of the six numerals its own cited
  // authority forbids. Deriving them means adding a triple THERE enrolls it here, with no second edit.
  it('derives the figure population from the authority, so a new retired triple enrolls itself', () => {
    const auth = path.join(fixture, 'scripts', 'lint-deferral-referent-resolves.mjs');
    fs.writeFileSync(auth, fs.readFileSync(auth, 'utf8')
      .replace('194/104/54%', '194/104/54% and 999/888/77%'));
    write(path.join(fixture, 'docs', 'specs', 'window10-deep-property-guards.eli16.md'),
      'The measurement was 999 of something.\n');
    const r = run('lint-account-matches-tree.mjs');
    expect(r.code).toBe(1);
    expect(r.out).toContain('publishes the SUPERSEDED figure "999"');
  });

  // The fail-closed direction: if the authority stops stating triples, the arm must SAY it is watching
  // nothing rather than print clean over an empty population — the alive-but-inert shape.
  it('refuses rather than reporting clean when the authority states no retired triple', () => {
    const auth = path.join(fixture, 'scripts', 'lint-deferral-referent-resolves.mjs');
    fs.writeFileSync(auth, fs.readFileSync(auth, 'utf8').replace(/\b\d{2,4}\/\d{2,4}\/\d{1,3}%/g, 'REDACTED'));
    const r = run('lint-account-matches-tree.mjs');
    expect(r.code).toBe(1);
    expect(r.out).toContain('watching NOTHING');
  });

  // Review pass 20 finding 2: the claim population is derived from the tree's own annotations, so
  // correcting a claim once (which means annotating the place that quotes it) immunises every surface.
  it('derives the claim population from annotations: an annotated claim repeated elsewhere is refused', () => {
    write(SE(), '- [SUPERSEDED — "a wholly invented retired wording"] → the corrected version.\n');
    write(path.join(fixture, 'docs', 'specs', 'window10-deep-property-guards.eli16.md'),
      'As established, a wholly invented retired wording is how it works.\n');
    const r = run('lint-account-matches-tree.mjs');
    expect(r.code).toBe(1);
    expect(r.out).toContain('repeats the RETIRED claim "a wholly invented retired wording"');
  });

  // Prose wraps. The offset-map scan finds a claim broken across lines exactly once, at its start.
  it('finds a retired claim wrapped across a line break, and reports it once', () => {
    write(SE(), '- [SUPERSEDED — "a wholly invented retired wording"] → the corrected version.\n');
    write(path.join(fixture, 'docs', 'specs', 'window10-deep-property-guards.eli16.md'),
      'filler line\nAs established, a wholly invented\nretired wording is how it works.\n');
    const r = run('lint-account-matches-tree.mjs');
    expect(r.code).toBe(1);
    const hits = r.out.split('\n').filter((l) => l.includes('repeats the RETIRED claim'));
    expect(hits.length).toBe(1);
    expect(hits[0]).toContain('eli16.md:2');
  });

  // Review pass 20 finding 5: an annotation must NOT grant amnesty to its neighbours. The escape is the
  // matched span's own lines, so a claim sandwiched between two annotated lines is still refused.
  it('refuses a retired claim sandwiched between two annotated lines', () => {
    write(SE(), '- [SUPERSEDED — "a wholly invented retired wording"] → the corrected version.\n');
    write(path.join(fixture, 'docs', 'specs', 'window10-deep-property-guards.eli16.md'),
      '[SUPERSEDED — an annotation]\na wholly invented retired wording\n[SUPERSEDED — another annotation]\n');
    const r = run('lint-account-matches-tree.mjs');
    expect(r.code).toBe(1);
    expect(r.out).toContain('repeats the RETIRED claim');
  });

  // The false-positive control: the annotated form is the SANCTIONED way to quote a retired wording.
  it('ACCEPTS a retired claim on a line carrying its own annotation', () => {
    write(SE(), '- [SUPERSEDED — "a wholly invented retired wording"] → the corrected version.\n');
    write(path.join(fixture, 'docs', 'specs', 'window10-deep-property-guards.eli16.md'),
      '[SUPERSEDED — quoted deliberately] a wholly invented retired wording, now corrected.\n');
    const r = run('lint-account-matches-tree.mjs');
    expect(r.code, r.out).toBe(0);
  });

  // The narrowing control. Pointing the FIGURE arm at the engineering log flagged eleven lines that
  // legitimately narrate how the measurement moved; a guard that flags correct prose trains its reader to
  // skip it. The two arms carry different populations, and this asserts that split is real.
  it('does NOT apply the figure arm to the engineering log, which narrates the figure history', () => {
    append(SE(), '\nThe measurement went 62% of 178, then 54% of 194, now 201 of 217.\n');
    const r = run('lint-account-matches-tree.mjs');
    expect(r.code, r.out).toBe(0);
  });

  // ── ARM 3 — the limb that lapsed TEN times as a resolution. A citation is the obligation. ──
  it('refuses when the tree cites a review pass whose verdict is not archived', () => {
    write(SE(), 'As review pass 47 found, the guard was blind.\n');
    const r = run('lint-account-matches-tree.mjs');
    expect(r.code).toBe(1);
    expect(r.out).toContain('pass47-verdict.md is MISSING, and the tree cites review pass 47');
  });

  it('refuses a hole in the middle of an otherwise contiguous archive', () => {
    // Passes 30 and 32 are NOT cited anywhere in the tree, so the gap at 31 can only be found by the
    // contiguity path — with cited passes the citation arm claims the gap first and this never runs.
    clearArchive();
    write(path.join(ARCHIVE(), 'pass30-verdict.md'), 'x\n');
    write(path.join(ARCHIVE(), 'pass32-verdict.md'), 'x\n');
    const r = run('lint-account-matches-tree.mjs');
    expect(r.code).toBe(1);
    expect(r.out).toContain('pass31-verdict.md is missing from an otherwise contiguous archive');
  });

  it('ACCEPTS a cited review pass whose verdict IS archived', () => {
    // Review pass 22 finding 4: this cited pass 7, which the untouched fixture ALREADY cites — so the
    // appended line changed the derived set not at all, and the test could not fail for any reason the
    // untouched-tree control does not already catch. Cite a pass nothing else mentions, and archive it.
    // Use the NEXT pass after the archive max: citing-and-archiving it keeps contiguity, whereas a
    // distant number would open a hole and fail for an unrelated reason.
    const next = Math.max(...fs.readdirSync(ARCHIVE()).map((f) => Number(/pass(\d+)-verdict/.exec(f)?.[1] ?? 0))) + 1;
    append(SE(), `\nAs review pass ${next} found, the guard was blind.\n`);
    write(path.join(ARCHIVE(), `pass${next}-verdict.md`), 'the verbatim verdict\n');
    const r = run('lint-account-matches-tree.mjs');
    expect(r.code, r.out).toBe(0);
  });

  // Review pass 22 finding 5: the plural and hash forms were announced as capabilities and nothing here
  // could fail when they broke — the precise absence the behavioural suite exists for.
  it('arms on the PLURAL citation form the logs already use', () => {
    append(SE(), '\nPasses 62 and 63 both rejected.\n');
    const r = run('lint-account-matches-tree.mjs');
    expect(r.code).toBe(1);
    expect(r.out).toContain('pass62-verdict.md is MISSING');
    expect(r.out).toContain('pass63-verdict.md is MISSING');
  });

  it('arms on the HASH citation form', () => {
    append(SE(), '\nPass #64 rejected.\n');
    const r = run('lint-account-matches-tree.mjs');
    expect(r.code).toBe(1);
    expect(r.out).toContain('pass64-verdict.md is MISSING');
  });

  // Review pass 22 finding 2: the tens table resolved compound ordinals but no ROUND one, while two
  // artifacts justified it by the exact property it lacked.
  it('arms on a ROUND ordinal, which the tens table alone cannot express', () => {
    append(path.join(fixture, 'docs', 'specs', 'window10-deep-property-guards.eli16.md'),
      '\n## Seventieth reading: what it found\n');
    const r = run('lint-account-matches-tree.mjs');
    expect(r.code).toBe(1);
    expect(r.out).toContain('pass70-verdict.md is MISSING');
  });

  // Review pass 22 finding 1: trimming closed the plain-indent wrap and left the PREFIX class open — on
  // the very file the previous commit had just added to the watched surfaces, whose every wrapped
  // sentence is a block comment.
  it('finds a retired claim wrapped across a COMMENT-prefixed continuation', () => {
    append(SE(), '\n- [SUPERSEDED — "a wholly invented retired wording"] the corrected version.\n');
    append(path.join(fixture, 'scripts', 'lint-account-matches-tree.mjs'),
      '\n/**\n * As established, a wholly invented\n * retired wording is how it works.\n */\n');
    const r = run('lint-account-matches-tree.mjs');
    expect(r.code).toBe(1);
    expect(r.out).toContain('repeats the RETIRED claim');
  });

  it('finds a retired claim wrapped across a BLOCKQUOTE continuation', () => {
    append(SE(), '\n- [SUPERSEDED — "a wholly invented retired wording"] the corrected version.\n');
    append(path.join(fixture, 'docs', 'specs', 'window10-deep-property-guards.eli16.md'),
      '\n> As established, a wholly invented\n> retired wording is how it works.\n');
    const r = run('lint-account-matches-tree.mjs');
    expect(r.code).toBe(1);
    expect(r.out).toContain('repeats the RETIRED claim');
  });

  // Review pass 22 finding 8 — ARM 3's fail-closed refusal over an empty derived population.
  //
  // I recorded this last cycle as UNTESTABLE, on the reasoning that the state is structurally
  // unreachable because the guard is itself a citing surface whose header cites passes. Review pass 23
  // falsified that in one mutation: replace the guard's LEADING BLOCK COMMENT — which contains nothing
  // executable and no message template — with a citation-free one, strip citations from the three doc
  // surfaces while KEEPING their quoted annotations, and clear the archive. One failure, its own, no
  // collateral. My obstacle was a blunt tool mistaken for a structural fact: my first attempt regexed
  // the whole source and corrupted the message templates. Every test here operates on a MUTATED
  // FIXTURE, never on the real repository, and both sibling fail-closed arms are tested exactly this
  // way. Written the way its siblings are written, as review pass 23 prescribed.
  it('refuses rather than reporting clean when ARM 3 derives nothing at all', () => {
    clearArchive();
    const g = path.join(fixture, 'scripts', 'lint-account-matches-tree.mjs');
    const src = fs.readFileSync(g, 'utf8');
    const close = src.indexOf('*/');
    // Replace ONLY the leading block comment — keeping the shebang, and resuming AFTER the terminator.
    // Nothing executable is touched and no message template is altered.
    const shebang = src.startsWith('#!') ? `${src.slice(0, src.indexOf('\n') + 1)}` : '';
    // The guard cites passes in its INLINE comments too, below the header. Strip those on COMMENT LINES
    // ONLY — identified by their leading marker, not by whether they contain a backtick, since comment
    // prose is full of backticks. No string literal is touched, so no message template can be altered:
    // that is the whole difference between this mutation and the blunt one that failed last cycle for an
    // unrelated reason.
    const body = src.slice(close + 2).split('\n').map((l) => {
      const lead = l.trimStart();
      if (!lead.startsWith('//') && !lead.startsWith('*') && !lead.startsWith('/*')) return l;
      return l.replace(/\bpasses\s+\d{1,3}\s+and\s+\d{1,3}\b/gi, 'SECTIONS')
        .replace(/\b(?:review\s+)?pass\s*#?\s*\d{1,3}\b/gi, 'SECTION')
        .replace(/\bpass\d{1,3}-verdict\b/gi, 'VERDICT')
        .replace(/[\w-]+\s+(?:reading|pass|review)\b/gi, 'SECTION');
    }).join('\n');
    fs.writeFileSync(g, `${shebang}/* header replaced by the fixture: no citations */${body}`);
    for (const rel of [
      'upgrades/side-effects/window10-deep-property-guards.md',
      'upgrades/next/deferral-tracking-verified-not-assumed.md',
      'docs/specs/window10-deep-property-guards.eli16.md',
    ]) {
      const p = path.join(fixture, rel);
      if (!fs.existsSync(p)) continue;
      fs.writeFileSync(p, fs.readFileSync(p, 'utf8')
        .replace(/\b(?:review\s+)?pass\s*#?\s*\d{1,3}\b/gi, 'SECTION')
        .replace(/\bpasses\s+\d{1,3}\s+and\s+\d{1,3}\b/gi, 'SECTIONS')
        .replace(/\bpass\d{1,3}-verdict\b/gi, 'VERDICT')
        .replace(/\w+\s+(?:reading|pass|review)\b/gi, 'SECTION'));
    }
    const r = run('lint-account-matches-tree.mjs');
    expect(r.code).toBe(1);
    expect(r.out).toContain('ARM 3 derived NO citations');
  });

  // Review pass 23 finding 1: the strip consumed at most ONE space, so a marker followed by two or more
  // stayed invisible — and three spaces after a star is the house indentation of the guard's OWN header,
  // the file the repair existed to cover.
  it('finds a retired claim wrapped across a comment continuation indented THREE spaces', () => {
    append(SE(), '\n- [SUPERSEDED — "a wholly invented retired wording"] the corrected version.\n');
    append(path.join(fixture, 'scripts', 'lint-account-matches-tree.mjs'),
      '\n/**\n *   As established, a wholly invented\n *   retired wording is how it works.\n */\n');
    const r = run('lint-account-matches-tree.mjs');
    expect(r.code).toBe(1);
    expect(r.out).toContain('repeats the RETIRED claim');
  });

  // Review pass 23 finding 4: stripping every marker on every surface joined two SEPARATE markdown
  // bullets into one sentence. A guard that flags correct prose is one its reader learns to skip.
  it('does NOT join two separate markdown bullets into one claim', () => {
    append(SE(), '\n- [SUPERSEDED — "a wholly invented retired wording"] the corrected version.\n');
    append(path.join(fixture, 'docs', 'specs', 'window10-deep-property-guards.eli16.md'),
      '\n* As established, a wholly invented\n* retired wording is how it works.\n');
    const r = run('lint-account-matches-tree.mjs');
    expect(r.code, r.out).toBe(0);
  });


  // Review pass 21 finding 2: the arm parsed only "pass N", while the explainer states the obligation —
  // and titles every one of its sections — in the ordinal form. The sentence announcing the obligation
  // was written in the one wording that could not trigger it.
  it('arms on the ORDINAL citation form the documents actually use', () => {
    append(path.join(fixture, 'docs', 'specs', 'window10-deep-property-guards.eli16.md'),
      '\n## Forty-seventh reading: what it found\n');
    const r = run('lint-account-matches-tree.mjs');
    expect(r.code).toBe(1);
    expect(r.out).toContain('pass47-verdict.md is MISSING');
  });

  // Review pass 21 finding 5: "pass" is also a verb, and the first version demanded a verdict file for
  // "the tests pass 100% of the time". A guard that refuses correct prose is one its reader learns to skip.
  it('does NOT arm on "pass" used as a verb', () => {
    append(SE(), '\nThe tests pass 100% of the time now, and the suite must pass 37 checks before merge.\n');
    const r = run('lint-account-matches-tree.mjs');
    expect(r.code, r.out).toBe(0);
  });

  // Review pass 21 finding 4: the figure arm refused over an empty derived population and the claim arm
  // did not, so rewriting one paragraph would silently empty this arm while it printed clean.
  it('refuses rather than reporting clean when no quoted annotation remains', () => {
    for (const rel of [
      'upgrades/side-effects/window10-deep-property-guards.md',
      'upgrades/next/deferral-tracking-verified-not-assumed.md',
      'docs/specs/window10-deep-property-guards.eli16.md',
      'scripts/lint-account-matches-tree.mjs',
      'scripts/lint-enforcement-gap-records.mjs',
      'scripts/lint-documented-only-countdown.mjs',
    ]) {
      const p = path.join(fixture, rel);
      if (!fs.existsSync(p)) continue;
      fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replace(/\[SUPERSEDED\s*—\s*"/g, '[SUPERSEDED — '));
    }
    const r = run('lint-account-matches-tree.mjs');
    expect(r.code).toBe(1);
    expect(r.out).toContain('watching NOTHING');
  });

  // Review pass 21 finding 1: the offset-map rewrite lost a case the deleted window caught — an indented
  // continuation line. It is the dominant wrap shape in these documents.
  it('finds a retired claim wrapped onto an INDENTED continuation line', () => {
    append(SE(), '\n- [SUPERSEDED — "a wholly invented retired wording"] the corrected version.\n');
    append(path.join(fixture, 'docs', 'specs', 'window10-deep-property-guards.eli16.md'),
      '\n- As established, a wholly invented\n  retired wording is how it works.\n');
    const r = run('lint-account-matches-tree.mjs');
    expect(r.code).toBe(1);
    expect(r.out).toContain('repeats the RETIRED claim "a wholly invented retired wording"');
  });
});
