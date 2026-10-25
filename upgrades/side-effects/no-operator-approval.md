# Side-Effects Review — operator approves constitution changes only; flagged merges need an independent review

**Version / slug:** `no-operator-approval`
**Date:** `2026-10-22`
**Author:** `echo`
**Second-pass reviewer:** `independent reviewer subagent, two rounds — concur`

## Summary of the change

Operator directive (Justin, 2026-10-22 08:58 PDT): "Why am I having to approve these? I should ONLY have to approve constitution changes." GitHub already enforces that through `.github/CODEOWNERS` (the two constitution paths) and the ruleset's code-owner review. This change removes the merge machinery's own operator approvals and replaces them with a machine-checkable independent second-pass review.

- `scripts/lib/instar-dev-trace.mjs` (new, + `.d.mts`): the ONE trace judge — completeness, coverage, artifact sha, concurring second pass. `scripts/instar-dev-precommit.js` now uses it for its own coverage/completeness/sha checks (behaviour unchanged).
- `src/localVerify/orchestrator.ts`: for a flagged record (harness-changing, protected-path, skips-added, tests-removed) the verifier computes the flagged paths and looks for a trace the PR adds or modifies, reading it and its artifact from the HEAD's tree; a concurring trace covering every flagged path is stored as `record.independentReview = { trace, concurred: true }` (`record.ts` validates it; `harnessClassifier.ts` gains `protectedPathMatches` / `harnessReasonPaths`).
- `scripts/safe-merge.mjs`: the local-floor predicate refuses a flagged record without it as `refused:needs-independent-review`; the operator-approval read (PR reviews), the executor-status read and `approverAcceptanceFromExecutorStatus` are removed. `approvedAtHead` stays in `local-verify-floor.mjs` (the feedback executor uses it); the review precheck is unchanged.
- `src/localVerify/statusProjection.ts`, `StatusReconciler.ts`, `reconcilerSeams.ts`, `localVerifyWiring.ts`, `src/commands/server.ts`: the projection pends `awaiting-independent-review` instead of `awaiting-operator-approval` / `approver-dependent`; the review and executor-status reads that only served it are removed.
- Watcher (`GreenPrAutoMerger.ts`, `greenPrAutomergeWiring.ts`, `greenPrLogic.ts`, `src/server/stopGate.ts`): protected-path PRs are no longer routed to the operator. Only PRs touching a CODEOWNERS-owned file (read at runtime from the base branch on GitHub; `parseCodeowners` / `codeOwnedFiles` in `local-verify-floor.mjs`) wait, until GitHub reports `APPROVED`. The protected list is kept only as the same independent-review requirement: on the local floor via the record; on the actions floor the watcher reads the trace + artifact at the head ref itself with the same judge. `refused:needs-independent-review` is terminal for that head (no ladder, no attention item, no re-spawn until the head moves).
- `scripts/safe-merge.mjs` (folded-in fix, coordinator request): right after a push `gh pr checks` can exit non-zero with empty stdout and stderr "no checks reported on the '<branch>' branch" (PRs 2296, 2314). `parseChecksRows` now reads that as zero rows; `classifyChecks` treats zero rows as NOT settled (`noChecks`), so the wait continues within the deadline and ends `refused:checks-timeout` (`noChecksReported: true`), never green. Any other empty/unparseable answer keeps the retry-then-`contexts-unverifiable` path, now with gh's stderr (first 200 chars) in the detail.
- Second-pass fixes: the review is bound to the head (no flagged path changed after the trace's last commit, checked through the verifier's git funnel; the watcher does the same through the compare API); a missing `artifactSha256` is `artifact-sha-missing`; the artifact's `## Second-pass review` `**Reviewer:**` line must name a reviewer (empty / placeholder / "pending" refuses); `extractRulesetReviewPolicy` reads `require_code_owner_review`, and safe-merge refuses a code-owned PR that is not `APPROVED` with the review link (`refused:approval-required`, via `code-owner-review`).
- `src/core/PostUpdateMigrator.ts`: the Green-PR CLAUDE.md section is re-synced (new marker `needs-independent-review`).
- Specs amended: `docs/specs/local-verify-merge-authority.md` (+ ELI16), `docs/specs/green-pr-automerge-enforcement.md` (+ ELI16).

## Decision-point inventory

- local-floor admission of a flagged record (safe-merge `evaluateLocalPredicate`) — modify — operator approval + Decision 16 acceptance → recorded independent review.
- status projection of a flagged record — modify — same rule, pending reason renamed.
- verifier classification (orchestrator `classify`) — modify — additionally records `independentReview`.
- watcher protected-path gate — modify — was operator routing; now CODEOWNERS wait + (actions floor) independent review.
- Decision 16 approver acceptance in local-verify — remove.
- safe-merge checks settle (`classifyChecks`) — modify — zero rows is not settled (was: settled, i.e. vacuously green had parsing allowed it).
- pre-commit trace validation — pass-through (refactored onto the shared judge, no behaviour change).

---

## 1. Over-block

- A flagged PR whose trace was written correctly but whose `coveredFiles` omits a non-in-scope flagged file (e.g. `vitest.config.ts`, `tsconfig.json`, `.github/workflows/*`, a changed test file under the skip ratchet): refused until the trace lists them. Precommit only requires in-scope files (`src/`, `scripts/`, …), so authors must pass the flagged files to `--files` explicitly. Stated in the spec; the refusal names the uncovered paths.
- A classification read failure leaves the flagged paths unknown, so no trace can count; it needs a re-verify (previously the operator could approve past it).
- Traces are gitignored; the PR must force-add its trace (as 220 tracked traces already are).

- A PR whose checks never register within the deadline now ends `checks-timeout` instead of `contexts-unverifiable` (same refusal class, clearer name).

## 2. Under-block

- **The concurrence is self-attested.** The pre-commit hook does NOT check `secondPass` or `reviewerConcurred` (it checks completeness, coverage and the artifact sha only), and the artifact's `**Reviewer:**` line is written by the same agent. So the trace records a claim that a second pass concurred, not proof that a different reviewer ran. The verifier makes the claim explicit, head-bound, path-covering and auditable; it does not make it unforgeable. That is acceptable under the spec's threat model (trusted principals; the design stops the accidental case, not deliberate tampering), and it is the trade the directive asks for.
- Head binding is by commit history, not content hash: the review counts only if no flagged path changed after the trace's last commit (`git log <traceLast>..<head> -- <flagged>` empty; on the actions floor, the compare API). A push that re-edits a flagged file therefore needs a new trace.
- On the actions floor `.github/**` PRs now merge with a concurring trace instead of the operator's eyes (the round-5 hollow-context concern is answered by the second pass, not removed).

## 3. Level-of-abstraction fit

The judge is a pure detector shared by three readers; authority stays where it was (safe-merge's predicate on the local floor, GitHub's required status, the watcher's candidacy). No parallel gate is added; the operator-approval branch is replaced in place.

## 4. Signal vs authority compliance

- [x] No — this change has no new brittle authority: it replaces one deterministic admission precondition (an approval on the head) with another (a concurring trace in the head tree). Both are structural preconditions on objective artifacts, the established pattern for merge gates.

## 4b. Judgment-point check

No new static heuristic at a competing-signals decision point: admission of a flagged record is an invariant (enumerable precondition), not a judgment between live signals.

## 5. Interactions

- **Shadowing:** the review precheck (GitHub's own required review) still runs before the local floor; CODEOWNERS-owned PRs still report `refused:approval-required` if attempted. The watcher waits for `APPROVED` first, so it does not spawn a doomed merge.
- **Double-fire:** none — the watcher no longer posts an operator line for protected paths; only the code-owner line.
- **Races:** a trace pushed after the verified head is a new head → new record; the watcher's terminal-for-head memory clears when the head moves.
- **Feedback loops:** `refused:needs-independent-review` no longer burns ladder attempts, so no give-up attention item is raised for it.
- The feedback executor's own approver-acceptance (its PRs) is untouched.

## 6. External surfaces

- GitHub: one extra contents read per watcher candidate (CODEOWNERS at base) and, on the actions floor only, trace/artifact reads for protected-path PRs.
- The `instar/local-verify` status description for a flagged record now reads `awaiting-independent-review · …`.
- Agents: the CLAUDE.md Green-PR section is re-synced by migration.
- Operator surface: one fewer approval class; the only remaining operator action is GitHub's own code-owner review (a link). No new operator actions.

## 6b. Operator-surface quality

No operator surface (dashboard/approval page) touched — not applicable.

## 7. Multi-machine posture

Machine-local by design, unchanged: records live in the lease holder's index; the watcher runs on the lease holder; the trace is read from git/GitHub, so every machine reads the same evidence. No new notices, durable state or URLs.

## 8. Rollback cost

Pure code + docs. Revert and ship a patch. Records written with `independentReview` validate under old code too (unknown fields ignored by the old validator). No migration to undo beyond the CLAUDE.md wording (re-synced again by a revert's own migration marker).

## Conclusion

The directive is implemented structurally: no merge path asks the operator for anything except GitHub's code-owner review of the constitution. The main residual is that the second pass is self-attested; it is now head-bound, path-covering and auditable instead of an operator click. Clear to ship once the second pass concurs.

- **Traces now ship with the commit.** `.instar/instar-dev-traces/` is gitignored, so before this change a trace only reached a PR when the author remembered `git add -f`; under the new rule a flagged PR whose trace was not committed would be refused forever. `write-trace.mjs` now stages its own trace (`git add -f`, additive; a failure prints the exact command to run). Tested both sides in `tests/unit/write-trace-tier.test.ts`.

## Second-pass review (if required)

**Reviewer:** independent reviewer subagent (two rounds)
**Independent read of the artifact: concur (after fixes)**

Round 1 raised: the recorded review was not bound to the reviewed content, so a flagged file edited after the second pass still merged on the old trace (now: no flagged path may change after the trace's last commit — verifier via git log, watcher via the compare API); a missing artifact sha skipped the check (now refused); the artifact's own Reviewer line was never read (now must be filled); safe-merge ignored `require_code_owner_review` and would try a merge GitHub refuses (now refuses with the review link); the spec did not say the actions floor has only protected-path flags (now stated); the artifact overstated what the pre-commit hook guarantees (now: concurrence is self-attested). Round 2 verified each fix and concurred, with one residual: GitHub's compare lists at most 300 files, so a longer list could hide a flagged path — now treated as unverifiable (`review-binding-truncated`), tested both sides.

## Evidence pointers

- Targeted tests (groups of ≤5): `tests/unit/safe-merge-latest-run.test.ts` (no-checks-reported both sides), `tests/unit/instar-dev-trace.test.ts`, `safe-merge-local-floor.test.ts`, `localVerify/{orchestrator,statusProjection,StatusReconciler,record,harnessClassifier}.test.ts`, `green-pr-{automerger,local-floor,automerge-wiring,layer2,red-watchdog}.test.ts`, `PostUpdateMigrator-mergeRunnerAutoArm.test.ts`, precommit tests, `tests/integration/{safe-merge-local-floor,local-verify-routes,green-pr-automerge-routes}.test.ts`, `tests/e2e/local-verify-lifecycle.test.ts`.

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect — not applicable (an operator-directed policy change, not a defect fix; no new self-triggered controller — the watcher's existing tick is unchanged and the new refusal reduces its spawns).
