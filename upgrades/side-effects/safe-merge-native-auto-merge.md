# Side-effects review — safe-merge `--auto` (native auto-merge path)

**Change:** add a `--auto` flag to `scripts/safe-merge.mjs` that arms GitHub
native auto-merge and returns immediately, as an additive alternative to the
existing `--admin` synchronous poll-and-merge path. Plus unit coverage.

## 1. Over-block (legitimate inputs rejected that shouldn't be)
None introduced. The new path is opt-in (`--auto`). The one new rejection is the
incoherent `--auto --admin` combo — that SHOULD be rejected (the two are
contradictory merge strategies). No existing invocation is affected: every
current caller passes `--admin` (or neither) and behaves byte-identically.

## 2. Under-block (failure modes still missed)
The `--auto` path delegates required-check enforcement to GitHub's branch
protection. If a repo has auto-merge enabled but branch protection is weak/absent
(no required checks), native auto-merge would merge on mergeable-state alone — but
that is GitHub's configured posture, not a bypass this script introduces, and it
is identical to what a human `gh pr merge --auto` would do. The `--admin` path's
manual re-imposition (e2e-presence, producer-bound floor) intentionally does NOT
run on `--auto` because GitHub enforces the required contexts itself; on a repo
with no required contexts there is nothing to enforce either way. Documented in
the ELI16. Mitigation for instar's own repo: main has 12 required checks, so
auto-merge waits for all of them.

## 3. Level-of-abstraction fit
Correct layer: this is the merge-mechanism wrapper, and native auto-merge is a
merge mechanism. It does not duplicate a higher gate — it DELEGATES to GitHub's
branch protection (a smarter, platform-level gate) rather than re-implementing
enforcement in-process. That is the right direction (less brittle in-process
logic, more native enforcement).

## 4. Signal vs authority compliance
The act-time authority on the `--auto` path is GitHub's branch protection (it
decides whether/when to merge). `safe-merge --auto` is a thin arming command +
honest confirmation reader — it holds no brittle blocking authority of its own;
it cannot merge anything GitHub's required checks haven't cleared. This is MORE
aligned with signal-vs-authority than `--admin` (which bypasses the authority and
then re-imposes it in brittle script logic). No new in-process gate is created.

## 5. Interactions (shadowing, double-fire, races)
- Does not shadow or get shadowed by the `--admin` path — they are mutually
  exclusive (parser-enforced) and the `--auto` branch returns before the poll
  loop is reached.
- No double-merge: arming auto-merge is idempotent (re-arming an armed PR is a
  no-op on GitHub); the independent confirmation reports `merged`/`armed`/error
  honestly.
- The dangerous-command-guard does NOT block `gh pr merge --auto` (verified
  live 2026-06-15: `--auto` only QUEUES, it does not merge-before-green) — so the
  arming command runs without tripping the #539-outage guard.
- `--match-head-commit` interaction: when an explicit SHA is supplied it is
  passed through to `gh pr merge --auto`, so a moved head cancels the arming
  (GitHub behavior), consistent with the head-pin intent. When NO explicit SHA is
  supplied, the head is intentionally NOT pinned on the `--auto` path — native
  auto-merge re-evaluates required checks against whatever the head becomes, so a
  post-arming push simply makes GitHub wait for the new head's checks; it cannot
  merge an unverified head. (This differs from the `--admin` path, which always
  pins; the difference is sound under native enforcement.)

## 6. External surfaces
- Changes the script's CLI contract (new `--auto` flag, new feature
  `native-auto-merge`, new exit code `5 = autoMergeArmed`) — surfaced in
  `--capabilities` and asserted in tests, so a caller probing the contract sees
  it.
- Depends on the repo having "Allow auto-merge" enabled (enabled on
  JKHeadley/instar 2026-06-15). On a repo without it, arming fails with a clear
  `refused:auto-arm-<cls>` + a message naming the missing setting — an honest
  refusal, never a silent degrade, and the `--admin` path remains the fallback.

## 7. Multi-machine posture (Cross-Machine Coherence)
**Machine-local BY DESIGN.** `safe-merge.mjs` is a stateless CLI invoked
synchronously by whichever machine runs it; it holds no durable state, opens no
topic, generates no URL. The arming call targets GitHub (a shared external
authority), so the outcome is identical regardless of which machine arms it —
and GitHub de-dupes (arming an already-armed PR is a no-op), so two machines
arming the same PR cannot double-merge. No replication or proxied-read needed.

## 8. Rollback cost
Trivial. The flag is additive; reverting the commit removes `--auto` and leaves
the untouched `--admin` path. No data migration, no state repair, no fleet
coordination. At the repo level, `allow_auto_merge` can be toggled back off in
one API call / settings click if ever undesired (independent of this code).

## Second-pass review (required — touches merge machinery)

Second-pass: CONCUR — the `if (args.auto)` block early-returns before the poll
loop so the `--admin` path is behavior-identical, the independent `pr view`
re-read only claims `merged`/`armed` on a real `MERGED`/`autoMergeRequest` state
and otherwise exits 2 (no false success), and mutual-exclusion + exit codes are
correct; the only weakening is the author-disclosed branch-protection delegation
(§2), which is bounded — it adds no bypass and is moot on JKHeadley/instar's 12
required checks, so "strictly safer than --admin" holds wherever required checks
exist. (Reviewer's §5 doc-precision nit on head-pinning was applied above.)
