---
title: "Ask the operator to approve only what needs them"
slug: approval-asks-only-where-required
author: echo
eli16-overview: approval-asks-only-where-required.eli16.md
review-convergence: "2026-11-18T05:46:39.700Z"
review-iterations: 3
review-completed-at: "2026-11-18T05:46:39.700Z"
review-report: "docs/specs/reports/approval-asks-only-where-required-convergence.md"
cross-model-review: "codex-cli:gpt-6-astra"
single-run-completable: true
frontloaded-decisions: 7
cheap-to-change-tags: 0
contested-then-cleared: 3
parent-principle: "Agent Proposes, Operator Approves"
approved: true
approved-by: "echo (agent) — operator rule: only constitution changes need Justin (2026-10-22 08:58 PDT, \"I should ONLY have to approve constitution changes\"; 2.0 Rule 82). This spec touches no path .github/CODEOWNERS names. Task brief for Echo Bugs topic 10000002791: do not ask Justin for ordinary engineering approval."
approved-at: "2026-11-18T05:47:00Z"
---

# Ask the operator to approve only what needs them

## Problem statement

On 2026-11-17 at 15:14 PT a build session on the Mac M5 posted in the operator's topic 144201:
"The switch to the new GPT-6.2 models is ready for your review: https://github.com/JKHeadley/instar/pull/3326 …
What I need from you: your yes on this change. The repository only counts a GitHub approval from
someone other than the account that pushed it, which is mine, so I can't approve it for you."
Justin replied at 15:15: "why is this something that requires my approval?" At 15:22 he added: "This is an
instar violation." (Echo Bugs report in topic 10000000001; fixer topic 10000002791; feedback fb-37dfc510-444.)

The facts below were read for this spec, not taken from the report:

- **PR 3326 touches no code-owner file.** It changes 33 files. None is `docs/STANDARDS-REGISTRY.md` or
  `.github/CODEOWNERS`, the only two paths that `.github/CODEOWNERS` assigns to `@JKHeadley`.
- **The `main` ruleset requires no general review.** The ruleset is `instar-main-protection`
  (id 15247386). Its `pull_request` rule has `required_approving_review_count: 0`,
  `require_last_push_approval: false`, `require_code_owner_review: true` and `required_reviewers: []`.
  It also has `require_extra_approval_for_unattributed_changes: true`.
  - Non-constitution PRs authored and pushed by the agent merge with zero reviews under these settings.
    #3331 merged today with 0 reviews.
  - So the extra-approval flag adds nothing when the required count is 0.
  - 3326 is held only by its red `instar/local-verify` status. GraphQL `reviewDecision` is `null`.
- **The session's false claim came from the instar-dev skill.** "The repository only counts an approval
  from someone other than the pusher" is `skills/instar-dev/SKILL.md` Phase 7: "When the repo itself
  requires a human approval (a main-branch ruleset with `require_last_push_approval` / a required review —
  in force on `JKHeadley/instar` since 2026-08-22 17:03 PDT) …". That setting is gone, and the text was
  never updated. Every build session reads a false fact about the repository.
- **Two skills name the user as approver.** Phase 0 of the same skill, and `/spec-converge`, say so:
  - "The user must have reviewed the convergence report and applied `approved: true`"
  - "That's the user's step"
  - "It does not auto-approve on behalf of the user"

  In practice the agent records spec approval itself. 2026-11 specs carry
  `approved-by: "echo — operator delegation …"`. The text and the practice disagree, and a session that
  follows the text asks the operator.
- **A send-time hook asked GitHub on Justin's behalf.** `src/messaging/prLinkReviewRequest.ts` requests
  the operator's GitHub review on every open agent-authored PR linked in an outbound reply, whatever the
  PR touches. On 3326 the operator was requested at 22:29:33Z, seven seconds after the PR opened. So
  GitHub's own review-request list asked him for an approval nothing required.
- **No every-session text states the rule.** It lives in agent memory ("only constitution changes need
  Justin": 2026-09-28 for 2.0, 2026-10-22 for 1.x). The asking session was spawned from a hand-written
  brief that did not repeat it.
- **Already correct:** `scripts/safe-merge.mjs` returns `refused:approval-required` only when GitHub will
  refuse a merge for want of a review (ruleset count or last-push approval, or a code-owned file under
  `require_code_owner_review`). The merge tool needs no change.

Governing rule: instar-2 `docs/01-the-rules.md`, Rule 82, *Agent Proposes, Operator Approves*:
"they never merge: the agent merges anything honestly green, and the operator is asked only for changes to
the constitution and to the short protected list the register names." Rule 104 adds: "Within a current
grant, the agent does not ask again for what it already covers unless the sign-off list requires it."
In 1.x the protected list is what CODEOWNERS names, enforced by GitHub
(`docs/specs/standards-approval-via-github-review.md`).

## Root cause

The cause is upstream of the outbound message. Three things told the session to ask, and nothing told it
not to:

1. Skill text states a false repository fact and names the user as approver.
2. A send-time hook turns every agent PR link into a GitHub review request.
3. No every-session text states the rule.

## Proposed design: simplest robust route

Fix the three causes. Add no new authority over outbound messages.

### Part 1: the instructions stop stating repository facts and say who approves

- **`skills/instar-dev/SKILL.md`, Phase 0.** The approval bullet becomes: the agent records
  `approved: true` with an `approved-by` line naming who approved and on what basis. The operator
  approves a spec only when it amends the constitution or the protected list (the paths CODEOWNERS
  names), or when the operator's recorded instructions reserve it.
- **`skills/instar-dev/SKILL.md`, Phase 7.** The stale ruleset paragraph is replaced with a rule that
  names no ruleset setting:

  > Whether a merge needs a human approval is read live, never remembered. Do not decide it from memory,
  > from a brief or from this text: the repository's rules change. An approval the operator's recorded
  > instructions reserve is asked for first. Otherwise `safe-merge` decides: it returns
  > `refused:approval-required` only for a PR GitHub will not merge without a review, and only then is the
  > operator sent the review link. Every other green PR is merged without asking, and the operator hears
  > what shipped.

  Precedence (round 2): a reservation the operator recorded comes first; repository rules decide the
  rest. GitHub mergeability never establishes authorization on its own.

- **`skills/spec-converge/SKILL.md`.** Its eight approval sentences (the table below lists each one) say the same.
  Phase 6 (handoff): `publish-spec-review.mjs` is for a spec that needs the operator's approval. Any other
  converged spec gets no handoff message; it reaches the operator in the regular status update or the
  merged PR. The verdict line becomes "Spec is ready to approve and build".
- **`skills/spec-converge/templates/report.md`.** The approval line says the same. This file is already
  an `alwaysOverwrite` mirror entry, so existing agents receive it on update.
- **`scripts/instar-dev-precommit.js`.** The two refusal messages that say "The user must review … and
  apply the approved tag" now name the same rule. The check is unchanged.
- **Unchanged:** `publish-spec-review.mjs` keeps its message ("ready for your review … Nothing builds until
  you approve it"). After this change it is used only when that message is true.
- **One table:** every replaced sentence lives in one table, `src/core/approvalWhereRequiredSkillText.ts`,
  as an exact prior/next pair (every shipped variant shares its prior; checked against both files' git
  history). The bundled skills are produced from that table, and a test pins that they contain every
  `next` and no `prior`.
- **The core instruction section "PR links ask for the review on GitHub too"** (`src/scaffold/templates.ts`
  and `patchClaudeMdContent`) described the hook as requesting on every agent PR link. Round 2 found
  this the same kind of stale instruction as cause 1. It is reworded to describe Part 3. Reference-layout
  agents get the new text from the regenerated canonical document. Full-layout agents get an in-place
  replacement of the exact first-version body (`PR_LINK_REVIEW_SECTION_BODY_V1` →
  `PR_LINK_REVIEW_SECTION_BODY`), idempotent.

### Part 2: every session reads the rule

Round 2 checked what actually reaches a build session. An awareness entry lands in the agent home's
`.instar/reference/*.md` with only its title in the agent's CLAUDE.md. A session working in an instar
worktree loads the repository's own `CLAUDE.md`, not the agent home's. So the rule goes to both places:

- **The instar repository's `CLAUDE.md` Standards** gains *Approval Only Where Required*: the operator
  approves only the constitution and the protected list, plus what their recorded instructions reserve.
  Specs are the agent's to approve with `approved-by`. Whether a PR needs a human approval is read live
  through `safe-merge`, never from memory or a brief. Every session building instar in a worktree loads
  this file, so this is the carrier for the failing case: a spawned build session, whatever its brief
  says.
- **New awareness entry** `src/data/awareness/approval-only-where-required.md`, for every agent's other
  sessions. It is worded around the operator's recorded instructions and the repository's own rules
  (Sovereignty: what needs a given operator is theirs to say). It names `safe-merge` only "on the instar
  repository", since ordinary agents do not have it, and gives no merge directive to agents that do not
  merge.

### Part 3: the send-time hook stops requesting a review nothing requires

`ensureReviewerOnPr` runs on agent-authored open PRs only (unchanged). After it establishes that, it reads
an **approval fact** for the PR. When the fact is `not-required`, the outcome is the new
`skipped-no-approval-required` and no review is requested. In every other case, today's behaviour holds.

**The fact** (new pure function `approvalRequirement` in new module `src/messaging/prApprovalFact.ts`). It
reads the raw `pull_request` rules itself and imports only `parseCodeowners` and `codeOwnedFiles` from
`scripts/local-verify-floor.mjs`. That file stays unchanged, and so does safe-merge. It answers
`not-required` only when ALL of these were read and hold:

1. **A governed surface exists.** The base branch's rulesets (`GET repos/{r}/rules/branches/{base}`)
   contain a `pull_request` rule with `require_code_owner_review: true`. The repository has named who
   approves what. If it has not (no rulesets, or no code-owner rule), the answer is `ungoverned` and
   today's request stands. That keeps this change out of every repository whose owner has not expressed
   an approval surface (Sovereignty).
2. **No rule requires a general approval.** Every `pull_request` rule has
   `required_approving_review_count` of 0, `require_last_push_approval` false and `required_reviewers`
   empty. Any `pull_request` parameter outside the known set gives `unknown`. The known set is:
   `allowed_merge_methods`, `dismiss_stale_reviews_on_push`, `require_code_owner_review`,
   `require_last_push_approval`, `required_approving_review_count`, `required_review_thread_resolution`,
   `required_reviewers`, `require_extra_approval_for_unattributed_changes`. The last one is treated as
   adding nothing at count 0. The evidence is narrower than a contract: agent-authored, agent-pushed PRs
   (#3331 and the rest) merge with zero reviews while it is true. It does not cover unattributed (app or
   bot) pushes. If the treatment is wrong, the cost is one missing GitHub request, and safe-merge's
   refusal path requests the review anyway. An unknown parameter's name is logged in the
   `[pr-link-review]` line, so a quiet fall-back to always-request can be traced.
3. **Classic protection requires no review.** The agent's login cannot read
   `GET /branches/{b}/protection` (404 for non-admins), so that read is not used. GitHub's own computed
   `reviewDecision` (GraphQL) is used instead. It is `REVIEW_REQUIRED`, `CHANGES_REQUESTED` or `APPROVED`
   whenever classic protection requires reviews. Any non-null value gives `required`, and a failed read
   gives `unknown`. (A ruleset code-owner requirement leaves it null, per PR #2812 2026-11-05. That case is
   item 4. Checked 2026-11-17: registry PRs #3296, #3219, #3200 and #3097 each carry an APPROVED review and
   read `reviewDecision: null`, so on this repository a non-null value appears only under classic required
   reviews. GitHub documents the enum values, not the null case. Bots such as Kodiak and Mergify read it the
   same way, so this is established practice, not a formal contract. The cost bound above applies.)
4. **The PR touches no code-owned file.** CODEOWNERS is read from the base branch in GitHub's order:
   `.github/CODEOWNERS`, then `CODEOWNERS`, then `docs/CODEOWNERS`, first found. The base-branch read is deliberate:
   a PR that edits CODEOWNERS cannot change its own answer, and that edit is itself an owned touch. All three returning 404
   with a governed surface gives `unknown`. The changed files (`pulls/N/files`, paginated) contain no
   path `codeOwnedFiles` marks as owned. A rename counts by both its new path and its `previous_filename`,
   so moving an owned file away is a touch. A file list at GitHub's 3000-file cap gives `unknown`.

   This is the third reader of code ownership, after safe-merge's `fetchCodeOwnership` and the watcher's
   `codeOwnedPaths`. Those two read only `.github/CODEOWNERS` and treat a 404 as "nothing owned". This one
   is stricter (three locations, all-404 is `unknown`). The difference is intended: its only effect is
   skipping a request, so an unread answer must not skip it. The other two readers' narrower lookup is a
   found problem. It goes to the feedback queue (triage: not blocking, not major).

Any read error, unparseable answer or timeout gives `unknown`. Only `not-required` changes behaviour.

- **No re-read:** the PR view the hook already holds supplies the base branch.
- **Parallel reads:** four logical lookups (rulesets, `reviewDecision`, CODEOWNERS with up to two
  fallbacks, the paginated file list) run at once.
- **Own time budget:** `APPROVAL_FACT_BUDGET_MS` = 6 s. Unanswered gives `unknown`, i.e. today's request,
  and leaves the rest of the hook's existing 10 s budget for the request and its read-back.
- **Overall timeout unchanged:** the 10 s budget is shared by all links in a message, and the 6 s fact
  budget is per link (they run in parallel). If the whole hook overruns, today's outcome applies: the
  reply goes out with the existing "could not confirm … as a reviewer" note, and an in-flight request may
  still land. A link past the 5-link cap is not checked at all (today's behaviour).
- **No memo.** The fact is read only for agent-authored open PRs with a resolved reviewer, the PRs that
  already cost the hook several reads, and for at most 5 links (`MAX_PR_LINKS`, existing).

**Switch:** `prLinkReviewRequest.requestWhenNotRequired: true` restores the old always-request
behaviour without a deploy. It is read on every call, and when absent it is `false`. The whole hook keeps
its existing `prLinkReviewRequest.enabled` switch.

**The 2026-11-10 directive** ("every time you send me a link, I actually am a requested reviewer") was
about links asking for his approval (#3046 was an approval ask). His 2026-11-17 words ("why is this
something that requires my approval?", "This is an instar violation") settle that a PR needing no approval
should not ask him for one, and a GitHub review request is such an ask. A constitution PR touches a
code-owned file, so its fact is `required` and it always keeps the request.

A spec for a constitution amendment: its spec PR touches `docs/specs/` only, so its fact is `not-required`
and no GitHub request is made on the spec PR. The operator's GitHub approval of a constitution change is
given on the PR that edits the registry or CODEOWNERS, which always gets the request. The chat ask
about the spec is unaffected: this hook never changes the message, it only skips the GitHub request.

### Migration parity

- **New `PostUpdateMigrator.migrateApprovalWhereRequired()`.** For each of `instar-dev` and
  `spec-converge`, it applies the table's exact prior→next replacements:
  - **Where:** the canonical `.instar/skills/<name>/SKILL.md` and both renderings (`.claude/skills`,
    `.agents/skills`), in place. Unrelated edits are preserved.
  - **Re-stamping:** a rendering whose `x-instar-stamp` equalled the old canonical body hash gets the new
    one, so the parity rule sees no drift. The same replacements leave the rendering's body equal to the
    new canonical body, which is checked before re-stamping. A rendering already in conflict keeps its stamp.
  - **Done:** a sentence counts as done when its next text is present.
  - **Customized:** a sentence found in neither form is left alone and reported as a skip line.
  - **Idempotent:** once replaced, no prior remains. No marker is needed.
- **Already covered:** `templates/report.md` is an existing `alwaysOverwrite` mirror entry.
- **Needs nothing:** the awareness entry (rebuilt on every update) and the hook (server code).

## Decision points touched

| Decision point | Classification | Floor / arbiter / justification |
|---|---|---|
| `approvalRequirement`: will GitHub merge this PR with no approval? | invariant; basis: external-constraint; evidence: GitHub enforces the ruleset, classic protection and CODEOWNERS at merge, and the fact reads those settings or GitHub's computed `reviewDecision` | A deterministic prediction over recorded governed state. It is exact where GitHub's settings are read directly, and inferred from observation for the null `reviewDecision` case and the unattributed-changes flag (both stated in Part 3). It is never the enforcement: GitHub's merge protection is, so the prediction only decides whether to send a request. Every unread or unrecognized input gives `unknown`, never `not-required`. A wrong `not-required` costs one missing GitHub request. GitHub still refuses the merge, and safe-merge's refusal path requests the review itself. |
| Send-time review request skipped for `not-required` | invariant; basis: external-constraint; evidence: the request asks for an approval the repository's rules do not require, and the operator's recorded instructions (2026-10-22 "I should ONLY have to approve constitution changes"; 2026-11-17 "why is this something that requires my approval?") reserve only the code-owned surface | `ungoverned` / `unknown` / `required` keep today's request. The switch restores always-request. |
| Skill migration: replace exact stock sentences | invariant; basis: enumerable-domain; evidence: a fixed table of exact sentences in two files, every shipped variant covered (git history checked) | A missing sentence is reported and left alone, never guessed. |


## Signal vs authority

No decision about meaning is added; nothing judges message text. The change adds no authority. Part 3 only removes a side effect (a GitHub review request), on a
deterministic prediction of GitHub's own rule. Parts 1 and 2 are instruction text. The outbound tone gate is unchanged.

## Verify the state, not its symbol

- **Symbols:** GitHub's ruleset answer, `reviewDecision`, CODEOWNERS and the file list.
- **State:** "GitHub will merge this PR with no approval".
- **Corroboration:** GitHub's merge outcome itself. A wrong fact can only produce a refused merge, which
  safe-merge answers by requesting the review. It can never produce a merge that skipped a required review.
- **Unmeasurable:** `unknown`, which keeps today's behaviour.
- **Classic protection:** not read directly (unreadable to the agent). GitHub's computed `reviewDecision`
  stands in for it, and its failure is `unknown`.

## Multi-machine posture

- **Fact:** unified via the shared upstream. Every machine reads GitHub with its own login. No state, no
  cache. A machine whose login cannot read something gets `unknown` there and keeps today's behaviour.
- **Skill text and awareness entry:** delivered to every machine's agent home by the update path.
- **No durable state is added.**

## Over-block and under-block

- **Over-block** (a request skipped that should be made): only when the fact reads `not-required`
  wrongly. Bounded above. The operator's chat ask is never touched.
- **Under-block:** a session that still asks in chat out of habit is not stopped by code. The
  instructions it reads (skills and awareness) now say not to. A measured recurrence would justify a
  judged backstop. It will show up as an operator correction in the correction ledger, which is where
  this one surfaced.

## Constitution check engagement (round 2 flags)

- *Structure beats Willpower*: the chat ask is left to instructions. Those instructions are delivered
  structurally: the awareness entry is written into every session's instructions by the update path, and
  the skill is the instar-dev entry point that the commit hooks enforce. A code check on chat asks was
  weighed and rejected (Frontloaded Decision 1). The residual risk is named in Under-block, along with
  how a recurrence would be seen.
- *Conservative Outbound*: ungoverned repositories keep today's request. That is the status quo, kept
  because nothing in such a repository says who approves, and their operators' wishes are theirs to
  state (Sovereignty).
- *Judgment Within Floors*: the 5-link cap and the 10 s budget are the hook's existing limits, unchanged
  by this spec. The new 6 s fact budget is a share of that 10 s, sized so the request and its read-back
  (two calls, measured at 0.64-0.70 s together on the Mac Studio, 2026-11-17) still fit. Every overrun lands on today's request,
  the conservative side. A link past the cap, or a slow read, keeps today's behaviour (the request), the
  conservative side.
- *Live-User-Channel Proof*: the hook runs only in the server, so a real-channel proof needs the released
  build. After release, the first outbound reply carrying an open agent PR link on the Studio is read back
  from the server log (`[pr-link-review] …: skipped-no-approval-required`) and from GitHub's
  requested-reviewers list. Before release, the live proof is the module against real GitHub (Testing).

## Maturation plan

- **test-agent-live:** the unit and integration tests drive the real hook through `/telegram/reply` with a fake GitHub, on both sides of every boundary. The built module is then run against real GitHub: this PR reads `not-required`, a merged registry PR reads `required`. No message is sent.
- **dev-agent-live:** Echo, from the release that carries it. The first outbound replies carrying an open agent PR link are read back from the server log (`[pr-link-review] …: skipped-no-approval-required` for a governed non-code-owned PR, `requested` for a code-owned one) and from GitHub's requested-reviewers list.
- **fleet:** on by default with the release. It is a bug fix restoring the operator's stated rule. It changes nothing for repositories without a code-owner rule, and `prLinkReviewRequest.requestWhenNotRequired: true` restores the old behaviour per agent.
- **graduation criterion:** over 14 days on Echo: every logged fact for a governed PR matches what safe-merge did at merge (no `not-required` PR refused with `refused:approval-required`), and the operator makes no correction about being asked to approve something nothing required. A refused merge on a `not-required` fact is a failed graduation and reopens this spec.
- **dark-window:** none. The change only removes a false ask and corrects instruction text, and the switch is the rollback.
- **ladder:** prLinkReviewRequest

## Frontloaded Decisions

1. **No outbound-gate rule.** Round 1 (three internal reviewers and GPT-6 Astra) found it unnecessary once
   the causes are fixed (2.0 Rule 116). It would also be new blocking authority whose fact has blind spots
   on repositories the agent cannot fully read. Reconsider it only on a measured recurrence.
2. **The fact is the repository's rules, scoped to repositories that name a code-owner surface.** Not a
   list of one operator's files, and nothing changes for repositories with no such rule.
3. **The request is narrowed, not removed.** Constitution PRs keep it. The 2026-11-10 directive is read
   with the 2026-11-17 words, as stated in Part 3.
4. **`publish-spec-review` is unchanged.** The skill says when to use it.
5. **Spec approval is recorded by the agent** (`approved: true` + `approved-by` with basis), except for a
   constitution or protected-list amendment or a reservation the operator recorded. This writes down
   practice; the pre-commit check is unchanged.
6. **The 1.x registry is not amended here.** Its *Agent Proposes, Operator Approves* does not carry 2.0
   Rule 82's sentence "the operator is asked only for changes to the constitution and to the short
   protected list". Adding it is a constitution change, so it is the operator's. This fix does not depend
   on it. CODEOWNERS and the 10-22 directive already settle the practice. It is reported to the operator
   as a constitutional finding, not a blocker.
7. **A reservation the operator recorded on a non-code-owned PR gets no GitHub request** (round 3). Such
   a PR needs no GitHub approval to merge, so the approval of record is the operator's explicit yes in the
   conversation (Rule 98: an explicit yes, recorded). The ask itself is unaffected, because this change never
   alters a message. Intent plumbing from every approval workflow into the hook was weighed and not added
   (Rule 116: no named failure it prevents that the chat yes does not already cover). An operator who wants
   a GitHub request on every linked PR sets `prLinkReviewRequest.requestWhenNotRequired: true`.

## Testing

- **Unit, `approvalRequirement`:** both sides of every boundary.
  - Governed vs ungoverned.
  - Count above 0, last-push approval, `required_reviewers` non-empty, unknown parameter.
  - The unattributed flag with count 0.
  - `reviewDecision` null vs `REVIEW_REQUIRED` vs read failure.
  - CODEOWNERS in each of the three locations and all-404.
  - An owned file touched vs not, and the 3000-file cap.
  - Every read error gives `unknown`.
- **Unit, hook:** `ensureReviewerOnPr` skips with `skipped-no-approval-required` for `not-required`.
  It requests for `required` / `unknown` / `ungoverned`. The switch restores always-request, and the
  passed PR view is not re-read.
- **Unit, migration:** `migrateApprovalWhereRequired` covers:
  - stock canonical and renderings updated and re-stamped;
  - a customized sentence reported and preserved;
  - idempotence.
- **Unit, skill text:** the bundled skills contain every `next` and no `prior`.
- **Unit, PR-links section:** the template and the migration constant are equal, and the first-version
  body is reworded in place, once.
- **Unit, awareness entry:** passes `tests/unit/awareness-entry-registry.test.ts`.
- **Integration:** `/telegram/reply` through the real middleware with a mocked `gh`. A link to a governed
  not-required agent PR gets no POST to `requested_reviewers`. A code-owned PR gets it.
- **E2E:** the production server init mounts the hook with the new deps, checked by the existing
  wiring/alive check pattern.
- **Live proof:** the built module is run against real GitHub. This PR's own fact must be `not-required`,
  and a past merged registry PR's fact must be `required`. No messages are sent and no reviewer is
  requested, so there is no test traffic on the operator's topics.

## Existing requests

Reviews already requested on open agent PRs that need no approval stay in the operator's queue: the
change only stops new ones, and automatic removal would be new authority. As an ordinary operator chore,
the fixer removes the operator's pending request from PR 3326 (`DELETE …/requested_reviewers`) and
reports it. Other open agent PRs are left alone.

## Left behind

- safe-merge and the watcher read CODEOWNERS only from `.github/` and treat a 404 as "nothing owned".
  Filed to the feedback queue.
- A precommit refusal of an agent-written `approved-by` on a constitution spec was considered. GitHub's
  code-owner review on the registry PR is the enforced point (Rule 82), so it is not added.
- The live proof through a real channel waits for the release (see the constitution engagement section).

## Rollback

Revert the PR. No durable state is added. `prLinkReviewRequest.requestWhenNotRequired: true` restores
the old hook behaviour without a deploy. Skill copies migrated in place keep the new sentences until a
later update. That is harmless, since the wording matches practice.

## Open questions

*(none)*
