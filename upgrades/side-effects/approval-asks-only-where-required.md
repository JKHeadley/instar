# Side-Effects Review — ask the operator to approve only what needs them

**Version / slug:** `approval-asks-only-where-required`
**Date:** `2026-11-17`
**Author:** `Echo (instar-dev)`
**Second-pass reviewer:** `independent subagent (see below)`
**Spec:** `docs/specs/approval-asks-only-where-required.md` (converged in 3 rounds, codex-cli:gpt-6-astra; approved by the agent under the operator's only-constitution rule)

## Summary of the change

Echo Bugs topic 10000002791. On 2026-11-17 a build session on the M5 asked Justin to approve PR #3326. That PR touched neither code-owned file. The session also told him "the repository only counts a GitHub approval from someone other than the account that pushed it". The repo requires no approval for it: the ruleset has `required_approving_review_count: 0`, and code-owner review applies only to `docs/STANDARDS-REGISTRY.md` and `.github/CODEOWNERS`.

Traced causes:

1. **instar-dev Phase 7 states a removed ruleset rule as in force.** It said `require_last_push_approval` / a required review was "in force since 2026-08-22". Both skills also call approval "the user's step".
2. **The send-time PR-link hook asks on every link.** It requested the operator's GitHub review on every open agent PR linked in a reply. Justin became a requested reviewer on 3326 seven seconds after it opened.
3. **No text the build session reads states the rule.** It lived only in memory.

Changes:

- **`src/messaging/prApprovalFact.ts` (new).** A pure `approvalRequirement` plus `readPrApprovalFact`. The answer is `not-required` only when all of these hold:
  - the base branch has a ruleset code-owner rule;
  - no `pull_request` rule requires a general approval (count, last-push, `required_reviewers`), and every parameter is on a known list;
  - GitHub's computed `reviewDecision` is null (the stand-in for unreadable classic protection);
  - CODEOWNERS is read from GitHub's three locations, on the base branch;
  - no changed path, including a rename's previous path, is code-owned.

  Anything unread, unknown or truncated is `unknown`. A repo without a code-owner rule is `ungoverned`.
- **`src/messaging/prLinkReviewRequest.ts`.** After the existing agent-PR, reviewer, already-requested and approved-at-head checks, the fact is read within `APPROVAL_FACT_BUDGET_MS` (6 s). `not-required` gives the new outcome `skipped-no-approval-required` and no request. Every other answer keeps the request. Switch: `prLinkReviewRequest.requestWhenNotRequired` (read per call; absent means false). The fact is logged on the `[pr-link-review]` line.
- **`src/server/routes.ts`.** Passes the switch into the hook deps.
- **Skill text.** One table, `src/core/approvalWhereRequiredSkillText.ts`, holds 2 instar-dev and 8 spec-converge sentence pairs. The bundled `skills/instar-dev/SKILL.md` and `skills/spec-converge/SKILL.md` were produced from it. They now say:
  - whether a merge needs approval is read live through `safe-merge`;
  - a reservation the operator recorded comes first;
  - the agent approves its own specs, except constitution or protected-list amendments;
  - a spec goes to the operator only then.
- **`skills/spec-converge/templates/report.md`.** Verdict wording updated (reaches agents via its existing `alwaysOverwrite` mirror entry).
- **`scripts/instar-dev-precommit.js`.** Two refusal messages reworded. The check is unchanged.
- **`src/core/PostUpdateMigrator.ts`.**
  - New `migrateApprovalWhereRequired()`: exact-sentence replacement in the canonical `.instar/skills/<name>/SKILL.md` and both renderings. In-sync renderings are re-stamped to the new canonical body hash. A customized sentence is reported and left. Idempotent.
  - The core section "PR links ask for the review on GitHub too" is reworded (constants `PR_LINK_REVIEW_SECTION_BODY` and `_V1`), with an in-place replacement for full-layout CLAUDE.md files. `src/scaffold/templates.ts` emits the same text.
- **`CLAUDE.md` (repo).** New Standard, *Approval Only Where Required*. This is the carrier for worktree build sessions.
- **`src/data/awareness/approval-only-where-required.md`.** New awareness entry, worded around the operator's recorded instructions.

Tier 2. The first draft's outbound-gate sub-clause was removed in review (Rule 116), so the change adds no authority.

## Decision-point inventory

- **The prLinkReviewRequest send-time side effect: modify.** A GitHub review request is skipped on an exact `not-required` fact. It never blocks or alters a message.
- **The `approvalRequirement` prediction: add.** A signal only. GitHub enforces at merge.
- **Instruction text (skills, CLAUDE.md, awareness): modify / add.** No runtime decision.
- **The tone gate, safe-merge, local-verify-floor and the green-PR watcher: unchanged.**

---

## 1. Over-block

The only thing that can be "blocked" is a GitHub review request. A request is wrongly skipped only if the fact reads `not-required` while GitHub would require an approval. Every read failure, unknown parameter, missing CODEOWNERS or truncated list gives `unknown`, and `unknown` keeps the request. Two inferences remain:

- a null `reviewDecision` means no classic review requirement (observed on four approved registry PRs; used the same way by Kodiak and Mergify);
- the unattributed-changes flag adds nothing at count 0 (agent PRs merge with zero reviews under it).

If either is wrong, GitHub refuses the merge and safe-merge's refusal path requests the review itself, so the cost is one delayed request. No message is ever changed or held.

A reservation the operator recorded on a non-code-owned PR gets no GitHub request. The chat yes is the approval of record (spec decision 7), and the switch restores always-request.

## 2. Under-block

A session can still ask in chat out of habit. Nothing in code stops it. That was deliberate (spec decision 1, Rule 116). The instructions that caused the ask are corrected, and the rule now sits in the repo CLAUDE.md that every build session loads. A recurrence would show as an operator correction in the correction ledger, which would justify a judged backstop.

Requests already made (e.g. on 3326) stay. That is an operator chore, handled once by the fixer.

## 3. Level-of-abstraction fit

The cause was upstream (instructions plus a side-effecting hook), and the fix is at those layers. The outbound gate was considered and rejected as the wrong layer: it would judge a symptom whose causes are removed. The fact reuses the existing CODEOWNERS parser (`scripts/local-verify-floor.mjs`) and leaves safe-merge's predicate untouched. Merge authority stays in one place.

## 4. Signal vs authority compliance

Compliant (`docs/signal-vs-authority.md`). The fact is a deterministic signal over recorded GitHub state. It only decides whether to send a GitHub request, which is a side effect, not a gate on information flow. No brittle check gains blocking authority, and no message is held, filtered or rewritten. The only text change to outbound messages is the existing "could not confirm" note, which is unchanged.

## 4b. Judgment-point check (Judgment Within Floors standard)

No judgment point is added. The fact is an invariant prediction over recorded GitHub state (spec, Decision points touched: basis external-constraint). The draft's judged outbound-gate rule was removed in review. Nothing decides meaning.

## 5. Interactions

- **Ordering in the hook.** The fact read runs after the existing skips (not open, not the agent's, no reviewer, author equals reviewer, already requested, approved at head), so those outcomes are unchanged.
- **Timeouts.** The hook's 10 s budget is unchanged.
  - The fact reads start as soon as the PR is known to be the agent's own, in parallel with the already-requested and reviews checks, so they overlap rather than add to the existing reads.
  - The fact has its own 6 s cap, and an overrun gives `unknown`, i.e. the request.
  - Remaining path (second pass): on a GitHub slow enough to overrun the whole 10 s, a PR reports `failed`, and the reply carries the existing "could not confirm … as a reviewer" line. That is today's slow-GitHub behaviour, unchanged by this PR. A `not-required` answer returns at once, so the line follows one only when GitHub is slow enough that the answer itself lands after the 10 s limit (first PR read over about 4 s).
- **safe-merge.** Unaffected. It still requests on its refusal path.
- **Existing tests.** The existing fake GitHub in `prLinkReviewRequest.test.ts` fails every fact read, so the fact is `unknown` and the request is made. Those tests stay green as intended.
- **The skill parity rule.** Canonical and renderings are edited together and in-sync renderings re-stamped, so there is no `user-edit-conflict`.
- **Reference-layout CLAUDE.md.** Regenerated from the template, so it receives the new section text.

## 6. External surfaces

- **GitHub reads.** For each agent-authored open PR link: 4 logical reads (rulesets, a GraphQL review decision, CODEOWNERS with up to 2 fallbacks, the paginated file list at `per_page=100`). These come on top of the hook's existing reads, only for agent PR links, at most 5 per message.
- **GitHub requests.** The visible change is fewer review requests on PRs nothing requires the operator to approve.
- **Instruction text.** Every agent's instruction text changes: the skills, a CLAUDE.md section and a feature note.
- **Repo dependence.** The fact depends on GitHub's API shape. A new ruleset parameter falls back to `unknown`, with the parameter named in the log.

## 6b. Operator-surface quality (Operator-Surface Quality standard)

No rendered operator surface changes: no dashboard file, approval page or grant form is touched. The gate matched `src/core/approvalWhereRequiredSkillText.ts` by name. That file is a table of skill instruction sentences an agent reads, not a page an operator sees. The operator's only visible effect is on GitHub's own review-request list, which gets fewer false entries. Per criterion:

1. **Leads with the primary action:** n/a, justified. No page exists. The operator surface this touches (GitHub review requests) now shows only reviews the repository actually requires, so the request that remains is the action that matters.
2. **Zero raw internals as primary content:** yes. No operator-facing text is added. The one agent-facing log line carries the reason in plain words.
3. **Destructive actions de-emphasized:** n/a, justified. No action control is added or moved.
4. **Plain language at phone width:** yes. The operator-visible messages this governs (asks, status) are plain-language replies. The rendered message format is unchanged.

## 6c. Agent Proposes, Operator Approves (authorization surface)

This change is governed by *Agent Proposes, Operator Approves* (the spec's parent principle; 2.0 Rule 82). It narrows *when* the operator is asked, and does not change *how* an ask is built.

1. **Approving a pre-filled request, not constructing one.** Unchanged. A remaining operator ask is still safe-merge's review link (one click, Approve) or a chat yes/no. No form, field or authority is added for the operator to assemble.
2. **An authority statement authored by the server, not agent free-text.** Unchanged. No authority statement or approval card is added or edited. The file the gate matched holds instruction sentences agents read. It renders nothing to the operator and grants nothing.

The effect is fewer false asks: a review request is no longer made where the repository's rules require nobody's approval.

## 7. Multi-machine posture (Cross-Machine Coherence)

- **Fact: unified via the shared upstream.** Every machine reads GitHub with its own login. There is no state and no cache. A machine that cannot read something gets `unknown` there and keeps today's request.
- **Skill text, CLAUDE.md sections and awareness entry:** delivered to every machine's agent home by the update path.
- **No user-facing notice, durable state or generated URL is added.**

## 8. Rollback cost

- **Revert the PR.** No durable state, config or data migration needs undoing.
- **`prLinkReviewRequest.requestWhenNotRequired: true`** restores always-request without a deploy.
- **Migrated skill copies** keep the new sentences after a revert. That is harmless, since they match the operator's stated rule and current practice.

---

## Proportion

- **Size:** Tier 2, ~400 source LOC across ~10 files, plus ~350 test LOC.
- **Review:** 3 of 6 spec rounds.
- **Commits:** gate attempts are counted at commit time.
- **In line:** the round-1 reshaping (the outbound-gate rule removed) is what review is for.

## Second-pass review

Independent reviewer subagent, 2026-11-17, two passes.

**Pass 1: concern raised.**
1. `migrateApprovalWhereRequired` re-stamped only body-identical renderings. A user-edited rendering would have been left with a stale stamp, which invites a re-render that overwrites the user's edits. Fixed: re-stamp whenever the stamp named the old canonical hash, with a unit test.
2. (Minor) The fact's 6 s share could push a slow-GitHub message past the 10 s budget. Fixed: the fact read now starts in parallel with the existing checks, and the remaining path is named in Interactions.

**Pass 2: "Concur with the review."** Notes:
- The "never follows not-required" wording was too strong. Softened.
- An early-started test-seam fact promise could reject unhandled. A `.catch` to `unknown` was added.
