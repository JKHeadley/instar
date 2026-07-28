# Convergence Report — Fix: peer stateSync receive-advert dropped → cross-machine memory replication never crosses

## Cross-model review: codex-cli:gpt-5.5

A real GPT-tier external pass (codex-cli, gpt-5.5) AND a Gemini-tier pass (gemini-cli,
gemini-2.5-pro) ran on both convergence rounds through the agent's own installed CLIs. Both
returned `MINOR ISSUES` on the converged body — no material design-blocking findings. Standards-
Conformance Gate: ran via markdown body (0 flags returned; the full specPath evaluator needs the
running server's own specsDir, unavailable from this decoupled worktree — recorded honestly, not
skipped).

## ELI10 Overview

The agent can run on two of your machines at once (say a laptop and a Mac mini) and is supposed to
share what it learns between them. It never worked: a learning written on the laptop never reached
the mini. The reason is a tiny but fatal data-drop. Before one machine sends a record to another,
it checks a little "yes, I can receive and store this" flag the other machine advertises. Each
machine could see its OWN flag but the PEER's flag was getting thrown away in transit — so each
machine concluded "my peer can't receive this, sending would just lose it," and refused. Both
machines did this to each other, so nothing ever crossed.

The flag was dropped in three places on the RECEIVE side: the code that unpacks a peer's reply
forgot to copy the flag; the component that records peer status didn't carry the field either; and
even if those were fixed, a "still alive" ping every 30 seconds (which carries no capability info)
would blank it out again. The fix copies the flag through both unpack sites and makes the 30-second
ping KEEP the last known flag instead of blanking it. Plus a guard test that checks EVERY
capability field survives the trip — because this exact "forgot to copy one field" bug has now
happened four times for four different fields, and the guard makes the fourth the last.

Tradeoffs: the fix is deliberately small and mirrors an existing pattern in the code rather than
re-architecting the heartbeat. Two outside reviewers suggested bigger redesigns (separate channels
for "alive" vs "capabilities", or distinct types for rich vs sparse pings); both were declined as
out-of-scope for a targeted bug fix, with the reasoning recorded — they're noted as possible future
hardening, not blockers.

## Original vs Converged

- **Originally** the spec named two edit sites (matching the build brief). Review found a THIRD
  drop site — the `PeerPresencePuller` intermediary between the network handler and the registry —
  which alone would have made the two-site fix a no-op. Convergence added it.
- **Originally** the integration test was to extend the existing round-trip test. Review caught
  that that test inlines its OWN copy of the buggy mapping, so it would prove nothing about the
  real fix. Convergence **extracted the mapping into a single shared, exported pure function** so
  production AND the test run the exact same code — and the regression-guard test now runs over
  real production code, not a hand-copied mirror.
- **Originally** the carry-forward's safety rested on an unstated assumption ("a real status ping
  always includes the capability object"). Two external reviewers flagged this as a drift risk.
  Convergence made the assumption **executable** — a test pins that the capability object is always
  present (even when every sub-flag is off), so a future cleanup can't silently re-break it.
- **Originally** the regression guard was a source/string check (brittle). Convergence made it
  **behavioral over the extracted function** and backed by a shared field registry, so adding a new
  advertised field without passing it through fails loudly.

## Iteration Summary

| Iteration | Reviewers who flagged | Material findings | Spec changes |
|-----------|-----------------------|-------------------|--------------|
| 1 | integration (HIGH), lessons-aware, codex, gemini | 4 | Added the 3rd drop site (PeerPresencePuller); extracted the mapping into a shared pure helper to close the integration-test-fidelity gap + make the ratchet behavioral; made the "object always present" invariant executable; rejected the deep-merge with rationale; added post-sparse-beat assertion, bounded-data note, N≥1 note, quotaState consequence bound. |
| 2 | codex (minor), gemini (minor) | 0 material | Folded two cheap structural improvements (shared `SESSION_STATUS_ADVERT_FIELDS` registry for the ratchet; `!== undefined` presence guards). Rejected gemini's two re-architecture suggestions as out-of-scope, with rationale. |
| 3 | (converged) | 0 | none |

## Decision-Completeness

No decisions are parked on the operator. All design choices are frontloaded: the three fix sites,
the helper extraction, the carry-forward scope (seamlessnessFlags only — fail-closed), the
rejected deep-merge, the ratchet form, and the test plan across all three tiers. `## Open
questions`: none. The build ships behind the already-merged WS2 stateSync substrate; a single-
machine install is a strict no-op.

## Multi-machine posture

This fix IS the cross-machine path. Verified N ≥ 1 correct: `checkPoolFlagCoherence` iterates all
online peers with no pairwise/"exactly 2" assumption; each peer is an independent registry Map
entry. Migration parity: pure runtime code fix (server.ts + two core modules) — no config, hook
template, or settings change — ships via the normal update path; old peers omit the field and are
treated as non-participants (the conservative side), exactly as before.
