# Side-Effects Review — Pairing buttons on a new agent (armed observe)

**Version / slug:** `pairing-buttons-before-enforce`
**Date:** `2026-10-21`
**Author:** `Dawn`
**Second-pass reviewer:** `Echo, on the Studio, 2026-10-21: approved 6879b7d1a (read the guard; did not run tests)`
**Spec:** `docs/specs/a2a-pairing-invite-link.md` §6.1 (r5 amendment, approved: false — see below).

## Approval status, stated plainly

r5 changes a rule Echo required in the r1 review (B2: "Off in observe mode"). Justin set the direction in topic 61599 on 2026-10-21 ("it should NOT tell me to go to the dashboard"). Echo reviewed 6879b7d1a and approved: B2's purpose was "no tap authority without a proven secret on that tap", and once armed the guard refuses an unproven callback in either mode before pairing runs. Echo checked this against the base guard's `evaluate()` but did not run the tests (module resolution in its worktree); the evidence below is my mutation-checked runs.

## Summary of the change

Justin paired PP (a fleet agent) with Echo (a development agent). Echo's guard enforces from the start, so Echo showed Approve. PP's guard was in default observe, so `PairingInviteTelegram`'s `enforcing()` was false and the Finish prompt said "Open the Threadline tab on the dashboard". A fleet agent stays in observe for 24 h to 7 days after arming, so this hits every first pairing on every new agent.

1. `src/server/LifelineIngressGuard.ts`: `tapsProvable()`. True in enforce. In observe it is true only when not held by config, not bypassed, armed by `lifeline-proof`, and a secret is held. In that state the guard already refuses every tap without the secret (`refusingTaps`, the existing "after arming, an unproven tap is REFUSED in observe as well as enforce" test).
2. `src/server/routes.ts`: pairing's `enforcing` is `tapsProvable() && !isPolling` (it was `mode() === 'enforce' && !isPolling`).

## Decision-point inventory

- Whether pairing offers Telegram buttons, and whether `operatorTap` accepts a tap at all — **modify** — from "enforce" to "can prove a tap". Every other tap check is unchanged: `verified` (the lifeline secret on this callback), owner id, chat, one-time token.

## 1. Over-block

Unchanged or reduced. Held observe, bypass, no held secret, and a lifeline that has never proven itself still fall back to the dashboard, as before.

## 2. Under-block

The question is whether a tap that enforce would refuse is now accepted. `operatorTap` still requires `verified === true`, and `verified` is true only when this callback carried the correct lifeline secret. The guard computes that the same way in either mode. In armed observe the guard's own callback route refuses a secretless tap with 401 before pairing sees it (integration test: `cbq-forged` → 401). Enforce adds one thing over armed observe: it refuses secretless MESSAGES. Pairing's invite interception (`onForwardedInvite`) also requires `verified`, so it doesn't rely on that either. The cooperative boundary in §6.1 (a process that reads the secret file can forge a tap) is the same in both modes.

## 3. Level-of-abstraction fit

The guard owns "can a tap be proven here"; pairing asks it instead of reading the mode and re-deriving the guard's tap semantics.

## 4. Signal vs authority compliance

The authority is still the owner's verified tap. The guard state is a signal of whether verification is possible.

## 4b. Judgment-point check

None added.

## 5. Interactions

Only pairing's `enforcing` reads `tapsProvable()`. Tunnel consent and prompt-gate taps are unchanged. Echo's `telegram-button-approval.md` §2 plans to move P-class pairing taps to the dashboard when the PIN stops being posted to Telegram; that plan conflicts with Justin's direction here and is raised with Echo and Justin separately. This change does not touch it.

## 6. External surfaces

Telegram: new agents in armed observe now show Approve / Decline / Finish / Not them / "It's one of my agents" instead of the dashboard text. No route or wire change.

## 6b. Operator-surface quality

Removes a dead end for the most common case (a person pairing a new agent). The dashboard text remains only where no verified tap is possible.

## 7. Multi-machine posture

Machine-local: each machine's guard state decides its own buttons, as before.

## 8. Rollback cost

Revert the routes line to `mode() === 'enforce'`; `tapsProvable()` has no other reader. No state, no migration.

## Conclusion

Narrow change. Per tap, it accepts exactly what enforce accepts, because every pairing tap already requires the lifeline secret on that tap.

## Echo's non-blocking notes

1. Excluding held observe is a choice, not a safety need. Now said in the docstring.
2. `tapsProvable` needs a held secret. Right after a restart, before the lifeline's first request loads it, buttons are briefly off; the invite forward itself goes through `evaluate()` first, so in practice the secret is loaded. Low.

## Evidence pointers

- `tests/unit/lifeline-ingress-guard.test.ts` › tapsProvable (6 cases, mutation-checked).
- `tests/integration/pairing-invite-telegram-routes.test.ts` › observe (real routes; proven → prompt, forged → 401, proven tap approves; never proven → dashboard; mutation-checked against the old wiring).
- `tests/e2e/threadline/pairing-handshake-production-path.test.ts` › "a NEW agent …" (real relay, real guard in armed observe; mutation-checked).

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect is fixed and no self-triggered sends are added.
