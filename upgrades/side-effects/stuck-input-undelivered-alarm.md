# Side-Effects Review — stuck-input undelivered alarm

**Slug:** `stuck-input-undelivered-alarm`
**Date:** `2026-10-20`
**Author:** Echo (autonomous, 24h run on topic 61449)
**Tier:** 1

## Summary of the change

Two defects in stuck-input recovery. (1) `fireStuckInputRecovery` required a
durable delivery row that is only ever created for `codex-cli`, so on every other
framework it returned `refused / missing-durable-delivery-evidence` without sending
a key — 75,001 consecutive refusals measured on one agent, all at attempt 0, so the
ladder never advanced, never exhausted, and never escalated. (2) Every terminal
path ended in `exhausted = true` plus one JSONL row, with no attention item, no
degradation and nothing to the person waiting.

The fence is now scoped to where its evidence can exist; a refusal consumes a
budget so the wedge reaches a terminal state; that state raises one alarm per wedge
(attention item + a deterministic notice into the conversation). Both recovery
surfaces stopped reporting recovery they had not observed.

## Decision-point inventory

No LLM decision points added or changed. The new terminal verdict is deterministic
(counter vs threshold over pane observations).

## Blast radius

- `SessionManager.fireStuckInputRecovery` — the Stage B branch now requires a
  `deliveryId` to engage. Where one exists (codex), behaviour is byte-identical.
  Where none exists, the pre-Stage-B keypress path runs. This is strictly MORE
  capability than today's permanent refusal, and no more reach than the injection
  path in the same function already takes on the untracked branch.
- `SessionManager.verifyInjection` — consumes the recovery result; adds one
  verify-only poll at 9000ms. No new keypresses; the ladder is unchanged at four.
- `StuckInputSentinel` — new per-record refusal budget and a one-shot
  `onUndeliverable` callback. Signal-only; it presses nothing new.
- `server.ts` — wires that callback to the attention queue and to `sendToTopic`.

## Reversibility

Fully reversible by revert. No state schema change, no migration, no new config
key, no durable file format change. The new JSONL `action: 'undeliverable'` row is
additive and ignored by existing readers.

## Failure modes considered

- **A noisy alarm.** Deduped per stuck text (`undeliverableRaised`), and only
  reachable after a full budget against an IDLE pane. A session mid-turn is never
  touched (`isPaneActivelyWorking`), and the harness's own dim composer suggestions
  are excluded by the existing ghost-text gate, which this change deliberately does
  NOT alarm on (2,271 such skips measured — alarming on them would be the flood).
- **A throwing consumer.** Wrapped; a consumer that throws logs and the tick loop
  continues (test covers it).
- **A duplicate submit from the newly-live keypress.** The pane-state guards that
  always governed the keypress are unchanged: marker still at prompt, no activity
  indicator, ghost-text gate. The only change is that the key now actually reaches
  tmux on frameworks where it previously could not.
- **The notice itself failing.** Sent through `sendToTopic`, the deterministic path,
  never the LLM-gated reply path — which fails closed under exactly the pressure
  that produces a wedge, and would have turned the one message explaining the
  silence into more silence.

## Verification

10 new unit tests (`tests/unit/stuck-input-undelivered-alarm.test.ts`), including
wiring integrity for the server-side consumer. The Stage B fence test was verified
to FAIL against the unfixed gate and pass with it. Existing related suites green:
`StuckInputSentinel`, `-ghost-text`, `-escalation`, `session-injection-verify`,
`codex-stranded-draft-recovery` — 89 tests. Full lint clean. `tsc --noEmit` clean.

## Class-Closure Declaration

**Defect class:** `unbounded-self-action`
**Closure:** `guard`
**Enforcement:** ratchet — `tests/unit/stuck-input-undelivered-alarm.test.ts`

This change does not introduce an unbounded self-action; it BOUNDS one that was
already running. The sentinel's keypress was already on a timer, and because a
refusal consumed no rung the loop had no terminal state at all: 75,001
consecutive refusals were measured on one agent, every one at attempt 0, re-asked
every ten seconds indefinitely.

**Convergence argument.** Steady-state bound: at most `maxAttempts` (4) keypresses
per stuck prompt text, asserted over 40 consecutive ticks by the ratchet test.
Settling brakes, in order: a refusal now consumes the same budget
(`consecutiveRefusals`), so the refusal loop terminates; `undeliverableRaised`
makes the terminal alarm one-shot per wedge rather than per tick;
`record.exhausted` stops all further firing until the prompt text changes; and the
per-record state is keyed on that text, so a changed prompt is a new episode
rather than an extension of the old one.

**Known gap, out of scope here:** `StuckInputSentinel` is not a member of
`src/testing/selfActionRegistry.ts`, so it is not covered by
`tests/unit/self-action-convergence.test.ts`'s shared fixture. Registering it
needs a pressure fixture of its own and is tracked separately; the ratchet cited
above is specific to the bound this change adds.
