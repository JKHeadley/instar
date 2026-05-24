---
title: "A Wall Is a Hypothesis — constitution standard + B16 structural guard"
date: 2026-05-24
author: echo
review-convergence: internal-plus-conformance-2026-05-24
approved: true
approved-by: Justin
approved-via: Telegram topic 12143 (2026-05-24 — proposed the standard with its story; Justin "I approve all of your recommendations. Please proceed". Enforcement corrected after verifying the registry is not parsed at runtime: the real surfaces are the MessagingToneGate rule + the design-principles catalog the /spec-converge reviewer loads.)
eli16-overview: wall-is-a-hypothesis-standard.eli16.md
---

# A Wall Is a Hypothesis — standard + B16 structural guard

## Problem

An agent declared native `/goal` delegation "infeasible" because Claude Code's `/goal` exposes no programmatic API — while Instar's defining capability is driving interactive sessions by injecting text (`SessionManager.sendInput`). Both facts were in hand; they were never connected, and "no API → can't delegate" shipped to the user as a recommendation. The corrected approach (inject `/goal <condition>` directly) shipped the same day.

This is the feasibility-judgment cousin of the existing "Know Before You Claim / Self-Discovery" discipline: an agent surrendering to an unverified wall. The discipline already existed in prose for capability claims ("I can't") and still did not fire for a design judgment ("this path is blocked"). Inspirational prose does not fire at the moment an agent types "infeasible." Per Structure beats Willpower, the behavior must be enforced structurally.

## Scope

Two coordinated pieces:

1. **Constitution entry** — add the standard "A Wall Is a Hypothesis" to `docs/STANDARDS-REGISTRY.md` in The Substrate family, adjacent to "Architectural Agency in the Gap" and counterweighted by "The Right to Stand Ground". Authored in the registry's format (Rule / In practice / Earned from / Traces to the goal / Applied through), per the registry's amendment loop (agent proposes with its story, operator ratifies).

2. **Structural guard (B16_UNVERIFIED_WALL)** — a new rule in `MessagingToneGate`, the existing outbound-message authority that already hosts B15_CONTEXT_DEATH_STOP. B16 is always evaluated (no signal/kind precondition, same as B15). It blocks an outbound message that declares a path impossible / blocked / infeasible / "can't be done" because some interface / API / mechanism is missing, when the message shows no evidence the agent inventoried its own capabilities first.

## Enforcement reality (verified, not assumed)

Before authoring the standard's "Applied through" line, the claim that "the spec-review gate and the Usher read the registry" was checked against the code. Finding: no runtime code parses `docs/STANDARDS-REGISTRY.md`; the registry-reading conformance gate and the Usher are North Star designs that are not yet implemented. The standard's enforcement is therefore stated truthfully against what exists:

- **MessagingToneGate B16** — the hard structural catch at the moment of surrender (outbound message). Real, shipping in this change.
- **`docs/INSTAR-DESIGN-PRINCIPLES-AND-LESSONS.md`** — the catalog the `/spec-converge` lessons-aware reviewer actually loads. Registering the standard there makes specs that accept an untested wall reviewable. Real, shipping in this change.
- The registry-wide conformance gate and Usher are named as the North Star surfaces that will pick this up once built — described as planned, never claimed as live.

## Design — B16_UNVERIFIED_WALL

Block condition (all must hold): the candidate relays an infeasibility / dead-end conclusion AND cites a missing interface / API / mechanism AND shows no evidence of a capability inventory AND none of the legitimate clauses is present.

Legitimate clauses (any one → pass):
- The message shows a capability inventory was done and the wall survived (names what was checked or tried).
- The constraint is genuinely external and outside the agent's toolkit to change (a credential the user holds, an account the user must connect, a verified third-party/platform limit).
- The message asks a real either/or design question, or reports a genuine runtime error/blocker (a call that actually failed).
- The message merely discusses this rule or the concept of unverified walls.

Severity favors false-negatives over false-positives: ordinary "I can't access X without you connecting it" must pass. The rule targets the precise failure — an internal feasibility verdict resting on a missing interface, with no inventory shown.

### Why MessagingToneGate (signal-vs-authority compliance)

B16 lives inside the single outbound authority, not in a separate detector with independent block power. This matches the signal-vs-authority principle: the authority combines the candidate with conversational context and makes one decision. The route plumbing (gate block → HTTP 422 with the rule id) is rule-agnostic and unchanged.

## Migration parity

`MessagingToneGate` runs server-side; it is not an agent-installed file. The rule ships with the server on update — no `PostUpdateMigrator` entry is required. The doc changes (`STANDARDS-REGISTRY.md`, `INSTAR-DESIGN-PRINCIPLES-AND-LESSONS.md`) are repository documentation, read by humans and the `/spec-converge` skill, not deployed per-agent.

## Testing (three tiers)

- **Unit** (`tests/unit/messaging-tone-gate-b16.test.ts`): the rule definition + infeasibility markers + carve-outs render in the prompt; B16 is accepted as a valid rule id without fail-open (the /goal-style wall); both sides of the boundary — wall-after-inventory, genuinely-external limit, and rule-discussion all pass; drift detection preserved (an invented rule id still fails open).
- **Integration** (`tests/integration/telegram-reply-b16-wall.test.ts`): through the real `POST /telegram/reply` route, a B16 block returns 422 with `rule="B16_UNVERIFIED_WALL"` and the message is not sent; a passing reply still delivers 200.
- **E2E**: the tone-gate authority's production HTTP path is already exercised by the existing tone-gate route tests; B16 rides that path (always-evaluated, no new route), and the integration tier proves the rule surfaces through it.

## Out of scope

Building the registry-wide conformance gate and the Usher (North Star infrastructure that would parse the registry directly) is separate, larger work and is not part of this change.
