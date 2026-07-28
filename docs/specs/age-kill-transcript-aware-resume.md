---
title: "Age-Kill Transcript-Awareness — close the MCP/tool blind spot in the session age-limit reaper"
slug: "age-kill-transcript-aware-resume"
author: "echo"
parent-principle: "Observation Needs Structure"
eli16-overview: "age-kill-transcript-aware-resume.eli16.md"
status: "converged"
approved: true
approved-by: "operator pre-approval — Justin, topic 25660, 2026-06-13: explicit pre-approval for this directive's decisions and any specs needing approval (exercised by Echo in the pre-approved 24h autonomous run; operator may revoke)"
review-convergence: "2026-06-14T04:59:28.794Z"
review-iterations: 2
review-completed-at: "2026-06-14T04:59:28.794Z"
review-report: "docs/specs/reports/age-kill-transcript-aware-resume-convergence.md"
cross-model-review: "degraded-all-rounds"
cross-model-review-reason: "codex not on session PATH; gemini API returned invalid content (retries exhausted)"
single-run-completable: true
frontloaded-decisions: 0
cheap-to-change-tags: 0
contested-then-cleared: 0
---

# Age-Kill Transcript-Awareness

**Parent principle — "Observation Needs Structure"** (`docs/STANDARDS-REGISTRY.md`). Its corollary
"your record schema is your perception — a missing category is a designed-in blindspot" is the
indisputable fit: the age-gate's perception of "is this session working?" had a designed-in
blindspot — it observed only the pane + child-procs and was structurally blind to the MCP/tool
activity category. A guard whose perception silently omits a category cannot see the work it is
killing; this change gives the age-gate the transcript-activity category its sibling guard (the
SessionReaper) already perceives, so its self-model of session activity matches reality.

## 1. Problem

On 2026-06-13 an interactive session that was actively doing real work — driving the
Playwright MCP server to provision the EchoOfDawn GitHub identity, interleaved with
short `gh`/`curl` calls — was **terminal-killed by the session age-limit reaper** with no
resume and a delayed notice. The operator saw silence, not a heads-up.

Forensics (from `logs/reap-log.jsonl` + source):

- The kill came from `SessionManager`'s wall-clock age enforcement (`terminateSession(id, 'age-limit', { disposition: 'terminal' })`), fired at the ~5h mark (`DEFAULT_MAX_DURATION_MINUTES = 240` + a 20%/max-60m buffer ≈ 300m). The session had been open since 15:30.
- Reap-log recorded `midWork:false` → the session was NOT queued for mid-work resume.
- The age-kill path's "is this session still working?" gate (the `ageGateTrulyIdle` check) consults only two signals: the tmux pane shows an idle prompt (`captureMeaningfulTail` + `IDLE_PROMPT_PATTERNS`) AND there is no non-baseline child process (`hasActiveProcesses`).
- **Both signals are blind to MCP/tool work.** The Playwright MCP server runs OUT of the tmux session's process tree, and bash tool calls are short-lived. Between tool calls the pane shows an idle-looking prompt and there is no child process — so an actively-working session reads as "truly idle" and becomes age-kill-eligible.

The root mechanism is a **parity gap between the two reap paths**:

- The `SessionReaper` (the idle/pressure path) ALREADY layers transcript-growth awareness — it imports `probeTranscript` / `transcriptDelta` and requires `flat-transcript + positive-idle + confirmObservations` before a session is reap-eligible. A session whose JSONL is still growing is `'grew'` → KEEP. It would NOT have killed the EchoOfDawn session.
- The `SessionManager` age-limit kill path does NOT layer transcript-growth. It is the lone blind spot.

## 2. Goal / non-goals

**Goal:** bring the age-limit kill path to parity with the SessionReaper's existing
transcript-awareness, so a session that is actively producing output (its framework
transcript is growing) is treated as working and the kill is HELD OFF — exactly as a
session with a live child process already is. This both prevents the wrongful kill AND,
because the only sessions age-killed are now genuinely quiet, makes the resume question
moot for this path (we no longer terminal-kill active work).

**Non-goals (deliberately out of scope, with reasons — not punted work):**

- **No change to the WorkEvidence enum or the ReapGuard `evaluate()`/`workEvidence()` keep/resume logic.** That subsystem is fragile (documented kill/revive loops: 2026-06-13 13-session loop on stale `open-commitment`; 2026-06-05 flood). The lightest correct fix is to fix the blind path, not to re-architect evidence. The SessionReaper's existing transcript-awareness already covers the pressure/idle path; the age-path fix below covers the only remaining gap, so an active session is now protected on ALL paths without touching evidence. `<!-- tracked: topic-25660 -->` (a transcript-active WORK-EVIDENCE signal for the rare "active session hard-killed by a non-age path" case is a separate, evaluate()-coupled change requiring its own loop-safety analysis; recorded against topic 25660 for a future, independently-reviewable spec).
- **No change to the reap-notify coalescing window.** The notice-delay symptom is a property of the genuine-idle reap notice path; with active sessions no longer age-killed, the active-session-silent-kill symptom is removed at the source. The notifier promptness question is a separate subsystem.

## 3. Design

### 3.1 New probe — `SessionManager.isTranscriptRecentlyActive(session, withinMs)`

A small, public method on `SessionManager`:

```
isTranscriptRecentlyActive(session, withinMs):
  sessionId = session.claudeSessionId
  if !sessionId: return false
  jsonlPath = resolveFrameworkTranscriptPath({
    framework: session.framework ?? 'claude-code',
    sessionId,
    projectDir: session.cwd ?? this.config.projectDir,
  })
  if !jsonlPath: return false
  return (Date.now() - statSync(jsonlPath).mtimeMs) < withinMs
  // any throw (missing file, permission, stat error) ⇒ return false
```

- Reuses the same per-framework resolver the SessionReaper's `probeTranscript` uses (`resolveFrameworkTranscriptPath` from `core/FrameworkSessionStore`) — a CORE module, so no `core → monitoring` layering inversion. It deliberately does NOT depend on `monitoring/transcriptProber`.
- Single-point mtime recency, NOT the SessionReaper's cross-tick `transcriptDelta` (grew/static across two snapshots). The two ask deliberately different questions: the SessionReaper asks "did it grow since my last tick?" (it owns multi-tick idle confirmation via `confirmObservations` + positive-idle); the age gate asks "was it touched in the last `withinMs`?" — the right shape for a single over-age check. The asymmetry is intentional and benign: a transcript last written 90s ago reads `static` to the SessionReaper's single-tick delta yet `recently-active` to the age gate. That cannot produce a contradictory kill — the SessionReaper never reaps on one `static` read (it requires repeated positive-idle confirmations), and the two paths are independent authorities; the age gate is simply the more conservative of the two within its 2-min window.
- **Per-framework coverage + safe degradation.** `resolveFrameworkTranscriptPath` resolves claude-code (deterministic path), codex-cli (date-tree glob), and gemini-cli (session-file lookup). It has **no `pi-cli` case** — pi-cli falls through to the claude-code default and will not resolve a real pi transcript. This is a PRE-EXISTING gap in the shared resolver (it equally affects the SessionReaper's `probeTranscript`, `PreCompactionFlush`, and `ResumeValidator` — every transcript consumer, not just this change), surfaced by the convergence foundation-audit. For this change the consequence is **safe degradation, never regression**: a pi-cli (or any unresolvable) session gets `isTranscriptRecentlyActive === false` and the age gate falls back to EXACTLY today's pane/procs verdict — pi-cli is no worse than before this change, while claude/codex/gemini GAIN the transcript-deferral. Fixing pi-cli transcript resolution is a separate shared-foundation change (it needs pi's real transcript layout and re-tests all consumers) and is out of scope here. `<!-- tracked: topic-25660 -->`
- **Fail direction:** an unprobeable transcript (no session id, unresolved path, missing file, stat error) returns `false` — NOT evidence of activity. This never *blocks* a kill on an unreadable transcript; it falls through to the existing pane/procs verdict. (Correct: a keep-true fail-safe here would pin a possibly-dead session alive forever — wrong direction for this method, which only ADDS a defer condition.)

### 3.2 Wire it into the age gate

In the wall-clock age block (`elapsed > limit`):

```
const ageGateTranscriptActive = this.isTranscriptRecentlyActive(session, AGE_GATE_TRANSCRIPT_ACTIVE_MS);
const ageGateTrulyIdle = ageGateIsIdle && !ageGateHasProcs && !ageGateTranscriptActive;
```

The idle decision itself is extracted into a pure, exported
`isAgeGateTrulyIdle(idleAtPrompt, hasActiveProcs, transcriptActive)` = `idleAtPrompt &&
!hasActiveProcs && !transcriptActive`, called as
`ageGateTrulyIdle = isAgeGateTrulyIdle(!!ageGateIsIdle, ageGateHasProcs, ageGateTranscriptActive)`.
The extraction makes the exact incident reproducible at the decision boundary in a unit test
(Bug-Fix Evidence Bar) without driving the whole `monitorTick` loop.

A transcript-active session is therefore NOT "truly idle" → the existing `!ageGateTrulyIdle`
branch defers the kill (logs the one-shot "actively working … Deferring kill" line, now also
reporting `transcriptActive=…`), and falls through to idle-detection so a session that LATER
goes quiet is still caught. No new kill path; one new defer condition.

### 3.3 Constant

`AGE_GATE_TRANSCRIPT_ACTIVE_MS = 120_000` (2 min). Comfortably covers the gap between tool
calls during active MCP work. Over-deferring a just-finished session for at most one window is
harmless: the idle-detection block below still reaps it once the transcript goes quiet.
A code constant (not a config key) — it ships with the dist on update, so no Migration-Parity
config work is required.

## 4. Signal vs Authority

The change is a SIGNAL that ADDS a defer (keep) condition to an existing authority; it grants
NO new blocking authority and moves strictly in the safe direction (fewer kills of active
sessions). It mirrors the SessionReaper's already-shipped transcript signal. Brittle-probe risk
is bounded by the fail-to-`false` contract: a probe error never keeps a session alive, it only
declines to add the new defer reason.

## 4.1 The age cap is a zombie reaper, not a hard resource cap (denial-of-reaping)

Convergence review (security) raised: with this change a session that keeps its transcript
fresh is never age-killed — so a session could "stay alive forever." This is the INTENDED
behavior, and it is not a new hole:

- **Only real model activity keeps the transcript fresh.** A Claude Code session does not have
  a tool to touch its own transcript mtime independent of producing turns; the runtime appends
  to the JSONL when (and only when) the model actually does a turn / tool call. Keeping the
  mtime <2-min fresh therefore REQUIRES continuous real work — which is precisely the state the
  age gate should defer, not the gameable no-op the phrase "touch the file" implies.
- **It matches the existing SessionReaper policy.** The pressure/idle reaper ALREADY refuses to
  kill a session whose transcript is still growing (`'grew'` ⇒ KEEP). An actively-producing
  session is already non-reapable system-wide; this change brings the age path into line, it
  does not invent a new exemption.
- **It is what the operator explicitly asked for** (topic 25660): "There's no reason the session
  should be killed [while it has work in flight]." The age cap's job is to retire ZOMBIES (open
  tmux, no model activity), not to wall-clock-evict live work.
- **Runaway-but-active sessions are owned by other guards, not this one.** A session stuck in a
  tight produce-garbage loop is the domain of the SessionWatchdog (stuck-process / escalating
  kill), the context-wedge sentinel, and the CPU/memory-pressure reaper — all of which still
  apply unchanged. The age gate deliberately does NOT try to be a hard resource ceiling; layering
  one back on (e.g. "kill even an active session at 24h") would reintroduce the exact
  kill-active-work bug this spec fixes and is explicitly rejected.

## 5. Side effects (full review in the instar-dev artifact)

- **Over-block (wrongly defers a kill):** a genuinely-finished session whose transcript was
  touched <2m ago is held off for up to one window. Harmless — idle-detection reaps it next.
- **Under-block (still kills something it shouldn't):** none new; the change only adds a defer
  condition. A session with NO resolvable transcript (e.g. a framework whose transcript can't be
  located) falls through to today's pane/procs verdict — identical to current behavior.
- **Interactions:** consistent with the SessionReaper's existing transcript-growth gate (same
  resolver, same intent); idle-detection block still owns genuinely-idle reaping; the
  `overAgeButActiveLogged` once-per-session log set already prevents spam on the held-off path.
- **Multi-machine posture:** machine-local BY DESIGN — each machine reaps only its own sessions
  and reads only its own local transcripts. No replication/proxy surface; nothing crosses a
  machine boundary.
- **Rollback:** revert the PR (single-file behavior change + tests); no data migration, no agent
  state repair. As an interim dial, setting the window to 0 makes the new condition inert.

## 6. Testing (Testing Integrity)

- **Unit (behavioral, `isTranscriptRecentlyActive`):** returns true for a transcript modified
  within the window, false for stale, false for no-sessionId, false for a missing file, and
  false (safe-degrade) for a non-claude framework whose transcript is unresolvable (codex-cli +
  pi-cli) — both sides of every boundary, real fs fixtures written at the resolved path.
- **Unit (decision boundary, `isAgeGateTrulyIdle`) — REPRODUCES the original failure
  (Bug-Fix Evidence Bar):** the exact incident inputs (idle pane + no child proc + ACTIVE
  transcript) resolve to `false` ⇒ held off, not killed; the genuine-zombie inputs (idle pane
  + no proc + quiet transcript) resolve to `true` ⇒ still killed (no regression); a live child
  process or a non-idle pane is never truly-idle. Exhaustive over all 8 combinations.
- **Unit (source-assertion):** the age gate computes `ageGateTranscriptActive` via
  `isTranscriptRecentlyActive` and feeds all three signals to `isAgeGateTrulyIdle`; the
  constant + resolver import exist.
- Typecheck (`tsc --noEmit`) clean; full unit suite green (Zero-Failure Standard).

### 6.1 Test-tier applicability (Testing Integrity Standard)

The three-tier mandate (unit / integration-HTTP / E2E-lifecycle) is calibrated for features
with **API routes** — the "feature is alive, returns 200 not 503" E2E is its load-bearing case.
This change introduces **no route, no DI component, no config/HTTP surface**: it is a pure
decision method inside `SessionManager.monitorTick`. The substantive test surface is therefore
the decision boundary itself, which the `isAgeGateTrulyIdle` extraction now covers directly
(both sides, all combinations, the original-failure repro). A genuine E2E ("a real session is
age-killed after >5h, then NOT killed when its transcript is live") is impractical — it would
require a multi-hour wall-clock wait per run; the decision-boundary repro is the faithful,
deterministic substitute. Integration/E2E tiers are recorded **N/A with this reason**, not
skipped silently. (Conformance gate, round 1: Testing Integrity + Bug-Fix Evidence Bar
findings — both addressed here.)

## 7. Acceptance criteria

1. An over-age session whose transcript was modified within `AGE_GATE_TRANSCRIPT_ACTIVE_MS` is
   held off, not terminal-killed.
2. An over-age, transcript-quiet, pane-idle, no-child-proc session is still killed (no
   regression to the genuine-zombie reap).
3. tsc clean; new unit tests pass; existing session-timeout tests still pass.
