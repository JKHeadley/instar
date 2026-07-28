---
title: "Audit-Convergence Enforcement — the converging loop as the structurally-enforced default for every audit"
slug: "audit-convergence-enforcement"
author: "echo"
parent-principle: "Iterative Audit to Convergence"
eli16-overview: "audit-convergence-enforcement.eli16.md"
lessons-engaged: "P2 (Structure > Willpower), P3 (Migration Parity), Agent Awareness Standard, Constitutional Traceability, converging-audit-default (spec #4 — the spec-review half this extends), Judgment Within Floors §3.6 (the FD12 tag-writer refusal precedent), no-silent-llm-fallback (the standard's own worked example), Signal vs. Authority (the precommit-gate exemption class + the secrets hard-block carve-out)"
review-convergence: "2026-07-11T20:41:25.455Z"
review-iterations: 11
review-completed-at: "2026-07-11T20:41:25.455Z"
review-report: "docs/specs/reports/audit-convergence-enforcement-convergence.md"
cross-model-review: "codex-cli:gpt-5.5"
cross-model-review-reason: "GPT-tier external ran every round 1-11; no material from round 3 on; gemini degraded-timeout r2/r6 (recorded)"
single-run-completable: true
frontloaded-decisions: 16
cheap-to-change-tags: 2
contested-then-cleared: 2
approved: true  # operator authenticated preapproval, topic 11960, 2026-07-11 ("you have my preapproval for any decisions needed")
---

# Audit-Convergence Enforcement

> Operator directive (topic 11960, 2026-07-11): "before you start I'd like to make
> sure the iterative converging audit process is a standard that is enforced and
> that is the default route that you use whenever you do an audit."
>
> Ground truth at drafting time: the standard **"Iterative Audit to Convergence"**
> exists in `docs/STANDARDS-REGISTRY.md` (ratified 2026-06-07), but the
> StandardsEnforcementAuditor classifies it **`documented-only` with zero guards**
> — its prose names no citation the auditor can resolve. The `/iterative-converging-audit`
> skill exists but its ledger is free-form prose; nothing refuses a one-pass audit
> dressed up as thorough; no template section delivers the default-route behavior
> to agents; `specReview.requireConvergenceReport` (the spec-review half, spec #4)
> ships false everywhere.

## Glossary (local terms used below)

- **standing guard / ratchet** — a committed automated check (a `no-*` test / lint) that FAILS if the audited-away pattern reappears, so a converged audit cannot silently un-converge on a later commit. The standard's Step 5.
- **PostUpdateMigrator** — instar's in-place update engine: existing agents receive changes to agent-installed files (CLAUDE.md sections, skills, config) only through a migration it runs, never automatically.
- **framework shadow markers** — the allowlist (`migrateFrameworkShadowCapabilities` in `PostUpdateMigrator`) that mirrors a Claude-template capability section into the non-Claude agent files (Codex `AGENTS.md`, `GEMINI.md`) so those agents learn it too.
- **feature-delivery-completeness guard** — `tests/unit/feature-delivery-completeness.test.ts`, the CI test that fails if a CLAUDE.md section reaches one delivery path (template / migrator / shadow markers) but not the others.

## Problem statement

An audit that stops after one pass is the exact failure the standard exists to
prevent ("~20 sites" became 44 on the re-sweep). Today the ONLY thing standing
between a one-pass audit and the label "thorough" is the auditing agent's
willpower: the skill describes the loop, the standard demands it, and nothing
enforces it. Per Structure > Willpower, a behavior that matters must be enforced
in code. This spec makes the converged state a **stampable, machine-validated,
CI-re-verified claim** — mirroring the pattern that already guards spec
convergence (`write-convergence-tag.mjs`) — and delivers the default-route
process discipline to every agent.

**Scope honesty (what enforcement can and cannot do — reviewers ADV-1/ADV-3, lessons-aware M3, folded up front).** The gate makes a FALSE `converged:` claim in a canonical audit report structurally impossible to commit or merge. It does NOT force an audit to be routed into the canonical location in the first place, it cannot force a shallow-but-well-formed audit to be deep, and — the sharpest residual — **the stamp validates the ledger's FORM (≥2 round sections, a zeroed final round, closed dispositions, a tracked standing-guard), not the fact that a re-sweep actually happened**: a fabricated two-round ledger earns the stamp, exactly the "added a tag ≠ ran the audit" residual spec #4 named for its own mirror. Three honest residuals, raised-cost but not eliminated: (a) an agent can write an "audit" as prose in chat or under another path and never produce a report — mitigated by the canonical-path-only stamp rule + the honest registry wording, not eliminated; (b) two well-formed shallow rounds satisfy the shape checks — mitigated by requiring each round to record the search angles + surface-growth actually run (raising fabrication cost, giving reviewers something checkable), not eliminated; (c) ledger truthfulness and standing-guard adequacy stay with the auditor and its reviewers. The gate's honest value: "converged" becomes an *auditable, form-verified, CI-re-checked* claim wherever the process is followed — a strictly better epistemic state than today's unguarded `documented-only` — and the registry citation (§4) is worded to claim exactly that and no more (it never claims the stamp proves the sweeps occurred). **Two enforcement scopes, stated up front** (codex clarity note): the machine STAMP + precommit gate + CI ratchet are ENFORCED in the instar source repo (and any repo vendoring the validator); the converging-loop process discipline (single-pass = incomplete; use the canonical report) is INSTRUCTED/DEFAULTED on every installed agent via the skill + template — so "every audit" never means "machine-enforced everywhere." §4's fleet-vs-repo split is the full treatment.

## Lifecycle at a glance (the whole flow in one example)

An agent audits "all silent-catch fallbacks in `src/`":
1. **Create** `docs/audits/silent-catch-fallbacks.md` (frontmatter `audit: silent-catch-fallbacks`, `target-pattern`, `search-surface`).
2. **Round 1** — grep several ways, record each finding as a ledger row with a disposition (`fixed:<commit>` / `accepted:<reason>` / `deferred:<ref>`), plus the search angles run and the surface delta; `New findings this round: 14`.
3. **Round 2** — re-sweep the (now-larger) surface; `New findings this round: 0`, ledger empty.
4. **Standing guard** — add a `no-silent-catch` ratchet test and name it in `standing-guard:` (or, if the pattern is not CI-expressible, `exemption: non-ci-expressible` + rationale).
5. **Stamp** — run `write-audit-convergence.mjs`; it verifies ≥2 rounds, final-round-zero (line == rows), closed dispositions, a tracked standing-guard, then writes `converged: <ISO>`.
6. **Commit** — the precommit re-validates the staged bytes + scans for secrets; a hand-added stamp or an unearned one is refused.
7. **Merge** — the PR touches `docs/audits/**`, so it routes to the operator (not auto-merged); the CI ratchet re-checks the stamp at merged state.

## Proposed design

Five thin pieces, all riding existing patterns.

### 1. The canonical audit report + validator (`scripts/write-audit-convergence.mjs`)

Audit reports live at `docs/audits/<slug>.md`. `<slug>` is charset-jailed to
`^[a-z0-9][a-z0-9-]{0,63}$` (the existing precommit slug regex), and the file
basename MUST equal the frontmatter `audit:` slug (a mismatch refuses the
stamp). Frontmatter:

```yaml
---
audit: "<slug>"                 # == file basename; charset-jailed
target-pattern: "<what was hunted>"
search-surface: "<where>"
rounds: <N>                     # validator-DERIVED (body ## Round count); display-only, overwritten
converged: ""                   # stamped by the validator ONLY
standing-guard: "<repo-relative ratchet path>"   # OR the exemption field below
exemption: ""                   # one of the closed enum (see below) + rationale; XOR standing-guard
---
```

Body carries one `## Round N` section per pass. Each round records — and the
validator REQUIRES (a missing element refuses the stamp; ADV-3 anti-fabrication):
- **Search angles run this round** — the concrete commands / grep patterns / search modes used (skill Step 0/3 already demand these).
- **Surface delta** — how the search surface grew since the prior round (the standard's own "~20 became 44" signal).
- A findings ledger, one row per NEW finding this round (rounds are new-findings-only — prior rounds are immutable history, so growth is linear and the count is cross-checkable): `location | behavior | bucket | disposition`.
- An explicit `New findings this round: <count>` line.

**Disposition is a closed enum** (an unrecognized or open disposition refuses the stamp — fail-closed, ADV-6):
- `fixed:<commit-or-PR-ref>` — non-empty ref (existence of the ref is NOT network-verified; advisory only, stated so nobody assumes it is).
- `accepted:<reason>` — non-empty rationale; a written DECISION, not a TODO.
- `deferred:<tracking-ref>` — a real finding with tracked follow-up (a commitment / evolution-action / issue id); non-empty ref REQUIRED. (Decision-Completeness G2: a deferral is first-class in this codebase's culture — Close the Loop — and must not be mislabeled `accepted`.)

**`location` never quotes secret material** (Security M5). The ledger references a path+line; it MUST NOT paste the offending content. A "find leaked credentials" audit records `src/foo.ts:42` — never the token. This is enforced by the secret-scan in §2.

`write-audit-convergence.mjs` (mirrors `write-convergence-tag.mjs`; pure
functions exported for tests; main guarded; parsing is **line-oriented,
single-pass, dependency-free, and fail-closed** — dependency-free by deliberate
parity with `write-convergence-tag.mjs` and the rest of the precommit hot path,
which add NO npm deps for parsing (a markdown-AST dep like `remark`/`gray-matter`
would be new supply-chain surface on a security-sensitive git hook, codex-R3);
the fail-closed refusal of any ledger-like-but-unparseable content, NOT a lenient
best-effort parse, is what keeps a line parser safe here — an unparseable `## Round` section or a report
with zero parseable rounds REFUSES with a named reason; only the FIRST
frontmatter block counts; a duplicate managed key is a hard refusal, ADV-6/m1).
**Recognizers are tolerant of benign format variants** (lessons-aware m2 — the
mirrored `write-convergence-tag.mjs` had exactly this over-block bug fixed
post-hoc: `## Round 2 (final)` heading suffixes, table-vs-bullet ledgers), and
**every refusal message teaches the expected shape** (P18 "the refusal teaches
the shape") rather than a bare reject; variant-recognition cases are unit
fixtures. It resolves the audited repo's ROOT from `process.cwd()` /
`git rev-parse --show-toplevel` (NOT the script's own package root, so a vendored
copy validates the RIGHT tree — lessons-aware M2). It REFUSES to stamp
`converged:` unless ALL hold:

  1. **≥2 rounds** recorded (a clean first pass still needs a confirming zero-round).
  2. The **final round's `New findings this round` line is 0 AND its ledger has 0 rows** — the validator DERIVES the count from parsed rows and refuses on any mismatch with the stated line (ADV-5/m2). A `0` line above a non-empty table refuses.
  3. **Every** ledger row across all rounds carries a valid closed disposition (the enum above).
     **Unrecognized ledger-like content refuses, never counts as zero** (adversarial-R2 new-1 — the tolerant-recognizer/fail-closed seam): a line inside a round's ledger region that looks like a finding row (a table row, a `-`/`*` bullet) but does not parse into a well-formed `location | behavior | bucket | disposition` row is a REFUSAL with a teaching message, NOT silently skipped — otherwise a variant-formatted real finding in the final round parses as 0 rows and matches a stated `New findings this round: 0`. (Tolerance applies to BENIGN heading/table-vs-bullet variants that still parse; malformed content that does not parse is refused. Unit fixture for the ledger-like-but-unparseable case.)
  4. Each round carries its search-angles + surface-delta elements.
  5. The `standing-guard` XOR `exemption` field validates (below).
- **`standing-guard` resolution is jailed** (Security M3): the path is resolved, `realpath`'d, and must be CONTAINED under repo ROOT (absolute paths and `..`/symlink escapes refuse), AND must be **git-tracked or staged in this commit** (`git ls-files --error-unmatch` / staged set) — a path that merely exists in the worktree but never ships fails. An audit whose pattern is CI-expressible must leave a ratchet — the standard's own Step 5.
- **`exemption` is a closed enum, loud + tracked** (codex-1 / gemini-1 / ADV-8): one of `non-ci-expressible` | `external-system` | `one-time-human-review`, plus a non-empty rationale (length floor). The validator PRINTS the exemption text in a distinct banner on stamp/`--check` (mirrors the observe-only cross-model surfacing), and the conformance/coverage surface reports the ratchet-vs-exemption ratio across `docs/audits/` so a rising exemption ratio is a visible drift alarm.
- On success writes `converged: <ISO>` into the frontmatter and DERIVES/overwrites `rounds: <N>` from the body's `## Round` count. **Re-stamp is byte-idempotent** (Scalability M5): an existing VALID `converged:` timestamp is PRESERVED (the stamp writes only when the field is empty or the ledger no longer validates), so a re-run on an unchanged, still-valid report produces a byte-identical file.
- `--check` mode validates without stamping. It reads the **staged blob** for the sniff and the validated content (`git show :<path>` / a `--content-from -` stdin mode), never the worktree copy (Security M1 / Scalability M6 — stage-forged/worktree-clean bypass). Exit codes: `0` pass, `1` validation-failed, `2` internal-error.
- **Path traversal on the WRITE side is refused** (Security M4): the stamp target is derived strictly as `docs/audits/<jailed-slug>.md`, `lstat`-refused if a symlink; the validator is invoked from the hook via `execFileSync` argv (never string-interpolated shell).

### 2. Pre-commit gate (the structural refusal) + secret scan

`scripts/instar-dev-precommit.js` gains one step, placed **immediately after the
staged-file listing (Step 1) and BEFORE the in-scope early-exit** (Scalability
M1 / ADV-1 — an audit is a docs-only commit, so a step after the early-exit is
dead code). Trigger: `staged.some(f => /^docs\/audits\/.+\.md$/.test(f))`
(prefix-match under `docs/audits/`, `.md` suffix — covers nested subdirs and
`--diff-filter=ACMR` renames, ADV-9/m3). For each such staged file:

1. **Secret scan** (Security M5 — the legitimate hard block under signal-vs-authority's irreversible-action carve-out): the staged content is scanned for credential patterns; a match BLOCKS with a message pointing at the offending line and the "reference path+line, never quote" rule. This is the one blocking action here; committing a secret is irreversible (git history + remote push). **The pattern set lives in a pre-compile-importable home** (Integration-R2 new-2): the precommit runs BEFORE `tsc`, so it cannot import the TS scrubber modules (`src/core/durableSecretScrub.ts` etc.); the patterns are a plain-JS constant inside `write-audit-convergence.mjs` (or a sibling `.mjs`), imported by both the precommit and the CI ratchet — no compiled dependency on the hot path.
2. **Convergence validation**: if the staged frontmatter claims `converged:` non-empty, the pure check function is invoked (imported, not child-processed — cleaner failure semantics + no node-boot cost) on the STAGED content. A hand-added stamp the ledger does not earn BLOCKS. A report WITHOUT a convergence claim passes untouched (the asymmetry: the refusal targets the false claim, never the honest-incomplete state).
3. **Canonical-path-only stamp** (adversarial-R2 new-3 — makes the m5 residual ENFORCED, not merely stated): a staged `docs/**/*.md` OUTSIDE `docs/audits/` whose frontmatter carries an **`audit:` key** (the unambiguous audit-report signature) BLOCKS — a `converged:` audit stamp is legitimate only in the canonical location. The trigger is the `audit:` key, NOT a bare `converged:` (codex-R3 collision guard: `converged` is generic English and a spec frontmatter uses `review-convergence:`, so keying on `audit:` avoids false positives in unrelated docs while still catching any real audit-report stamp misplaced under `docs/investigations/` or `docs/specs/`). (Same check runs in the §3 CI ratchet over committed files.)

**Crash semantics: fail-CLOSED** (Scalability M2). A validator throw / unparseable
frontmatter / internal error BLOCKS the commit, with a message naming the
zero-cost honest escape: *remove the `converged:` line and commit the audit as
honestly-incomplete*. Fail-closed is safe here precisely because that escape
always exists — a crash-blocked commit is never a wedge, whereas a crash-passed
commit is a fake stamp in history. (This deliberately inverts the file's
prevailing fail-open default, which exists for gates whose false-positive would
sever the ability to ship; this gate has no such property.) **Validator-regression
override** (codex-R2): if a validator BUG blocks a legitimate edit to an
already-stamped report, the honest escape (drop the stamp, re-stamp after the fix)
is the first path; for an urgent block the standard `INSTAR_DEV_ALLOW_*`-style
env override the precommit already provides is the audited break-glass, so a
validator regression is never an unrecoverable wedge.

### 3. CI backstop (the merged-state re-verification)

The precommit is client-side and dodgeable (`--no-verify`, a stale worktree ~100
patches behind, a GitHub web edit). A CI ratchet test
`tests/unit/audit-convergence-reports.test.ts` (the literal path cited in the
registry edit for `ratchet` strength) runs the validator's `--check` over
**every committed `docs/audits/**/*.md` whose frontmatter claims `converged:`
non-empty**, at merged state (Security M2 / Integration M6 / ADV-4).
Grandfathering is mechanically clean: the two existing reports carry NO YAML
frontmatter at all, so a `converged:`-keyed check ignores them untouched (stated
explicitly rather than prose-only "grandfathered"); any genuine pre-gate
*stamped* report is pinned in an explicit in-source `GRANDFATHERED_AUDIT_SLUGS`
allowlist (the `GRANDFATHERED_SLUGS` precedent — extended only by PR, never
"anything older than the gate"). The allowlist keys on the report's **full
repo-relative path**, not the bare slug (adversarial-R4 minor: a slug-only key
would exempt a same-slug file at `docs/audits/<anydir>/<slug>.md` once the CI
glob covers nested subdirs — moot while the list ships empty, pinned now so a
future entry can't over-exempt). This is the layer that catches every local
dodge in one place and closes half of the bootstrap ordering games (§5). The
same CI test also enforces the canonical-path-only rule (§2 item 3) over
committed files, and refuses a `converged:`/`audit:` frontmatter key in any
`docs/**/*.md` outside `docs/audits/`.

**Auto-merge protection** (adversarial-R2 new-2 — the "extended only by PR" control
is vacuous under green-PR auto-merge, since a PR can add its own slug to the
allowlist beside a fake-stamped report and self-merge with no human eye): the
paths that ARM this gate are added to the existing `PROTECTED_PATH_PREFIXES`
array in `src/monitoring/greenPrAutomergeWiring.ts` (the same list that already
protects `.github/` and `scripts/safe-merge.mjs`), so a PR touching them routes
to operator attention instead of auto-merging. The protected set is
**`docs/audits/`, `GRANDFATHERED_AUDIT_SLUGS`, the CI ratchet test file, AND the
enforcing machinery itself — `scripts/write-audit-convergence.mjs` + its
secret-pattern sibling module** (adversarial-R4 finding-2: the existing list
protects its OWN engine — safe-merge, `GreenPrAutoMerger.ts`, `MergeRunner.ts` —
so omitting the validator would let a PR neuter the check function, update its
non-protected fixtures, and auto-merge with no human eye, rubber-stamping every
later CI run). This supplies the human-reviewer layer the shape-checks
deliberately do not (the ADV-3 depth residual): an audit-report PR gets a human
eye because it touches `docs/audits/`.

**Arm-then-push TOCTOU — deterministic bypass closed; residual timing-race
post-hoc-alarmed** (adversarial-R4 finding-1 + adversarial-R5 findings 5-A/5-B —
the load-bearing fix, corrected against the real reconciliation code):
`PROTECTED_PATH_PREFIXES` is consulted only at ARM time (`protectedPaths()`
enumerates the PR's files when the watcher decides to arm), and the default
`mergeStrategy: 'auto'` hands the merge to GitHub native auto-merge, which gates
on required CHECKS only and stays armed across later pushes. So an attacker could
open an innocuous PR → get it armed → push a fake-stamped `docs/audits/*.md` (the
CI ratchet passes it by design — form-only, residual b) → GitHub merges on green
with zero human eye.

The fix keys on GitHub's OWN armed flag, NOT the local episode (adversarial-R5
5-A — the deterministic zombie): the existing OPEN+head-moved reconciliation
branch CLEARS the local `armedAt`/`armedHead` without disarming GitHub
(reconciliation is deliberately read-only), and `gather()`'s already-armed skip
(`pr.autoMergeArmed === true`) fires BEFORE the protected-paths gate — so keying
the re-check on the LOCAL armed episode is bypassed by a two-push zombie (arm →
innocuous push clears local state → push fake audit → no local episode → no
re-check). Instead, in `gather()`: for ANY PR observed as `autoMergeArmed: true`,
RE-RUN `protectedPaths()` against the CURRENT file-list BEFORE the already-armed
skip; a protected-path hit triggers `gh pr merge --disable-auto` + routes to
operator attention. Keyed on GitHub-armed state, it fires regardless of whether a
local episode still exists.

**The predicate is FAIL-CLOSED on unknown arm-state** (adversarial-R6 fast-confirm —
the load-bearing correction): the earlier wording "drift from the arm-time head"
/ "hit not present at arm time" references an operand that DOES NOT EXIST once the
local episode is cleared — GitHub's `autoMergeRequest` carries `enabledAt` but no
arm-time head OID (`expectedHeadOid` is aspirational, ACT-1191), so a literal
"no arm-time head ⇒ no drift ⇒ skip" reopens the zombie. Rule: **an armed PR whose
arm-time protected-state is UNKNOWN (no surviving local episode / no arm-time head
OID) is treated as drifted — ANY current-file protected hit fires disarm+attention
(fail toward no-merge).** Drift-vs-arm-time is an OPTIMIZATION to spare the API
call when a local episode survives; it is never a precondition for firing.

**Disarm is UNIFORM — no operator-spare special-case** (adversarial-R7 + R8, closed
by simplification): an earlier draft spared *operator*-armed protected PRs from
disarm (to avoid "machine-overrides-human"), but that special-case spawned two
successive gaps — a missing fail-closed default on the `enabledBy` discriminator
(R7), then an alarm-free merge lane because a spared PR gets no synthesized episode
so its post-hoc alarm is structurally dead (R8). Both vanish once the spare is
removed: **a protected-path PR is not auto-mergeable regardless of who armed it —
the SAME uniform policy the existing system already applies to `.github/` and
`scripts/safe-merge.mjs` (nobody calls THAT a human override).** So the re-check
disarms ANY armed PR whose current files touch a protected path — agent- or
operator-armed alike — and routes it to operator attention. This is NOT a
machine-overrides-human violation: the human's recourse is unchanged (merge the
protected PR manually, exactly the intended protected-path flow); only the
auto-merge *convenience* is declined on protected paths, uniformly — precisely as
the existing system already declines it for `.github/` (which provides NO
"auto-merge this protected change anyway" override, and which nobody treats as a
human override). No `enabledBy` plumbing, no actor branching, no fail-open
exemption. **No disarm loop** (adversarial-R6 note): the disarm is idempotent
(disarming an already-disarmed PR is a no-op) and the attention item is deduped
per PR-episode, so an operator-armed protected PR is disarmed ONCE with one
notice, never re-disarmed every tick.

**Post-hoc alarm survives the episode-clearing window** (adversarial-R6 6-A):
the existing `merged-at-unexpected-head` detection lives in `reconcileArmed()`,
which filters `armedAt != null` — but the head-moved branch DELETES
`armedAt`/`armedHead` and nothing re-synthesizes them, so the two-push race would
merge with NO alarm (the post-hoc net is dead in exactly the variant it must
catch). Fix, code-precedented on the existing `skipped:already-armed-on-refetch`
synthesis: when `gather()`'s re-check finds a GitHub-armed PR with cleared/absent
local arm and a CLEAN (verified) protected re-check (no protected path YET),
RE-ADOPT the arm locally — synthesize `armedAt` and advance `armedHead` to the
current VERIFIED-CLEAN head — so reconciliation keeps tracking it and the
merged-at-unexpected-head alarm survives a LATER protected push. (A protected path
already present ⇒ disarm per the uniform rule above; an UNVERIFIABLE re-check ⇒
re-adopt but RETAIN the prior verified-clean head, per the three-verdict rule
below — advancing `armedHead` is safe ONLY on a verified-clean head.)

**All THREE `protectedPaths()` verdicts are pinned fail-closed** (adversarial-R9
deep-confirm — `protectedPaths()` returns `{touches:false, unverifiable:true}` on a
`gh api …/files` failure, a THIRD verdict the earlier draft left unpinned; R10
confirms the space is exhaustive — `{touches:true, unverifiable:true}` is
unconstructible): `hit` ⇒ disarm+route; `clean` ⇒ re-adopt tracking AND advance
`armedHead` to the current (verified-clean) head; **`unverifiable` ⇒ re-adopt
tracking + retry next tick, but RETAIN the last VERIFIED-CLEAN `armedHead` — NEVER
advance `armedHead` to the current unverified head, and NEVER treat it as
clean-for-merge or as a hit.** The head-retention is load-bearing (adversarial-R10):
`merged-at-unexpected-head` compares the merge head against `armedHead`, so if an
`unverifiable` re-adoption STAMPED the current (possibly already-poisoned) head as
`armedHead`, a merge there would be alarm-EXPECTED and slip un-alarmed. Retaining
the last verified-clean head means any merge at a head added during the outage is
UNEXPECTED ⇒ alarms. **A PR first observed DURING an outage (no prior verified-clean
head exists) is marked head-UNVERIFIED so ANY merge alarms** (fail-closed — never
bless an unverified head). Left unpinned, a literal `waiting`-style skip on
`unverifiable` would resurrect the alarm-dead two-push lane. (The `hit` path never
fires on `unverifiable` — an unconfirmed file-list is not a positive protected
match — so an API outage cannot mass-disarm healthy PRs either.)

**Residual timing race (adversarial-R5 5-B — stated honestly, NOT claimed
closed):** even with tracking preserved, the re-check is a poll on the
reconciliation tick (10-min default) and does not run while not-lease-holder /
busy / latch-disabled / breaker-open, while GitHub merges the instant checks pass.
A push timed just after a tick can merge BEFORE either the pre-merge re-check OR
the post-hoc reconcile fires — the post-hoc alarm (now kept alive by re-adoption)
narrows this to the sub-tick window but does not eliminate it. The definitive
pre-merge closure is GitHub-side head-pinning at merge time
(`expectedHeadOid`/`--match-head-commit` proven to refuse a moved-head auto-merge)
— the code demonstrably does not assume that today; pinning it is tracked as a
green-PR-auto-merge follow-up <!-- tracked: ACT-1191 -->.

**Layered guarantee — what is deterministic vs best-effort (the honest bound, so
the post-hoc corners are a bounded residual, not an open-ended hunt):**
- **DETERMINISTIC (load-bearing):** the pre-merge `gather()` re-check disarms any
  armed protected PR, fail-closed across all three `protectedPaths()` verdicts —
  this closes the deterministic arm-then-push bypass on the reconciliation tick
  boundary.
- **DETERMINISTIC (independent, merged-state):** the §3 CI ratchet re-validates
  every committed `converged:`-claiming report — it catches an UNEARNED stamp
  (hand-added / wrong ledger) regardless of HOW the PR merged. (It does NOT catch a
  form-VALID *fabricated* ledger — that is the acknowledged ADV-3 residual (b/c),
  which the shape checks raise the cost of and the human-eye routing catches in the
  common case, not this TOCTOU layer.)
- **BEST-EFFORT (defense-in-depth):** the post-hoc `merged-at-unexpected-head`
  alarm + re-adoption. Under sufficiently adversarial conditions — a merge inside
  the sub-tick window, OR a sustained `gh api` outage — the post-hoc alarm is
  narrowed but NOT guaranteed; the definitive pre-merge closure for that whole
  class is GitHub-side head-pinning (ACT-1191). The spec does NOT claim post-hoc
  airtightness; a further outage/timing corner of this layer is within this
  acknowledged ACT-1191 residual, not a new guarantee-breaking hole.

(This whole subsection is a correctness hardening of an existing guard this spec
depends on — NOT a rollout-ladder flip of the green-PR feature; its enabled/dark
state is unchanged.)

### 4. Registry + skill + default-route delivery

- **Registry:** the standard's `**In practice.**` line gains guard citations
  with the EXACT literal backticked forms the StandardEnforcementExtractor +
  `classifyFileGuard` require (Integration M4 / lessons-aware m3 — the extractor
  scans only the `**In practice.**` / `**Applied through.**` lines, and its
  `ENFORCEMENT_PATH_PREFIXES` does NOT include `skills/`): cite
  `` `scripts/instar-dev-precommit.js` `` (base contains "precommit" → grades
  **`gate`**) and `` `tests/unit/audit-convergence-reports.test.ts` `` (a
  `*.test.ts` → grades **`ratchet`**, matching the standard's own
  `no-silent-llm-fallback` worked example). `` `scripts/write-audit-convergence.mjs` ``
  is cited too but grades only `lint` (generic `scripts/`), so it is NOT relied
  on for the classification; the SKILL.md path is NOT cited (it would not resolve
  — `skills/` is outside the prefix set). Net: the standard classifies **ratchet**
  (its strongest verified guard), a real upgrade from `documented-only`. **The
  citation prose is worded to the honest scope** (§scope honesty): a `converged:`
  claim in a canonical audit report is form-verified + CI-re-checked; it does NOT
  claim all audits are so routed, nor that the stamp proves the sweeps ran. The
  m1 exemption-class reasoning (the gate's blocking authority is the documented
  Signal-vs-Authority exemption, not a violation — closed-world format invariant
  at a dev-process chokepoint, FD12 precedent) is recorded in this edit so the
  exemption stays argued, not assumed. (Registry RULE text is operator-ratified
  and unchanged; only the `**In practice.**` guard-citation prose is edited.)
  **Load-bearing location:** `write-audit-convergence.mjs` stays at top-level
  `scripts/` (NOT `skills/spec-converge/scripts/` where its sibling lives) so it
  remains auditor-visible.
- **Skill — single-sourced to close the three-copy drift** (Integration M3 /
  lessons-aware M1, both grounded: `src/commands/init.ts` `installBuiltinSkills`
  embeds an inline copy that has ALREADY diverged from the repo file). The skill
  content becomes ONE exported constant consumed by (a) the on-disk
  `skills/iterative-converging-audit/SKILL.md`, (b) the `installBuiltinSkills`
  scaffold path in `init.ts` (new agents), and (c) a `PostUpdateMigrator`
  skill-content migration (existing agents) whose stale-fingerprint is authored
  against the CURRENT INLINE-installed content (not the repo file) so it actually
  fires on deployed agents. Two guarding tests (Integration-R2 M3): one proving
  the migration triggers on a fixture installed from the current inline template,
  and a **parity assertion that the on-disk `skills/iterative-converging-audit/SKILL.md`
  content equals the exported constant** — closing the repo-file↔constant
  two-copy residual (leg (a)) so the exact drift bug this fix exists to prevent
  cannot recur unguarded. The skill text: the ledger
  IS the canonical `docs/audits/<slug>.md` file from §1; Step 4's completion claim
  runs the validator to stamp; the stamp is the only honest way to say
  "converged" — and (per the fleet-vs-repo split below) it says so ONLY where the
  validator is present.
- **Default route to every agent** (Agent Awareness + Migration Parity): a
  CLAUDE.md template section — *"Audits run to convergence (the default route)"*:
  any audit-shaped task runs as the converging loop with the canonical report; a
  single-pass audit is INCOMPLETE by definition and must be reported as such —
  added to `generateClaudeMd()` + `migrateClaudeMd()` via a shared exported
  section constant (single source, consumed by both) with the literal heading
  `Audits run to convergence (the default route)`, tracked in the
  feature-delivery-completeness guard's `legacyMigratorSections` list — the
  `SESSION_LISTING_HYGIENE_CLAUDEMD_SECTION` precedent for an interpolated shared
  constant. (Integration-R2 new-3 precision: that list asserts the heading is
  present in the migrator source, not a both-sources parity check — the
  single-sourced constant is what actually prevents drift; the guard entry is the
  tracking, not the anti-drift mechanism.) Plus the
  `migrateFrameworkShadowCapabilities` markers so Codex/Gemini agents learn it
  too. The section stays PROPORTIONATE (lessons-aware m6): trigger + one-line
  pointer to the skill for the loop mechanics — a trivial "quick check X" ask is
  NOT ceremonialized into a repo report.
  **"Audit-shaped" boundary, frontloaded** (Decision-Completeness G3): a **SWEEP
  over a surface** (find-all-X, security sweep, compliance/coverage check,
  "review everything of kind K") IS an audit; a **single-artifact review** (one
  PR, one document, one function) is NOT. The section states this line so the
  default-route rule has a decidable boundary.
- **Fleet-vs-repo split, frontloaded** (Decision-Completeness G1 — the one real
  mid-build decision, decided here): the **process discipline** (run audits as
  the converging loop; single-pass = incomplete; use the canonical report shape)
  ships to EVERY agent via the template/skill — it needs no binary. The
  **machine STAMP + precommit gate + CI lint** live in the instar source repo
  (and any repo that vendors `write-audit-convergence.mjs`). The skill/template
  text says so explicitly: on a repo WITHOUT the validator, an agent still writes
  the canonical report and self-checks against the shape, and marks the report
  `converged:` only after running the validator where it exists — it does not
  fabricate a machine stamp it cannot earn. This is the honest scope of "every
  agent," stated rather than implied.

### 5. Bootstrap / self-application clause (the audit about to run)

The motivating directive is "make the process enforced BEFORE the next audit."
Ordering games (run the LLM-decision audit before this gate merges; commit its
report from a stale worktree; route it outside `docs/audits/`) would let the very
audit that motivated this spec converge on one shallow pass (ADV-2). Binding
clause: **the first audit run under this directive (the LLM-decision
accountability audit) MUST use the canonical `docs/audits/<slug>.md` format and
be stamped by running `write-audit-convergence.mjs` manually — recording the
run — even if the precommit gate PR has not yet merged; and its report may not
merge before or without this gate.** The CI lint (§3) enforces the "not without
the gate" half at merged state regardless of which worktree authored it.

### 6. The spec-review half: flip the existing Part-B switch (dev agent) — at the read-point that actually fires

`specReview.requireConvergenceReport: true` for this development agent — the
already-approved spec #4 report-backed gate for SPEC reviews, shipped dark.
Flipping it here is spec #4's own dev-first rollout, not new design. **This is a
BUNDLED-BUT-SEPARABLE dependency, not central to the audit design** (codex-R7): it
governs SPEC reviews, whereas §§1–5 govern AUDIT reports; it is included here
because this run exercises spec #4's rollout, and it may be split into its own
implementation step without affecting §§1–5. Acceptance criterion: after the flip,
a spec-review commit on this dev agent requires the convergence report (the
existing spec #4 behavior), verified independently of the audit-report gate.
**Two read-point corrections make the flip real** (Integration M2, both grounded):

- **Worktree read-point.** `.husky/pre-commit` probes `./.instar/config.json`
  relative to the checkout, but `instar worktree create` does not seed that file
  into a worktree — and the Worktree Convention mandates all dev commits happen
  in worktrees, so flipping the agent-home config delivers nothing where commits
  occur. Fix (pinned): the husky probe resolves the MAIN checkout root via
  `git rev-parse --git-common-dir` (worktree → main checkout, where the live
  `.instar/config.json` sits) before falling back to the local paths — fail-open
  preserved. This is the load-bearing change; without it Part 6 is a no-op.
- **Every-machine.** The config is per-machine and Echo is multi-machine, so the
  flip lands on EVERY machine of the dev agent, not just one. (This flag governs
  a dev-process gate, not runtime behavior, so it is not added to the
  machine-coherence compared-flags set — noted so the divergence is a recorded
  decision, not an oversight.)

## Alternatives considered (codex-5)

- **CI status checks / GitHub issue templates / workflow artifacts as the substrate.** Rejected as the PRIMARY mechanism: the audit artifact must be a first-class, diffable, git-replicated repo object that the StandardsEnforcementAuditor and human readers already consume as markdown; a CI-only signal isn't present at author time (the precommit is where the false claim is cheapest to stop) and isn't a durable repo artifact. CI is used as the BACKSTOP (§3), not the substrate.
- **A SARIF-style structured findings format.** Rejected for the ledger: SARIF is tuned for tool-emitted static-analysis results, not human/agent audit reasoning with per-round dispositions and accepted-risk decisions; markdown+frontmatter matches the existing spec-convergence + `docs/audits/` precedent and stays human-readable.
- **Signed attestations / build-provenance (SLSA-style) / an append-only signed decision log** (codex-R2). Rejected: the artifact must be a human- and agent-readable markdown object that reviewers and the StandardsEnforcementAuditor already consume in-tree; cryptographic attestation adds key-management + tooling for a claim whose residual is *substance* (a signed shape is still just a shape — §scope honesty), which signing does not close. The `converged:` stamp + the CI ratchet + git history already give tamper-evidence at the granularity that matters here.
- **A workflow/state-machine engine.** Rejected per the same reasoning the Self-Heal standard uses — no new external engine; the converging loop is a thin declaration + a validator over existing git/precommit/CI primitives.

## Decision points touched

- `write-audit-convergence.mjs` stamp refusal — `invariant`: an enumerable-domain deterministic check (rounds ≥2, final-round-zero cross-checked against rows, closed-enum dispositions, jailed+tracked standing-guard, closed-enum exemption, fail-closed parse); a false "converged" claim is never a judgment call.
- Pre-commit convergence gate — `invariant`: the same check at the commit chokepoint on staged bytes; refuses only the unearned claim.
- Pre-commit secret-scan hard block — `invariant`: a safety guard on an irreversible action (committing a credential), the documented Signal-vs-Authority carve-out where a deterministic gate legitimately blocks.
- CI convergence lint — `invariant`: merged-state re-verification of the same deterministic checks.
- Green-PR auto-merge protected-path re-check + uniform disarm (audit-report PRs) — `invariant`: a deterministic path-membership test (does the current file-list touch a protected prefix?) keyed on GitHub's armed flag, fail-closed on unknown arm-state; no competing signals are weighed.
- No `judgment-candidate` points: nothing here weighs competing signals; the CONTENT quality/depth of an audit stays with the auditor and its reviewers (stated as a residual, not a gate).

## Non-goals

- No runtime behavior change anywhere (scripts, docs, skill text, template
  sections, a CI test, one dev-agent config flag).
- No retro-validation of historical audits — grandfathered via the explicit
  in-source allowlist (§3); the gate applies to reports claiming convergence from
  the allowlist boundary forward, and the registry classification is honest about
  that boundary.
- No new server routes or background actors (zero capacity-safety surface).
- Does NOT force audits to EXIST or be routed to `docs/audits/` in the first
  place (the honest residual, §Problem statement); does NOT make a shallow
  well-formed audit genuinely deep (the ledger validates form, not substance —
  §scope honesty). What IS now enforced: a `converged:` stamp is refused ANYWHERE
  outside `docs/audits/` (§2 item 3 + §3), and a well-formed audit-report PR is
  routed to a human reviewer via auto-merge protection — at arm time, and via a
  `gather()` re-check keyed to GitHub's `autoMergeArmed` flag (fail-closed on
  unknown arm-state) so the DETERMINISTIC arm-then-push bypass is closed, with the
  local arm RE-ADOPTED on a clean re-check so the post-hoc `merged-at-unexpected-head`
  alarm survives the episode-clearing window (§3, adversarial-R5 5-A + R6 6-A). The
  narrow SUB-TICK timing race against GitHub native auto-merge is NOT claimed
  closed: it is narrowed and caught POST-HOC by a loud attention item naming the
  protected path — pending GitHub-side head-pinning (ACT-1191). So the residuals
  are: the sub-tick race (post-hoc-alarmed) and "an audit declared done verbally
  with no report at all" (which no in-repo gate can reach).
- Does NOT replace the spec-review convergence gate (spec #4) — separate
  validators because the artifacts differ (spec + reviewer counts vs audit ledger).

## Multi-machine posture

Two distinct surfaces, declared separately (Integration M5, contested both
directions against the closed taxonomy):

- **Validator / precommit gate / CI lint / audit report — `unified` (via git).**
  These are git-tracked repo artifacts (and `.husky/` rides the same tree);
  git itself replicates them to every checkout on every machine. This is NOT
  machine-local — declaring machine-local here would be the exact
  declared-but-wrong inversion Standard A warns about. No justification marker
  needed; the default `unified` posture is satisfied by git.
- **`specReview.requireConvergenceReport` — machine-local, justified.** This is
  genuinely per-machine (`.instar/config.json` per machine). Justification marker
  (verifiable ref = the merged, operator-approved spec #4 "report-backed
  converging audit" whose dev-first rollout ladder this flip executes):

  machine-local-justification: operator-ratified-exception — merged in commit 742723fc4 (PR #1052)

  Per §6 it lands on every machine of the dev agent, so "machine-local" is the
  config's storage locality, not a per-machine behavior divergence.

## Rollback

Revert the PR (scripts + CI test + docs are self-contained). **Full reversal of
the fleet-delivered text** (the CLAUDE.md section + skill content already
migrated onto agents) requires a REMOVAL migration in `PostUpdateMigrator`
(Decision-Completeness G7) — a plain source revert leaves the migrated
instructions on already-updated agents; the rollback path names that removal
migration. The config flag flips back per-agent. No data migration; committed
audit reports remain valid markdown either way.

## Tests

- Unit (validator): stamp refused on — 1 round / non-zero final round / final-round
  line-vs-rows MISMATCH / open-or-unknown disposition / empty `fixed`/`accepted`/`deferred`
  ref / missing search-angles-or-surface-delta / standing-guard that is
  absolute-path / `..`-escape / symlink / untracked-but-present / missing
  exemption rationale / duplicate `converged:` key / unparseable round (fail-closed)
  / basename≠slug / bad slug charset; stamp GRANTED on the compliant fixture;
  **byte-idempotent** re-stamp (second run identical); the `--content-from`/staged
  path validated (not worktree); crash-path (throw) ⇒ exit 2 / block.
- Precommit path: staged fixture with unearned `converged:` blocks; staged-forged
  + worktree-clean blocks (staged-blob read); secret in staged audit report
  blocks; honest-incomplete report passes; compliant stamped report passes;
  docs-only commit exercises the pre-early-exit placement.
- CI lint: a committed report with an unearned stamp fails the lint; a
  grandfathered slug passes; a compliant one passes; a `converged:`/`audit:` key
  in a `docs/**/*.md` outside `docs/audits/` fails (canonical-path-only).
- Ledger-parse seam: a round whose final ledger has finding-shaped-but-unparseable
  content (a variant the row-recognizer skips) REFUSES rather than reading 0 rows
  (adversarial-R2 new-1 fixture).
- Auto-merge protection: assert `docs/audits/`, the allowlist, the ratchet test
  file, AND `scripts/write-audit-convergence.mjs` + its pattern module are in
  `PROTECTED_PATH_PREFIXES` (adversarial-R2 new-2 + R4 finding-2).
- Arm-then-push TOCTOU (the load-bearing tests for the ADV-3 human-eye routing):
  (1) a head that gains a protected path after arm, with a live local episode,
  triggers `--disable-auto` + attention (adversarial-R4 finding-1); (2) THE
  TWO-PUSH ZOMBIE — arm on an innocuous PR, an innocuous push that CLEARS the
  local episode, then a push adding a fake-stamped `docs/audits/*.md`: the
  `gather()` re-check keyed on GitHub `autoMergeArmed` still fires `--disable-auto`
  + attention with NO local episode present (adversarial-R5 5-A); (2b) FAIL-CLOSED
  PREDICATE — an armed PR with NO surviving local episode and NO arm-time head OID
  whose CURRENT files touch a protected path fires disarm+attention (must NOT skip
  for "no drift detectable" — adversarial-R6 fast-confirm); (2c) UNIFORM DISARM —
  an OPERATOR-armed protected-path PR is ALSO disarmed + routed (no operator-spare;
  the same policy already applied to `.github/`), so there is no alarm-free
  exemption lane (adversarial-R7 + R8 — the spare was removed by simplification);
  (3) RE-ADOPTION KEEPS THE ALARM ALIVE — after the
  cleared-episode innocuous push (still-CLEAN re-check), `gather()` re-synthesizes
  `armedAt`/`armedHead`, so a subsequent moved-head raced merge of a protected path
  DOES raise the `merged-at-unexpected-head` attention item (adversarial-R6 6-A —
  without re-adoption this alarm is dead in the two-push variant); (3b) UNVERIFIABLE
  FAIL-CLOSED — when `protectedPaths()` returns `unverifiable` (API failure) for a
  cleared-episode armed PR, `gather()` STILL re-adopts tracking but RETAINS the
  last verified-clean `armedHead` (never advances to the current unverified head),
  so a merge at a head added during the outage is UNEXPECTED and ALARMS
  (adversarial-R9 + R10 — a sustained file-list outage must neither resurrect the
  alarm-dead lane NOR bless a poisoned head as expected); (3c) NO-PRIOR-CLEAN-HEAD —
  a PR first observed during an outage (no verified-clean head on record) is marked
  head-unverified so ANY merge alarms (adversarial-R10 — never bless an unverified head).
- Parity: the new CLAUDE.md section tracked in the feature-delivery-completeness
  guard (template + migrator + shadow markers).
- Conformance: after the registry edit, assert (via the StandardsEnforcementAuditor
  unit-test harness pattern) that the standard resolves its named citations and
  classifies **ratchet** (not merely better than `documented-only`).
- Skill single-source: (a) a unit test proving the `PostUpdateMigrator` skill
  migration FIRES on a fixture installed from the current `installBuiltinSkills`
  inline template (Integration M3 / lessons-aware M1 — the stale-fingerprint must
  match inline-installed content, not the repo file); (b) a parity assertion that
  the on-disk `skills/iterative-converging-audit/SKILL.md` equals the exported
  shared constant (Integration-R2 M3 leg (a) — repo-file↔constant drift guard).
- Precommit meta-tests: the existing `tests/unit/instar-dev-precommit-*.test.ts`
  sandbox fixtures are re-run/updated so a sandbox commit that stages
  `docs/audits/` paths neither trips nor dodges the new step unexpectedly
  (lessons-aware m4 — recent gate additions broke these meta-tests twice).

## Open questions

*(none)*
