# Convergence report: the owner record on every machine (piece 2b)

**Spec:** `docs/specs/identity-security-piece2b-owner-record-store.md`
**Iterations:** 7 rounds with an internal security and integration reviewer, plus one cross-model round (GPT-6.2 Astra on the Headley Codex account) and the constitution check.

## In plain words

Piece 2a wrote the rulebook for the owner ledger. This piece decides where each computer keeps the ledger, how it is started, how computers share it, and what the agent does when the ledger is missing or broken. The reviews mostly found ways a missing or confused ledger could quietly fall back to the old, weaker rules, or let one bad computer force work on all the others. Each was closed.

## Findings by round

| Round | Design findings | What changed |
|---|---|---|
| 1 | 7 | no pin at Basic; a machine with no identity waits for enrolment; markers apart from the record; no daily cap; push bounds; the fence moved to piece 2c; one gate function |
| 2 | 4 | a genesis must match a registered machine; peer markers; peer answers gate only bootstrap; TLS flood fixed in 2a |
| 3 | 2 | the registry check stops at the pin; a peer marker is honoured only when it checks out |
| 4 | 1 | a broken record that never enrolled reads as Basic and can be replaced |
| 5 | 0 | converged (precision: peers with the same broken record; replacement excludes the old genesis everywhere) |
| Constitution | 3 standards | each bound's source is shown; an unverifiable marker holds; the retry backs off |
| Astra | 3 relevant (others re-reviewed piece 1) | three gate outcomes with a "seen" marker; bounds across all peers and a breaker; summary fix |
| 6 | 1 | the revocation lane admits only a revocation that verifies against a key valid now |
| 7 | 0 | converged |

## What the design guarantees

- **A deleted or broken ledger never reads as the old rules on an enrolled agent.** The agent holds risky actions and lets the owner look.
- **A never-enrolled agent keeps working** when a computer is asleep.
- **One bad computer can't invent a starting line,** lock the others, or force endless work on them.
- **Older builds are waited for, not trusted.** Refusing them outright is piece 2c, and piece 3's enrolment requires it.

## Left for later pieces

- Reading identity from the record (piece 3).
- The owner's reset.
- The minimum-build fence (2c).
- Compacting a long record.
