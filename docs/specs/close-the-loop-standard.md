---
title: "Close the Loop (Untracked = Abandoned) — constitution standard"
date: 2026-05-31
author: echo
review-convergence: internal-plus-conformance-2026-05-31
approved: true
approved-by: Justin
approved-via: Telegram topic 13435 (2026-05-31 — proposed the "Close the Loop" standard with its rule, its coherence tie, and its earned-from story; Justin ratified: "1) yes" to the articulation, "2) proceed as you best see fit" to declare it. Out of the rate-limit investigation where the common thread surfaced.)
eli16-overview: close-the-loop-standard.eli16.md
---

# Close the Loop (Untracked = Abandoned) — constitution standard

## Problem

Three pieces of Instar infrastructure share one shape and one founding purpose, and none of them named the shape: the commitment infrastructure (promises tracked by cadenced beacons until delivered), the graduated-feature-rollout / maturation track (features shipped dark, re-surfaced for promotion), and — newly motivated — per-feature metrics/review for LLM-driven sentinels and gates (so their effectiveness and cost can be re-evaluated and tuned rather than run unexamined forever). The common factor, in Justin's words, is "not letting anything fall through the cracks."

The cost of leaving the shape unnamed is concrete and recurring, all of one form — *a loop opened, then silently dropped*:

- A follow-up commitment that **auto-resolved itself 22 seconds after it was opened** ("no automated verification method — trusting agent acknowledgment"), terminal and non-reopenable, so its beacon never fired and the promise evaporated — the exact case the "open a commitment for cross-turn follow-through" pattern exists to protect.
- Features **shipped dark and never matured** — the rollout machinery exists, but without a cadence that re-surfaces a dark feature, it sits at stage 0 indefinitely.
- LLM gates and sentinels that **ran unmeasured** until their accumulated cost surfaced as a rate-limit nobody had attributed to them — "you can't tune what you can't see," and nothing was re-surfacing them for review.

This is the lifecycle cousin of the existing **Deferral = Deletion** standard. That standard governs the *moment of capture* (write it now, because a successor lacks the context). It does not govern the *lifecycle after capture*: a thing that was captured still rots if no structure re-surfaces it for review. Capture-now and re-surface-until-closed are the two halves of the same substrate truth, and only the first half was written down.

## The standard

**Close the Loop (Untracked = Abandoned).** Every loop the agent opens — a promise to a user, a feature shipped dark, an LLM gate deployed, a flagged issue, a hypothesis to revisit — must be durably registered and re-surfaced on a cadence until it reaches a *deliberate* close. Capturing it once is not enough; if no structure brings it back for review, it rots silently and is, in effect, abandoned. Where there is no cadence, add one — a beacon, a maturation entry, a periodic review job — never a private intention to "come back to it."

**Why it is constitutional (the coherence tie).** This is the founding goal — *a coherent, self-evolving agent* — made operational across **time**. "Structure beats Willpower" (the Root) is coherence on the *willpower* axis: you cannot rely on remembering a rule *within* a session, so it lives in structure. "Close the Loop" is coherence on the *time* axis: you cannot rely on remembering to *revisit* an open loop *across* sessions, so the re-surfacing must live in structure. An agent whose past commitments, deployed mechanisms, and open questions quietly drift out of view is not one coherent agent persisting through time — it is a string of amnesiac instances. The principle is therefore not a nicety; it is part of what makes an agent *one agent* over time.

## Scope

This is a **documentation + awareness** change. It declares a standard and propagates the operating principle to agents; it ships no new runtime gate. (The infrastructure that *implements* the principle — the unified per-feature metrics + recurring-review substrate — is a separate, larger spec that follows; this standard is the value that substrate serves.)

In scope:
- `docs/STANDARDS-REGISTRY.md` — the living constitution. The standard is declared in the Substrate family, immediately after its sibling **Deferral = Deletion**, with the four registry facets (Rule / In practice / Distinct-from-Deferral / Earned-from / Traces-to-the-goal).
- `src/scaffold/templates.ts` (`generateClaudeMd`) — the agent-facing Core Principles section, so newly-initialized agents inherit the operating principle next to Deferral = Deletion (**Agent Awareness Standard**).
- `src/core/PostUpdateMigrator.ts` (`migrateClaudeMd`) — an idempotent, content-sniffed migration so existing deployed agents inherit it on their next update, not only new agents (**Migration Parity Standard**).

Out of scope (explicitly deferred to the follow-on substrate spec): any new endpoint, job, store, or gate. This change must not alter runtime behavior.

## Enforcement surfaces

Consistent with how the registry's own framing describes itself — "the constitution a spec or a build must be checked against" — the principle is surfaced where builds and agents actually read:
- The **/spec-converge reviewer** loads the design-principles catalog; a future draft that opens an un-tracked loop can be checked against this standard.
- Every agent's **Core Principles** (template for new, migration for existing) so the principle is in session-start awareness, exactly like Deferral = Deletion and Structure > Willpower.

## What changed

- **`docs/STANDARDS-REGISTRY.md`**: added the `### Close the Loop` standard after `### Deferral = Deletion`.
- **`src/scaffold/templates.ts`**: added the `**Close the Loop (Untracked = Abandoned)**` bullet to the agent template's Core Principles, after `**Deferral = Deletion**`.
- **`src/core/PostUpdateMigrator.ts`**: added an idempotent `migrateClaudeMd` block, content-sniffed on the marker `Close the Loop (Untracked = Abandoned)` (the same string the template emits, so a freshly-initialized agent is never double-patched).

## Tests

- `tests/unit/PostUpdateMigrator-closeTheLoop.test.ts` (7 tests): migration adds the principle when absent; idempotent (exactly one heading on re-run); **does not double-patch** an agent that already has the template version; preserves existing content above; graceful skip when CLAUDE.md is missing; the constitution (registry) declares the standard with its facets; the template emits it.
- `tests/unit/feature-delivery-completeness.test.ts`: the new migrator section is registered in `legacyMigratorSections` (a core operating *principle*, like Deferral = Deletion / anti-confabulation — mirrored in the template but not a user-invokable capability requiring framework-shadow markers). The completeness guard catching the unregistered section is itself the standard in action.

## Migration parity

Existing agents receive the principle via the `migrateClaudeMd` content-sniffed append on their next update. New agents receive it via the template. The shared marker string guarantees no double-patch. No `.instar/config.json` default, hook, or skill changed.

## Non-goals / risk

Zero runtime behavior change — documentation and CLAUDE.md text only. The single guarded risk (double-patching a new agent) is covered by the shared-marker content-sniff and an explicit test.
