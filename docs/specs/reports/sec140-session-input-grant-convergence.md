# Convergence Report — Typing into a session from the phone needs Face ID once every few minutes (SEC-140)

## ⚠ Round cap passed: a confirming round (7) was run on the Chief of Staff's instruction and was not quiet

The internal reviewer returned DESIGN-SOUND in round 5. The external reviewer raised five precise findings in round 6 (transport for grants, the first-grant transition, clear ordering across a restart, pending key presses, the passcode limit), all applied as specified. They have not been confirmed by another round. The constitution check on the final text: 102 standards, 0 findings.

## Cross-model review: codex-cli:gpt-6.2-astra

A real GPT-tier external pass ran in all six rounds (`cross-model-review.mjs --family codex-cli`). An internal Claude reviewer covering security, adversarial, integration/multi-machine and decision-completeness ran in rounds 1-5.

## ELI10 Overview

The phone can type commands into the agent's sessions, and today it proves only that the request came from the phone, not that its owner is holding it. After this change, typing needs a short "go-ahead" the phone gets with Face ID. One Face ID covers a stretch of typing (5 minutes idle, 30 minutes at most, owner-adjustable). Older apps keep working until they update, but a phone that has used a go-ahead once always needs one, on every machine, so a copied phone key cannot skip it.

## Original vs Converged

- **Original:** a presence-signed 5-minute grant, a three-value mode switch, a per-device "has used a grant" flag, the grant checked on the machine the phone talks to.
- **Rounds 1-2:** the updated app must take a grant on first send (otherwise protection never starts); fresh `LAContext` per grant; the per-device flag must work without a ledger and across machines; clears must name exact records; 428 instead of 401; the chat path named as a separate item; grants not bound to the host name.
- **Rounds 3-4:** one rule with three outcomes (allow, grant-required, blocked) shared by the app and the server; the "available" condition becomes the enrolment route's own predicate; crash recovery for the ledger row; relay errors never mapped to the retryable code.
- **Rounds 5-6:** the renewed deadline returned on each send; whether this connection can set up Face ID; readiness counted per ingress machine; grants only over the local secure transport; clears that arrive before their rows; key presses need a fresh tap after Face ID; the passcode limit stated.

## Iteration Summary

| Iteration | Reviewers who flagged | Design findings | Spec changes |
|---|---|---|---|
| 1 | codex 5, internal 6; SCG 2-3 per pass | 11 | first-use grant, LAContext, ledger + local flag, epochs, 428, chat out of scope, host binding |
| 2 | codex 4, internal 3 | 7 | row-id sets, no boot backfill, `available` as a machine setting, decision table, retry/replay order |
| 3 | codex 5, internal 2 | 7 | three outcomes, closure by permission, enrolment risk in the offer, DELETE route, timeout rule |
| 4 | codex 5, internal 1 | 6 | shared predicate, separate exposures, crash recovery, relay 428 mapping |
| 5 | codex 4, internal 0 (DESIGN-SOUND) | 4 | renewed deadline, enrolment over this connection, ingress readiness, replay test |
| 6 | codex 5 | 5 | grant transport, first-grant loss, clear ordering, key presses, passcode limit |
| 7 (confirming, after the Studio check's six concerns and the registration/chat section) | codex 4, internal 3 | 7 | connection eligibility in the shared rule, one mode resolver (`resolveDevAgentGate`), grants still issued in `off`, fresh tap whenever Face ID interrupts a key press, per-pairing registration states, SEC-142 not a merge blocker and never lowering `grantSeen` |

Standards-Conformance Gate: ran every round; final run 0 flags. Earlier runs raised Security Fixes Keep the Experience Whole (now an open question for Justin), Judgment Within Floors (the lifetime caps were removed; the owner sets them), Close the Loop (the weekly re-raise), multi-machine posture and cross-store coherence (the ledger design).

## Proportion

Tier 2, security-sensitive, a contract with shipped apps on two platforms, six rounds. The findings shrank from design-level to precision-level over the rounds.

## Open questions (for Justin, through the Chief of Staff)

1. Experience cost: one Face ID prompt per stretch of typing, for a medium-high finding (accept, or re-rate critical).
2. The interim window in which older apps keep device-key-only typing.

Also: authorise one confirming round, or accept the round-6 fixes as written.

## Convergence verdict

**Not converged by the skill's rule.** The confirming round found seven more findings, all about consistency between sections and the app contract, none a new bypass; all are applied and not yet confirmed. Final constitution check: one flag (the 30-minute default, which the spec makes owner-adjustable with its reasons). The design now depends on the registration fix (SEC-142) for full strength and on a separate chat control (SEC-143), as the threat model sets out. The app half (echo-instar-apple-app-rebuild) and Android (via the Chief of Staff) are named in the spec.
