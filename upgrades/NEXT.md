# Upgrade Guide — vNEXT

<!-- bump: minor -->
<!-- Valid values: patch, minor, major -->
<!-- patch = bug fixes, refactors, test additions, doc updates -->
<!-- minor = new features, new APIs, new capabilities (backwards-compatible) -->
<!-- major = breaking changes to existing APIs or behavior -->

## What Changed

### WikiClaim Evidence Phase 3 — DecisionJournal + /learn producers

Every entry written to the decision journal must now cite at least one piece of evidence, and the `/learn` skill auto-derives evidence from the conversation context (feedback IDs, commit SHAs, session UUIDs) or accepts a document fallback.

Spec source: `docs/specs/OPENCLAW-IMPORT-WIKICLAIM-EVIDENCE-SPEC.md` § Producers line 258 + § Migration Plan line 339.

- `DecisionJournal.log(entry, evidence)` is a breaking signature change. `evidence` is now a required `MemoryEvidence[]` second argument; passing an empty array or undefined throws `EvidencePolicyError`. Spec-mandated kinds for DecisionJournal: `message`, `commit`, `ledger-entry`, `session`.
- `DecisionJournal.setSemanticMemory(memory, entityPrivacyScope?)` wires a producer bridge — each logged decision is also promoted to a `decision` MemoryEntity via `rememberWithEvidence`, and the resulting `entityId` is back-referenced on the JSONL row.
- New module `src/core/LearnSkillBridge.ts` powers the `/learn` evidence auto-derivation. Patterns recognized: `fb_<hex>` becomes `feedback` (surfaced as externalReference; LearnSkill cannot itself write `feedback` kind), 40-char SHA becomes `commit` external reference, UUID v4 / `sess_<hex>` becomes `session` evidence. When no structured ref is detected and context is non-empty, an inline `message` row is synthesized.
- `POST /intent/journal` accepts an optional `evidence` array in the request body. If omitted, the route synthesizes a minimum-viable `session` evidence row from the request's `sessionId` (sourceId = `session:<sessionId>`) so existing callers keep working while still satisfying the evidence policy. Passing explicit evidence overrides the synthesis.
- `POST /evolution/learnings` accepts a `context` string (and/or `documentFallback`) and runs the LearnSkillBridge. The response surfaces derived `evidence`, `externalReferences`, and `pendingDocumentRef`.

## What to Tell Your User

Your agent's decision-journal entries and lessons now carry citations. When you log a decision via `POST /intent/journal`, you may include an `evidence` array describing what informed it (a message ID, commit SHA, ledger entry, or session ID); if you omit it, the server cites the session itself. When you record a lesson via `POST /evolution/learnings`, the server auto-detects feedback IDs, commits, and sessions in your context — you'll see them on the response. If nothing is auto-detected and your text is empty, pass a `documentFallback` like `{ "sourceId": "docs/RUNBOOK.md" }` to cite a doc.

This is how your agent's memory becomes inverse-queryable: "what decisions cite this commit?" or "what lessons cite this feedback report?" returns real, narrow results instead of free-form-text search.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Required-evidence gate on decision journal entries | automatic on `DecisionJournal.log()`; HTTP route synthesizes `session` evidence if body omits |
| DecisionJournal to SemanticMemory producer bridge | `DecisionJournal.setSemanticMemory(memory, entityPrivacyScope?)` |
| `/learn` skill auto-derivation of evidence | `POST /evolution/learnings` with `context` string; surfaces derived evidence/externalReferences |
| Inverse-traceability queries | `SemanticMemory.findCitations(sourceId)` |

## Evidence

Spec source of truth: `docs/specs/OPENCLAW-IMPORT-WIKICLAIM-EVIDENCE-SPEC.md` § Producers (line 258) + § Migration Plan (line 339).

- `tests/unit/decision-journal-evidence.test.ts` and `tests/unit/learn-skill-evidence.test.ts` — 34 tests covering the gate, allowlist enforcement, narrowing-only privacy, and auto-derivation patterns.
- `tests/integration/intent-routes.test.ts` — 16 tests covering POST /intent/journal synthesis path + GET round-trips.
- Side-effects review: `upgrades/side-effects/wikiclaim-evidence-phase3.md`.
