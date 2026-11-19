# Convergence Report — Telegram sender authority: one rule on every path, and an empty list is not everyone

**Spec:** [docs/specs/identity-security-piece1e-telegram-senders.md](../identity-security-piece1e-telegram-senders.md)
**Slug:** `identity-security-piece1e-telegram-senders`
**Iterations:** 3 (round 3 was a delta check). It was also section 3 of piece 1 in that spec's round 5.
**Final-round design findings:** 0 internal. The cross-model items left are scope rulings recorded in the spec.

---

## ELI10 Overview

A Telegram agent decides who may use it from a list. An empty list, which is the default, meant anybody could. Agents that get Telegram through their relay process also skipped the list for commands and for the emergency stop.

Now one rule decides on every path. The owner, people on the list and people the owner has approved may use the agent. Only the owner can use the controls that affect the whole agent. Someone the agent can positively identify as not allowed is a stranger: they get one private reply, and the owner gets a code to approve them with. If the agent can't tell who someone is, it handles them exactly as today.

It refuses only on development agents at first. Everyone else's agents just watch and show their owner who would have been refused.

## Original vs Converged

- **Originally:** one sender check on both paths, with a fleet-wide refusal of strangers' emergency stops.
- **Round 1** found these problems:
  - the fleet-wide refusal;
  - no difference between "stranger" and "can't tell";
  - the relay process's own commands and downloads were unchecked;
  - the stranger reply went to the group;
  - talking to the agent also gave control of everyone's sessions;
  - there was no working way in.
- **Round 2** responded with:
  - four standings;
  - an action table;
  - the same rule in the relay process;
  - private, capped replies;
  - `/approve` and `/decline` wired to the existing join requests;
  - everything that refuses behind a development switch.
- **Round 2's findings:**
  - an approval could start a one-person list and lock out everyone else under today's check;
  - the topic's operator record is overwritable, so it can't decide session controls.
- **The delta** fixed both: approvals register people, and session controls go to the owner or any authorized person.
- **The throwaway proof and the second pass** added these fixes:
  - refusals are reported as refusals;
  - the check runs before the history log and media capture;
  - join-request answers skip the stop classifier;
  - unknown senders and bots keep today's answer;
  - switch off keeps today's unknown-user flow;
  - approved people get an id from their Telegram id.

## Iteration Summary

| Iteration | Reviewers who flagged design issues | Design findings | Precision findings | Spec sections changed |
|-----------|-------------------------------------|-----------------|---------------------|-----------------------|
| 1 | security+adversarial, integration+lessons+DC, Astra | 4 + 4 + 6 | ~12 | redesign: standings, action table, three paths, way in, switch. Standards-Conformance Gate: ran (5 flags) |
| 2 | security (1: one-person list), integration (1: overwritable operator), Astra (7, mostly scope) | 1 + 1 + 7 | ~10 | approvals to the registry, session-control rule, owner-unknown item, `'*'` talk-only |
| 3 | none (both internal deltas converged) | 0 | 4 | precision only |

## Full Findings Catalog

All answers are in the build state folder: `reviews/r5`, `reviews/p1e-r1`, `reviews/p1e-r2`, `reviews/p1e-r3`, `reviews/p1e-second-pass.md`.

## Left behind

- A per-person session record (pieces 2 and 1f).
- Owner candidates and migration (piece 2).
- Replicated admission across machines (piece 4).
- Fleet enforcement through the owner's per-agent card (piece 5).
- SMS rows on iMessage (1e-b).
- A real Telegram chat with a fresh owner: the same dated daytime check as 1d.

## Convergence Verdict

Converged at round 3 (80/20: the internal design findings fell to zero). The spec carries `approved: true` under the approved umbrella and Justin's standing guidance. No constitution text changes.
