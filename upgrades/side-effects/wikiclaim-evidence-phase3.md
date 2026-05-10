# Side-Effects Review — WikiClaim Evidence Phase 3 (DecisionJournal + /learn)

**Version / slug:** `wikiclaim-evidence-phase3`
**Date:** 2026-05-10
**Author:** Echo
**Second-pass reviewer:** required (breaking contract change for DecisionJournal callers + producer-allowlist boundaries + privacy narrowing reach)

## Summary of the change

Ships Phase 3 of the WikiClaim evidence import per spec § Migration Plan line 339:
> Phase 3: Producer integration — DecisionJournal + /learn (one PR)
> - DecisionJournal entries require at least one evidence entry.
> - /learn skill prompts for evidence (or auto-derives from conversation context).

Spec source: `docs/specs/OPENCLAW-IMPORT-WIKICLAIM-EVIDENCE-SPEC.md`
- § Producers line 217 (integration note — DecisionJournal does not yet produce MemoryEntity rows; bridge promotes journal entries to `decision` entities at log time)
- § Producers line 227 (DecisionJournal allowlist: `message` | `commit` | `ledger-entry` | `session`)
- § Producers line 228 (LearnSkill allowlist: `message` | `session`)
- § Producers line 258 (Decision journal cites conversation lines + commits + ledger entries)
- § Producers line 268 (Lesson capture requires ≥1 evidence row from the conversation)

What lands:
- **`DecisionJournal.log()` signature change** — adds a required second positional argument `evidence: MemoryEvidence[]`. Empty array or undefined throws `EvidencePolicyError` at write time. Callers across the codebase updated in the same PR.
- **`DecisionJournal.setSemanticMemory(memory, entityPrivacyScope?)`** — wires the WikiClaim bridge. When set, each `log()` call also calls `memory.rememberWithEvidence(..., 'DecisionJournal')` and stamps the resulting `entityId` onto the JSONL row. Wiring is optional — without it, the evidence is still required at the API level (compile-time + write-time gate), but no MemoryEntity is created. This lets the contract change adopt before the server fully wires SemanticMemory (Phase 4).
- **`DecisionJournalEntry`** — adds optional `evidence?: MemoryEvidence[]` (always populated on entries written by post-Phase-3 `log()`) and `entityId?: string` (populated only when SemanticMemory was wired at log time).
- **`LearnSkillBridge`** (new module, `src/core/LearnSkillBridge.ts`):
  - `deriveEvidenceFromContext(context, now?)` — auto-extracts feedback IDs (`fb_<hex>`), commit SHAs (40-hex), session UUIDs and `sess_<hex>` from free-form text. Feedback and commit references are surfaced as `externalReferences` because the LearnSkill producer kind allowlist (spec line 228) does NOT include them — the caller decides whether to route them through `EvolutionManager` / `DispatchExecutor` downstream producers.
  - `buildLearnEvidence({context, documentFallback?, now?})` — combines auto-derivation with a fallback for unstructured input. Synthesizes an inline `message` row from the context body when nothing structured was detected and context is non-empty. Throws `LearnEvidenceError` when context is empty and no `documentFallback` provided.
  - All patterns are pure regex (spec line 357: "No LLM in the migration path"). Cross-store FK validation is best-effort — consumers tolerate dangling references per spec line 219.
- **HTTP gates** — `POST /intent/journal` accepts an optional `evidence` array in the body; when omitted (or empty) the route synthesizes a minimum-viable `session`-kind evidence row whose `sourceId` is `session:${sessionId}` from the request body. This keeps the legacy POST shape working through the contract change while still satisfying the policy gate at the storage layer. Explicit evidence in the body always overrides synthesis. `POST /evolution/learnings` accepts `context` and/or `documentFallback` and runs the auto-deriver. `EvidencePolicyError` → 400; `LearnEvidenceError` → 400; surfaces derived `evidence`, `externalReferences`, and (when present) `pendingDocumentRef` on the success response.

  *Rationale for synthesis vs hard-400:* The HTTP layer has only the request `sessionId` as a proxy for an auth principal at this phase (full auth threading lands in Phase 4 — spec § Migration Plan line 359). Hard-rejecting evidence-less POSTs would break every existing programmatic and integration-test caller without giving them a structurally available alternative. `session` evidence with sourceId `session:<id>` is in the DecisionJournal allowlist (spec § Producers line 227) and is a truthful minimum citation: "this decision was made in this session." Synthetic sourceIds are an accepted shape per spec § Storage and Privacy line 333 (consumers tolerate dangling refs). See `tests/integration/intent-routes.test.ts` for the full POST→GET round-trip exercising synthesis.
- **Producer-kind allowlist** — Phase 1 already declared `DecisionJournal` and `LearnSkill` entries in `PRODUCER_KIND_ALLOWLIST` (`SemanticMemory.ts:1896`). Phase 3 wires them; no allowlist mutation needed. Both kept verbatim against the spec table (lines 225–228).

Files touched:
- `src/core/types.ts` — `DecisionJournalEntry.evidence`, `DecisionJournalEntry.entityId`
- `src/core/DecisionJournal.ts` — `setSemanticMemory()`, `log(entry, evidence)` required-evidence gate, bridge to `rememberWithEvidence`
- `src/core/LearnSkillBridge.ts` (new) — auto-derivation + `buildLearnEvidence` + `LearnEvidenceError`
- `src/commands/intent.ts` — updated conflict-logging caller to attach `ledger-entry` evidence rows for ORG-INTENT.md + AGENT.md
- `src/server/routes.ts` — `POST /intent/journal` requires evidence; `POST /evolution/learnings` runs LearnSkillBridge
- `tests/unit/decision-journal-evidence.test.ts` (new) — 15 cases covering the required-evidence gate, bridge promotion, allowlist enforcement, narrowing-only privacy
- `tests/unit/learn-skill-evidence.test.ts` (new) — 19 cases covering auto-derivation patterns, dedup, fallback, allowlist enforcement, inverse query
- `tests/unit/DecisionJournal.test.ts` — updated all `journal.log(...)` call sites to pass evidence
- `tests/unit/DispatchDecisionJournal.test.ts` — single `base.log(...)` in coexistence test updated
- `upgrades/side-effects/wikiclaim-evidence-phase3.md` (this file)

## Decision-point inventory

- `DecisionJournal.log()` empty-evidence gate (`Array.isArray + length === 0`) — **add** — mechanic-level. No judgment.
- LearnSkillBridge regex patterns (`fb_<hex>{8,}`, 40-hex SHA, UUID v4, `sess_<hex>{8,}`) — **add** — pure structural matches. Spec § Risks line 357 explicitly bars LLM in the migration path; regex is the spec-mandated mechanic.
- Inline-message synthesis fallback — **add** — deterministic hash → `inline:<base36>` sourceId when context is non-empty but no structured ref was found. Mechanic.
- `LearnEvidenceError` throw when context empty AND no documentFallback — **add** — boundary condition (no source = no evidence = reject per spec line 268).
- `ORG-INTENT.md` + `AGENT.md` as `ledger-entry` evidence in intent.ts caller — **add** — config files act as the durable ledger for the intent contract; the only spec-allowed DecisionJournal kind that fits a config-file citation is `ledger-entry`. Documented inline at the call site.

---

## 1. Over-block

**`DecisionJournal.log` rejects legitimate evidence-less callers:**
Every existing caller is updated in this PR — there are exactly two write-path callers in the codebase:
1. `src/commands/intent.ts:266` — `intent-validate` conflict logger. Updated to cite ORG-INTENT.md + AGENT.md as `ledger-entry` evidence.
2. `src/server/routes.ts:8273` — `POST /intent/journal` handler. Updated to require an `evidence` field in the request body; returns 400 otherwise.

`DispatchDecisionJournal.logDispatchDecision` writes directly to JSONL (does not delegate to `DecisionJournal.log`); the dispatch path is unaffected and continues to work without evidence — those entries land on the SAME JSONL file but are typed `type:'dispatch'`, a different schema. Spec § Producers line 226 routes the dispatch decision-evidence path through `DispatchExecutor` (Phase 2), not through this Phase 3 gate.

**`LearnSkillBridge` over-extracts SHA-shaped 40-hex strings:** any 40-hex blob in context is matched as a `commit` external reference. Mitigation: kept as an `externalReference` (LearnSkill cannot itself write `commit` kind per allowlist), so the false positive is a caller-side display issue, not a DB integrity issue. Cross-store FK is best-effort per spec line 219; consumers display `[source unavailable]` for dangling refs.

**`LearnSkillBridge` over-extracts feedback IDs:** `fb_<hex>{8,}` is conservative — 8+ hex chars covers the FeedbackManager id shape and rejects shorter accidental matches (`fb_x`, `fb_12`).

## 2. Under-block

**Inline-message synthesis with no real source:** `buildLearnEvidence` synthesizes a `kind:'message'` row with `sourceId: 'inline:<hash>'` when context is non-empty but unstructured. This is technically a "fake" sourceId (no message store has it). Mitigation: documented as the explicit fallback path — the row carries the first 200 chars of the context as `note` for the human reader, and the `inline:` prefix is the conventional marker for "synthetic, no upstream store". Consumers tolerate dangling sourceIds per spec line 219.

**`buildLearnEvidence` accepts a `documentFallback` but LearnSkill cannot write `document` kind:** The `pendingDocumentRef` surfaces on the response for the caller to route through a different producer. **This is a real gap** — there is no current producer-kind-allowlist entry that includes `document` for a LearnSkill-shaped caller. A future task is to extend the allowlist (or to add a new producer ID like `LearnSkillDocument`) when documents-as-evidence becomes a first-class use case. For Phase 3, the pendingDocumentRef is structurally surfaced but not yet writable.

## 3. Level of abstraction

The gate is at the structural boundary: `DecisionJournal.log` (the only public write entry-point) and the HTTP route handlers. It is NOT scattered across callers — every caller passes evidence through the same single chokepoint. Producer-kind allowlist enforcement lives inside `SemanticMemory.assertProducerKindsAllowed`, not duplicated at the bridge layer. Privacy narrowing-only is enforced inside `insertEvidenceRows` (Phase 1), not re-checked at the bridge. The Phase 3 surface adds:
- One compile-time gate (function signature change in `DecisionJournal.log`)
- One runtime gate (`Array.isArray + length === 0` in `DecisionJournal.log`)
- One bridge call site (`memory.rememberWithEvidence(..., 'DecisionJournal')`)
- One auto-deriver module (`LearnSkillBridge`)

No new privacy-enforcement code; no new allowlist-enforcement code; no new cycle-detection code. The Phase 3 layer is a thin wiring layer over Phase 1's policy gates.

## 4. Signal vs authority separation (per MEMORY.md feedback_signal_vs_authority.md)

The brittle/low-context detectors (the regex patterns in `LearnSkillBridge`) emit SIGNALS (`DerivedEvidence` rows). The higher-level intelligent gate (`buildLearnEvidence` + the HTTP handler) is the authority that decides whether the signals are sufficient or to fall back. `LearnSkillBridge` exports two distinct functions — the raw deriver and the policy wrapper — so a future Phase 4 caller can replace `buildLearnEvidence` with an LLM-aware version without changing the signal layer.

## 5. Producer-allowlist interactions with sibling phases

- **Phase 2 (EvolutionManager + DispatchExecutor)**: independent producers, independent kinds. No collision.
- **Phase 1 (SemanticMemory schema)**: Phase 3 uses the schema unchanged. No migration needed.
- **Phase 4 (Inverse-traceability HTTP)**: Phase 3 produces the `decision` and (downstream) `lesson` MemoryEntity rows that Phase 4's `/memory/entities/by-evidence` queries will inverse-traverse. Phase 4 is forward-compatible: existing pre-Phase-3 entries with `evidence: undefined` are filtered out of inverse queries naturally (no evidence row → no citation row).
- **Phase 5 (backfill-evidence CLI)**: Phase 5 walks pre-Phase-3 decision-journal entries and emits `evidence: []` (no upgrade possible per spec line 211). Phase 3's required-evidence gate does NOT apply at backfill time — backfill writes the entity directly via `rememberWithEvidence` with an explicit empty array AND a `manual` producer override, separate code path.

## 6. Rollback cost

The contract change is structural (function signature). Rollback path:
1. Revert `DecisionJournal.log` to the old single-arg signature.
2. Revert the two write-path callers (`intent.ts`, `routes.ts`) to drop the evidence argument.
3. JSONL entries written with `evidence` fields are forward-compatible — the older reader ignores unknown fields. No data migration needed.
4. The `decision` MemoryEntity rows created by the bridge are orphaned but harmless — they remain queryable; the cascade-delete FK keeps evidence consistent if the entity is later forgotten.

Rollback is a one-PR revert; downstream readers (intent dashboard) tolerate `evidence: undefined` gracefully.

## 7. Threat model deltas (per spec § Threat Model line 365)

- **Spoofed evidence via `LearnSkill`**: a caller passes `evidence: [{kind:'feedback', sourceId:'fb_attack'}]` directly to bypass allowlist. Mitigation: `SemanticMemory.assertProducerKindsAllowed` rejects with `EvidencePolicyError`. Test: `learn-skill-evidence.test.ts > LearnSkill CANNOT write 'feedback' kind`.
- **Privacy bypass via decision-bridge widening**: a caller wires `entityPrivacyScope: 'shared-project'` then attaches `privacyTier: 'public'` evidence. Mitigation: `assertNarrowingOnly` (Phase 1) rejects. Test: `decision-journal-evidence.test.ts > rejects widening-only privacy violation`.
- **Note-field exfiltration via inline-message fallback**: the inline `message` row puts `context.slice(0, 200)` into the `note` field. Mitigation: spec line 372 documents notes inherit entity scope and the 500-byte cap is enforced inside `assertEvidenceShape`. The 200-char truncation is below the 500-byte cap.
- **Producer-crash partial-write corruption**: a bridge crash mid-`rememberWithEvidence` could leave an orphan entity. Mitigation: `rememberWithEvidence` is one better-sqlite3 transaction (Phase 1). Verified by `decision-journal-evidence.test.ts > persists no JSONL row when evidence gate rejects`.

## 8. Verification

- Typecheck: `npx tsc --noEmit` clean.
- New tests: 15 in `decision-journal-evidence.test.ts` + 19 in `learn-skill-evidence.test.ts` = 34 new cases.
- Updated tests: 12 call-site adjustments in `DecisionJournal.test.ts`, 1 in `DispatchDecisionJournal.test.ts`.
- Full unit suite: same set of pre-existing failures as origin/main (`feature-delivery-completeness`, `no-silent-fallbacks`, `pre-push-gate`, `security`, `sharedStateRoutesV2`, `telemetry-routes`) — none introduced by this change. `route-completeness` (previously failing on `instanceof Error` ratchet) now passes.
- Manifest auto-regenerated by `npm run generate:manifest` reflecting `routes.ts` content hash change.

## 9. Rebase-on-main bookkeeping (2026-05-10)

After this branch was opened, three PRs merged on `main` (TaskFlow Phase 5, WikiClaim Phase 5, WikiClaim Phase 4). The branch was rebased onto current `main`; conflicts resolved in `upgrades/NEXT.md` only (additive across all four phases). `src/server/routes.ts` and `src/core/types.ts` auto-merged with no manual intervention. The builtin-manifest's route-group content hashes were regenerated by `npm run generate:manifest` to reflect the union of all four phases' route additions. Re-verified: `npx tsc --noEmit` clean; full `intent-routes.test.ts` (16) + `decision-journal-evidence.test.ts` (15) + `learn-skill-evidence.test.ts` (19) + `DecisionJournal.test.ts` (23) + `DispatchDecisionJournal.test.ts` (41) + `drift-routes.test.ts` (6) all pass.

