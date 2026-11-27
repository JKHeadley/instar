# Side-Effects Review — safe-merge reads the real approval when reviewDecision is empty

**Slug:** safe-merge-ruleset-code-owner-approval
**Tier:** 1. Size: 8 code/test files, about 130 lines. Effort: no spec, three second-pass reads (the first found the same defect in the watcher, now fixed here; the second corrected this artifact).

## Summary of the change

`reviewPrecheck` in `scripts/safe-merge.mjs` refused every code-owned PR whose GraphQL `reviewDecision` was not APPROVED. GitHub returns null for it when the code-owner requirement comes from a ruleset, so an approved PR was refused (#2812, fb-694c7d08-aa8). New `codeOwnerApprovedAtHead` in `scripts/local-verify-floor.mjs`: an empty decision falls through to the REST reviews, and passes only if each owned file has a named owner whose latest review approves the pinned head. `fetchCodeOwnedFiles` became `fetchCodeOwnership`, returning rules and files; `fetchReviews` is new. The green-PR watcher had the same hold (`GreenPrAutoMerger`, `co.touches && reviewDecision !== 'APPROVED'`), which also told the operator a PR was waiting for a review already given. `codeOwnedPaths` in `greenPrAutomergeWiring.ts` now sets `ownerApproved: true` through the same function, and the watcher passes on it.

## Decision-point inventory

- `reviewPrecheck` code-owner step (a pre-merge check): modified, narrower refusal.
- GitHub's ruleset enforcement at merge: unchanged, remains the authority.
- `GreenPrAutoMerger` code-owner hold: modified, same narrowing. Its later `reviewPrecheckPasses` call has no ownership input and is unchanged. On the local floor safe-merge's precheck runs again at merge. On the actions floor `--auto` skips `reviewPrecheck`, so GitHub alone is the act-time check there.

## 1. Over-block

Team owners never count, so a PR owned only by a team and approved by a member is still refused here when the decision is empty. Same as today, and instar's CODEOWNERS names one person. No new over-block.

## 2. Under-block

A pass can be wrong only if GitHub disagrees with this reading, for example a stale-approval rule this code does not model. GitHub then refuses the merge call, and `mergeAndConfirm` handles that refusal as it does today. Self-approval by a pusher who is the code owner is also GitHub's to refuse. Nothing here adds a way past GitHub: the agent's token cannot bypass the ruleset (`current_user_can_bypass: never`). The local floor merges with neither `--auto` nor `--admin`.

## 3. Level-of-abstraction fit

Correct layer: the wrong read is in this precheck. It reuses `approvedAtHead`, shared with the feedback executor, and `parseCodeowners`, shared by safe-merge and the watcher. The feedback executor has its own CODEOWNERS parser, untouched here. `reviewPrecheckPasses` stays pure and unchanged.

## 4. Signal vs authority compliance

Complies. The precheck is a courtesy signal in front of GitHub's own enforcement. The change is a structural read of review records, not a brittle authority: it can only remove a false refusal.

## 4b. Judgment-point check (Judgment Within Floors standard)

No competing-signals decision is added. Whether an owner approved a head is a fact read from a record.

## 5. Interactions

`refuseApprovalRequired` still fires, and still requests review, when the check fails. Both `reviewPrecheck` callers wrap it in try/catch: an unreadable review list throws and refuses as `refused:contexts-unverifiable`. The `--auto` path does not call `reviewPrecheck` before `mergeAndConfirm`; that is unchanged here, and its Actions wait is a separate item in fb-694c7d08-aa8. Reviews are fetched only when the decision is empty, so a stated decision costs no extra call.

## 6. External surfaces

One extra GitHub REST read in the empty-decision case. One operator-visible change: for a code-owned PR already approved at its head, the watcher no longer shows "it waits for your code-owner review" or records a `code-owner-review` snapshot entry, so that false wait stops appearing. No change for other agents.

## 6b. Operator-surface quality (Operator-Surface Quality standard)

Not applicable: no dashboard renderer, approval page or form is edited. The watcher's waiting notice keeps its wording and simply stops firing when the approval is already in (section 6).

## 7. Multi-machine posture (Cross-Machine Coherence)

safe-merge is a stateless CLI. The watcher keeps its existing per-machine state and adds none: the new value is computed on each tick from GitHub, the shared source, so machines agree without replication.

## 8. Rollback cost

Plain revert. No data, no migration, no agent state.

## Conclusion

Clear to ship. Removes a false refusal without touching what GitHub enforces.

## Second-pass review (if required)

**Reviewer:** independent general-purpose subagent, three reads
**Independent read of the artifact: concur**

First read found the same false hold in the green-PR watcher, now fixed in this change. Second read found no fault in the code and corrected five artifact claims. Third read checked each correction and concurs. Its caveats: with the non-default `mergeStrategy: 'admin'` the actions floor does run `reviewPrecheck`, which is harmless, and it did not itself rerun the #2812 replay.

## Evidence pointers

- `tests/unit/safe-merge-local-floor.test.ts`, `safe-merge-hardening.test.ts`, `green-pr-automerge-wiring.test.ts`, `green-pr-local-floor.test.ts`: both sides of the boundary.
- Replay on #2812's real CODEOWNERS, files and reviews: true at 6c4c2a700, false at 4f6c6f089.

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect — not applicable.
