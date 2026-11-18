# Convergence Report — A missing or unreadable API key

**Spec:** [docs/specs/identity-security-piece1h-no-token-refusal.md](../identity-security-piece1h-no-token-refusal.md)
**Slug:** `identity-security-piece1h-no-token-refusal`
**Converged at:** 2026-11-18 (round 2 plus a delta check)
**Iterations:** 2 as its own spec (it was section 1 of piece 1b for that spec's round 1)
**Final-round design findings:** 0 internal; the cross-model reviewer's remaining items are scope rulings recorded in the spec.

---

## ELI10 Overview

An agent's control panel asks every caller for a secret key. Two things can go wrong with that key. If the key is stored but can't be read, the agent used to crash on every request; now it refuses cleanly, keeps everything with its own proof working, retries, and tells the owner if it lasts. If there is no key at all, the agent is open to anyone who can reach it. This change does not suddenly lock such an agent: doing that automatically broke running conversations and message relays in review. Instead it logs who would have been refused, keeps the owner's existing "fix auth" reply (now safer), and leaves the lock-down decision to the owner's per-agent card in a later piece. The Telegram relay also stops sending a broken key and picks up a changed one by itself.

## Original vs Converged

- **Originally:** refuse every request when no key is configured, create a key automatically at boot, and have the relays re-read it, behind a development switch.
- **After round 1:** automatic creation was dropped. Each machine would mint a different key, running sessions keep the old value, and the relay kept a stale key and lost messages. Section 10 of the umbrella makes the lock-down the owner's per-agent decision. What stayed:
  - the clean refusal of an unreadable key (known-invalid);
  - the relay fixes;
  - a count of requests served without a key;
  - the existing owner notice.
- **After round 2:**
  - the refusal moved after the dashboard and session tokens;
  - `false`/`0` count as unreadable;
  - the count became an observe log with the caller;
  - "fix auth" refuses on a multi-machine agent;
  - the server re-read uses the full config load.

## Iteration Summary

| Iteration | Reviewers who flagged design issues | Design findings | Precision findings | Spec sections changed |
|-----------|-------------------------------------|-----------------|---------------------|-----------------------|
| 1 | security+adversarial, integration+lessons+decision-completeness, Astra | 3 + 3 + 9 | ~15 | redesigned: no auto-creation, no switch. Standards-Conformance Gate: ran (6 flags) |
| 2 | Astra (security and integration converged) | 9 (2 fixed, 7 ruled as scope with reasons) | ~10 | refusal position, observe log, fix auth. Standards-Conformance Gate: ran (4 flags, each answered in the decision points) |

## Full Findings Catalog

All answers are in the build state folder: `reviews/p1b-r1`, `reviews/p1h-r1`, `reviews/p1h-r2`. The rulings on the cross-model round-2 items are in the spec's "Review rulings" section.

## Proportion

Tier 2. About 10 source files and 250 lines, plus a new small class and tests. The design was cut rather than iterated a third time.

## Left behind

- Enforcement on no-key agents: piece 5's per-agent card, reading this spec's observe log.
- Key rotation with a consumer inventory: piece 4.
- Sessions started before this release keep the text "undefined" until they restart.

## Convergence Verdict

Converged at round 2 (80/20 standard: the internal findings fell to zero, and the cross-model items left are umbrella sequencing, recorded with reasons). The spec carries `approved: true` under the approved umbrella (Justin, 2026-11-17 19:34 PST) and his standing guidance that only constitution changes need his approval. No constitution text changes.
