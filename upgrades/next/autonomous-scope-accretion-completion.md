<!-- bump: minor -->

## What Changed

Autonomous Scope-Accretion Completion Discipline (spec:
`docs/specs/autonomous-scope-accretion-completion.md`; parent principle:
Deferral = Deletion). The completion judge now refuses `met:true` while
in-scope artifacts an autonomous session ITSELF drafted sit unbuilt without
operator ratification. All load-bearing facts are server-side at the
`POST /autonomous/evaluate-completion` chokepoint: a git-truth sweep over the
run's roots (catches Write/Edit, Bash heredocs, `tee`, subagents identically —
P20), per-class deterministic corroboration (ceremony-record+report for specs,
an exact merged-PR predicate with ≥10 non-docs changed lines, a positive-only
local-git shortcut), and ratification resolved only from the server's own
Telegram receive path or the dashboard-PIN route — never from
session-writable files, never from client-supplied booleans. New:
`POST /autonomous/register` (server-minted runId, config + start-SHA snapshot,
endAt clamp), `POST /autonomous/:topic/run-end` (every exit surface —
met/expiry/hard-blocker/emergency-stop — enumerates unbuilt accreted work
loudly), PIN-gated `ratify-deferral` + `scope-accretion-override`, a persisted
K=3 breaker with a loud distinctly-labeled exit carrying the P13
classification, deletion-is-not-an-exit flagging, advisory layers (stop-hook
Layer-B vocabulary scan with fenced/quoted exclusion; PostToolUse `file_path`
ledger on both hook-template copies; Codex PostToolUse group), config
defaults (`autonomousSessions.completionDiscipline.scopeAccretion`, default
ON — monotone-safe), CLAUDE.md template + PostUpdateMigrator parity (marker
bump REALCHECK_VERIFY → SCOPE_ACCRETION for the stop hook, setup script, and
SKILL.md), and WorkingSetManifest carriage of the new server-owned store.

## What to Tell Your User

Nothing proactively. If asked why an autonomous run "won't finish": the run
drafted deliverables (specs/audits/runbooks/scripts) it hasn't built yet, and
I now structurally hold "done" until they're built and corroborated, were
declared at setup, or you ratify deferring them — say "ratify deferral" in
the run's topic and I'll reply with the exact list for a one-tap yes, or use
the dashboard. Every run exit now tells you plainly if drafted work was left
unbuilt — a silent clock-out is structurally impossible.

## Summary of New Capabilities

- `POST /autonomous/register` — server-side run registration (snapshot + runId).
- `POST /autonomous/:topic/run-end` — loud exit enumeration on every exit surface.
- `POST /autonomous/:topic/ratify-deferral` (PIN) — ratify deferring accreted artifacts.
- `POST /autonomous/:topic/scope-accretion-override` (PIN) — live mid-run lever.
- Conversational ratification at the live Telegram receive path (server-authored
  enumeration; reply-anchored confirmation; verified operator only).
- Config: `autonomousSessions.completionDiscipline.scopeAccretion` (`enabled`,
  `breakerK`) + `autonomousSessions.maxDurationMs`; feature-metrics key
  `scope-accretion`.

## Evidence

Three-tier suite green: 106 unit tests across 7 files (store, sweep,
corroboration, ratifier, stop-hook Layer B, CompletionEvaluator v3 canary),
20 integration tests (route round-trips: register → hold → ratify → met;
PIN contracts; degraded corroboration), 5 e2e lifecycle tests including the
required evasion-shaped case (Bash-heredoc spec + met-looking transcript held
until real ceremony evidence) and the loud labeled breaker exit. Six new
parsers registered with byte-for-byte captured fixtures
(`tests/fixtures/captured/scope-accretion-*/`); `tsc --noEmit` clean; full
unit suite green at push.
