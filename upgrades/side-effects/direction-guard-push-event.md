# Side-Effects Review — the direction guard reads the operator's approval on push, not only on the PR

**Version / slug:** `direction-guard-push-event`
**Date:** `2026-08-23`
**Author:** `Echo (claude-opus-5)`
**Second-pass reviewer:** `independent subagent (general-purpose) — CONCERN, six findings, five fixed in this change; see Second-pass review below`

## Summary of the change

The direction guard's path-B evidence-gathering step in `.github/workflows/ci.yml` shipped gated `if: github.event_name == 'pull_request'`. On a push to `main` it therefore never ran, `STANDARDS_DIRECTION_REVIEW_FILE` was never written, and `scripts/standards-coverage.mjs` read the resulting ENOENT as "review unavailable" and refused — demanding a ratification the operator had already given on the pull request that produced that exact commit. The step now runs on both events; on a push it resolves the pull request whose merge produced the commit (matching `merge_commit_sha`, not list position) and feeds that PR's head sha and reviews to the same unchanged `evaluateOperatorReviewApproval`. `scripts/standards-coverage.mjs`'s Root self-wiring pin follows the step: `if` is now refused on it, and `EVENT_NAME`/`PUSH_SHA` are pinned. Three regression assertions in `tests/unit/standards-coverage-ratchet.test.ts` pin all three routes.

## Decision-point inventory

- `scripts/standards-direction-guard.mjs#evaluateOperatorReviewApproval` — **pass-through** — the approval evaluator is untouched; only where its inputs come from on a push event changes.
- `scripts/standards-coverage.mjs#validateRootSelfWiring` — **modify** — the exact-keys contract for the review step now refuses `if` and requires the two push-branch env inputs.
- `.github/workflows/ci.yml` → "Fetch operator review context (direction guard path B)" — **modify** — runs on both events; adds a push branch that resolves the originating PR.

---

## 1. Over-block

**What legitimate inputs does this change reject that it shouldn't?**

The change is strictly un-blocking on the push path: previously *every* review-ratified registry change was rejected there; now the ones with a resolvable originating PR and a bound approval pass. It rejects nothing it previously accepted.

Residual over-block, stated rather than implied away: a merge commit whose originating pull request GitHub cannot associate — a rewritten/force-pushed history, a merge performed outside GitHub, or an association API outage — still refuses on the push build even though a human did approve. That is the pre-existing behaviour for that shape, unchanged, and it fails toward refusal by design.

---

## 2. Under-block

**What failure modes does this still miss?**

- A repository admin who pushes directly to `main`, bypassing branch protection, is refused by this check — but this check is not what stops them; the ruleset is, and an admin can disable that. Unchanged, and stated in the article itself: this is legibility, not the boundary.
- If a merged PR's branch is force-pushed *after* the merge so `head.sha` no longer matches the reviewed commit, the push build refuses. Fails closed, correct direction, no new hole.
- The check still cannot tell a *considered* approval from a reflexive one. Out of scope for any mechanical check.

---

## 3. Level-of-abstraction fit

Correct layer, and deliberately the low one. The step is an evidence *gatherer* — it fetches an API fact GitHub holds and writes it to a file. All judgment stays in `evaluateOperatorReviewApproval`, which is untouched. The alternative (teaching the node script to fetch its own reviews) was built earlier in the same evening as `c4b3a0be3` and **withdrawn** precisely because it put network I/O and identity comparison inside the evaluator and duplicated an implementation that already existed. This change keeps the split: shell gathers, evaluator judges.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — this change produces a signal consumed by an existing smart gate.

The step produces evidence (a JSON file); the authority to accept or refuse remains entirely with `evaluateOperatorReviewApproval` and, above it, the repository ruleset. The step is designed not to fail the job: every command carries an explicit fallback, so a broken gatherer degrades to "no approval found" (refuse) and never to "approved".

**Corrected by second-pass finding 3.** The first draft of this section asserted the step was "deliberately incapable of failing the job", and that was not true as written: GitHub's default shell is `bash -e`, and three `jq` invocations on the push branch carried no `|| …`. Practically unreachable — the input was jq-produced JSON — but an invariant that holds by accident is the kind that breaks later, and stating it as a guarantee was the defect. All three now carry `2>/dev/null || echo ''`, and the claim is true because it is enforced rather than because it happened to hold.

---

## 4b. Judgment-point check (Judgment Within Floors standard)

No new static heuristic at a competing-signals decision point. The one added predicate — "which pull request produced this commit?" — is not a judgment: GitHub records the answer as `merge_commit_sha`, so the domain is enumerable and the match is an equality test on an authoritative field. The deliberate rejection of the softer heuristic ("take the first associated pull request") is the point: that one *would* have been a guess at a decision point where a wrong guess reads someone else's approval.

**Second-pass finding 5 closed a gap between that reasoning and the code.** The filter took `.[0]` of the matches, which is the singleton assumption *asserted in prose and not in the code* — precisely the shape this section exists to catch. It is now `if length == 1 then .[0] else empty end`: more than one match resolves nothing and the guard refuses, which is what the argument above actually claims.

---

## 5. Interactions

- **Shadowing:** the step runs immediately before the `--check` invocation and writes only its own file. It shadows nothing; the base-resolution step (`area-audit-base`) and the check step are unchanged and still ordered exactly as the self-wiring pin requires.
- **Double-fire:** on a `pull_request` event the behaviour is byte-identical to before (the push branch is skipped by the `EVENT_NAME` test), so no event produces two fetches.
- **Races:** none. The step writes one file in `$RUNNER_TEMP`, consumed once, in-process, by the next step of the same job.
- **Feedback loops:** none. The check reads GitHub state and never writes it.
- **Self-wiring pin coupling (the real interaction):** loosening the pin in the same change that changes the step is exactly the shape the pin exists to catch, so the loosening is narrow and directional — `if` moves from *asserted-equal* to *asserted-absent*, which is strictly stricter, and two required env keys are added rather than removed.

---

## 6. External surfaces

- **GitHub API:** adds one call on push builds only — `GET /repos/{repo}/commits/{sha}/pulls`. Read-only, uses the run's own `github.token`.
- **Token scope — corrected by second-pass finding 2, and it was a real error.** This section originally claimed the call ran "under the job's existing `contents:read` + `pull-requests:read`. No new permission." There was no `permissions:` block anywhere in the workflow; the job ran on the repository's *default* workflow permission, which I had asserted rather than read. That matters beyond bookkeeping: if that default is ever tightened by policy to contents-only, the association call 403s, `associated` becomes `[]`, and the fix silently reverts to always-refusing on push — the exact state it exists to end, reported as "head sha unavailable". The job now declares `contents: read` + `pull-requests: read` explicitly, and the Root self-wiring pin REQUIRES that block, so the scope is ratcheted rather than inherited.
- **Other agents / install base:** none. This is repository CI for the instar source tree; nothing ships to an installed agent.
- **Persistent state:** none. The context file lives in the runner's temp dir for the length of one job.
- **Timing we don't control:** the association API can lag immediately after a merge. Failure mode is refusal, not a false pass, and a re-run repairs it.
- **Observability — second-pass finding 4.** The reviewer's sharpest point: as first written, this change reproduced its own named defect class one layer down. A 403, a rate limit, association lag, and a genuine direct-push-with-no-PR all produced an empty `headSha` and the identical downstream message, and the step printed nothing at all — so the first real failure would have been indistinguishable from a legitimate refusal, on the branch where you cannot iterate. The step now logs the resolved state (event name, association count, matched PR number or `none`, review count, head sha, owner) to the job log. Nothing in that line is secret.
- **Operator surface (Mobile-Complete Operator Actions):** no operator-facing action added or changed. The operator's one action — approving on GitHub — is unchanged and already phone-completable; this change is precisely what makes that phone action count on the push build too.

---

## 6b. Operator-surface quality

No operator surface — not applicable. No dashboard renderer, approval page, or grant/revoke/secret-drop form is touched.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

**machine-local BY DESIGN — and specifically not-on-any-machine.** This code executes only inside GitHub Actions runners, never on an agent machine. There is no per-agent state, no replication path to name, and no pool-wide read: two agent machines observing the same repository see the same CI verdict because the verdict is computed in GitHub, not locally.

Explicitly: it emits **no** user-facing notices (so no one-voice gating question), holds **no** durable state (so nothing strands on topic transfer), and generates **no** URLs (so no machine-boundary link problem).

---

## 8. Rollback cost

- **Hot-fix release:** pure revert of two files plus the tests. No release needed — CI configuration takes effect on the next run.
- **Data migration:** none. No persistent state.
- **Agent state repair:** none. No installed agent runs this code.
- **User visibility:** reverting restores the red main branch this change fixes; it does not create a new user-visible regression.

---

## Conclusion

The review changed nothing about the design, because the design's only real question — how the push path identifies the originating pull request — was settled by verification rather than argument before the review began: `5a4efecc1` resolves to PR #1960 as its sole association with a matching `merge_commit_sha` and one `APPROVED` review bound to that PR's head, and `6bd584de0` resolves to #1965 the same way. The one thing the review sharpened is the framing of the defect: the guard's "review path unavailable" verdict collapsed two genuinely different world states — *the operator did not approve* and *nobody ever asked* — into one refusal, which is why the red state was unfixable by any action the operator could take. That is the class, and the pin is what closes it. Clear to ship.

---

## Second-pass review (if required)

**Reviewer:** independent subagent (general-purpose), briefed to attack rather than concur
**Independent read of the artifact: CONCERN — six findings**

What the reviewer verified before objecting, which is why the findings are worth their weight: the evaluator really is untouched; the real `ci.yml` passes its own pin; `exactKeys` sorts, so ordering is a non-issue; and it simulated the new shell across eleven paths (gh failure, `[]`, non-JSON, JSON object, empty stdout, no match, match with missing `head.sha`, reviews-fetch failure, reviews non-JSON, and the PR event) — every one exits 0 and writes a well-formed file, with the PR-event path byte-identical to before. On **security it found no hole**: the push path still requires an APPROVED owner review whose `commit_id` equals the resolved PR's `head.sha`; an empty `headSha` can never be accepted because the 40-hex check runs first; org owner, fork PR, bot author, self-approval and post-merge force-push all still refuse.

**Fixed in this change (findings 1-5):**

1. **The `run:` body was not pinned at all** — the ratchet guarded the step's key set and env map but never its behaviour, so the entire push-resolution block could be deleted and all three new assertions would still pass, because the fixtures' run body was `echo "{}" > "$OUT"` and no test ever executed the real shell. This directly falsified the `guardEvidence` claim below, which said the exact edit that skips the push path fails the ratchet — true for the `if:` route only, one of at least three. The body is now pinned literally, exactly as the protected-base step's is, and the three fixtures share one definition so they cannot drift apart.
2. **The permissions claim was factually wrong** — see §6. Fixed in code and in the text.
3. **"Incapable of failing the job" was not true as written** — see §4. Fixed in code and in the text.
4. **The change reproduced its own defect class one layer down** — see §6. Fixed with explicit step logging.
5. **`.[0]` was an undeclared silent pick on multiple matches** — see §4b. Now fails closed.

**Accepted and NOT fixed here (finding 6), stated rather than closed:** the `push` webhook payload's `repository.owner` carries a different schema from the pull-request payload's, and the evaluator refuses first on `ownerType !== 'User'`. The evidence pointers below verify the REST repo object and the association API from a local token; neither proves the *runner's* push payload populates `owner.login`/`owner.type`. If it does not, the fix no-ops — safely, but silently. The reviewer is right that the artifact read as end-to-end verified when the push path has never actually executed. Finding 4's logging is what makes the answer readable; the commitment attached to this change is to read the first post-merge push build's `path-b:` and `direction-guard=` lines before calling the class closed, and to say so plainly if it did not work.

**Minor, acknowledged, not changed:** `!Object.hasOwn(reviewStep,'if')` is strictly redundant given `exactKeys` — removed, since presenting a redundant assertion as the load-bearing one is its own small dishonesty. And the release note's flat "the bypass stays closed" is one notch stronger than §2 supports: path B is non-per-article, so a push whose tip is an approved merge commit gives blanket coverage to any earlier unapproved registry commit in the same push. Admin-only and consistent with the stated boundary, but the note now carries the qualifier the artifact already did.

---

## Evidence pointers

- Failing CI job: run `32619488561`, "Standards Enforcement Coverage" — `review context unreadable (ENOENT ... standards-direction-review.json)` on the push build for `5a4efecc1`.
- Working PR-event path for contrast: run `32614325158` on PR #1960 — `direction-guard=passed` on an unsigned registry change.
- Association verification: `GET /repos/JKHeadley/instar/commits/{5a4efecc1,6bd584de0}/pulls` → exactly one PR each, `merge_commit_sha` matching, `APPROVED` review bound to that PR's head.
- Regression assertions: `tests/unit/standards-coverage-ratchet.test.ts` — re-gated step refused; `EVENT_NAME` dropped refused; `PUSH_SHA` dropped refused.

---

## Class-Closure Declaration (display-only mirror)

- **`defectClass`** — `instrument-semantic-darkness`
- **`closure`** — `guard`
- **`guardEvidence`** — `{ enforcementType: ratchet, citation: tests/unit/standards-coverage-ratchet.test.ts (three assertions on the review-step wiring, over a fixture that carries the step's real run body), howCaught: the Root self-wiring pin refuses an "if:" on the evidence-gathering step, requires EVENT_NAME + PUSH_SHA, and pins the run body LITERALLY — so every route that makes the producer skip the push path while the consumer still evaluates there (re-gating the step, dropping an input, or gutting the shell) fails the ratchet instead of shipping a verdict that cannot distinguish "no approval" from "never fetched" }`

*The literal run-body pin is in this declaration because of second-pass finding 1: without it the claim above was false for two of the three routes, and a guardEvidence claim that only covers the route the author happened to think of is the closure equivalent of a green test that never ran.*

The class fits on its own terms: the guard emitted one verdict for two distinct world states, and a reader of that verdict could not tell which one they were in. The registry's exclusion for "an honestly unassessable run with a future observation path that can repair it" does not apply — on the push build no future observation could repair it, because the step that produces the observation was structurally excluded from that path.
