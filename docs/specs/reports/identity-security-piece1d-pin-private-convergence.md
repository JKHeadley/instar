# Convergence Report — The dashboard PIN goes to the owner privately, never to a group

**Spec:** [docs/specs/identity-security-piece1d-pin-private.md](../identity-security-piece1d-pin-private.md)
**Slug:** `identity-security-piece1d-pin-private`
**Iterations:** 3 (round 3 was a delta check). It was also section 5 of piece 1 in that spec's round 5.
**Final-round design findings:** 0 internal. The cross-model items left are scope rulings recorded in the spec.

---

## ELI10 Overview

The agent used to pin its dashboard PIN in the Telegram group, where everyone in the group could read it. Now the PIN goes only to the owner's private chat with the agent's bot. The group message keeps the link and says the PIN was sent privately.

If the owner has never opened a private chat with the bot, the group keeps the PIN for now so they aren't locked out, and adds a link to open that chat. The moment the owner says hi there, the agent sends the PIN and takes it off the group.

Agents can ask the server to send the PIN privately, but they never see the PIN themselves.

## Original vs Converged

- **Originally:** send the PIN privately on each broadcast, and fall back to the group whenever that failed.
- **Round 1** found five problems:
  - the group fallback triggered on ordinary failures;
  - there was no route an agent could call without reading the PIN;
  - the quiet-by-default gate could store the private message, PIN included;
  - standby machines also broadcast;
  - the delivery waited for a broadcast that named tunnels rarely get.
- **Round 2** responded with:
  - a server action that returns only an outcome;
  - a protected `owner-secret` category that is always delivered and never stored;
  - delivery on the owner's own first private message;
  - a record per machine and PIN generation;
  - digits in the group only on a definite "no private route" with no other way in.
- **Round 2 also** fixed migration parity for the Codex and Gemini instruction copies.
- **The throwaway proof** added two fixes: a send-time stamp on each message, and a "sent a moment ago" answer for repeats.

## Iteration Summary

| Iteration | Reviewers who flagged design issues | Design findings | Precision findings | Spec sections changed |
|-----------|-------------------------------------|-----------------|---------------------|-----------------------|
| 1 | security+adversarial, integration+lessons+DC+scalability, Astra | 3 + 4 + 5 | ~15 | redesign: route, secret category, triggers, digits rule. Standards-Conformance Gate: ran (3 flags) |
| 2 | integration (1: Codex/Gemini copies), Astra (7, scope); security converged | 1 + 7 | ~14 | migration scope, gate restriction, standbys, rate cap |
| 3 | none (integration delta converged) | 0 | 2 | — |

## Full Findings Catalog

All answers are in the build state folder: `reviews/r5`, `reviews/p1d-r1`, `reviews/p1d-r2`, `reviews/p1d-r3`.

## Left behind

- No PIN in any chat at all: piece 4 (device credentials), after the local link (piece 1a).
- Rotating PINs that were already posted: piece 4.
- A discard operation for a held secret send in the origin layer's retry store.
- A real private chat with a fresh owner: a dated daytime check with the spare test bot.

## Convergence Verdict

Converged at round 3 (80/20: the internal design findings fell to zero). The spec carries `approved: true` under the approved umbrella and Justin's standing guidance. No constitution text changes.
