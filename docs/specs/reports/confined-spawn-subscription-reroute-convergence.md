# Convergence Report — Confined spawns on the subscription path

## Converged at round 12 (rounds 10, 11 and 12 each without a design-class finding)

The first run stopped at the 10-round hard cap with one clean round (round 10). The coordinating session approved up to two more rounds (a desk-level process decision). Rounds 11 and 12 both came back MINOR from both external families, with every finding declared a refinement ("no finding invalidates the architecture"), and were folded in. By the skill's rule (the reviewer declares the class; two consecutive clean rounds), the spec converged at round 12.

**Author's disclosure on classification.** Two round-11/12 refinements changed behaviour, not only text, and the author would have been inclined to call one of them design-class had the reviewers not declared otherwise: the D3 totality point (the exclusion enumerated two answerers while claiming that no Instar writer could press a key after delivery). It is now enforced at the `sendKey`/`rawInject` chokepoint and pinned by a test, rather than argued. The other, the trust-focus rule (an unexpected focused option now fails at once instead of at the 5 s deadline), tightens a tolerance.

## Cross-model review: codex-cli:gpt-6-astra

A real GPT-tier external pass ran in all 10 rounds. Gemini was unavailable (`gemini-not-authed`).
Clean-door second read: `claude-code:claude-fable-5` (not cross-family) in rounds 1–7, 9 and 10. Round 8's clean-door call returned no output.

## How the internal review ran (disclosed)

This convergence ran inside a forked worker session, which cannot spawn subagents. The six internal perspectives (security, scalability, adversarial, integration, decision-completeness, lessons-aware) were applied by the authoring session itself, in-session, on Opus 5.5, not by independent subagents. That is weaker than the skill's design. The independent reads were the two external families plus the Standards-Conformance Gate, which ran every round. In-session review still produced real design findings in round 1: the slash-command surface of typed prompts, the trust dialog reading as `ready` to the generic detector, and the PromptGate/AutoApprover race (D3).

## ELI10 Overview

The feedback system writes fixes in a locked sandbox. This agent runs Claude only on its subscription, which means interactive mode. The lock existed only for one-shot mode, so Instar refused to start any locked session, and no fix attempt could ever run. This spec gives interactive mode the same lock: same policy file, same "refuse instead of ask" mode, an empty environment, none of the agent's keys, and the task handed over as a file instead of typed in. It also adds a small, strict script for the two startup questions interactive mode asks: "trust this folder?" (yes, only for the exact folder the executor built) and "use your browser?" (no). Anything unexpected stops the session instead of guessing.

## Original vs Converged

- **Prompt delivery.** Originally the prompt was typed into the REPL. Now it is written to a private file and one fixed line is typed. Untrusted report text could otherwise act as slash commands.
- **Startup.** Originally "answer two dialogs" was a loose matcher. Now it is a deterministic state machine:
  - exact-path trust match and verified focus;
  - a two-frame tolerance for half-drawn frames;
  - echo-then-Enter;
  - a post-submit mode check (measured footer);
  - a positive composer shape for `ready`.
- **Generic auto-answerers.** Not considered originally. Now they are excluded from confined sessions (the operated host's PromptGate would have pressed Enter on "No, exit").
- **Restart.** Not covered originally. Now there is an explicit restart boundary: `confinedDeliveredAt` is saved only after the post-submit check, and an undelivered session is killed at boot.
- **Capacity refusals.** Originally they would have parked valid items. Now the executor:
  - defers claims while the lane is full;
  - maps a typed `RerouteRefusedError` to `stopped` / `reroute-capacity`;
  - refunds the start exactly once, in one transaction, capped per claim day.
- **Claims narrowed to match evidence.** The canary covers effects, not every flag. The Goal now states the one pre-delivery residual (CLI tool-permission state is detected, not prevented). The sentinel is "improbable", not "impossible".

## Iteration Summary

| Round | Design-class findings | Precision findings | Standards-Conformance Gate | Spec/code changes |
|---|---|---|---|---|
| 1 | codex 3; clean-door 2; in-session 3 | 3 | ran (2 flags: Signal vs Authority, Framework-Agnostic) | D1 prompt file, D2 state machine, D3, shared adapter, S-v-A text, framework scope |
| 2 | codex 3 | clean-door 2 | ran (2 flags) | canary-coverage claim narrowed, restart boundary, starvation handling |
| 3 | codex 3; clean-door 2 | 4 | ran (3 flags) | G1 reality (`local` source loads `settings.local.json`), admission pre-check, typed error, refund, TOCTOU |
| 4 | codex 3; clean-door 2 | 3 | ran (2 flags) | orphan window, refund semantics, classifier precedence, echo-then-Enter, post-delivery signal |
| 5 | codex 4; clean-door 2 | 3 | ran (3 flags) | debounce unknown, refund ledger, residual race named, delivery ordering |
| 6 | codex 3; clean-door 1 | 4 | ran (3 flags) | post-submit check, single transaction, persistence statements, path charset |
| 7 | codex 3; clean-door 1 | 3 | ran (2 flags) | detection-not-prevention, rollback procedure, measured post-submit frame, G9 pin |
| 8 | codex 3 | (clean-door no output) | ran (2 flags) | Goal narrowed (Frontloaded 6), post-submit state, canary bound, P20 table |
| 9 | clean-door 1 | codex 3; clean-door 3 | ran (2 flags) | positive composer shape |
| 10 | **0** | codex 3; clean-door 5 | ran (1 flag: Framework-Agnostic, the parent spec's accepted gap) | precision only |
| 11 | **0** (both families MINOR) | codex 3; clean-door 4 | ran (1 flag: Verify the State — the post-submit check, already declared detection-not-prevention) | table restructured per state; restart precedence; charged-claims wording; post-submit check samples up to 3 frames; whitespace-path refusal by name |
| 12 | **0** (both families MINOR) | codex 4; clean-door 4 | ran (2 standing flags: Framework-Agnostic; Verify the State, both argued) | deadline-before-observation precedence; focus enumeration; build-only failure argument; completion/persistence ordering; 120 s budget with basis; D3 enforced at the send chokepoint; timing-constant basis |

Standing gate flags that were argued rather than changed:
- **Framework-Agnostic:** the parent spec's explicit, accepted gap; confinement is claude-code only by canary eligibility.
- **Signal vs Authority:** a deterministic floor deciding whether an unattended process may press a key in a security dialog; both external families agreed in every round that an LLM authority would be the defect.
- **No Unbounded Loops:** the saturated check performs no action. It is bounded by the scheduler, with one report after 12 checks.

## Full Findings Catalog (abridged; raw reviewer JSON retained in the run's scratch directory)

- **R1 codex:** completion provenance; dialog transition timing; S-v-A framing.
- **R1 clean door:** trust semantic drift; cap contention; sentinel vs untrusted evidence; pin-binary alternative; terms.
- **R2 codex:** canary coverage; restart crash points; starvation is unbounded.
- **R2 clean door:** D3 ordering race; per-attempt config home alternative; expect alternative; entropy/terms.
- **R3 codex:** boot predicate also hit headless; `--setting-sources local` semantics; daily start consumption; probabilistic wording.
- **R3 clean door:** billing premise; string-prefix error contract; TOCTOU; trust accumulation; transcript completion; upstream request.
- **R4 codex:** orphan window; refund idempotency/day; classifier precedence; completion overclaim.
- **R4 clean door:** TOCTOU at Enter; post-delivery dialogs; upstream; clarity; footer fixture.
- **R5 codex:** non-atomic Enter; delivered definition; refund marker; auto-mode admission.
- **R5 clean door:** partial-render debounce; D2 failure blames item; upstream; echo match; terms.
- **R6 codex:** residual worst case overstated; crash-consistent stop; persistence claims.
- **R6 clean door:** path charset kill-switch; debit-later alternative; option-B question; MTTR; terms.
- **R7 codex:** check is detection; crash before transaction; rollback with live sessions.
- **R7 clean door:** unmeasured post-submit frame (then measured); G7/G9 pins; D1 clarity; escape hatches.
- **R8 codex:** Goal equivalence; table ordering; canary bound.
- **R9 codex:** total transition function; credential wording; claim-day cohort.
- **R9 clean door:** absence-defined ready (design); upstream; premise detector; sequence.
- **R10 codex:** table completeness (precision); midnight wording; manual ticks.
- **R10 clean door:** premise detector; sentinel entropy; MTTR; path whitespace; refund complexity.
All addressed in text or code, or recorded as a named residual (upstream trust-skip request, option-B question, billing-premise re-check) for the coordinating session.

## Live evidence (Mac Studio, 2026-10-19)

The executor's session canary was run twice through this branch's built `SessionManager` under `mode: force`, in fresh never-trusted workspaces with a planted project hook and a planted MCP server. Both runs:
- answered the trust dialog, delivered the task by file, and recorded `confinedDeliveredAt`;
- passed 16 of 17 probes;
- showed the planted hook not running and the planted MCP server not starting.

The single failing probe, `session-git-status`, fails because Claude Code 2.1.303's Bash wrapper writes `/tmp/claude-501/cwd-*`, which the executor's sandbox policy denies (it allows `/tmp/claude`). Every Bash command therefore exits 1. That is in the executor's sandbox policy, outside this spec, and is the next executor blocker.

## Round 11 and 12 findings

- **R11 codex:** table placement of the two-frame tolerance; restart precedence (jobSlug × confined); "daily start" meaning. **R11 clean door:** single-sample post-submit check; option-B/upstream asymmetry; table clarity; whitespace-path precondition.
- **R12 codex:** dismissal deadline behind the wait rule; focus-mismatch outcomes; build-only startup failures; completion racing persistence. **R12 clean door:** 90 s budget headroom; D3 totality; bespoke-expect pattern; timing constants.
All addressed in text or code; the upstream request and the option-B question remain the coordinating session's (not filed, per its instruction).

## Convergence verdict

Converged at iteration 12. No design-class findings in rounds 10, 11 or 12. Spec is ready for approval.
