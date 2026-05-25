# Codex Parity — Tracked Follow-Ups

Companion to `codex-enforcement-hook-layer.md`. Captures parity work that is
real but out of the enforcement-layer ship, so nothing is silently dropped.
Each item is owned here until promoted to its own spec or closed.

_Last updated: 2026-05-25 (echo)._

## A. Compaction-recovery parity (design needed)

Claude agents survive context compaction because `SessionStart(source=compact)`
re-injects identity via `additionalContext`. Codex has **no** such path:
- Codex `SessionStart` triggers are `startup/resume/clear` — no `compact`.
- Codex's `PostCompact` output schema (verified vs the 0.133 binary) is only
  `continue/stopReason/suppressOutput/systemMessage` — **no `additionalContext`**,
  the only field that re-injects context into the model.
- Only `SessionStart` and `UserPromptSubmit` carry `additionalContext`.

So a Codex agent silently loses identity/topic context on compaction.
**Candidates:** (1) ride the next `UserPromptSubmit`'s `additionalContext` to
re-inject after a compaction boundary; (2) test whether `PostCompact`'s
`systemMessage` is surfaced into the post-compaction model context (needs a live
0.133 experiment — do NOT assume). Needs a small spec + live verification before
any wiring. (A naive PostCompact→compaction-recovery wiring was built and
**discarded** this session because it would have been a no-op.)

## B. PermissionRequest live-behavior confirmation

`PermissionRequest → external-operation-gate` is wired + auto-decides with no
human prompt (autonomy-preserving). Unconfirmed: whether the event **fires at
all** under `--dangerously-bypass-approvals-and-sandbox` (likely suppressed →
the registration is defensive, `PreToolUse` is the real gate). Needs one
interactive codex 0.133 run that triggers a permission escalation. No code
change expected either way.

## C. Broader Claude-hook parity audit (per-hook applicability)

Claude installs more hooks than Codex currently gets. Audit of each Claude hook
**not** yet wired on Codex, with a Codex-applicability verdict:

| Claude hook (event) | Codex applicable? | Note |
|---|---|---|
| `slopcheck-guard.js` (PreToolUse/Bash) | **Yes — candidate** | Package-legitimacy check on installs. Codex's `exec_command` is the equivalent surface; real safety value. Wire on Codex PreToolUse (same shim as dangerous-command-guard). |
| `claim-intercept-response.js` (Stop) | **Yes — candidate** | Anti-confabulation claim interception. Framework-neutral (stdin + server). Wire on Codex Stop. |
| `external-communication-guard.js` (PreToolUse) | **Likely — verify** | Identity grounding before external comms. Confirm it's stdin-based + not Claude-tool-specific, then wire. |
| `subagent-start-tracker.js` (SubagentStart) | **Yes — observability** | Codex HAS a `SubagentStart` event. Tracker is observability, not safety; lower priority. |
| `free-text-guard.sh` (PreToolUse/AskUserQuestion) | **No** | Guards the `AskUserQuestion` tool, which Codex does not have. Claude-specific. |
| `skill-usage-telemetry.sh` (PostToolUse/Skill) | **No / different** | Matches the `Skill` tool; Codex has no Skill tool. N/A as-is. |
| `instructions-loaded-tracker.js` (InstructionsLoaded) | **No** | `InstructionsLoaded` is not in Codex's hook-event set (8 events: PreToolUse, PermissionRequest, PostToolUse, Pre/PostCompact, SessionStart, UserPromptSubmit, Stop). |

**Recommendation:** the three "candidate" enforcement hooks (slopcheck,
claim-intercept, external-communication) are the next real parity increment —
they're structural safety/grounding gates Codex agents currently lack. Worth a
focused follow-up spec (same pattern as this layer: wire in `installCodexHooks`,
migration via `migrateHooks`, 3-tier tests, live-prove on a real codex).
