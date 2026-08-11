import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/**
 * POPULATION PARITY — the guard that fails when a repair to a guard is reverted.
 *
 * Review pass 29 finding 2, which its own metric counted OUT and then called "the single most
 * consequential thing in this pass": reverting the previous increment's headline repair — the one that
 * stopped the sub-obligation countdown arm gating on a trigger PHRASE — dropped the collected population
 * from 48 back to 47, silently re-opening expiry, horizon and uniqueness on a live member, and the whole
 * behavioural suite stayed green at 52/52. Nothing in the repository could fail when that repair broke.
 *
 * Its prescription, and this file: *"Build the guard that fails when a repair to a guard is reverted, and
 * put the published figures behind the tooling that produces them."* Both halves are the same move.
 *
 * ── The design rule that makes this different from a snapshot ──────────────────────────────────────
 * Every expectation here is RE-DERIVED FROM THE SOURCE MATERIAL on both sides. Nothing is a hard-coded
 * number, because a hard-coded number is the very defect this window kept producing — a figure that reads
 * right and goes stale in silence. The test computes the population from the document, the guard computes
 * it from the document, and the test asserts they AGREE. A repair that narrows a population makes the two
 * disagree and reds; a legitimate change to the material moves both together and stays green.
 */

const ROOT = path.resolve(__dirname, '..', '..');
const run = (script: string, args: string[] = []) => {
  try {
    return execFileSync('node', [path.join(ROOT, 'scripts', script), ...args], { cwd: ROOT, encoding: 'utf-8' });
  } catch (e: unknown) {
    const err = e as { stdout?: string; stderr?: string };
    return `${err.stdout ?? ''}${err.stderr ?? ''}`;
  }
};
const registry = () => fs.readFileSync(path.join(ROOT, 'docs', 'STANDARDS-REGISTRY.md'), 'utf-8');

describe('population parity — a narrowed guard population must red a test', () => {
  it('the countdown guard collects every sub-obligation countdown the document declares', () => {
    // Re-derived from the document, not asserted: this is the exact defect pass 28 found (48 declared,
    // 47 collected, one member escaping three arms) and pass 29 found unprotected.
    const declared = (registry().match(/\*\*Sub-obligation countdown\.\*\*\s*`?\d{4}-\d{2}-\d{2}`?/g) ?? []).length;
    expect(declared).toBeGreaterThan(0);
    const out = run('lint-documented-only-countdown.mjs');
    const collected = Number(/(\d+) sub-obligation countdown/.exec(out)?.[1] ?? -1);
    expect(collected, `the document declares ${declared} sub-obligation countdowns; the guard reports `
      + `${collected}. A gap between these two numbers is a member of the population escaping every arm — `
      + `which is exactly how a live countdown dodged expiry, horizon AND uniqueness until review pass 28 `
      + `counted the document two ways. Guard output:\n${out}`).toBe(declared);
  });

  it('the account guard derives a claim for every quoted annotation in its own sources', () => {
    const json = JSON.parse(run('lint-account-matches-tree.mjs', ['--json']));
    // Re-derive the same population the guard derives, from the same files, with the same rule.
    const sources = [
      'upgrades/next/deferral-tracking-verified-not-assumed.md',
      'docs/specs/window10-deep-property-guards.eli16.md',
      'docs/STANDARDS-REGISTRY.md',
      'upgrades/side-effects/window10-deep-property-guards.md',
      'scripts/lint-enforcement-gap-records.mjs',
      'scripts/lint-documented-only-countdown.mjs',
      'scripts/lint-account-matches-tree.mjs',
    ];
    const wordings = new Set<string>();
    for (const rel of sources) {
      const abs = path.join(ROOT, rel);
      if (!fs.existsSync(abs)) continue;
      for (const m of fs.readFileSync(abs, 'utf-8').matchAll(/\[SUPERSEDED\s*—\s*"([^"]{4,160})"/g)) {
        wordings.add(m[1].trim());
      }
    }
    expect(json.claimsDerived, 'the guard and an independent re-derivation disagree about how many retired '
      + 'wordings are enrolled. Review pass 29 finding 3: a published figure of 7 against a real 9, read off '
      + 'the wrong noun. The number belongs to the tooling, not to prose.').toBe(wordings.size);
  });

  it('the figure population matches every retired triple its authority declares', () => {
    const json = JSON.parse(run('lint-account-matches-tree.mjs', ['--json']));
    const auth = fs.readFileSync(path.join(ROOT, 'scripts', 'lint-deferral-referent-resolves.mjs'), 'utf-8');
    const header = auth.slice(0, auth.indexOf('*/'));
    // DERIVED BY A DIFFERENT RULE FROM THE GUARD'S.
    //
    // My first version of this test re-used the guard's own regex — so reverting the guard reverted the
    // test with it, and the pass-27 parser repair could be undone with all four parity tests green. A test
    // that shares its subject's parser cannot falsify that parser; it is the tautological-control shape
    // this window has produced at three different layers. Caught before shipping only by reverting the
    // repair and watching the test NOT red.
    //
    // So: locate the sentence where the authority retires figures, and split it on slashes rather than
    // matching a triple pattern. A parser change that loses a notation still leaves these numerals in the
    // prose, so the two sides can genuinely disagree.
    const retireSentence = /\(TWO earlier figures[\s\S]*?Do not\s*\n?\s*\*?\s*quote either\.\)/.exec(header)?.[0] ?? '';
    expect(retireSentence, 'the authority no longer states its retired figures in the form this test reads')
      .not.toBe('');
    const elements = new Set(
      (retireSentence.match(/\d{1,4}%?(?=\s*\/)|(?<=\/)\d{1,4}%?/g) ?? []).map((x) => x.trim()),
    );
    expect(json.figuresDerived, `the authority's retirement sentence names ${elements.size} distinct `
      + `figure elements (${[...elements].join(', ')}); the guard derives ${json.figuresDerived}. This is `
      + 'the pass-26/27 shape: a parser tuned to one notation while the source uses another.')
      .toBe(elements.size);
  });

  it('the archive holds a verdict for every review pass the tree cites', () => {
    // REWRITTEN after review pass 30 finding 4 proved the first version TAUTOLOGICAL: it compared the
    // guard's count of this directory against a second count of THE SAME DIRECTORY. Both sides moved
    // together, so deleting a verdict file left it green while the underlying lint correctly failed —
    // a parity assertion that added no protection, inside the file whose subject is assertions that
    // cannot fail. My own sabotage proof this evening hit a DIFFERENT arm of this file and I reported
    // the file sound; proving one arm of four and reporting the whole is the narrow-population habit
    // turned on my own evidence.
    //
    // The title always named the right comparison — CITED passes against FILED verdicts — and now the
    // assertion makes it. Both sides are derived from different sources, so they can disagree.
    const json = JSON.parse(run('lint-account-matches-tree.mjs', ['--json']));
    const dir = path.join(ROOT, 'docs', 'specs', 'reports', 'window10-external-passes');
    const filed = new Set(
      fs.readdirSync(dir)
        .map((f) => /^pass(\d+)-verdict\.md$/.exec(f))
        .filter((m): m is RegExpExecArray => m !== null)
        .map((m) => Number(m[1])),
    );
    // The tree's own citations, read from the registry rather than from the guard's summary.
    const cited = new Set(
      [...registry().matchAll(/\breview pass (\d+)\b/gi)].map((m) => Number(m[1])),
    );
    expect(cited.size, 'the registry cites no review pass — the matcher is broken, not the archive clean')
      .toBeGreaterThan(0);
    const missing = [...cited].filter((n) => !filed.has(n)).sort((a, b) => a - b);
    expect(missing, `the tree cites review pass(es) ${missing.join(', ')} with no filed verdict`)
      .toEqual([]);
    // And the guard's own two counts must agree with the sets, so a drift in EITHER is caught.
    expect(json.archivedVerdicts, 'the guard disagrees with the directory about filed verdicts')
      .toBe(filed.size);

    // MY population above is NARROWER than the guard's — it reads the registry, the guard reads a wider
    // surface (30 cited vs the registry's 14). Proven, not assumed: deleting pass29's verdict fails the
    // GUARD and not my scan, because the registry never cites 29. A test whose population is narrower
    // than the guard it checks is this branch's signature defect, so rather than keep a second copy of
    // the guard's citation logic — which would drift — the guard's own verdict is consumed directly.
    const missingVerdictFailures = (json.failures ?? [])
      .filter((f: string) => /is MISSING, and the tree cites review pass/.test(String(f)));
    expect(missingVerdictFailures, 'the guard reports a cited pass with no filed verdict')
      .toEqual([]);
  });
});
