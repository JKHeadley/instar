---
title: Iris-Audit Session Observability & Config-Application Fixes
status: approved
approved: true
approver: echo
approved-at: "2026-06-02T23:59:00Z"
approval-basis: "Justin standing preapproval for autonomous-session instar-dev (build + ship + self-approve, spec convergence as appropriate, proceed carefully)"
created: 2026-06-02
owner: echo
parent-principle: "Observability — you can't tune what you can't see"
eli16-overview: iris-audit-session-observability.eli16.md
phased-delivery-tracked: "PR B = CMT-944"
review-convergence: "2026-06-02T23:58:30.479Z"
review-iterations: 1
review-completed-at: "2026-06-02T23:58:30.479Z"
review-report: "docs/specs/reports/iris-audit-session-observability-convergence.md"
cross-model-review: "unavailable"
cross-model-review-reason: "no codex CLI on host"
---

# Iris-Audit Session Observability & Config-Application Fixes

## Origin

A token-efficiency audit on a deployed Instar agent (Iris) surfaced four issues.
Each is either an **awareness gap** (the agent doesn't know a capability exists or
how it behaves) or a **real code gap**. This spec drives the fixes. All four share
one root: an operator (or the agent itself) could not **see or control** the things
a token/efficiency audit needs to see and control — which model a session runs, what
each feature costs in tokens, and how to push a config change onto live sessions.
That is the constitutional parent: *Observability — you can't tune what you can't see.*

The four items, with the verified verdict from a grounded read of `JKHeadley/main`:

1. **Token metrics zeroed (REAL).** `/metrics/features` reports `tokensIn:0 /
   tokensOut:0` for every feature though call counts work. Root cause: the
   `IntelligenceProvider.evaluate()` contract returns `Promise<string>` (text only);
   `ClaudeCliIntelligenceProvider` runs the CLI with `--output-format text` (which
   discards the usage object); and `CircuitBreakingIntelligenceProvider`'s metrics
   tap records latency/outcome/count but never passes token counts. So the
   `FeatureMetricsLedger` token columns are structurally always null → aggregate 0.

2. **Configured Claude model silently dropped + not recorded (REAL).** The
   interactive `claudeCodeBuilder` resolved `frameworkDefaultModels['claude-code']`
   but never passed `--model` to the `claude` CLI — unlike the Codex and Gemini
   builders, which both do. So the configured default had **no effect** on Claude
   sessions (they ran the CLI account default), and the session record stored a
   model only when a default was set. This is why the auditing agent "changed the
   default model and saw no effect." Contradicts the documented contract on
   `InteractiveLaunchOptions.defaultModel` ("Claude inherits its CLI's account
   default" only WHEN UNSET).

3. **No bulk force-restart after a config change (REAL gap; single-session exists).**
   `POST /sessions/refresh` already restarts ONE session (kill + `claude --resume`,
   conversation preserved). There is no bulk equivalent and no auto-propagation of a
   config change to live sessions, so an operator's only options were "wait for the
   reaper" or refresh each session by hand.

4. **UserPromptSubmit hook in Telegram sessions (AWARENESS, not an injection bug).**
   Instar delivers every Telegram message — whether it opens a session or arrives mid-
   conversation — by typing it into the
   live `claude` pane via `tmux send-keys` + Enter, which is a real interactive
   submission, so `UserPromptSubmit` **does** fire. The reported miss (a hook didn't
   flag a high-stakes draft) is explained by Claude Code loading hooks only at session
   **start**: a hook added mid-session never engages on the already-running session.
   The remedy is operational (restart the session — item 3), not an injection fix.

## Goals

- Make `/metrics/features` report real per-feature token usage.
- Make `frameworkDefaultModels['claude-code']` actually pin the interactive Claude
  model, and make `GET /sessions` report the model each session was launched with.
- Provide a bulk `POST /sessions/restart-all` to apply a config/hook change across
  all running sessions in one operation, preserving each conversation.
- Give the agent durable awareness (CLAUDE.md template + migration) that hooks and
  config load at session start, so applying a change requires a restart.

## Non-goals

- Auto-propagating config changes to live sessions without an explicit restart call
  (a watcher that kills sessions on every config edit is too aggressive; restart-all
  is the explicit, operator-/agent-triggered primitive).
- Changing the `IntelligenceProvider.evaluate()` return type (breaking). Token usage
  is threaded via an additive optional side-channel, leaving every existing caller
  byte-identical.
- Extending bulk restart to non-Telegram-bound (Slack/iMessage/headless) sessions —
  the respawn path is topic-routed, the same v1 limitation as `/sessions/refresh`.

## Design

### Phasing (one spec, two PRs)

This spec is implemented in two sibling PRs that BOTH reference it; every item ships —
none is dropped. The split is durably tracked so it is explicit and audited rather
than implicit. <!-- tracked: CMT-944 -->

- **PR A — session lifecycle (items 2, 3, 4).**
- **PR B — token usage accounting (item 1).** Durably tracked as commitment CMT-944
  so it survives session turnover and is re-surfaced until shipped (Close the Loop).
  <!-- tracked: CMT-944 -->

Both PRs carry a trace referencing THIS approved spec; PR B is not postponed
indefinitely — it is the next scheduled change. <!-- tracked: CMT-944 -->

### Item 2 — Claude builder honors the configured model

`claudeCodeBuilder(options)` resolves `resolveModelForFramework('claude-code',
options.defaultModel)`; when truthy it pushes `--model <resolved>`. When
`defaultModel` is unset the builder pushes nothing, preserving the CLI account
default (the user can still `/model`-switch in-session). Tier aliases
(`fast|balanced|capable` → `haiku|sonnet|opus`) and raw model ids pass through
unchanged via the existing resolver. The interactive `Session` record stores the
model actually launched with — `resolveModelForFramework(framework,
launchDefaultModel)` (post Codex rate-limit swap) — so `GET /sessions` reports the
real running model.

**Activation safety (convergence refinement):** this makes a previously-inert config
*active*. An agent that had set `frameworkDefaultModels['claude-code']` will, on its
next session start (or restart-all), now actually launch with that model. That is the
intended fix and matches the documented contract — but it is a behavior change for any
deployment that set the field and (incorrectly) relied on it being ignored. It is not
a silent switch: nothing changes unless the field is set, the effect appears only on a
fresh session, and `GET /sessions` then shows the model so it is auditable. An invalid
model id (a typo) passes through to the CLI and surfaces as a session-spawn failure —
identical to the existing Codex/Gemini builders, which also validate CLI-side; v1 does
not add config-load-time model validation.

### Item 3 — `POST /sessions/restart-all`

A thin route over the existing `SessionRefresh`. It snapshots running sessions,
filters to Telegram-bound (in-memory OR disk, mirroring `SessionRefresh`'s own
resolution), responds `202 { scheduled, count, skipped }`, then schedules a
**staggered** `refreshSession` per target (500ms + i·750ms) to avoid a kill+respawn
storm. Body: `{ reason?, excludeSession?, followUpPrompt? }`. `excludeSession` lets a
caller keep itself alive. Each `refreshSession` is independently rate-guarded
(5/10min) inside `SessionRefresh`, so a repeated restart-all inside the window is
harmlessly refused per session. Returns 503 when `sessionRefresh` is not wired (no
Telegram adapter), identical to `/sessions/refresh`.

**Semantics, bounds, and interactions (convergence refinements):**

- *Snapshot-time set.* The target set is computed once, at request time. A session
  spawned AFTER the snapshot is neither restarted nor excluded — it simply isn't
  seen. `excludeSession` therefore means "the session name you are calling from at
  request time"; a caller that spawns children mid-burst is responsible for naming
  the one it wants kept alive. This is intended (a one-shot apply), not a race to fix.
- *Fleet-size bound.* The stagger spreads the kick-offs (N sessions → last fires at
  500 + (N−1)·750 ms; e.g. 10 sessions ≈ 7s, 20 ≈ 15s). For instar's realistic
  interactive fleet (single- to low-double-digit topics per machine) this keeps
  respawns from landing simultaneously. There is no fleet-wide concurrency ceiling in
  v1 — the per-session rate-guard is the only aggregate backstop. If a deployment ever
  runs dozens of concurrent interactive sessions, a fleet-wide max-parallel ceiling is
  the tuning knob to add; that is named here as a known bound, not silently assumed.
- *Reaper interaction is not new.* restart-all calls the SAME `SessionRefresh.refresh
  Session` path the shipped single-session `/sessions/refresh` already uses (kill via
  `killSession` which fires `beforeSessionKill`, then respawn). It introduces no new
  reaper coordination surface beyond what single refresh already exercises: a freshly
  respawned session has current activity so the idle-reaper does not immediately reap
  it, and the killed old session is marked `killed` in state. restart-all is N
  sequential, staggered single-refreshes — nothing the single path doesn't already do.
- *Async result visibility.* Like `/sessions/refresh`, per-session refresh outcomes
  are logged (`[sessions/restart-all] refreshed/refused …`); the 202 returns the
  scheduled set, not per-session final status. This matches the established refresh
  contract; a pollable job-status surface is a possible future enhancement, not a gap
  this route regresses.
- *Auth.* `/sessions/*` is operator/Bearer-gated (and denylisted from the agent
  `/capabilities` index); `excludeSession` carries no privilege beyond that existing
  trust boundary.

### Item 4 — awareness + migration parity

A CLAUDE.md template section ("Applying config & hook changes to running sessions")
teaches three things: (1) hooks and config defaults load at session **start**, not
mid-session, so a config/hook change does NOT reach a running session; (2) applying
the change to live sessions requires `POST /sessions/refresh` (one) or `POST
/sessions/restart-all` (all), each preserving the conversation; (3) `GET /sessions`
reports the launched `model` so the operator can confirm what each session picked up.
An idempotent `migrateClaudeMd` backfill delivers the section to existing agents on
update (Migration Parity). Idempotency is a content-sniff: the migration appends only
when `!content.includes('Applying config & hook changes to running sessions')`, so a
re-run is a no-op and reverting the migrator leaves an already-patched file unchanged
(no removal needed). `/sessions/*` is operator/dashboard-facing (the `CapabilityIndex`
denylist already excludes it), so the section is tracked as operational knowledge in
`feature-delivery-completeness`'s allowlist, not as a framework-shadowed capability.

### Item 1 (PR B) — token usage accounting

`ClaudeCliIntelligenceProvider` switches `--output-format text` → `json`, parses the
result object for the response text (`result`) and `usage` (input/output tokens), and
returns the text unchanged. An additive optional `onUsage?(usage)` callback on
`IntelligenceOptions` surfaces token counts without changing the `Promise<string>`
return type. `CircuitBreakingIntelligenceProvider` passes an `onUsage` that records
`tokensIn/tokensOut` into the existing `FeatureMetricsLedger` tap. The rate-limit
classifier reads `stderr`, so the stdout-format change does not affect error/limit
detection; a JSON parse failure falls back to returning the raw trimmed stdout.

## Decision points touched

- `claudeCodeBuilder` argv construction (item 2) — a launch-shape change, no
  block/allow surface.
- `POST /sessions/restart-all` (item 3) — a new action endpoint with real blast
  radius (kills+respawns sessions); reuses the existing rate-guarded `SessionRefresh`
  authority rather than adding a new one.
- `migrateClaudeMd` (item 4) — additive, idempotent, content-sniffed text backfill.
- LLM metrics tap (item 1) — observability only; never gates.

## Testing

Per the Testing Integrity Standard:

- **Unit:** builder `--model` rendering (set/unset/tier/raw/with-resume); restart-all
  route via the real Express pipeline (validation, 202 ack, scheduled/skipped,
  exclusion, staggered dispatch, default reason); migration idempotency; token-usage
  parsing + tap wiring (PR B).
- **Integration:** restart-all over the real `createRoutes` Express pipeline with a
  wired `SessionRefresh` (mirrors `sessions-refresh-route.test.ts`).
- **Route-liveness (Tier-3 intent):** the route is proven *registered* (not 404) in
  the real router — the "503 when sessionRefresh not wired" case hits the route and
  gets a 503, confirming wiring; this matches the established test depth of the
  sibling `/sessions/refresh` (which ships with route-level coverage, no separate
  server-standup E2E). A full server-standup E2E is not added because restart-all
  introduces no new wiring surface beyond the already-E2E-exercised `SessionRefresh`.
- **Parity:** `feature-delivery-completeness` (template ↔ migrator) stays green.
- `tsc --noEmit` and `pnpm build` clean.

## Rollback

Pure code + additive route + idempotent text backfill. Back-out is a code revert
shipped as the next patch. No persistent-state migration, no agent-state repair, no
user-visible regression during the rollback window. The migration only appends a
content-sniffed CLAUDE.md section; reverting the migrator leaves already-patched
CLAUDE.md files harmlessly carrying the section (idempotent, no removal needed).

## Constitutional traceability

Parent: **Observability — you can't tune what you can't see.** Item 1 makes token
cost visible; item 2 makes the running model visible AND controllable; item 3 is the
control surface that applies a tuning decision; item 4 makes the agent aware of how
to use it. Supporting articles: **Agent Awareness** (item 4 template/migration),
**Migration Parity** (item 4 backfill), **Signal vs. Authority** (the metrics tap and
the model record are signals; restart-all reuses the existing refresh authority).

<!-- tracked: CMT-944 — token usage accounting (item 1) ships as sibling PR B referencing this same spec; durably tracked as commitment CMT-944, explicitly phased, not dropped. -->
