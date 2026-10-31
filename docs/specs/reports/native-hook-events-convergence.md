# Convergence Report — Native hook events

## Cross-model review: codex-cli:gpt-6-astra

A real GPT-tier external pass ran in every round through the agent's codex CLI (7 passes across 6 rounds). Gemini was not available (`gemini-not-installed`); Grok is not enabled. The Standards-Conformance Gate was unavailable every round: `POST /spec/conformance-check` only reads specs inside the agent home's `docs/specs/`, and this spec lives in an instar worktree (feedback fb-3bdf0337-7a0). The lessons-aware reviewers searched `docs/STANDARDS-REGISTRY.md` directly.

## ELI10 Overview

While an agent works, Claude Code runs small "hook" programs at fixed moments. One of them, the event reporter, only tells the agent's main server "this happened", and it starts a whole program each time, after every single tool call and at six other moments. Claude Code can now deliver that news straight to the server with no program at all. This spec switches the reporter over, switched off by default.

Measuring it showed the reporter has barely worked: it recorded every event except "a tool was used" as "Unknown", so several features waiting for "session stopped", "helper finished" or "task completed" have never received one. Fixing the names would suddenly switch those features on, and one of them would have checked every conversation whenever any one of them compacted its memory. So the spec reviews each newly fed feature and corrects it first.

The task as written asked for a "dispatcher" that runs all of an event's hooks in one program. That was prototyped and measured: it saved about a third of the processor time and broke a security check, so it was rejected with the numbers.

## Original vs Converged

- **Scope.** The first draft also skipped five advice checks with Claude Code's per-hook conditions. Review showed Claude Code would run some of them twice, and one does more than it appears to, so that part was dropped and queued (fb-81852c3a-3a3).
- **A live bug split out.** Review found the reporter registered on two events where Claude Code expects the hook to *create and remove working copies itself*; tested for real, this breaks Claude Code's own working-copy feature in every Instar session. That fix ships separately as PR #2423.
- **Dead features coming alive.** Each round found more consumers that would start receiving data for the first time (the subagent tracker, a watchdog that types warnings into sessions, a kill veto, a silence-alert suppressor). The converged spec gives each a reviewed posture; the watchdog's typed warnings stay off, and the "helper is still running" list gets a one-hour limit so a missed message can never silence a safety check forever.
- **What is stored, and where it goes.** The draft kept command text and long messages; the converged spec stores a typed, size-bounded set of fields, blanks credentials before shortening a message, keeps the folders out of the file viewer and out of git sync (one agent's repository was already uploading a copy), and never touches a user's own repository.
- **Not a new hole.** The draft parsed large bodies before checking who sent them; the converged spec checks location, token and size before reading anything, and bounds the work queue so the server stays responsive.
- **Migrations.** Review found existing migrations would have silently reverted the new entries; the path was renamed and the migrations taught to leave it alone, and the session-id bridge that resume depends on is kept.

## Iteration Summary

| Iteration | Reviewers who flagged | Design findings | Left behind | Spec changes |
|-----------|-----------------------|-----------------|-------------|--------------|
| 1 | security, integration, GPT | 14 | 15 | if-filters dropped; worktree bug found; migrations; session bridge; subagent consumers; projection; guard before parsing |
| 2 | integration, GPT | 3 | 9 | subagent staleness cap; tmux-scoped methods; incarnation-checked compaction trigger |
| 3 | GPT (internal: none) | 2 | 10 | redact-then-truncate; incarnation-scoped SessionEnd |
| 4 | integration, GPT | 3 | 8 | git-ignore migration; typed bounded schema; bounded queue |
| 5 | GPT (internal: borderline 1) | 2 | 7 | live sessions never evicted; untrack only where instar owns commits |
| 6 | GPT (internal: none) | 2 (applied at cap, not re-reviewed) | 3 | launch-time settings check; drain budget with yielding |

Standards-Conformance Gate: unavailable every round (specPath escapes specsDir; fb-3bdf0337-7a0).

## Proportion

Tier 2 (it changes what every Claude Code session runs and what the server stores); 6 rounds of a 6-round cap; the spec grew to ~190 lines for a change touching about 10 source files. ⚠ The full cap was used. Most rounds removed a factually wrong premise or a newly-fed consumer rather than polishing, because the reporter had been mostly dead for a long time and each fix exposed another sleeping consumer.

## Left behind

- Round 6 GPT design findings, applied at the cap without a further round (neither is safety, security or data loss): launch-time re-validation of reporter entries; a 50-events-or-10-ms drain budget with yielding.
- `if` filters on advice-only hooks — feedback fb-81852c3a-3a3.
- Hook timeouts written in milliseconds where Claude Code reads seconds — feedback fb-a0852d6a-bf0.
- The Codex script's `hook_event` naming bug, deliberately left (fixing it would switch on the same consumers for Codex; separate review).
- The worktree-event fix ships as PR #2423, independent of this spec.
- Eviction can exceed 50 sessions by the number of live runs (bounded elsewhere).
- Precision items from every round were applied in passing or are wording only.

## Full Findings Catalog

Every round's internal reviewers (round 1: security+scalability and integration+decision-completeness+lessons; rounds 2–6: one full-lens reviewer) and GPT outputs (retained on Mama PC at `/home/echo/echo-test-tmp/codex-h{1..7}.json` for the build) were folded into the spec as listed above. The decisive facts each round turned on are recorded in the spec itself with file:line references and the live checks run on Claude Code 2.1.310 (HTTP hooks delivered, header variables expanded and unset ones sent empty, worktree hooks replacing git behaviour).

## Convergence verdict

Converged at round 6 (the Tier-2 cap). The final internal round found no design-class issue; the final external round's two design findings were non-safety corrections with concrete fixes, applied and recorded above. Zero open user decisions. Spec is ready for build.
