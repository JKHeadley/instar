# Side-Effects Review — Multi-Shot Stuck-Input Recovery

## Change Summary

`SessionManager.verifyInjection` upgrades from single-shot to multi-shot
polling with escalating recovery actions. When the recovery Enter is itself
eaten by the same paste-end race that caused the original stuck state, the
loop keeps trying — with different key combinations — until the marker
clears the `❯` prompt or the bounded schedule (4 attempts over 6.5s)
exhausts.

Three surface changes in `src/core/SessionManager.ts`:

1. `verifyInjection` now polls at 500ms, 1500ms, 3500ms, 6500ms from
   injection. Each tick checks pane state; stops as soon as the marker
   clears the prompt. Single Degradation entry on the first recovery firing.
2. `isMarkerStuckAtPrompt(pane, marker)` extracted as a named method so the
   polling loop and tests share one detection rule.
3. `fireStuckInputRecovery(tmuxSession, attempt)` escalates the recovery
   action: attempts 0 and 1 send `Enter`; attempt 2 sends `C-m` (literal
   carriage return — bypasses any Enter-specific consumer); attempt 3 sends
   `Enter` + 150ms sleep + `Enter` (covers sub-second race windows).

## Failure Mode Being Fixed

Reproduced live in `/Users/justin/.instar/agents/echo/logs/server.log`:

```
01:31:49 [LOG] Injected initial message into "echo-telegram-messages-pausing-in-input" (297 chars)
01:33:49 [WARN] Injection stuck — marker "[telegram:7195] Your session j…" still at prompt. Resending Enter.
01:33:49 [DEGRADATION] SessionManager.verifyInjection: Enter eaten by paste-end race
01:34:15 [WARN] Injection stuck — marker "[telegram:7195] Your session j…" still at prompt. Resending Enter.
01:34:15 [DEGRADATION] SessionManager.verifyInjection: Enter eaten by paste-end race
```

Two observations:

- The async setTimeout(1500ms) fired 120 seconds after injection — the Node
  event loop was blocked, likely by initial-message-driven session startup
  work. Single-shot timing is unreliable under load.
- The recovery Enter itself failed (the second `Injection stuck` log line
  for the same marker proves the first recovery did not unstick the input).

The single-shot design assumed both: (a) the timer fires near 1.5s and (b)
the recovery Enter always lands. Both assumptions break in practice.

## Over-Block Risk

**Polling more times = more chances to send a spurious Enter.** The
detection gate is unchanged from the single-shot version: marker (first
40 chars, stripped of leading whitespace, ≥8 chars) must appear on or
immediately after a line containing `❯`. Claude Code only renders `❯` on
the active input prompt row — not on transcript history — so the marker
cannot match a historic echo of the message. Each polling tick re-runs the
same gate; if the message has submitted, the gate refuses and recovery
does not fire.

Worst-case false-positive: marker is genuinely visible at `❯` because the
user is still typing the same prefix the agent just injected. Extremely
implausible (the marker is the message's first 40 chars, not a common
prefix). Impact if it happened: one or more extra Enters in the input
box. The user would see their typing submitted prematurely. Acceptable
trade for fixing the stuck-message bug.

The escalation to `C-m` and double-Enter applies only on attempts 2 and
3 — after two consecutive ticks showed the marker still stuck at `❯`.
That's an additional safety margin against accidental escalation.

## Under-Block Risk

If the polling schedule's last tick (6500ms) still shows the marker stuck
despite four recovery attempts, the loop exits without further action.
The existing recovery layers below still apply:

- `StallTriageNurse` fast-path nudges stuck inputs when its periodic
  diagnosis pass runs.
- The `pasteRetried` mechanism handles the `[Pasted text #N]` placeholder
  case.
- The idle-prompt zombie reaper eventually kills sessions with no output
  changes past the configured threshold.

A session that survives all four ticks without recovery is almost certainly
not suffering the paste-end race — something else is wrong (tmux frozen,
terminal in a weird state, etc.) and continued Enter-hammering would not
help.

## Level-of-Abstraction Fit

Same as the single-shot version: `verifyInjection`,
`isMarkerStuckAtPrompt`, and `fireStuckInputRecovery` are all private
methods on `SessionManager` and operate at the tmux-send-keys abstraction
layer. No new public API. No upward leakage of tmux details. Helpers are
extracted only because polling and detection are now distinct concerns
that benefit from named test boundaries.

## Signal vs Authority Compliance

`verifyInjection` is a verification (signal-emitting) layer. It detects a
specific structural failure (`marker visible at ❯ after Enter was sent`)
and takes one bounded structural action per detection (one Enter / C-m /
Enter+sleep+Enter). It does not replace any higher gate; it is the only
component at this layer with both the context (the marker text and the
injection timing) and the authority (it owns the tmux session interaction)
to perform the recovery. There is no higher gate to defer to.

The escalation across attempts is a structural escalation in mitigation
strategy, not in authority. Each recovery attempt remains "send one of N
recovery key sequences to tmux" — same authority bound throughout.

## Interactions With Existing Recovery Paths

| Layer | Trigger | Scope | Conflicts with multi-shot? |
|-------|---------|-------|----------------------------|
| `verifyInjection` polling (new) | After every `rawInject` | per-injection, bounded by 6.5s schedule | n/a — this is the new layer |
| `pasteRetried` | `[Pasted text #N]` visible at idle prompt | per-session lifetime | independent — different match string, fires from idle detector |
| `StallTriageNurse` fast-path | text at ❯ with no glyphs, before LLM | per-triage-pass | independent — runs from triage scheduler. Could fire AFTER verifyInjection's 6.5s window if the session is still stuck. Sending one more Enter at that point is harmless. |
| Zombie-kill timer | `idleMs > idlePromptKillMinutes` | global | unchanged — only fires if all prior layers missed and session sat for the configured minutes |

The four layers gate from fast-and-proactive (per-injection polling) to
slow-and-destructive (zombie kill). Adding more ticks to the proactive
layer is monotonically safer — it shifts more stuck-state recovery to the
fast path rather than waiting for the LLM-backed triage.

## Rollback Cost

- Revert: restore the single `setTimeout` body from the prior version of
  `verifyInjection`; delete `isMarkerStuckAtPrompt` and
  `fireStuckInputRecovery`. Pure additive — no state, no schema, no
  migration.
- Tests added: `tests/unit/session-multishot-recovery.test.ts` (12 tests).
  Existing structural tests (`tests/unit/session-injection-verify.test.ts`)
  were updated to assert the bounded-multi-shot invariants — 10 tests pass.
- Branch surface area: 1 source file modified, 1 test file modified, 1 test
  file added.

## Evidence

- Live failure: `/Users/justin/.instar/agents/echo/logs/server.log`
  01:31–01:34 — two stuck-then-eaten-recovery events on the same injection
  marker.
- `tests/unit/session-multishot-recovery.test.ts` — 12 tests covering
  multi-shot polling, escalation across attempts, bounded recovery count,
  early-stop on submission detected, no-op for clean injections, no-op for
  short markers, halt on tmux session disappearance, and detection-
  heuristic edge cases.
- `tests/unit/session-injection-verify.test.ts` — 10 structural tests
  asserting the new design contract (bounded retries, monotonic backoff
  schedule, recovery-method escalation, early-stop predicate).
- No regression: `SessionManager-injection.test.ts`,
  `paste-stuck-detection.test.ts`, `session-telegram-inject.test.ts`,
  `stall-triage-typed-not-submitted.test.ts` all pass (25 tests).
