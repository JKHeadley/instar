# State-Detection Robustness — Rule 3

**Status:** Active, locked 2026-05-15 by Justin
**Branch:** `spec/provider-portability`
**Applies to:** Every Instar module that reads state from an external system to make a decision. **This rule is upstream-agnostic** — it applies equally to Claude Code, OpenAI Codex, Google Gemini, Ollama / LM Studio, any OS-level state (`ps`, `tmux`, filesystem), any third-party API (Telegram, Slack, GitHub, Cloudflare), and any future provider or service Instar comes to depend on. Drives state-detector design in Phase 3+, the audit Tier 2 work, every future adapter, every future feature that parses external state. Every adapter ships with its own canary set sized for the upstream's stability characteristics.

---

## ELI16 — what this document says

Instar reads state from a bunch of external systems to decide things — "is Claude done generating?" "what's our quota balance?" "did a subagent start?" "is the user mid-edit?" "did the Codex thread crash?" "is Telegram rate-limiting us?" The systems we read from change all the time without telling us. **This is true for every external system Instar depends on**, not just Claude Code — OpenAI Codex, Gemini, Telegram, Slack, OS process state, the filesystem, future providers we haven't integrated yet. Every one of them will evolve out from under us at some point. When our state-detection code doesn't keep up, it silently returns wrong answers, and the next layer of code acts on those wrong answers as if they were true. Worst class of bug: silent data corruption that looks like success.

The previous response to this class of bug was to fix each instance when it surfaced. The new response is structural: any state-detection code we ship from now on follows three rules. The system is allowed to detect that it's broken AND to fix itself before bothering anyone, and only when self-fixing fails does it surface to a human — and even then, only to echo (the developer agent), not to every Instar agent in the fleet.

The goal is "quietly correct across upstream evolution" — not "loud about every problem." Cat-and-mouse with evolving upstream systems is the nature of this project. The framework needs to evolve with it.

---

## Rule 3 — every state-detector ships with rationale, canary + self-healing, and e2e coverage

### Three sub-rules

**3.1 — Deterministic vs LLM is an explicit design decision per check.**

For every state-check we write, the PR ships a one-paragraph rationale covering:
- **Criticality:** silent corruption if wrong (worst) → minor degradation if wrong (best)?
- **Frequency:** per-prompt → per-hour → per-session-start → startup-only?
- **Upstream stability:** Anthropic UI (unstable) → conversation log format (semi-stable) → our own state file (stable) → OS process state (very stable)?
- **Fallback when wrong:** does anything else cross-check this signal, or is its output load-bearing?

The combination drives the decision:
- **Critical + Frequent + Unstable + No fallback** ⟶ deterministic alone is forbidden. Bring in a Haiku-class LLM (per-check token cost ~$0.0001) OR add a canary that makes the deterministic check self-healing (3.2). Probably both.
- **Critical + Infrequent + Stable + Has fallback** ⟶ deterministic check is fine, but a canary is still required.
- **Non-critical, anywhere** ⟶ deterministic check is fine; canary is best-effort.

**3.2 — Mandatory canary with self-healing.**

Every state-detector ships with a paired **canary** that:

1. **Forces the state being detected into a known shape** by exercising the upstream system in a controlled way (e.g., send a known short prompt, write a known file, fire a known event).
2. **Captures the upstream's observable response** to that known input.
3. **Verifies the detector reads the response correctly** by comparing the detector's output against the expected answer derived from the known input.

The canary runs at startup AND on a recurring schedule (default hourly; the recurrence cadence is configurable per detector based on how fast the upstream changes).

**On canary failure, the system tries self-healing first**, in this order:

1. **Re-derivation:** the canary itself produced a known input/output pair. Re-derive the detector's signature from that pair (e.g., empty-prompt detector: derive the prompt character by finding the structurally-distinguishable line that's present after completion and absent before).
2. **Alternative strategies:** if re-derivation isn't possible, try a documented list of alternative detection strategies for the same signal (e.g., a different known pattern, a different parse path, an LLM-based check as fallback).
3. **Persist the new signature:** once a strategy works, persist it so future startups use it.

Only when **self-healing exhausts** does the failure surface as a user-facing degradation signal. Echo's Telegram alerts catch this. Other Instar agents in the fleet do NOT see this surface by default — alerts default to local logs only and opt-in to Telegram via agent-level config. This avoids alert noise across the fleet while keeping the developer (Echo) in the loop.

The success path is **quietly correct**. Telegram is the exception path, used only when the system can't self-heal.

**3.3 — E2E coverage gate, not unit-test-only.**

No state-detection code merges without an e2e test that exercises the real upstream system end-to-end.

Synthetic-buffer / mock-based unit tests are regression armor — useful, required for fast iteration, but **insufficient as the only verification**. They encode our assumptions about the upstream, and silent failures happen exactly when our assumptions diverge from reality.

The canary defined in 3.2 doubles as the e2e gate: it's already exercising the real upstream. CI runs the canaries against real upstream systems (gated by `INSTAR_REAL_API=1`) and blocks merges that don't include one.

### Why

The Phase 3 substrate audit surfaced three bugs of this class in a single component:
1. The completion-detector used static UI strings as markers, returned wrong answers when those strings appeared in response bodies or when Claude Code's UI evolved.
2. The capability declarations claimed primitives the adapters didn't implement, and the tests verified mocks instead of behavior.
3. The pool's "stable for N seconds means done" heuristic relied entirely on upstream timing characteristics that change with model speed and context length.

All three are the same pattern: deterministic check + upstream evolution + no canary + insufficient e2e = silent failure. The pattern has recurred in Instar before this project and will recur again. The structural response is what this document specifies.

Cat-and-mouse with evolving upstream is unavoidable. The framework needs to evolve along with the upstream — fast enough that drift is detected and healed before users notice, quiet enough that healing doesn't generate alert fatigue, robust enough that the failure mode of last resort is graceful degradation rather than silent corruption.

---

## Upstream-agnostic — every external dependency

Rule 3 is not a Claude-Code-specific rule. The same three sub-rules apply to:

- **OpenAI Codex** (Phase 4) — its `codex exec` output format, its app-server JSON-RPC schema, its hook payloads, its session UUID format. All of these can drift; all need canaries.
- **Google Gemini, Ollama / LM Studio, OSS frameworks** (Phase 6) — every adapter for a new provider ships with its own canary set.
- **Telegram, Slack, GitHub, Cloudflare** — webhook payload shapes, rate-limit response formats, API schemas. Canary cadence is per-upstream based on how often the system actually changes.
- **OS-level state** (`tmux`, `ps`, filesystem) — slower-evolving but not immune. Canaries here run weekly or at major-version-upgrade time, not hourly.
- **Future providers we haven't integrated yet** — the rule applies before they ship, not retroactively. New-adapter PRs include the canary infrastructure as a gate.

The framework needs to be generic enough that a new adapter doesn't reinvent canary infrastructure — there's a substrate-level pattern (`src/providers/canary/` or equivalent) that each adapter extends with its own upstream-specific checks.

---

## What this looks like in practice

For the substrate fixes shipped in commits a1b2d47a..1baee926 of `spec/provider-portability` (idle-marker / pool decay / poisoned-session / capability-honesty), each one needs a paired canary retrofit:

- **Empty-prompt detector (`promptRunner.ts`).** Canary: at pool spawn, send a known short prompt (`"reply with the digit 7"`), capture the pane after completion-detection fires, verify the captured response contains `"7"`. On failure, re-derive the detector signature from the post-completion pane structure (the line above the status-bar zone that wasn't there before sending becomes the new empty-prompt pattern). Persist to `~/.instar/state/anthropic-interactive-pool/empty-prompt-signature.json`. After 3 re-derivation attempts fail, fall back to a Haiku LLM check ("is this terminal output a completed Claude Code prompt?") and continue. If that also fails, surface to Echo Telegram and refuse to start the pool.

- **Pool decay handler (`pool.ts`).** Less drift-prone (errors are JS-level, not Anthropic-UI level). Canary is lighter: at startup, attempt a controlled spawn failure (e.g., wrong claudePath), verify the degradation event fires and retry-with-backoff kicks in. Run weekly, not hourly.

- **Capability-honesty marker (`markers.ts`).** Drift-resistant by design (symbol-based, internal to Instar). Canary verifies stubs created by both adapter factories satisfy `isStubPrimitive` at startup. Run at startup only.

- **Conformance framework population.** This is the audit's biggest single gap (no-op assertions). Each conformance suite gets real behavior assertions gated by `INSTAR_REAL_API=1`, replacing the current Phase 2 placeholders. The conformance suites themselves become the e2e gate per Rule 3.3.

---

## Enforcement

- **At design time:** every PR introducing new state-detection code includes the Rule 3.1 rationale doc + the Rule 3.2 canary + the Rule 3.3 e2e test in the same PR. Review checklists call this out.
- **At commit time:** a future structural check (hook? linter?) scans diffs for new regex/state-parsing patterns and flags PRs that don't ship a canary alongside.
- **At runtime:** canaries actually run. Failures self-heal, log locally always, surface to Telegram only for opted-in agents (Echo by default).

This document is enforced the same way Rules 1 and 2 are: foundational, overrides any earlier proposal that conflicts.
