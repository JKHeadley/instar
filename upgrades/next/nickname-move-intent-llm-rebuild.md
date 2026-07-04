<!-- audience: agent-only | maturity: experimental -->

## What Changed

The "move/run/pin this on `<machine-nickname>`" recognizer — the thing that decides whether a
mid-conversation message is a command to move the session to another machine — was rebuilt from a keyword
verb-list into an LLM classifier (`src/core/MoveIntentClassifier.ts`). The old code (`TRANSFER_VERBS =
[move, transfer, run, continue, resume, keep, …]` × a preposition × a known nickname) hijacked the
operator's plain discussion **"keep the work on the laptop"** on 2026-07-03 — it matched the verb `keep`
and swallowed the message before the agent ever saw it. The new classifier infers move/pin intent from the
message **and** a bounded window of recent conversation, and constrains the target machine to a
known-nickname enum via **code-side validation of the model's emitted field** (never string-matching the
model's prose). It is the exemplar conversion under the constitutional standard *"Intelligence Infers,
Keywords Only Guard"* (parent: *"Intelligent Prompts — An LLM Gate Must Not String-Match"*). It **fails
open**: on any uncertainty — no provider, circuit-breaker open, timeout, unparseable/schema-violating
output, target-not-in-enum, or low confidence — the message passes straight through to the agent, never
hijacked. It ships **dev-gated dark on the fleet + dry-run first on a development agent** (it logs
would-hijack vs would-pass to `logs/move-intent.jsonl` and actuates nothing until a deliberate
`dryRun:false`). The keyword decision is removed from `NicknameCommand.ts` (only the `NicknameCommand` type,
consumed by the unchanged `TransferByNickname` planner, remains). Ships with a committed discrimination
corpus (command vs discussion both ways + guardrail + fail-open) — deterministic in CI plus an opt-in
`INSTAR_LIVE_MOVE_INTENT=1` real-model benchmark used as the graduation gate before actuation.

## What to Tell Your User

Nothing user-facing right now — this ships dark on the fleet and dry-run on a development agent, so no
behavior changes until it's deliberately graduated. If asked why the agent used to grab a message like
"keep the work on the laptop" as a machine-move command: that was a brittle keyword list, now replaced by
an LLM that judges intent from the message and its conversation context and errs toward *not* grabbing your
message when unsure. The move-by-nickname capability itself is a dev-only experimental feature (part of the
dark multi-machine session pool); only *how it recognizes your intent* changed.

## Summary of New Capabilities

- `src/core/MoveIntentClassifier.ts` — LLM-with-context move-intent recognizer (`classifyRelocationIntent`
  + `toNicknameCommand`); structured-output enum guardrail validated in code; fail-open on all uncertainty.
- Config `multiMachine.sessionPool.moveIntent` (`enabled` dev-gated; `dryRun:true`, `minConfidence:0.85`,
  `timeoutMs:4000`, `contextWindowTurns:6`, `modelTier:'fast'`); registered in `DEV_GATED_FEATURES`.
- `logs/move-intent.jsonl` — machine-local dry-run soak log (LLM-engaged decisions only; 80-char preview).
- Committed discrimination corpus + opt-in real-model benchmark (`INSTAR_LIVE_MOVE_INTENT=1`), the
  graduation gate before `dryRun:false`.
