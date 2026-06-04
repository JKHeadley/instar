---
title: Gemini multi-turn loop-driver (need-gem-002)
status: draft-for-review
author: echo
date: 2026-06-04
review-convergence: "self-converged"
review-iterations: 1
approved: false
approved-by: null
approved-note: "Draft surfaced to Justin for design input on the BUDGET GUARDRAILS specifically (his standing overspend concern — subscription auth, no API keys). Echo intends to build it DARK under standing autonomous-dev preapproval unless Justin wants to steer §6 first. The codex sibling (docs/specs/codex-autonomous-loop-driver.md) was approved 2026-05-30 with the same dark→verify→enable conditions; this mirrors that shape for the gemini-cli adapter."
second-pass-required: true
---

# Gemini multi-turn loop-driver (need-gem-002)

## Problem

A one-shot `gemini -p "<task>"` runs exactly one turn and exits. Nothing re-prompts
while autonomous work remains. This is the **#1 program-need** distilled in the
codey-to-gemini retro-harvest ("enable + harden the loop-driver so a mentee sustains a
multi-turn build to a PR without the overseer hand-driving each turn") and the **#1
maiden-voyage lesson** ("mentee capacity is a hard one-shot constraint... cannot sustain
multi-turn work without a loop-driver"). Codex hit the identical wall (`task:#28`) and
could not be a multi-turn agent until `codexLoopDriver` shipped. Gemini needs the
equivalent to be a real **mentee** in apprenticeship Steps 3–5.

The Step-2 adapter spec (`APPRENTICESHIP-STEP2-GEMINI-RUNTIME-ADAPTER-SPEC.md` §9)
deliberately surfaced this as `need-gem-002` rather than shipping it, and named the
codexLoopDriver as the porting pointer. This spec is the dedicated Tier-2 design for
it, grounded in live probing that was previously deferred as "UNKNOWN until live."

## Prerequisites — empirically PROVEN on disk (2026-06-04, gemini-cli 0.25.2)

The Step-2 spec listed the gemini session/resume/hook contract as deferred-unknown
(`need-gem-001`). It is no longer unknown. Echo probed it live:

1. **Native session persistence.** `gemini --list-sessions` shows per-project session
   history with stable UUIDs. Each `gemini -p` run persists a session.
2. **Resume restores full context across separate process invocations.** Seeded the
   codeword `PELICAN-7` in a fresh session (uuid `ef951c6e…`); a *separate* process
   `gemini -r latest -p "what codeword?"` returned `PELICAN-7`. Continuity is real, not
   a flag that no-ops.
3. **Resume accepts a STABLE UUID handle.** `gemini -r ef951c6e-…-b8aa62b4403f -p "…"`
   recovered the codeword — so the driver can resume a *specific* session by UUID, immune
   to other sessions accruing. (The `--help` only documents `latest`/index; the UUID form
   works beyond the docs — a finding worth pinning in a test.)
4. **Verbs present:** `-r/--resume <latest|index|uuid>`, `--list-sessions`,
   `--delete-session <index>`, `-i/--prompt-interactive` (run a prompt then continue
   interactive), `gemini hooks migrate` (import Claude-Code hooks).
5. **Explicit `-m <model>` is load-bearing for reliability.** Without it, gemini-cli runs
   a pre-turn `ModelRouterService → ClassifierStrategy → generateJson` call that can
   exhaust retries on "invalid content" and kill the whole turn *before generating*
   (observed live; logged framework-issue
   `gemini-cli-router-classifier-generatejson-invalid-content`). Passing `-m <model>`
   bypasses the classifier. Instar's `buildGeminiOneShotArgv(model, prompt)` already
   always passes `-m` — so the driver inherits the bypass for free.

These five facts make the **quota-efficient** architecture viable today.

## The gap (single sentence)

There is no Instar mechanism that re-prompts a gemini agent turn-after-turn toward a
goal; a gemini mentee is therefore bounded to one-shot tasks and cannot sustain a
multi-turn build.

## Design — external resume-orchestration (Structure > Willpower + rollback-safe)

### Why NOT the codex Stop-hook shape

The codexLoopDriver is a **Stop hook inside a persistent interactive session** (codex
runs under tmux; the Stop hook re-injects the task and the session keeps living). Gemini
in Instar runs as **one-shot** (`gemini -p` exits at turn-end). Two architectures were
considered:

- **(A) Interactive + migrated Stop hook** — run `gemini -i` as a persistent tmux session
  and migrate a Stop-equivalent hook that re-injects. Mirrors codex exactly BUT depends on
  the gemini hook return-contract (which only exposes `hooks migrate` today, no documented
  Stop-re-prompt semantics) and on interactive-mode tmux plumbing. Higher risk, unproven.
- **(B) External resume-orchestration** — Instar drives the loop by re-spawning
  `gemini -m <model> -r <sessionUUID> -p "<next turn>"` each turn, letting gemini restore
  context natively. **Proven today** (prereqs 1–3), **no unknown-contract dependency**, and
  **quota-efficient** (native resume ⇒ no transcript re-send; each turn sends only the next
  instruction, not the accumulated history).

**This spec chooses (B).** (A) is recorded as a possible future enhancement if interactive
mode + hooks later prove more robust for tool-heavy turns.

### Mechanism

A new `GeminiLoopDriver` (monitoring/, sibling of the codex driver but framework-additive
and self-contained — it does NOT touch the Claude or codex paths):

1. **Start.** Given a goal + a bound config, run turn 1 as a normal one-shot
   `gemini -m <model> -p "<goal + autonomous framing>"`. Capture the created session UUID
   from `--list-sessions` (the newest "Just now" row for this cwd) — this becomes the
   stable loop handle.
2. **Turn loop.** While not done and budget remains: spawn
   `gemini -m <model> -r <handle> -p "<continuation instruction>"`. The continuation
   instruction is short and constant-shaped (the goal is already in the resumed context),
   e.g. *"Continue toward the goal. If the goal is fully complete, end your reply with the
   exact token GEMINI_LOOP_DONE."*
3. **Completion detection (driver-side — there is no in-session Stop hook).** Stop when
   ANY of: (a) the turn output contains the sentinel `GEMINI_LOOP_DONE`; (b) an
   independent completion-condition judge confirms the goal (mirrors `/loop`'s judge — a
   single cheap `-m flash` classification on the surfaced output); (c) `maxTurns` reached;
   (d) the budget gate trips. No self-declared "done" without (a) or (b).
4. **Per-turn context isolation for the handle.** To keep `--list-sessions` "newest row"
   attribution unambiguous, the driver runs gemini with a **dedicated cwd per loop**
   (the autonomous session's working dir is already isolated) so concurrent loops cannot
   steal each other's "latest". The UUID handle (not "latest") is the primary resume key;
   the dedicated cwd is belt-and-suspenders for handle capture.

### Subscription auth (NON-NEGOTIABLE — Justin's overspend rule)

Every turn spawns through the existing `geminiSpawn` transport, which **unconditionally
deletes** `GEMINI_BILLING_ENV_VARS` (`GEMINI_API_KEY`, `GOOGLE_API_KEY`,
`GOOGLE_APPLICATION_CREDENTIALS`, `GOOGLE_GENAI_USE_VERTEXAI`, `GOOGLE_CLOUD_PROJECT`) from
the child env and runs the `geminiKeyLeakageCanary`. The loop-driver adds **zero** new env
surface — it reuses that transport verbatim, so subscription OAuth (`~/.gemini/oauth_creds.json`)
is the only possible auth path. An API key cannot be introduced by this feature by
construction. A wiring-integrity test asserts the driver's spawn path routes through
`geminiSpawn` (not a raw `spawn`).

## §6 — Budget guardrails (the part Justin should weigh in on)

A self-looping LLM driver is exactly where overspend hides. Guardrails, all enforced in
code before any turn spawns:

- **`maxTurns`** (default e.g. 12) — hard cap on turns per loop. A turn that would exceed
  it does not spawn.
- **Token/spend budget** — the loop registers with the existing `QuotaTracker` /
  `LlmQueue` daily-spend accounting (the same pool every other instar LLM call shares). The
  loop refuses to start under budget pressure and halts mid-loop if the remaining budget
  drops below a per-turn floor. (Reuses the gate the autonomous `can-start` already checks.)
- **Capacity policy reuse** — a gemini `429 / exhausted capacity` pauses-and-escalates via
  the existing gemini capacity policy (`#708/#70`), NOT a tight retry. A capacity wall ends
  the turn cleanly and surfaces, rather than hammering the subscription.
- **Min-interval between turns** — a floor (e.g. ≥2s) so a fast-failing turn can't spin.
- **Single-instance per topic** — at most one active gemini loop per autonomous topic
  (mirrors the autonomous single-instance gate), so loops can't multiply.

> **Open question for Justin (§6):** default `maxTurns` and the per-loop token ceiling.
> Echo's proposed defaults are conservative (12 turns; refuse-to-start under the same
> budget pressure the autonomous gate already uses). Steer these and the spec locks them.

## Dark launch + rollback

- Ships **DARK** behind `autonomousSessions.geminiLoopDriver.enabled` (default `false`).
- On `developmentAgent` agents (echo) the `developmentAgent` gate may surface it live for
  dogfooding per the standard `explicit ?? (developmentAgent ? on : dark)` pattern — but
  it still requires an autonomous gemini session to even reach the driver, so the blast
  radius is one dev agent's own loops.
- **Instant rollback** by flipping the flag to `false` — no redeploy. The Claude and codex
  autonomy paths are byte-for-byte untouched (framework-additive; the driver only engages
  for `framework === 'gemini-cli'`).
- Deploy-dark → live-verify on a real gemini autonomous run → only then enable.

## Migration parity

- **Config default** — `migrateConfig()` adds `autonomousSessions.geminiLoopDriver` with an
  existence check (only if missing), default `{ enabled: false, maxTurns: 12 }`.
- **No hook/template/skill changes** — this is a runtime driver, not an installed file. No
  `.claude/settings.json` or CLAUDE.md template change is required for the driver itself.
- **Agent-awareness** — add a one-line capability note to the CLAUDE.md template's
  autonomy section ONLY when the feature graduates from dark (per maturity-honesty: a
  dark feature is not announced as a finished capability).

## Test plan (3-tier)

- **Tier 1 (unit).** `GeminiLoopDriver` turn-loop logic with an injected fake spawn:
  asserts (a) turn 1 spawns one-shot + captures the handle; (b) turns 2..N spawn with
  `-r <handle> -p` and a constant-shaped continuation (no transcript re-send);
  (c) `GEMINI_LOOP_DONE` ends the loop; (d) `maxTurns` ends the loop; (e) budget-gate
  refusal both at start and mid-loop; (f) wiring-integrity: spawn routes through
  `geminiSpawn` (subscription-auth path), never a raw spawn; (g) explicit `-m` is always
  present in argv (router-classifier bypass).
- **Tier 2 (integration).** HTTP route surfacing loop state (`GET /autonomous/gemini-loop`
  or fold into the existing autonomous sessions view) returns the live driver state when
  the feature is available; 503/absent when the flag is off.
- **Tier 3 (e2e lifecycle).** Production init path mirroring server startup: with the flag
  on + a gemini framework, the driver is constructed non-null and a stubbed 2-turn loop
  reaches a terminal state (the "feature is alive" test). With the flag off, the driver is
  inert and the autonomy path is unchanged.

## Risks & unknowns (named, not hidden)

- **Handle capture race.** "Newest row" attribution in `--list-sessions` is the fallback;
  the UUID handle is primary. If turn-1 UUID capture ever fails, the loop must abort (not
  silently fall back to "latest", which could resume a foreign session). Tested in Tier 1.
- **Resume + append durability across 3+ turns.** Proven for 2 turns; the build MUST verify
  a 3-turn resume chain accumulates (turn-3 sees turns 1+2) before enable. Recorded as a
  live-verify gate, not assumed.
- **Tool-heavy turns.** This spec targets reasoning/build turns. If a turn needs broad tool
  use, architecture (A) (interactive mode) may later prove better; (B) is the right *first*
  driver and the enhancement path is recorded.

## Close the Loop

`need-gem-002` is the Step-4 prerequisite and has been an open program-need since the
Step-2 spec. This spec converts it from "deferred-unknown" to "designed + empirically
grounded," and the build will close it. The framework-issue ledger entries
(`need-gem-001-resume-contract-proven`, `router-classifier-generatejson-invalid-content`)
keep the underlying findings re-surfaced until the adapter declares `SessionResumeIndex`
and the driver ships.
