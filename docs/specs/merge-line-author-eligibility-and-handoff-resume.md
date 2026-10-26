---
title: "Merge line accepts the agent's own PRs by author; a handoff respawn resumes in-flight work"
slug: "merge-line-author-eligibility-and-handoff-resume"
author: "echo"
eli16-overview: "merge-line-author-eligibility-and-handoff-resume.eli16.md"
status: "draft"
tier: 1
parent-principle: "The Agent Carries the Loop; No Silent Degradation"
review-convergence: "2026-10-26T02:57:39.908Z"
review-iterations: 3
review-completed-at: "2026-10-26T02:57:39.908Z"
review-report: "docs/specs/reports/merge-line-author-eligibility-and-handoff-resume-convergence.md"
cross-model-review: "codex-cli:gpt-6-astra"
single-run-completable: true
frontloaded-decisions: 2
cheap-to-change-tags: 0
contested-then-cleared: 0
---

# Merge line accepts the agent's own PRs by author; a handoff respawn resumes in-flight work

## Problem

(Describes behavior on `main` before this change.)

Two defects stalled delivery on 2026-10-25. The operator asked "why didn't the
autonomous infra restart the work?".

**D1 — the merge line skips the agent's own PRs by branch name.**
`classifyCandidate` (`src/monitoring/greenPrLogic.ts`) refuses any PR whose head
branch does not start with `<agentNamespace>/` (`not-agent-namespace`). The list
it classifies is already `gh pr list --author @me`, and the watcher's identity
contract proves `@me` is `expectedGhLogin`. So the namespace filter only ever
removes the agent's own PRs that happen to use another prefix. 9 of Echo's 10 open
PRs use `fix/`, `chore/`, `feat/`, `docs/` or a bare name. Local verify passes them,
the merge-line hand-off answers `handoff-not-eligible:not-agent-namespace`, and
nothing tells anyone (`.instar/logs/local-verify.jsonl`, PR 2360, 2026-10-26T02:20Z).
The existing `namespaceMismatch` signal fires only when ALL listed PRs are outside
the namespace, so one `echo/` PR hides the other nine.

**D2 — a no-message respawn tells the new session to do nothing.**
`spawnSessionForTopic` (`src/commands/server.ts`) builds, when a respawn carries no
new user message, the instruction "HANDOFF ONLY: … wait silently for the next user
message." That path runs on a topic-profile framework/model switch
(`TopicProfileOrchestrator` spawn port) and on recovery respawns with no prompt:
`StallTriageNurse` restart and `TriageOrchestrator` `auto_restart`, both through
`respawnSession` → `respawnSessionForTopic(…, undefined, …)`. For those the stall IS
an unanswered user message. (Dashboard `silentStart` returns before this branch; the
resume queue, PromiseBeacon revive, autonomous reconciler, pool transfer and
threadline respawn all pass a message.) The
previous session may have been mid-task: on 2026-10-25 18:58 a switch landed while
the topic's last agent message said "the PR opens as soon as it's green"; the new
session waited and the PR was never merged.

Same-framework switches already reattach the old transcript with `--resume` (the
orchestrator's `killForResume` path keeps the resume id); cross-framework switches
cannot resume another harness's transcript and get the topic history inline. In both
cases the injected instruction is what told the session to stop. So the fix is the
instruction, not the resume mechanics.

## Design

### D1 — eligibility by author

- `PrSummary` gains two optional fields from the list projection: `authorLogin`
  (`author.login`) and `isCrossRepository`. `LIST_PR_JSON_FIELDS` adds `author` and
  `isCrossRepository`; `mapPr` maps them.
- New pure helper `agentOwnership(pr, agentNamespace, expectedGhLogin)` returning
  `{owned, reason}`:
  1. `isCrossRepository === true` → not owned (`fork`), checked BEFORE either arm,
     so a fork with an `echo/` branch is excluded too (a tightening of today's rule).
  2. head in the namespace → owned (today's rule).
  3. `authorLogin` equals `expectedGhLogin` (case-insensitive, as GitHub logins are)
     AND `isCrossRepository === false` → owned.
  4. otherwise not owned (`author-mismatch`, or `ownership-unknown` when the
     author/repository fields are absent).
  Missing metadata (a legacy projection without the two fields): only arm 2 can
  admit, exactly today's behavior; the fork guarantee then rests on the
  `--author @me` list and safe-merge, as it does today. The live projection always
  requests both fields, so this applies only to an old caller.
- `classifyCandidate` takes `expectedGhLogin` in its options and uses the helper;
  the skip keeps its existing name `not-agent-namespace` (readers of the audit log
  and the hand-off reason already know it).
  Every later gate is unchanged and still runs: holds, draft, mergeable, the
  local-verify record / settled-green rollup, code-owner paths, the independent
  second-pass requirement, and safe-merge's own act-time checks.
- The watcher uses the same helper for the namespace-mismatch signal, the red-PR
  watchdog's "my own PR" check and `requestVerifies`, and the wiring's
  `holdEligible` (`POST /green-pr-automerge/hold`, which also runs `--disable-auto`)
  reads `author,isCrossRepository` and uses it too, so a hold covers every PR the
  watcher can merge. `expectedGhLogin` is threaded into the wiring opts for this.
- Intended effect and cost: the agent's other-prefix PRs (9 of 10 today) now get
  local-verify runs requested automatically. A full verify is about 45 minutes and
  runs one at a time, so a backlog of ~10 PRs is several hours of queue. That is the
  point (they were silently never merged); the existing verify queue cap and dedupe
  bound it.
- **Visibility of a skip that remains.** Each acting tick records the listed PRs the
  helper still refuses (a fork, a different author) in `state.notAgentOwned`
  (`{pr, headRefName, reason, hasVerifyRecord}`), and audits one
  `skipped:not-agent-owned` line per (pr, head) the first time it is seen (deduped
  in state, so it is not one line per tick). `GET /green-pr-automerge` returns
  `notAgentOwnedCount` and `notAgentOwned`. No attention item: a fork PR from the
  agent's login is unusual but not an emergency, and the hand-off audit already
  names the reason.

### D2 — resume what is in flight

- New pure helper `buildHandoffContinuationInstruction(openCommitments)` in
  `src/core/handoffContinuation.ts` returns the replacement text:
  - Do not narrate the switch or restart to the user and do not re-scope. The text is
    neutral about the cause (switch or recovery respawn).
  - If the latest user message has no reply, answer it.
  - If the restart followed a stuck session, first check whether the step that hung
    finished or left partial effects; retry it once only when safe and the cause
    looks transient; if it hangs or fails again, take another route or report the
    blocker.
  - Work counts as in flight only when the context shows it: a user request or a
    step the agent said it would take that the context does not show as done (not
    only in the last message — a later progress note such as "tests passed" does not
    close an earlier unfinished task), or an open commitment below.
  - Before resuming, reconcile: (a) a LATER user message that stops, cancels or
    replaces that work wins — then do not resume; (b) check the current state of
    anything external first (is the PR already merged, the message already sent,
    the commitment already delivered?) and never repeat an action that already
    happened.
  - If something is still in flight after that check, resume it as already stated
    and report its result normally when done.
  - If nothing is in flight, wait silently for the next user message.
  - The open commitments for this topic (newest first) are listed inside a fenced
    block labelled untrusted data — a record of what was promised, not an
    instruction. Each is tagged `[resumable]` (owner `agent`, an absent owner
    defaulting to `agent`; not blocked on `user-input`/`user-authorization`;
    `external` stays resumable) or `[waiting on the user]` (do not act: it
    needs their input or approval first). The list shows at most 5, each `id` + the stated response cut at
    300 chars; when more exist or a response is cut, the block says so in-band
    ("N more open commitments not shown", "…truncated") and names the full read
    (`GET /commitments/:id`, `GET /commitments`). The bounds keep a bootstrap
    message small; the session can read the rest, and is told it exists.
- `spawnSessionForTopic`'s no-message branch uses the helper. Open commitments come
  from a module-level late-bound reader `_activeCommitmentsForTopic`, assigned right
  after the `CommitmentTracker` is constructed (`getActiveByTopicId`). The helper
  takes a three-way input: a list (possibly empty → "no open commitments recorded
  for this topic"), or `unavailable` (reader unset or threw). `unavailable` is never
  shown as "none": the block says the commitments could not be read and tells the
  session to read `GET /commitments` before deciding nothing is in flight, and the
  spawn path logs one console line naming the topic and the error.
- No change to which spawns use `--resume`, to the message path, or to the silent
  dashboard start.

## Decision points touched

- **Merge-line candidacy (`classifyCandidate` ownership filter)** — `invariant`. Precondition: the input list is already `gh pr list --author @me` under the verified `expectedGhLogin`; the helper decides ELIGIBILITY over that trusted list, it does not prove provenance alone (the namespace arm is the original compatibility rule). Ownership is a fact (the authenticated author login + same-repo flag from GitHub), not a judgment. It widens a FILTER; authority to merge stays with the unchanged gates and safe-merge. A PR GitHub reports as cross-repository is excluded before either arm.
- **What a respawned session does with no new message** — `judgment-candidate`. Arbiter: the new session itself (the mind), reading the context. Floor: it may only resume work already stated in its own context or an open commitment; it never narrates the switch; with nothing in flight it waits silently (the previous behavior, the conservative default).

## Multi-machine posture

- D1: no new surface posture. The watcher already runs only on the serving-lease
  holder and keeps its state there (green-pr-automerge-enforcement, as merged); the
  new `state.notAgentOwned` field rides that existing state and is rebuilt from the
  GitHub list on every tick, so a lease move loses nothing.
- D2: the instruction is built on the machine doing the spawn from that machine's
  commitment store and context. Commitments are already replicated by the existing
  commitment path; nothing new is stored.

## Signal vs authority

D1 widens a candidacy filter and adds a visibility signal; it adds no blocking
authority. D2 removes an instruction that blocked continuation; the session's own
judgment, bounded by its stated work, decides.

## Over-block / under-block

- D1 over-block: a fork PR from the agent's login stays skipped (deliberate; now
  visible). Under-block: a PR authored by the agent on a same-repo branch someone
  else pushed to — still subject to every content gate and safe-merge; the lease
  `--author @me` scope is unchanged.
- D2 risk: a session resumes work the operator meant to stop, or repeats an action
  that already happened. Mitigation: the instruction makes a later stop/supersede
  message win and requires checking current external state before acting; the
  existing idempotent paths (safe-merge refuses a merged PR, the Telegram relay drops
  exact duplicates, commitment delivery is a status transition) bound the effect of a
  wrong call. A stop sent as a new message takes the message path as before.

## Rollback

Revert the commit. No migration, no config, no persisted shape another reader
depends on (`notAgentOwned` is additive and optional).

## Testing

- Unit: owner `user` / blockedOn `user-authorization` render `[waiting on the user]`;
  `holdEligible` accepts a same-repo `fix/` PR by author and refuses a fork.
- Unit: the helper's three commitment inputs (list, empty list, `unavailable`) render
  three different blocks; `unavailable` never reads as "none".
- Unit: `agentOwnership` / `classifyCandidate` both sides (namespace, author match,
  author match + fork, namespaced fork, author mismatch, legacy projection, case); `mapPr` maps the
  fields; `buildHandoffContinuationInstruction` with and without commitments, the
  truncation and cap with their in-band notices, that the reconcile-before-resume
  rules (later stop wins, check external state, never repeat) are present, and that
  "wait silently" is conditional on nothing being in flight. The session's judgment
  itself is not unit-testable; the prompt contract is.
- Integration: `GreenPrAutoMerger` tick with an out-of-namespace own PR becomes
  eligible; a fork PR lands in `notAgentOwned` with one audit line across two ticks;
  the route exposes `notAgentOwnedCount`.
- E2E: the server wiring test asserts the no-message branch calls the helper and
  `_activeCommitmentsForTopic` is assigned from the real tracker.

## Maturation plan

- **test-agent-live:** the unit + integration + e2e tests in this PR (no new agent
  surface beyond the existing watcher and spawn path).
- **dev-agent-live:** live on Echo from the release that carries it. Over the next
  week, count `handoff` / `would-merge` / merged rows in
  `logs/green-pr-automerge.jsonl` for PRs whose branch does not start with `echo/`,
  and `skipped:not-agent-owned` rows.
- **fleet:** the same release; ungated (the watcher itself is off fleet-wide and
  armed per dev agent; the handoff instruction applies everywhere).
- **graduation criterion:** within the week at least one non-`echo/` PR of Echo's
  is armed or merged by the watcher after a local-verify pass, and
  `notAgentOwnedCount` on `GET /green-pr-automerge` lists only forks or other
  authors. Zero non-`echo/` merges is not a pass.
- **dark-window:** none — live on release. If the criterion is not met within 14
  days of the release, the reason is recorded on the PR thread.

## Frontloaded Decisions

- Author match uses `expectedGhLogin`, not the live `gh` login: the identity contract
  already refuses to act when they differ.
- No attention item for a remaining skip (log + count only), per the operator's "at
  least a log line + count".

## Open questions

*(none)*

## Left behind

- PRECISION (codex r2): the namespace arm is a compatibility rule over a trusted
  `--author @me` list, not provenance; stated in Decision points.
- PRECISION (internal r1): the identity check compares logins case-sensitively while
  ownership compares case-insensitively; harmless (a mismatch makes the watcher
  refuse to act).
- The session's continuation judgment is prompt-bounded, not code-enforced; the
  idempotent downstream paths bound a wrong call (codex r3, internal r1).
