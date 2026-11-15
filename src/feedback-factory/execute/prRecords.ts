/**
 * The two repository records every instar PR carries, written for a feedback-executor fix PR by
 * trusted executor code (docs/specs/feedback-triage-and-execution.md §4 step 8).
 *
 * A hand-made PR gets them from the local instar-dev workflow: the pre-commit gate writes a
 * decision record (`.instar/instar-dev-decisions/<ts>-<slug>.json`) and the author writes a
 * release-note fragment (`upgrades/next/<slug>.md`). The executor's commits never pass through
 * that gate, so without these records the `decision-audit` and `release-fragment` checks fail on
 * every executor PR and it can never merge.
 *
 * Provenance is honest: the decision record says it was written by the feedback executor, that
 * the local pre-commit gate did NOT run, and lists the checks the executor itself ran. The confined
 * session cannot write either path (`.instar/` is a tooling path the diff gate holds, and these
 * entries are applied after the session's change set, so they win over any same-named file).
 *
 * Text that reaches these files from outside trusted code (the triage summary, which comes from
 * fleet feedback, and the session's test name) is flattened to one plain, length-bounded line, so
 * it can never open a markdown heading, a comment or a code span in the fragment.
 */
import type { ChangeEntry } from './changeSet.js';

/** Which related-tests outcome the executor recorded; `undefined` = not recorded (a held change set). */
export type RelatedTestsOutcome = false | 'timed-out' | 'preexisting' | undefined;

export interface PrRecordInput {
  kind: 'fix' | 'spec';
  /** ISO timestamp from the executor's clock. */
  at: string;
  initiativeId: string;
  clusterId: string;
  attempt: number;
  baseSha: string | null;
  /** Untrusted: the triage summary (from fleet feedback). */
  summary: string;
  /** Session-declared test files (already restricted to `tests/**.test.*` by the result parser). */
  testFiles: string[];
  /** Untrusted: the session's test name. */
  testName: string;
  related: RelatedTestsOutcome;
  /** True when the operator approved publishing a secret-shaped change set (the held path). */
  secretGateOperatorApproved: boolean;
  /** Every path the published change set touches (the session's entries, before these records). */
  entries: Array<Pick<ChangeEntry, 'path' | 'kind'>>;
}

/**
 * Mirror of `isInScopeFile` in scripts/decision-audit-presence-check.mjs (the CI check these records
 * satisfy). tests/unit/feedback-factory/execute-pr-records.test.ts imports the real script and
 * fails when the two disagree.
 */
export function decisionAuditInScope(file: string): boolean {
  if (file.startsWith('src/') || file.startsWith('scripts/') || file.startsWith('.husky/')) return true;
  if (file.startsWith('skills/') && (file.endsWith('SKILL.md') || file.endsWith('.sh') || file.endsWith('.mjs') || file.endsWith('.js'))) return true;
  return false;
}

/**
 * Mirror of `isReleaseRelevant` in scripts/release-relevant-paths.mjs for the paths a feedback
 * change set can carry (tooling paths are held before publication). Same drift test as above.
 */
export function releaseRelevant(file: string): boolean {
  const p = file.trim().replace(/\\/g, '/').replace(/\/+/g, '/').replace(/^\.\//, '').replace(/\/+$/, '').toLowerCase();
  if (!p) return false;
  if (p.split('/').includes('..')) return true;
  if (p.endsWith('.test.ts') || p.endsWith('.test.js') || p.endsWith('.test.mjs')) return false;
  for (const prefix of ['tests', 'docs', 'upgrades']) if (p === prefix || p.startsWith(`${prefix}/`)) return false;
  if (p.startsWith('.instar/')) return false;
  if (p.startsWith('.github/') && !p.startsWith('.github/workflows/')) return false;
  if (p === 'package.json' || p === 'package-lock.json') return true;
  if (['.github/workflows/', 'src/', 'scripts/', '.husky/', '.claude/hooks/'].some((prefix) => p.startsWith(prefix))) return true;
  const skillRelevant = () => p.endsWith('/skill.md') || p.includes('/templates/') || !p.endsWith('.md');
  if (p.startsWith('skills/')) return skillRelevant();
  if (['setup-wizard', 'secret-setup', 'autonomous', 'build'].some((n) => p.startsWith(`.claude/skills/${n}/`))) return skillRelevant();
  return false;
}

/**
 * One plain line from untrusted text: no control or bidi characters, no markdown or HTML syntax
 * characters, no `camelCase:` shape (the release-note validator rejects config keys in the user
 * section), collapsed whitespace, at most `max` characters. Empty → `fallback`.
 */
export function plainLine(raw: unknown, max: number, fallback: string): string {
  const flat = String(raw ?? '')
    .normalize('NFKC')
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/g, ' ')
    .replace(/[`<>#*_[\]|\\~{}]/g, ' ')
    // Every `:` / `=` run after a camelCase word, however many (one pass would leave `fooBar : x`).
    .replace(/\b([a-z]+[A-Z][a-zA-Z]+)[\s:=]*[:=]/g, '$1 ')
    // The validator's placeholder check has no leading word boundary (`/TODO\b/`), so neither does this.
    .replace(/(TODO|FIXME)\b/g, (m) => m.toLowerCase())
    .replace(/\s+/g, ' ')
    .trim();
  if (!flat) return fallback;
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

/** A repository path printed inside a code span only when it is plainly shaped. */
function codePath(file: string): string {
  return /^[\w./@+-]{1,200}$/.test(file) ? `\`${file}\`` : '(a file with an unusual name)';
}

function slugOf(input: Pick<PrRecordInput, 'initiativeId' | 'attempt'>): string {
  const base = String(input.initiativeId).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'item';
  return `feedback-${base}-a${Math.max(1, Math.trunc(Number(input.attempt)) || 1)}`;
}

function relatedLabel(related: RelatedTestsOutcome, ran: boolean): string {
  if (!ran) return 'not-run:no-changed-source-files';
  if (related === undefined) return 'not-recorded';
  if (related === 'timed-out') return 'inconclusive:timed-out-without-a-failure';
  if (related === 'preexisting') return 'inconclusive:every-failure-also-fails-on-the-unchanged-base';
  return 'pass';
}

/**
 * The entries to add to a fix PR so the decision-audit and release-fragment checks see what every
 * instar PR carries. A spec PR (one new docs/specs file, which the review gate requires to be its
 * only file) and a change set with nothing in scope get none.
 */
export function prRecordEntries(input: PrRecordInput): ChangeEntry[] {
  if (input.kind !== 'fix') return [];
  const paths = input.entries.map((e) => e.path);
  const inScope = paths.filter(decisionAuditInScope);
  const relevant = paths.some(releaseRelevant);
  if (inScope.length === 0 && !relevant) return [];
  const slug = slugOf(input);
  const summary = plainLine(input.summary, 240, 'a problem people using Instar reported');
  // The PR body (which the secret gate scans) carries the first 200 characters; never print more.
  const testName = plainLine(String(input.testName ?? '').slice(0, 200), 160, 'the regression test');
  const tests = input.testFiles.filter((f) => /^tests\/[\w./@-]+$/.test(f)).slice(0, 10);
  const sourcesChanged = input.entries.some((e) => e.kind !== 'deleted' && !e.path.startsWith('tests/') && /\.[cm]?[jt]sx?$/.test(e.path));
  const related = relatedLabel(input.related, sourcesChanged);
  const out: ChangeEntry[] = [];

  if (inScope.length > 0) {
    const record = {
      ts: input.at,
      slug,
      source: 'feedback-executor',
      // The instar-dev pre-commit gate never ran for this commit; the checks below are the ones
      // the executor ran itself, confined, on a fresh clone holding exactly the published bytes.
      localPrecommitGate: 'not-run',
      checks: [
        { name: 'base-check', result: 'test-failed-on-unchanged-code' },
        { name: 'head-check', result: 'test-passed-with-change' },
        { name: 'lint', result: 'pass' },
        { name: 'related-tests', result: related },
        { name: 'secret-gate', result: input.secretGateOperatorApproved ? 'held-then-operator-approved' : 'pass' },
      ],
      notRun: ['instar-dev pre-commit gate', 'side-effects review', 'tier classification'],
      feedback: { initiativeId: input.initiativeId, clusterId: input.clusterId, attempt: input.attempt, baseSha: input.baseSha },
      scope: {
        summary,
        // Any value but 'staged-in-scope-additions-plus-deletions' (which the presence check reads
        // as an old record that left deleted paths out): every in-scope path, deleted ones included.
        basis: 'feedback-executor-change-set-including-deleted',
        files: inScope,
      },
      causalAutopsy: null,
      classClosure: null,
      verdict: 'executor-checks-passed',
    };
    const ts = input.at.replace(/[:.]/g, '-');
    out.push({ path: `.instar/instar-dev-decisions/${ts}-${slug}.json`, kind: 'added', bytes: Buffer.from(`${JSON.stringify(record, null, 2)}\n`, 'utf8') });
  }

  if (relevant) {
    const relatedSentence = related === 'pass' ? 'the tests related to the changed files passed'
      : related.startsWith('inconclusive') ? 'the tests related to the changed files gave no clear result, so CI has to pass before merge'
      : related === 'not-recorded' ? 'the related-tests result was not kept for this held change set, so CI has to pass before merge'
      : 'no changed source file needed a related-tests run';
    const fragment = [
      '<!-- bump: patch -->',
      '## What Changed',
      '',
      `A fix opened by the feedback executor for a problem people using Instar reported: ${summary}`,
      '',
      `Changed files: ${paths.filter((p) => !p.startsWith('tests/')).slice(0, 10).map(codePath).join(', ') || 'tests only'}.`,
      '',
      '## What to Tell Your User',
      '',
      `A problem people reported is fixed in this update: ${summary}`,
      '',
      '## Summary of New Capabilities',
      '',
      '- None. This is a fix for reported feedback.',
      '',
      '## Evidence',
      '',
      `The feedback executor ran the regression test (${tests.map(codePath).join(', ') || 'the named test'}: ${testName}) on a fresh clone of the unchanged code, where it failed, and again with this change, where it passed. Both runs were in a sandbox with no network and no credentials. The repository lint check passed, and ${relatedSentence}. Independent reviewers and CI still have to pass before this merges.`,
      '',
    ].join('\n');
    out.push({ path: `upgrades/next/${slug}.md`, kind: 'added', bytes: Buffer.from(fragment, 'utf8') });
  }
  return out;
}
