/**
 * The lint chain may only GROW.
 *
 * WHY THIS EXISTS (found during the rebase planning for the standards-registry change,
 * 2026-07-28). That branch appends `lint-no-direct-standards-registry-path.mjs` to
 * `package.json`'s `lint` script at exactly the position where `origin/main` had since
 * appended `lint-rollout-evidence-resolvable.js`. Both are single-line edits to the same
 * line, so git presents one conflict — and resolving it "ours" or "theirs" silently
 * DELETES a required lint from CI.
 *
 * Nothing would fail. The guard would simply stop running, and the next person to look
 * would find a green build. That is the same invisible-guard-loss class the change
 * itself is about: a check whose absence is indistinguishable from its success.
 *
 * A conflict you must resolve correctly by remembering is a wish. This is the ratchet.
 *
 * **How to extend it:** add your lint's basename to `REQUIRED_LINTS` in the SAME commit
 * that adds it to the chain. Removing one is a deliberate two-file edit with a reason in
 * the diff — which is the entire point.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/**
 * Every lint that must be in the chain. Sorted for a readable diff, NOT for execution
 * order — order is `package.json`'s business, presence is this test's.
 */
const REQUIRED_LINTS = [
  // Not a `lint-*` name — which is exactly why the first version of the inverse check
  // could not see it, and why it was unprotected.
  'check-codex-rule1-drift.js',
  'lint-canonical-pipeline-completeness.mjs',
  // The Telegram egress boundary (2026-08-11). It replaced lint-telegram-send-funnel-guarded.mjs,
  // which had never been registered here — so the guard on the agent's outbound messaging path was
  // itself unprotected for as long as it existed, and swapping it for a stronger one would have
  // carried that gap forward silently. Registered with the replacement rather than after it.
  'lint-telegram-egress-boundary.mjs',
  // Registry-integrity lints. The first five landed 2026-08-06 with the ratified
  // standards batch and the last two on 2026-08-07 with the operator rulings; NONE
  // were registered here, so this inverse check had been failing since 2026-08-06
  // and nothing surfaced it — the worktree's commit hooks were inert (window-8
  // trap 1), so the ratchet that exists to protect these guards was itself never
  // executed. Verified against the base commit rather than assumed.
  'lint-blocking-decisions-declared.mjs',
  'lint-dispatch-withholds-answer.mjs',
  'lint-documented-only-countdown.mjs',
  // Not named "lint-*": it is a generator whose --check mode IS the guard. Listed
  // here anyway, because the property this ratchet protects is "a registry guard
  // is in the chain", and a guard that escapes the ratchet on a naming technicality
  // is exactly the hole the ratchet exists to close (2026-08-08).
  'generate-standards-hierarchy.mjs',
  'lint-no-duplicate-definitions.mjs',
  'lint-recall-surface-names-match-mechanism.mjs',
  // Retired constitutional articles must never strand a citation: every retired article names a
  // live successor, every citation site carries a forwarding marker, and the marker agrees with
  // the retirement record. Operator ruling 4a, 2026-08-13.
  'lint-retired-article-redirects.mjs',
  'lint-registry-tree-parentage.mjs',
  'lint-single-governing-obligation.mjs',
  'lint-cas-emit-placement.js',
  'lint-dev-agent-dark-gate.js',
  'lint-emit-without-admit.js',
  'lint-expected-capacity-degradations.js',
  'lint-guard-manifest.js',
  'lint-journal-actuation-ban.js',
  'lint-llm-attribution.js',
  'lint-migration-consumer-completeness.js',
  'lint-model-registry-freshness.mjs',
  'lint-nature-chains.mjs',
  'lint-no-blocking-process-scans.js',
  'lint-no-direct-destructive.js',
  'lint-no-direct-llm-http.js',
  'lint-no-direct-standards-registry-path.mjs',
  'lint-no-direct-url-log.js',
  'lint-no-mainthread-cartographer-walk.js',
  'lint-no-opus-claude-cli-gating.js',
  'lint-no-unbounded-llm-spawn.js',
  'lint-no-unfunneled-credential-write.js',
  'lint-no-unfunneled-headless-launch.js',
  'lint-no-unfunneled-tmux-literal-send.js',
  'lint-no-unfunneled-topic-creation.js',
  'lint-no-unreachable-messaging-gate.js',
  'lint-no-unregistered-self-action.js',
  'lint-no-wholefile-sync-read.js',
  'lint-rollout-evidence-resolvable.js',
  'lint-routing-registry-freshness.js',
  'lint-scrape-fixture-realness.js',
  'lint-state-registry.js',
  'lint-store-retention-declared.js',
  'lint-sync-subprocess-chokepoint.js',
];

/**
 * HISTORICAL NOTE, kept because the reasoning matters more than the code that is gone.
 *
 * While this branch was behind main, `lint-rollout-evidence-resolvable.js` existed there
 * and not here, so it could not be asserted PRESENT — a test red for a reason unrelated
 * to guard loss teaches people to ignore it. A `PENDING_FROM_MAIN` list carried it under
 * a weaker pair-invariant (fully wired OR fully absent, never half).
 *
 * The rebase made it REQUIRED, so the list emptied — and an `it()` iterating an empty
 * list passes with zero assertions while reading as coverage. That is the same
 * cannot-fail shape this whole change exists to remove, so the case is deleted rather
 * than left as decoration. Restore the pattern if the situation recurs; do not leave a
 * vacuous loop standing because it is green.
 */

function lintChain(): string {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8')) as {
    scripts?: Record<string, string>;
  };
  const chain = pkg.scripts?.lint;
  expect(chain, 'package.json has no `lint` script').toBeTruthy();
  return chain!;
}

describe('the lint chain may only grow — a conflict resolution cannot silently drop a guard', () => {
  it('every required lint is present in the chain', () => {
    const chain = lintChain();
    const missing = REQUIRED_LINTS.filter((l) => !chain.includes(l));
    expect(
      missing,
      `These lints are in REQUIRED_LINTS but NOT in package.json's \`lint\` script: ` +
        `${missing.join(', ')}. If a merge resolved the lint line by taking one side, this is the ` +
        `guard that was dropped — restore it. If the removal is deliberate, remove it from ` +
        `REQUIRED_LINTS in the same commit, with the reason in the diff.`,
    ).toEqual([]);
  });

  it('every required lint actually exists on disk — a chained lint that is gone is a dangling guard', () => {
    const absent = REQUIRED_LINTS.filter((l) => !fs.existsSync(path.join(ROOT, 'scripts', l)));
    expect(
      absent,
      `These lints are required and chained but have no file in scripts/: ${absent.join(', ')}. ` +
        `The chain would fail loudly, which is better than passing — but the list is now lying.`,
    ).toEqual([]);
  });

  it('the chain does not silently contain a lint the list has never heard of', () => {
    // The inverse direction. A lint added to package.json but not to REQUIRED_LINTS is
    // unprotected — the next conflict can drop it and this ratchet would not notice.
    // This is a nag, not a blocker on the lint itself: the fix is one line.
    const chain = lintChain();
    // Every `node scripts/<x>` token, not just `lint-*` — `check-codex-rule1-drift.js`
    // runs in this chain today and was invisible to a `lint-`-anchored regex, so the
    // ratchet that exists to stop a merge dropping a guard could not see it.
    const chained = Array.from(chain.matchAll(/node scripts\/([A-Za-z0-9_.-]+\.(?:mjs|js|cjs))/g)).map((m) => m[1]);
    const known = REQUIRED_LINTS;
    const unprotected = [...new Set(chained)].filter((l) => !known.includes(l));
    expect(
      unprotected,
      `These lints run in CI but are not in REQUIRED_LINTS, so nothing protects them from being ` +
        `dropped by a merge: ${unprotected.join(', ')}. Add them to the list.`,
    ).toEqual([]);
  });
});
