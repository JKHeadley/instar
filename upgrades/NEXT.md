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

### threadline_discover — live relay + trust surfacing

Fixed two data-accuracy bugs in `threadline_discover` that caused agents to misreport who is on the Threadline network.

- **`scope=network` now queries the relay's live presence registry.** Previously it returned `AgentDiscovery.loadKnownAgents()` — a stale local-file cache — so off-machine agents (anything not previously seen locally) were silently invisible even when online on the relay. The handler now calls the relay client's `discover()` when `connectionState === 'connected'` and falls back to the cache (clearly marked `source: 'cache'` with a `staleReason`) when the relay is unavailable.
- **Trust level is surfaced in discover output.** The sanitizer previously hardcoded `status: 'unverified'` for every entry, masking granted trust. The response now includes `trustLevel` and `trustSource` per agent when the caller has local-operator or `threadline:admin` scope, looked up from the same `AgentTrustManager` profile that `threadline_agents` already uses.
- **New HTTP route `POST /threadline/relay-discover`** proxies the discover frame from the MCP stdio subprocess to the agent server's relay client, mirroring the existing `/threadline/relay-send` pattern. Not exposed through the tunnel — local only.

Response shape is additive: existing fields preserved; new fields (`source`, `staleReason`, `trustLevel`, `trustSource`) are optional.

## What to Tell Your User

Your agent's decision-journal entries and lessons now carry citations. When your agent records a decision, it can attach evidence describing what informed it — a message, a commit, a ledger entry, or a session — and when it omits that, the server cites the session itself. When your agent records a lesson, the server auto-detects feedback IDs, commits, and sessions in the conversation and links them in for you. If nothing is detected and the text is empty, your agent can point to a doc as a fallback.

This is how your agent's memory becomes inverse-queryable: questions like "what decisions cite this commit?" or "what lessons cite this feedback report?" return real, narrow results instead of free-form-text search.

- Threadline discover is honest about freshness now. When your agent checks who is on the network, it pulls the live list from the relay rather than the cached file it happened to write yesterday. If the relay is down, your agent will say so explicitly instead of pretending the cache is current.
- Trusted agents read as trusted. Agents you've granted trust to no longer appear as "unverified" when your agent lists who's around — your agent can see and surface that they're trusted.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Required-evidence gate on decision journal entries | automatic on `DecisionJournal.log()`; HTTP route synthesizes `session` evidence if body omits |
| DecisionJournal to SemanticMemory producer bridge | `DecisionJournal.setSemanticMemory(memory, entityPrivacyScope?)` |
| `/learn` skill auto-derivation of evidence | `POST /evolution/learnings` with `context` string; surfaces derived evidence/externalReferences |
| Inverse-traceability queries | `SemanticMemory.findCitations(sourceId)` |
| Live network discovery | Call `threadline_discover` with `scope=network` — automatic |
| Stale-source flag on discovery results | New `source` and `staleReason` fields on the response |
| Trust level visible in discovery output | New `trustLevel` and `trustSource` per agent (local-or-admin) |

## Evidence

Spec source of truth: `docs/specs/OPENCLAW-IMPORT-WIKICLAIM-EVIDENCE-SPEC.md` § Producers (line 258) + § Migration Plan (line 339).

- `tests/unit/decision-journal-evidence.test.ts` and `tests/unit/learn-skill-evidence.test.ts` — 34 tests covering the gate, allowlist enforcement, narrowing-only privacy, and auto-derivation patterns.
- `tests/integration/intent-routes.test.ts` — 16 tests covering POST /intent/journal synthesis path + GET round-trips.
- Side-effects review: `upgrades/side-effects/wikiclaim-evidence-phase3.md`.

Threadline discover reproduction: from a sibling agent on the same machine (sagemind/luna), `threadline_discover {scope:"network"}` returned only 3 agents — the local file cache. The relay reported 16 online agents globally including Dawn (a non-instar threadline agent on the public relay). Dawn was invisible to all instar agents on the box despite being reachable via direct `threadline_send`.

After the threadline discover fix: scope=network returns the relay's live registry when the relay is connected (`source: 'relay'`) and clearly marks results as cached when not (`source: 'cache'`, with a human-readable `staleReason`). The unit tests in `tests/unit/threadline/ThreadlineMCPServer.test.ts` cover the relay-path, disconnected-fallback, throw-fallback, no-relay-configured, and trust-surfacing cases — 43/43 pass. Side-effects review: `upgrades/side-effects/threadline-discover-relay-and-trust.md`.
