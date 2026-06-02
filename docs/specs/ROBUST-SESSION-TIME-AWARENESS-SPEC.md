---
title: "Robust Session Time Awareness"
slug: "robust-session-time-awareness"
author: "echo"
eli16-overview: "robust-session-time-awareness.eli16.md"
lessons-engaged:
  - "Structure > Willpower — time awareness is computed + injected, never agent-remembered"
  - "P2 Signal vs Authority — the clock injection and the reporting nudge are SIGNAL-ONLY; they never block/rewrite a turn"
  - "P3 Migration Parity — every agent-installed file changed here ships a concrete migration"
  - "P7 LLM-Supervised Execution — the time pipeline is tier0 (pure deterministic computation, no LLM), declared explicitly"
  - "B11 timestamp-check — stale/conflicting injected dates are reconciled, not surfaced verbatim"
  - "L9/B4 — dense spec ships with an ELI16 companion"
supervision: "tier0"
review-convergence: "2026-06-02T06:08:55.969Z"
review-iterations: 3
review-completed-at: "2026-06-02T06:08:55.969Z"
review-report: "docs/specs/reports/robust-session-time-awareness-convergence.md"
cross-model-review: "unavailable"
cross-model-review-reason: "codex installed+authed but binary not reachable from shell env; full internal 5-reviewer + mandatory lessons-aware panel ran 3 rounds to convergence"
---

# Spec — Robust Session Time Awareness

**Status:** DRAFT — converged via spec-converge multi-reviewer panel (security, scalability, adversarial, integration, lessons-aware). Awaiting Justin's `approved: true`.
**Author:** echo · **Date:** 2026-06-02
**Origin:** Live incident 2026-06-02: in a 12h autonomous mandate the agent wrote an "end-of-stretch summary" and wound down at **~4h elapsed** (≈8h remaining), with no idea how much time had passed. Justin: *"this inaccurate tracking of time … seems to be widespread for all agents and all tasks."* Root cause (corrected after review): the agent ran the mandate in **`/loop` dynamic mode with NO autonomous-state record**, so no time-box existed to track at all.

---

## Problem (corrected after review)

An LLM agent has no internal clock; it knows the time only from what hooks inject each turn. Today that is incomplete and uneven. Precise, verified gaps:

1. **No time-box record ⇒ no tracking (the actual incident).** A time-boxed mandate run in **`/loop` dynamic mode** (self-paced `ScheduleWakeup`) writes **no durable started/duration record**. With no record, nothing can compute elapsed/remaining, and the autonomous-stop-hook — the one component that *does* track time — is inert (it keys on `.instar/autonomous-state.local.md`, which `/loop` never creates). The agent flew blind and rationalised a stop. **`/loop` is a Claude Code harness skill instar cannot modify** — so the fix is NOT to instrument `/loop`, it is to make the agent **create an autonomous-state record for any time-boxed run** and to make tracking read that record.
2. **Content gap, not a coverage void, in autonomous mode.** Contrary to the first draft, the autonomous-stop-hook **already injects `${REMAINING_MIN}m remaining`** into every continuation (line ~599/610). But it is **minutes-only remaining** — no absolute wall-clock, no elapsed, no percent, no human formatting ("480m remaining" vs "8h 0m remaining, 33% elapsed"). And on **user-prompt turns** the existing `telegram-topic-context.sh` injects absolute `CURRENT TIME` (verified: lines 18–24 of the deployed hook, sourced from the boot-wrapper template) but **no elapsed/remaining** for an active session.
3. **No self-query surface.** No endpoint/command for the agent (or a human) to ask "how long have I been running / how much is left."
4. **Stale baseline.** The harness system-prompt `currentDate` is date-only and can be stale/wrong (observed `2026-05-30` then `2026-06-01` in one run). The agent must reconcile to the freshest injected wall-clock, never trust the system-prompt date.

## Design — computed, sanitized, always-on time awareness

**Principle (Structure > Willpower; Signal-only):** the agent never computes or guesses elapsed/remaining. The system computes both from a durable record, injects a SANITIZED summary on every turn that has a record, and exposes it for query. Nothing here blocks or rewrites a turn (tier0, signal-only).

### Component 0 — The durable time-box record IS the substrate (behavioral + structural)
The single source of truth for an active time-box is the **autonomous-state record**, which already exists and is already durable:
- Single-session: `.instar/autonomous-state.local.md`.
- Multi-session autonomy: `.instar/autonomous/<topicId>.local.md` (one per topic).
Canonical fields (matching what the stop-hook actually reads + the live schema written by `setup-autonomous.sh` lines ~145-161): **`started_at`** (ISO-8601 Z) + **`duration_seconds`**. `end_at` is DERIVED (`started_at + duration_seconds`), never a separate source of truth — a finding from integration review (the first draft wrongly treated `end_at` as canonical).

**`label` provenance (security finding, round 2).** The record has NO `label` field — its human-readable fields are `goal`, `completion_condition`, `completion_promise`. The `label` referenced throughout this spec is therefore **DERIVED from `goal`**: `label := strip-control-chars-and-newlines(goal) | truncate-to-80`. This derived, single-line, bounded `label` is the **ONLY** task-descriptor text that ever enters a prompt (Component 2) or the `/session/clock` response (Component 3). The full `goal`, `completion_condition`, and `completion_promise` are **never** echoed verbatim anywhere — closing the prompt-injection-amplification vector. (A capped+stripped goal is still goal-derived, but bounded to 80 control-char-free chars it cannot carry a multi-line fake-directive or a `<promise>` token, which is the actual attack the prior round raised.)

**Structural fix for the incident:** the `autonomous` skill already writes this record. The gap is that a time-boxed mandate can be run WITHOUT the skill (raw `/loop`). So: (a) document that any time-boxed autonomous run MUST be entered via the `autonomous` skill (which writes the record), and (b) add a lightweight guard — when a `/loop` prompt or an autonomous-stop continuation carries an explicit duration ("12h") but no autonomous-state record exists, the stop-hook / a session-start check emits a SIGNAL ("you're running a timed mandate with no durable clock — create an autonomous-state record"). Signal-only; it cannot create the record for the agent, but it makes the omission impossible to miss.

### Component 1 — `SessionClock.compute()` (pure, deterministic, tier0)
A small pure module: given `{ label, kind, startedAt, durationSeconds|null }` and `now`, returns `{ elapsedSeconds, remainingSeconds|null, elapsedHuman, remainingHuman|null, percentElapsed|null, status: 'active'|'expired'|'not-started'|'unbounded' }`.
Robustness (security/scalability findings): **clamp** — negative elapsed (clock skew / future startedAt) → `not-started` with `elapsedSeconds: 0`, never a negative or absurd value; remaining clamped `≥ 0`; unparseable `startedAt` → `status: 'unparseable'` and the caller fails *open to absolute-time-only* with an **operator signal logged** (not silent). No `endsAt` ⇒ `remainingSeconds: null`, `status: 'unbounded'`.

### Component 2 — One shared injection routine, two call modes (no double-resolution)
`.instar/scripts/emit-session-clock.sh` (built-in; shipped + always-overwritten via a concrete migration — see Migration). It ALWAYS prints the absolute wall-clock with the **same single portable `date +'%Y-%m-%d %H:%M:%S %z (%Z)'`** call the existing time-injection hooks already use — no platform fallback is needed to *format now* (adversarial round-2 correction: the dual BSD/GNU `date -j/-d` fallback is only needed to *parse a stored `started_at`*, and ALL such parsing lives in `SessionClock.compute()` (TS, Component 1) — the bash routine never parses `started_at`).

It emits the SESSION CLOCK line from values it is GIVEN or QUERIED, in one of two explicit modes — never re-deriving when the caller already has the numbers:

- **Render mode (the autonomous-stop-hook call site).** The stop-hook has ALREADY selected the authoritative record (tmux→topic reverse-lookup, with the legacy→per-topic `mv` migration) and ALREADY computed `STARTED_AT`/`DURATION_SECONDS`/`ELAPSED`/`REMAINING` with its own parse. It passes those PLUS the derived `label` (Component 0) into the routine as args; the routine only formats them into the SESSION CLOCK line. It does **NOT** re-resolve the record or re-parse `started_at`. This guarantees the injected clock and the hook's duration-expiry verdict are computed from the SAME numbers and can never disagree (adversarial round-2 "two truths" fix).
- **Query mode (the `telegram-topic-context.sh` / UserPromptSubmit call site).** This turn type has no prior resolution. The routine resolves the active clock by calling `GET /session/clock?topic=<N>` (the local server runs `SessionClock.compute()` — the single parse implementation), binding to the turn's `[telegram:N]` topic (multi-session). If the server is unreachable, it degrades to absolute-wall-clock-only and logs one operator signal (never silent, never blocks).

The emitted line (when a clock is available), built from the derived bounded `label`:
`⏱ SESSION CLOCK [<derived-label>]: started <ISO> · <Xh Ym> elapsed · <Zh Wm> remaining of <T> (<NN>% elapsed). Do NOT conclude the session is over while remaining ≫ 0.`
Only the derived `label` (Component 0) is echoed; raw `goal`/`completion_*` never are.

Call sites (no instar-owned turn type left blind):
- **`telegram-topic-context.sh`** (UserPromptSubmit) — replaces its inline CURRENT TIME block with the routine in QUERY mode. *Verified premise:* this hook already emits CURRENT TIME unconditionally before the `[telegram:N]` early-exit.
- **`autonomous-stop-hook.sh`** continuation — the SESSION CLOCK line (RENDER mode, hook's own numbers) replaces the terse `${REMAINING_MIN}m remaining` in `TIME_MSG`, delivered through the existing `decision:block` continuation JSON (the continuation is the jq `block` payload, not `emit()` which goes to stderr under codex).
- (`/loop` wakeups are harness-owned — see Out of scope; covered only insofar as a `/loop` run created an autonomous-state record, which the next UserPromptSubmit/stop turn then surfaces.)

### Component 3 — Self-query surface
- `GET /session/clock` (Bearer; read-only observability, sibling of `/tokens/summary` at routes.ts:4478). Returns `{ now, nowIso, sessions: [ SessionClock for each active record ] }`, `{sessions:[]}` when none. **Leak-bounding (security finding):** the route returns the computed clock + the sanitized `label` ONLY — never the raw `goal`/`userRequest` task text (which would widen tunnel/token-leak blast-radius). Per-machine by nature (the record is `.local`, gitignored) — stated explicitly; paired readers query each machine's own clock.
- CLAUDE.md proactive trigger: *"how long have I been running / how much time is left → `GET /session/clock`."*
- (Optional) `instar clock` CLI.

### Component 4 — Accurate-reporting nudge (SIGNAL-ONLY, v1.1, scoped down after review)
Lessons-aware + security flagged the first draft for giving a regex-only host blocking-adjacent authority. Scoped down: a **bash, signal-only** check that reads the active record directly (no server call — the convergence-check host is pure-bash by design) and, if an outbound message contains a "done/over/complete/wrapped-up" assertion while `remainingSeconds > 10%` of total, emits a one-line SIGNAL. It **never blocks or rewrites** the message (P2 Signal vs Authority). **Signal sink (adversarial round-2):** the SIGNAL goes to **stderr / an operator log line ONLY — never into the agent's injected context** — and it carries the computed fact ("≈NN% of the time-box remains"), NOT a quote of the agent's "done/over" phrase, so the correction can never be re-read as self-confirming evidence that the run is finished. Deferred to v1.1; v1 ships Components 0–3.

## Migration parity (concrete hooks — integration findings)
- **`emit-session-clock.sh`** (new built-in script): add an explicit `migrateSessionClockScript()` block in `PostUpdateMigrator` that writes/overwrites it under `.instar/scripts/` every run (there is no generic "ship all template scripts" mechanism — it needs its own block). New agents get it via the same install path used by `init`.
- **`telegram-topic-context.sh`** (built-in `instar/` hook): always-overwritten on migration — gets the routine call for free.
- **`autonomous-stop-hook.sh`** (autonomous skill): a concrete `PostUpdateMigrator` content-sniff migration (marker: `SESSION CLOCK`) that rewrites the `TIME_MSG` block when the marker is absent — modeled on `migrateBootWrapperAbiCheck` (the existing skill install is install-if-missing + narrow content-sniff, so a dedicated migration is the only path to update on-disk copies).
- **`/session/clock` route + `SessionClock`**: ship in code → reach existing agents on update.
- **CLAUDE.md**: `migrateClaudeMd()` content-sniffed insert + `generateClaudeMd()` template update (Agent Awareness Standard).

## Tests (all three tiers — non-negotiable)
- **Unit:** `SessionClock.compute()` (TS — the single `started_at` parser, with the dual BSD/GNU-equivalent parse) — active / not-started / expired / unbounded / **clock-skew (future startedAt → 0, not negative; past end → clamp remaining ≥ 0)** / unparseable (→ `status:'unparseable'`, fail-open) / human formatting / percent / **`label` derivation from a `goal` longer than 80 chars proves truncate-to-80 + control-char/newline strip + no `<promise>`-token survival**. `emit-session-clock.sh` golden output — **render mode**: given args, formats the SESSION CLOCK line from them and never reads a record; **query mode**: with the server up returns the computed line, with the server down degrades to absolute-only + logs a signal; absolute wall-clock printed via the single portable `date +fmt` in BOTH modes; the raw `goal` text never appears.
- **Integration:** `GET /session/clock` → 200 with correct computed fields given a record; `{sessions:[]}` when none; Bearer-gated; **response contains the sanitized label but NOT the raw goal text** (leak-bound assertion).
- **E2E:** production server boots with a record present and `/session/clock` is alive (200 not 503); a simulated stop-hook continuation payload contains the SESSION CLOCK line (wire-integrity that the previously terse turn now carries rich elapsed/remaining).

## Decision points touched
- Adds one read-only route (`/session/clock`) — no block/allow gate.
- The reporting nudge (v1.1) is **signal-only** — explicitly NOT a gate.
- No existing gate is modified.

## Out of scope
- Modifying the `/loop` harness skill (host-owned; can't) — addressed via Component 0 (use the autonomous-state record).
- The harness system-prompt `currentDate` (host-owned) — compensated by always injecting fresh wall-clock + B11 reconciliation discipline.
- Cross-machine clock aggregation (each machine reports its own; the record is `.local`).

## Open questions (for Justin)
1. Component 4 (reporting nudge): ship signal-only in v1.1, or drop entirely? (Recommend v1.1.)
2. Should a time-boxed `/loop` with no autonomous-state record be a hard session-start SIGNAL every turn until a record exists, or a one-shot nudge? (Recommend: one-shot per session-start, to avoid noise.)

## Sequencing
1. `SessionClock` + `GET /session/clock` + unit/integration/E2E (Component 1+3).
2. `emit-session-clock.sh` + wire into both hooks + golden tests + the three migrations (Component 0+2) — highest-impact (closes the blind-`/loop` + terse-content gaps).
3. CLAUDE.md trigger + `migrateClaudeMd` + template.
4. (v1.1) reporting nudge.
Each step is a gated PR.
