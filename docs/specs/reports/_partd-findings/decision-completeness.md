# Part D — Decision-Completeness Re-Convergence Review

**Spec:** `docs/specs/autonomous-registration-guarantee.md`
**Lens:** DECISION-COMPLETENESS (does any NEW decision in Part D require the building agent to STOP and ask the user?)
**Scope:** "### Part D", "## Frontloaded Decisions", "## Open questions" — added after the original 2-round convergence (which left Open questions = none).
**Reviewer:** echo (decision-completeness lens)
**Date:** 2026-06-15

---

## What Part D introduces

Part D promotes `ReapGuard.recentUserMessage(topic, window)` from a v1 stub
(`() => false`, `server.ts:13530`, spread into both ReapGuard and SessionReaper) to a
**real, shared** inbound-user-message-recency predicate, so that ReapGuard's KEEP-probe
(Gate-I) and GAP-B's new D8 eligibility check are computed from the identical truth and
**cannot disagree** (the anti-loop invariant). The grounding facts were verified against
the codebase:

- **Stub confirmed.** `recentUserMessage: () => false` at `src/commands/server.ts:13530`,
  with an in-code comment calling Gate-I "a v1 stub (returns false)" and "a tracked tuning
  follow-up." Part D's premise is accurate.
- **Window value is NOT new.** `staleCommitmentWindowMinutes: 480` (8h) already exists in
  `src/config/ConfigDefaults.ts:153` and `src/monitoring/SessionReaper.ts:131`, with an
  operator-attributed rationale comment ("operator: restarts are cheap, prefer free
  resources"). Reusing it is reuse of an **already-shipped, already-operator-blessed**
  value — not a fresh window to be chosen.

---

## Q1 — Does Part D introduce a NEW decision the building agent must STOP and ask about?

**No.** Each of the four candidate decisions is a resolved type-B engineering choice:

1. **Sync-vs-async wiring of the KEEP-probe.** Part D ("Sync/async wiring (build must
   resolve)") names BOTH acceptable shapes — (a) make the KEEP-probe async and `await`
   `queryInbox`, or (b) pre-compute per-candidate recency into a sync snapshot the probe
   reads — and explicitly bounds the decision: "Decided at build time against ReapGuard's
   actual call-site signature; both preserve the shared-predicate guarantee." This is a
   **pure type-B implementation detail** with an in-spec invariant that both branches must
   satisfy (shared predicate). No user-visible behavior differs between (a) and (b); the
   agent owns it. **Resolved in-spec.**

2. **Inbound-user-message filter definition.** Part D specifies the mechanism
   (`MessageStore.queryInbox(agentName, { threadId })`, grounded at `MessageStore.ts:166`,
   live precedent at `server.ts:11988`), the semantic ("true iff there is an inbound USER
   message on the topic within `windowMs`"), and the exclusion ("Filter strictly to inbound
   user messages (not agent/system echoes)"). It correctly defers the field-level mechanics
   ("the build grounds the `MessageEnvelope` direction/role + timestamp fields and the
   `topicId → threadId` mapping before implementing") to build-time grounding — which is
   type-B engineering, not a taste call. **Resolved in-spec** (definition fixed; field
   plumbing is grounding, not a user decision).

3. **Window value (reuse `staleCommitmentWindowMs`, 8h).** Explicitly pinned: "Window
   default = ReapGuard's existing `staleCommitmentWindowMs` (8h)." This reuses an existing
   operator-blessed config value rather than introducing a new tunable. D5 already states
   `staleCommitmentWindowMs` is "reuse ReapGuard's existing value … code-defaulted and
   ABSENT from ConfigDefaults/migrateConfig." **Resolved in-spec — and notably NOT a new
   knob.**

4. **Dark-soak-then-enable rollout.** Part D ("Rollout: ship the real `recentUserMessage`
   + the injection dark, soak, and enable injection only after the dark soak confirms KEEP
   and eligibility agree on real data"). This is an **engineering rollout sequence the agent
   owns**, not an operator decision — see Q3. **Resolved in-spec.**

No candidate is a smuggled type-A. The one genuinely live-behavior change Part D makes —
promoting `recentUserMessage`, which makes ReapGuard's KEEP-probe go from inert to real — is
a **reaper-class** change, but it is (a) in the **safe direction** (it can only KEEP a
session that has BOTH a qualifying open commitment AND a recent inbound user message; it
never causes a reap), (b) **narrow** (requires both corroborators inside the window), and (c)
**loop-incapable while injection is dark** (the 2026-06-13 loop requires the revival path to
fire; revival ships dark/dryRun behind `monitoring.resumeQueue`, so no reap→revive→reap loop
is reachable even with `recentUserMessage` live). The worst case of the live KEEP change
alone is bounded resource-retention pressure — an engineering risk the spec analyzes and
contains, not a taste/irreversibility/user-facing call that the operator must adjudicate.

**Verdict on Q1: No new un-resolved user-decision.** The reaper-class promotion is
correctly classified by the spec as a contained type-B change with an explicit safe-direction
+ dark-injection containment argument, not a frontloadable type-A.

---

## Q2 — Is "## Open questions" still effectively none?

**Yes.** Part D reopened nothing that requires a live user decision. Every decision it raises
is either (a) bounded type-B with both branches named and an invariant they must satisfy, or
(b) an explicit build-time grounding step (field names, threadId mapping) that is engineering,
not user-facing. The `*(none)*` in "## Open questions" remains accurate. Part D did not
introduce a question only the operator can answer.

---

## Q3 — Does Part D need a Frontloaded Decisions entry of its own (the rollout)?

**No — the rollout is an engineering rollout the agent owns, not an operator decision.**

- The "ship `recentUserMessage` live + injection dark → soak → enable injection" sequence is
  the **standard graduated-rollout discipline** already encoded in the existing frontloaded
  decision **D5** ("Dark + dryRun … Part B injection rides the existing
  `monitoring.resumeQueue` dev-gate + dryRun"). Part D's rollout is the *application* of D5's
  posture to the `recentUserMessage` promotion, not a new operator decision. The injection
  gate (`monitoring.resumeQueue` dev-gate) and dryRun are already frontloaded; Part D adds no
  new flag, no new config key, no new operator-facing toggle.
- The promotion of `recentUserMessage` itself is **not behind a flag** (it is the single
  non-dark part of the feature) — but that is deliberate and argued: making the existing
  KEEP-probe real is safe-direction-only, and the loop risk is carried entirely by the
  injection path, which IS dark. Choosing to ship a safe-direction predicate un-flagged while
  keeping the loop-bearing path dark is an **engineering rollout judgment** — the kind the
  build agent makes and the spec defends — not a taste/irreversible call requiring operator
  sign-off.
- A Frontloaded Decisions entry exists to capture a decision the agent would otherwise STOP
  on. The rollout sequence is fully prescribed in Part D's prose and inherits D5's flag, so
  there is nothing for the agent to stop on. An additional FD entry would be redundant
  documentation, not a missing decision.

**Optional, non-blocking nicety (not a gap):** if the spec author wants symmetry, the rollout
could be cross-referenced from D5 (e.g. a one-line "D5 also governs the `recentUserMessage`
promotion's dark-soak: real predicate ships, injection stays dark until the soak confirms
agreement"). This is cosmetic — the decision is already resolved by D5 + Part D prose. It does
NOT block convergence.

---

## Overall verdict

**CONVERGED (decision-completeness lens).**

- Part D introduces **no new un-resolved user-decision**. The four candidate decisions
  (sync/async wiring, filter definition, window reuse, dark-soak rollout) are all resolved
  in-spec as bounded type-B engineering choices; the one live-behavior change (the
  `recentUserMessage` promotion) is a contained, safe-direction reaper-class change with an
  explicit dark-injection loop-containment argument — not a smuggled type-A.
- **"## Open questions" remains effectively none** — accurate as written.
- Part D needs **no Frontloaded Decisions entry of its own**; its rollout is an
  agent-owned engineering sequence already governed by the existing D5 dark+dryRun frontloaded
  decision. The only optional improvement is a cosmetic cross-reference from D5 — non-blocking.

No build-blocking decision-completeness defect found in Part D.
