# Side-Effects Review — per-topic effort pin (--effort at spawn)

**Version / slug:** `topic-effort-pin`
**Date:** `2026-06-12`
**Author:** `Instar Agent (echo)`
**Second-pass reviewer:** `workflow adversarial reviewer (CONCUR — 1 MEDIUM fixed, see below)`

## Summary of the change

Adds an optional `effort` field (enum `low|medium|high|xhigh|max`) to the
topic-profile system, threaded through validation, store, resolver, write
surface, change-classifier, orchestrator, conversational ingress, types, and the
two routes; and injects `--effort <level>` into the Claude Code launch argv
(interactive + headless builders in `frameworkSessionLaunch.ts`), resolved from
the topic profile at spawn in `SessionManager`/`server.ts`. Mirrors `thinkingMode`'s
plumbing. Operator request: Justin, topic 13481, "set ultracode for this topic"
(ultracode is not a CLI value; this pins the CLI ceiling `max`).

## Decision-point inventory

- Topic-profile resolution — **modify** — adds an `effort` resolution arm
  (pin > config-default > unset); off-enum value → fail-open `undefined`.
- Launch argv builders — **modify** — push `--effort` for claude-code only when
  set + enum-valid; non-claude untouched.
- `classifyProfileChange` — **modify** — adds a dedicated effort-only row
  (kill+resume, none-loss when resume-ready) so it is not misclassified as a
  thinking change (the second-pass MEDIUM finding, now fixed).
- Write surface / routes / ingress — **modify** — accept + validate `effort`.

---

## 1. Over-block
Off-enum values are rejected at the write API (HTTP 400, profile unchanged) — that
is the intended block. No legitimate input is rejected; the five CLI-valid levels
all pass. `ultracode` is deliberately refused (not a CLI value).

## 2. Under-block
A value that is enum-valid but unsupported by the *running model* (e.g. `xhigh`
on a model that floors to `high`) is passed through — the CLI itself floors it
(documented behavior), so no instar-side block is needed. Headless one-shot/job
spawns do NOT thread effort (interactive-only); acceptable — per-topic effort is
a per-conversation pin, and the headless builder support is forward-looking
defense-in-depth (flagged by the reviewer as a deliberate choice, not a bug).

## 3. Level-of-abstraction fit
Right layer: mirrors `thinkingMode` exactly across the same files; the resolver
owns precedence, the launch builder owns argv, the classifier owns respawn
semantics. No parallel machinery invented.

## 4. Signal vs authority compliance
N/A as a gate — this is a config field, not a decision point. The one authority-
adjacent concern (a bad value reaching the CLI) is defended by three independent
fail-open/validate layers.

## 5. Interactions
- Interacts with the `thinkingMode`→`--effort` mapping in the interactive builder:
  a direct effort pin WINS and suppresses the thinkingMode-derived mapping, so
  `--effort` is emitted exactly once (unit-tested).
- The change-classifier effort row composes with model/tier/thinking rows: a
  combined change is handled by those rows (their respawn carries the new flag);
  only effort-only needed the new row.

## 6. External surfaces
- `GET /topic-profile/:id` gains `resolved.effort` + `sources.effort` (additive).
- POST profile/propose accept `effort` (additive; off-enum → 400).
- A spawned Claude session's argv gains `--effort <level>` when the topic pins it.
  Old behavior (no pin) is byte-identical.

## Framework generality

The change DOES route through the framework abstraction (`frameworkSessionLaunch.ts`
builders), and is **deliberately Claude-optimizing, not Claude-leaking**:

- `--effort <low|medium|high|xhigh|max>` is a **Claude Code CLI flag**. Only the
  `claudeCodeBuilder` (interactive) and `claudeCodeHeadlessBuilder` (headless) push
  it. `InteractiveLaunchOptions.effort` / `HeadlessLaunchOptions.effort` are optional
  inputs the non-Claude builders simply **ignore** — `codexCliBuilder`,
  `geminiCliBuilder`, and `piCliBuilder` are untouched and emit no effort flag.
- This is the "Framework-Agnostic — and Framework-Optimizing" standard satisfied:
  the abstraction stays framework-agnostic (every builder receives the same options
  object; none is forced to honor a flag it doesn't have), while Claude gets its
  native knob. Codex/Gemini have their own reasoning/effort controls
  (e.g. codex `-c model_reasoning_effort`); wiring those is explicitly OUT OF SCOPE
  here and would be a separate per-framework mapping (a future `resolveEffortForFramework`
  analogous to `resolveModelForFramework`), not a generalization of this Claude flag.
- The topic-profile `effort` field itself is framework-agnostic (it's a profile
  value); only its TRANSLATION to a launch flag is Claude-specific, which is the
  correct layer for framework specificity (mirrors how `model` resolves per-framework
  via `resolveModelForFramework`).

## 7. Multi-machine posture (Cross-Machine Coherence)
**proxied-on-read / machine-local-by-design.** The topic profile already resolves
per-machine at spawn; effort rides the same path. When a topic transfers machines,
its profile carrier (the existing topic-profile pull-at-acquire seam) carries
`effort` along with the other fields (it's in `PROFILE_FIELDS`), so the pin
follows the conversation. No new replication surface; no new URL/notice.

## 8. Rollback cost
Trivial: additive field, unset by default. Reverting the PR removes the field and
the argv injection; no durable migration (the field simply stops being read). A
stored `effort` on a profile file is ignored by older code (additive JSON).

---

## Second-pass review

Workflow adversarial reviewer: **CONCUR** (tscClean, testsPass). Two findings:
- **MEDIUM — effort half-wired in `classifyProfileChange`** (in AXES but no
  branch → effort-only change fell through to the thinkingMode row, wrong reason
  + wrong verification gate). **FIXED**: added a dedicated effort-only row
  (kill+resume, none-loss when resume-ready; fresh recent-only otherwise) with an
  effort-specific reason; +4 classifier unit tests asserting it resolves as
  `resume`/none-loss, is NOT gated on the thinking flags, and the reason says
  "effort change" not "thinking".
- **LOW — headless builder has no live caller** (interactive-only data flow).
  Acknowledged as a deliberate, documented forward-looking choice (per-topic
  effort is a per-conversation interactive pin), not a bug (§2 above).
