# Side-Effects Review — Enforcement of the three ratified standards (A/B/C)

**Version / slug:** `three-standards-enforcement`
**Date:** `2026-07-03`
**Author:** `echo`
**Second-pass reviewer:** `not required`

## Summary of the change

Turns three operator-ratified constitutional standards into structure rather than reviewer willpower, per `docs/specs/three-standards-enforcement.md` (converged; this PR ships the enforcement MACHINERY only — the standard TEXTS ship separately under the already-granted ratification). Files touched: `skills/spec-converge/SKILL.md` and `skills/spec-converge/templates/reviewer-integration.md` (Standard A — the cross-machine review-check is upgraded from "a posture is *declared*" to "the default posture is `unified`; an undefended `machine-local` is a MATERIAL FINDING" over a closed 3-key justification taxonomy with a `machine-local-justification:` marker convention, bidirectional; Standard B — a self-heal-before-notify escalation-gate review-check requiring a watcher's operator-raise to be downstream of `selfHealAttempted && selfHealExhausted`, with declared `remediation-actions` + P19 brakes + `max-notification-latency` + severity class); `src/core/PostUpdateMigrator.ts` (a new idempotent `migrateThreeStandardsReviewChecks` so EXISTING agents receive the upgraded skill content — Migration Parity case 5b); `tests/integration/notification-flood-burst-invariant.test.ts` (Standard C — a table-driven routing CONTRACT test at the adapter/funnel boundary proving topic-less non-critical notices route to the ONE hub topic by default while HIGH/URGENT keep their own topic); and a new unit test `tests/unit/PostUpdateMigrator-threeStandardsReviewChecks.test.ts`. Decision points: the `/spec-converge` integration-reviewer verdict surface (A, B) — a review LENS on a smart reviewer, not a new blocking gate; and the Telegram topic-less-notice routing default (C) — a verification + test over machinery that already exists (the Agent-Health hub lane), no new block.

## Decision-point inventory

- `skills/spec-converge integration reviewer (A)` — modify — upgrades the cross-machine coherence review-check to reject an undefended machine-local (default `unified`), bidirectional, over a closed taxonomy. Semantic authority stays with the existing LLM reviewer; the `machine-local-justification` marker is the cheap deterministic signal.
- `skills/spec-converge integration reviewer (B)` — add — a self-heal-before-notify review-check binding monitors/watchers/recurring notice sources.
- `PostUpdateMigrator.migrateThreeStandardsReviewChecks` — add — idempotent, fingerprint-guarded re-copy of the two upgraded skill files to already-installed agents.
- `TelegramAdapter topic-less-notice routing (C)` — pass-through — verified-already-correct default (Agent-Health hub lane routes housekeeping notices to one hub from the first item; HIGH/URGENT carve-out preserved); this PR proves the rule with a contract test, it introduces no new routing code.

---

## 1. Over-block

**What legitimate inputs does this change reject that it shouldn't?**

A/B are review-LENSES on the `/spec-converge` LLM reviewer — they raise MATERIAL FINDINGS for a human/operator to weigh, they do not hard-block a build. A false positive (e.g. a genuinely-correct `machine-local` surface the reviewer contests) surfaces as a finding the author defends with a taxonomy-keyed `machine-local-justification:` marker; it never silently rejects work. C's contract test asserts existing routing behavior; it rejects no runtime input (a topic-less notice still routes to the hub, HIGH/URGENT still get their own topic).

---

## 2. Under-block

**What failure modes does this still miss?**

The deterministic marker LINT (A) and the self-heal field-schema LINT (B) are HARD-SEQUENCED to land WITH the registry ship (each standard's registered guard), NOT in this PR — so until they land, A/B enforcement is the per-spec `POST /spec/conformance-check` gate + the LLM review-lens (a semantic AUDIT), never a no-LLM deterministic guarantee. This is stated honestly in the spec and PR body; the review-check text does not claim the deterministic floor exists yet. C's contract test covers the enumerated routing cases (topic-less→hub, HIGH/URGENT→own, existing-owning-topic→that topic, unresolvable-hub→safe fallback) but cannot enumerate every future notice source — the funnel-level `createForumTopic` budget backstop (existing) remains the catch-all.

---

## 3. Level-of-abstraction fit

**Is this at the right layer?**

Yes. A/B are prompt/skill-level review LENSES fed by a cheap deterministic marker convention — the constitutional *Signal vs. Authority* / *Body and the Mind* split: the marker (body) signals, the full-context reviewer (mind) holds authority. Neither is a brittle detector with blocking authority. C's change is a TEST over the existing `TelegramAdapter` Agent-Health hub lane + `AttentionTopicGuard` funnel — it USES the existing routing primitive rather than re-implementing one, and the migration reuses the exact `migrateMultiMachinePostureReviewDimension` pattern rather than inventing a new one.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

**Does this change hold blocking authority with brittle logic?**

- [x] No — this change produces a signal consumed by an existing smart gate.

The `machine-local-justification` marker and the declared self-heal fields are cheap deterministic SIGNALS; the `/spec-converge` LLM integration reviewer holds the semantic authority and contests correctness bidirectionally. No new brittle string-matcher gains blocking authority. The migration is a mechanical file re-copy (no decision logic). The Standard C contract test is a test, not a gate.

---

## 5. Interactions

**Does this interact with existing checks, recovery paths, or infrastructure?**

- **Shadowing:** the A upgrade EXTENDS the existing multi-machine posture check (same integration reviewer bullet) rather than shadowing it; both coexist. The B check is a new bullet in the same reviewer.
- **Double-fire:** `migrateThreeStandardsReviewChecks` is fingerprint-guarded + marker-idempotent, so it re-copies each file at most once; it never fights `migrateMultiMachinePostureReviewDimension` (different marker string, and once one runs the file carries both bodies from the bundled source).
- **Races:** none — migration is a synchronous one-shot file write with an installed-copy existence check.
- **Feedback loops:** none.

---

## 6. External surfaces

**Does this change anything visible outside the immediate code path?**

- Other agents on the install base: YES — the upgraded spec-converge review-checks reach existing agents via the new migration (that is the intended Migration-Parity effect). New agents get them via `installBuiltinSkills`.
- External systems: none. No Telegram/Slack/GitHub/Cloudflare behavior changes — C is verification of existing routing.
- Persistent state: none new.
- **Operator surface (Mobile-Complete):** No operator-facing actions added — the change is reviewer-prompt content + a migration + tests. Not applicable.

---

## 6b. Operator-surface quality (Operator-Surface Quality standard)

No operator surface — not applicable. No dashboard renderer/markup, approval page, or grant/revoke/secret-drop form is touched.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

**machine-local BY DESIGN — with the reason, and it is the correct posture here (the standard applied to itself).**

- The A/B review-check upgrades live in `/spec-converge` SKILL.md + template — **replicated** via git like all skills (machine-agnostic content); existing agents pick up the CHANGED content on their machine via `migrateThreeStandardsReviewChecks` (replication of the file is not the same as an already-running agent adopting it — the migration is the adoption path).
- B's pattern is documentation + a per-watcher code shape; no new cross-machine state.
- C's hub TOPIC is legitimately **machine-local** under `machine-local-justification: physical-credential-locality` — a Telegram forum + its topic ids are namespaced by the machine's bot token + forum binding, a per-disk service credential (NOT hardware-bound — this is the exact taxonomy-key correction the spec makes against its own first draft). The contract test asserts the hub id resolves from config/state and is NEVER a baked-in universal `7848` constant. The operator's CRITICAL-alert VIEW stays pool-unified via `GET /attention?scope=pool` (the acute miss-risk is closed); the residual Telegram-push gap is a registered Close-the-Loop follow-up, not built here.
- Emits user-facing notices? C's hub routing is one-voice by construction (one hub topic). Durable state stranding on topic transfer? None new. Generated URLs? None.

---

## 8. Rollback cost

**If this turns out wrong in production, what's the back-out?**

Pure code + prompt + test change — revert the commit and ship a patch. No persistent state, no data migration to unwind. The `migrateThreeStandardsReviewChecks` migration is idempotent and only re-copies bundled skill content over a stock installed copy; a revert restores the prior bundled content and the next update re-syncs installed copies. No user-visible regression during the rollback window (the review-check is a spec-review-time lens; C is verification of unchanged runtime routing).

---

## Conclusion

The review confirms the change is a Signal-vs-Authority-compliant enforcement layer: A/B add review LENSES fed by cheap deterministic markers (semantic authority stays with the existing LLM reviewer), C proves an existing routing default with a table-driven contract test, and Migration Parity is satisfied by an idempotent migration that mirrors the established `migrateMultiMachinePostureReviewDimension` pattern. The purely-deterministic marker/field LINTS are honestly deferred to the registry ship (hard-sequenced) and the PR says so. Clear to ship.

---

## Second-pass review (if required)

**Reviewer:** not required

Not a block/allow decision on messaging/dispatch, not a session-lifecycle change, not a coherence/idempotency/trust gate, and not a sentinel/guard/gate/watchdog runtime change — it is reviewer-prompt content + a migration + tests. Second-pass not required.

---

## Evidence pointers

- `npx vitest run tests/unit/PostUpdateMigrator-threeStandardsReviewChecks.test.ts` → 7 passed (content-presence of A/B lenses + migration idempotency/fingerprint-guard).
- `npx vitest run tests/integration/notification-flood-burst-invariant.test.ts` → 12 passed (5 new Standard C routing-contract cases + 7 existing burst-bound cases).
- `npx tsc --noEmit` → clean.

---

## Class-Closure Declaration (display-only mirror)

- **`defectClass`** — `structure-not-willpower-review-gap` (nearest existing: a review expectation that lived in prose/reviewer-habit where structure was required; the tiered-intelligence machine-local-memory slip surviving seven rounds is the motivating instance).
- **`closure`** — `guard` for the migration + tests; the purely-deterministic marker/field LINT is a tracked `gap` hard-sequenced to the registry ship (per the spec's Rollout).
- **`guardEvidence`** — enforcementType `gate` (the `/spec-converge` integration reviewer now instructs "undefended machine-local = MATERIAL FINDING", citation `skills/spec-converge/SKILL.md` + `skills/spec-converge/templates/reviewer-integration.md`; howCaught: the reviewer is now told to raise the exact machine-local-by-design declaration that previously passed) plus `lint`-graded migration/content tests (`tests/unit/PostUpdateMigrator-threeStandardsReviewChecks.test.ts`).
- **`gap`** — the deterministic marker lint (A) + self-heal field-schema lint (B) land with the standards' registry guard; tracked in the spec's Close-the-Loop registration.
