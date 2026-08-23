---
title: "Operator approval for constitutional changes: the control plane, and the code beneath it"
slug: "standards-approval-via-github-review"
author: "echo"
parent-principle: "Know Your Principal — An Unverified Identity Is a Guess"
eli16-overview: "standards-approval-via-github-review.eli16.md"
status: "converged 2026-08-22 — 4 adversarial rounds (5 → 3 → 1 → 0 security findings); round 1 was invalidated wholesale and rewritten"
origin: "Topic 52222, 2026-08-22. The direction guard (landed 2026-08-17) requires an Ed25519 signature per changed constitutional article against a key pinned in the repository. The key shipped empty, so no registry change has merged since; PR #1960 (the operator's own five ratified amendments) is the first to hit it. Asked to install a key, the operator said: 'this sounds like an extreme hassle… we just need some simple solution that is mobile friendly… some link that you can click and then approve.'"
operator-gate: "The operator chose review-based approval over a held key (2026-08-22) after being shown the trade. This spec mints no constitutional text. It DOES ask the operator for a repository-settings change, which is the only part that carries security."
---

# Operator approval for constitutional changes

## The correction this document exists to make

Round 1 of this design proposed teaching the direction guard to accept an approving GitHub review instead of a signature, and claimed that would keep the agent from editing its own constitution. **An adversarial review found that claim false, and the reasoning generalises further than the proposal.**

> "GitHub runs repository-controlled enforcement supplied by the agent… Without that control plane, the proposed review logic is advisory code the governed agent can rewrite."

That is correct, and it applies to the CURRENT guard too. The conclusion this document is built on:

**No check the agent writes can constrain the agent. Only the repository's settings can.**

Everything below follows from that.

## The facts, verified against the live repository

1. **The agent can push directly to `main`.** Its GitHub identity (`EchoOfDawn`) holds `push` (not admin). The `main` ruleset carries `deletion`, `non_fast_forward` and `required_status_checks` — and **no `pull_request` rule**. Nothing requires a pull request or a review.
2. **The agent authors the checker and the workflow that runs it.** A single commit can change `docs/STANDARDS-REGISTRY.md` and `scripts/standards-coverage.mjs` together; the version of the checker that runs is the one in that commit.
3. **`standards-coverage` is not in the required status checks.** The `main` ruleset requires 15 contexts; none of them is the standards check.
4. **The dashboard PIN is agent-readable.** The server authenticates PIN-gated actions by hashing `config.dashboardPin`, which sits in plaintext in the agent's own config file. Any approval surface behind that PIN is not a different-principal check. (Filed separately as a HIGH attention item — it affects every route the agent's documentation calls operator-only.)
5. **A branch-protection-bypassing PAT lives in repository secrets.** `publish.yml` uses `RELEASE_TOKEN`, documented in-file as "a PAT that can bypass branch protection." Anyone who can land a workflow change can reach what a workflow can reach. This means `.github/**` is part of the trust boundary, not ordinary source.

**Correction to a claim round 1 made.** Round 1 wrote that "an unused guard protects nothing." That is false, and the reviewer was right to call it: the existing guard has in fact prevented every registry change since 2026-08-17, including this agent's own. It is weak against a determined agent and strong against an inattentive one, and those are different statements.

## What actually carries the security

**The repository ruleset, administered by the operator, who alone holds admin.** Three settings, in the GitHub UI:

**(a) Require a pull request to `main`.** Closes fact 1. Without this, every other measure is decoration.

**(b) Require review from Code Owners**, with a `CODEOWNERS` file naming the operator. **Two lines:**

```
docs/STANDARDS-REGISTRY.md   @JKHeadley
.github/CODEOWNERS           @JKHeadley
```

**A reasoning error, corrected after the operator pushed back (2026-08-22).** Earlier drafts code-owned six paths, adding `scripts/standards-*` and `.github/**` on the argument that an agent able to neuter the checker could slip a registry change past it. **That argument is wrong.** The approval requirement is enforced by GitHub against the FILE PATH, not by the checker. The checker can be broken, deleted or rewritten and a pull request touching `docs/STANDARDS-REGISTRY.md` still stops and waits for the operator. Owning the checker bought nothing and cost the operator approvals on unrelated work.

The second line exists solely so the first cannot be removed. That is the entire mechanism.

**Measured, because "it won't bother you much" deserves a number.** Over the last 72 commits on `main`, `docs/STANDARDS-REGISTRY.md` was touched **1** time (1.4%) and `.github/CODEOWNERS` **0**. The six-path version would have been ~10 of 72. Two lines is roughly one approval a month, only ever on the constitution.

**Deliberately EXCLUDED, named rather than quietly folded in.** `.github/**` is outside the boundary despite fact 5 — a workflow change can reach `RELEASE_TOKEN`, which bypasses branch protection. That is a real attack path and this design does **not** close it. Excluded on the operator's explicit instruction after being shown the trade: it is a far more elaborate attack, a different problem from constitutional approval, and guarding it costs an approval every week or two on ordinary work. Recorded so a later reader does not mistake the omission for an oversight.

**(c) `require_last_push_approval: true`.** An approval is invalidated by a subsequent push from the person who is not the approver. Closes the "approve, then push different bytes" hole directly, at the platform level rather than in code the agent wrote.

**Bypass list must not include the agent.** The release automation already pushes with `RELEASE_TOKEN`, a credential explicitly provisioned to bypass protection, so releases keep working without adding the agent to any bypass.

**What the operator's cost actually is:** one settings session, then an approval on pull requests touching the constitution or the guard machinery. Everything else is unaffected.

## What the code is for, stated honestly

With (a)–(c) in place, the in-repo direction guard is **not** the security boundary and this document does not claim it is. It remains worth having for three reasons, none of which is enforcement:

1. **Legibility.** Without it, a constitutional change is a pull request like any other and the reviewer has to notice the file. With it, CI says which articles changed and in which direction, so the operator's three taps are informed rather than ceremonial.
2. **Mechanical facts a human should not compute.** Which articles changed, whether an approval is bound to the current head, whether a ratification signature verifies — cheap for a parser, tedious and error-prone for a person on a phone.
3. **The signature path stays available.** Anyone who prefers a held key keeps it, unchanged.

So the code change is: **accept an approving review from the repository owner, on the exact head commit, as an alternative to the Ed25519 ratification** — while the ruleset, not the code, is what makes that meaningful.

### The check, precisely

Runs inside `standards-coverage`, only when the direction guard reports changed articles.

1. Resolve the owner from `repository.owner`. If `type !== 'User'`, path (B) is UNAVAILABLE — an organization names no individual, and falling back to an in-repo allowlist would reintroduce a trust root the agent can edit (fact 2). Report and fall through to path (A).
2. Fetch the pull request's reviews **and their current state**.
3. Accept only when there is a review with `state === 'APPROVED'`, `user.login === owner.login`, `commit_id === head.sha`, `user.login !== pull_request.user.login`, and **no later review or dismissal from that same login on that commit that withdraws it** — a `CHANGES_REQUESTED` or dismissed review submitted after the approval revokes it.
4. On acceptance every changed article in that pull request is approved; the reviewer approved the diff.
5. Record which proof was used, per article, in the coverage report.

### Content binding, and its residual limit

`commit_id === head.sha` binds the approval to the exact reviewed commit, and setting (c) invalidates the approval if the agent pushes after it.

**The residual, which round 1 missed and the reviewer named:** a merge commit or a moved base can put bytes on `main` that differ from the reviewed head. Mitigation is a platform setting, not code — either require linear history / up-to-date-before-merge, or accept the residual knowingly. **This document does not claim the residual is closed**, and recommends requiring branches be up to date before merging, which reduces it to the ordinary semantics every reviewer already assumes.

## Failure direction

Path (B) reports UNAVAILABLE with a named reason on any API error, rate limit, unexpected shape, missing event payload, or non-`pull_request` event, and the article then requires path (A). The guard **fails closed**: an approval that cannot be verified is not an approval.

**But the honest scope of "fails closed":** it describes the code's behaviour, not a guarantee against the agent, which can edit the code. The unconditional statement belongs to the ruleset; the code's version is conditional on the ruleset existing.

## The bootstrap transaction (round 3 — an ordering gap the second review found)

"Settings first" is not precise enough, and the gap is real: **"require Code Owner review" is inert until a `CODEOWNERS` file exists, and a `CODEOWNERS` file that lands while the agent can still push directly is a file the agent can replace.** Either order, taken naively, leaves a window.

The ordering below has no agent-writable window and requires no revocation of the agent's access. Each step is the operator's; none can be performed by the agent.

1. **Enable "require a pull request before merging" on `main`, WITH at least one required approving review, FIRST.** The required review is the load-bearing half and round 2's version of this step omitted it: require-PR alone still lets the agent open a pull request and merge its own, so the earlier claim that step 1 "prevents the agent from touching it" was **false** (round 3). GitHub forbids approving one's own pull request, so a count of 1 means the agent needs someone else from this moment on. Only with the count set does the rest of the sequence have no agent-writable window.
2. **Add `CODEOWNERS` with the two lines above.** Prepared as a pull request the operator approves rather than hand-authors — it is inert on merge, and step 1 already prevents the agent replacing it afterwards.
3. **Enable "require review from Code Owners" and `require_last_push_approval`** — and at this point the blanket approving-review count from step 1 may be dropped back to **0**, because Code Owner review now carries the requirement on exactly the paths that need it. That is the end state worth having: `required_approving_review_count: 0`, `require_code_owner_review: true`, `require_last_push_approval: true`. It is what keeps the operator from being asked about routine work while the constitution and the guard machinery stay owned.
4. **Verify from the platform, not from the repository.** The live ruleset is readable at `GET /repos/{owner}/{repo}/rules/branches/main`. Confirm the rule types include `pull_request`, that its parameters require Code Owner review and last-push approval, and that the bypass list contains no actor the agent controls. **The agent can run this and report it — and the operator should confirm it independently at least once, because a report from the agent about the constraint on the agent is exactly the class of evidence this whole document argues against.**
5. **Only then** merge the guard change (this spec's code half).

**RECOMMENDED instead of relying on the ordering at all:** temporarily remove the agent's write access for the duration of the bootstrap, do steps 2-4 unhurried, then restore it. Two clicks, a few minutes of the agent being unable to push, and every ordering subtlety above stops mattering. The ordered version is kept because it is useful when revoking access is inconvenient — but the second review found a false claim in its first step, which is itself an argument for preferring the version with no ordering to get wrong.

## Sequencing, and why it matters

**The settings change must land FIRST.** Shipping the code path before the control plane would install a keyless approval route while the agent can still bypass every route — strictly worse than today, because it would read as an improvement.

Round 1 also called its own bootstrap "non-constitutional" on the grounds that it touches no articles. The reviewer objected, correctly: a change to the mechanism governing amendments is constitutionally significant even when it edits no article, and installing a weaker path without using the existing approval path would be exactly the self-authorisation this guard exists to prevent. **So the code change is itself submitted for the operator's approval under the new rules**, not merged as routine work.

## Enforcement and testing

- owner review on the head SHA → accepted
- same review after a later push (head SHA moved) → refused
- approval later followed by `CHANGES_REQUESTED` from the owner → refused
- dismissed approval → refused
- review by a non-owner → refused
- review by the pull request's own author → refused
- `COMMENTED` state → refused
- organization-owned repository → UNAVAILABLE, never permissive
- API error / rate limit / missing payload → UNAVAILABLE, falls back to path (A)
- valid Ed25519 ratification, no review → accepted (path A unbroken)

**What no test in this repository can establish:** that the gate cannot be removed. That property lives in the ruleset, and its evidence is the live platform configuration, not a test file and not a green pipeline. Stating this rather than letting a passing suite imply otherwise.

**Consequently — the satisfaction condition for this whole design is not "CI is green."** It is: the ruleset is live as described, `CODEOWNERS` is present and operator-verified, no agent-controlled actor is on the bypass list, and only then does an approval mean what it says. Until an operator has confirmed that once, the honest description of this repository is that the constitution is guarded by the agent's restraint, not by structure — which is the thing the constitution's own founding principle says never to rely on.

## For the operator to decide

1. Apply (a), (b), (c)? Without them this code is advisory and the current key path is too.
2. Require branches up to date before merging, to close the merge-commit residual?
3. Anything else that should be code-owned beyond the list above?
4. Bootstrap by ordering (steps 1-5 above), or by temporarily removing the agent's push access for the duration? The second is stricter and costs a few minutes.

## What this does not fix

The dashboard-PIN finding (fact 4) is untouched by any of this and remains open. So does the broader question of what else in the agent's documentation claims to be operator-gated while resting on a secret the agent holds. Both are tracked separately; neither is resolved here.
