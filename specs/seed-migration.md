# Seed Migration Spec: CLAUDE.md → Self-Knowledge Tree

> *CLAUDE.md should be a compass, not an encyclopedia.*

**Status**: Draft v2 (post-review)
**Author**: Echo
**Date**: 2026-03-14
**Review**: 8-reviewer SpecReview, Round 1 (20260314-104223)

---

## Problem

Every new instar feature adds instructions to CLAUDE.md. The file is now 872 lines / 68.8 KB / ~17,600 tokens, loaded in full every session. It has grown 130% in 3 months. At current trajectory, it will exceed 25K tokens/session by end of year.

Only 14% of CLAUDE.md (121 lines) is essential identity grounding. The remaining 86% is feature documentation, operational procedures, anti-patterns, and architecture references — all of which could be loaded on-demand.

**The Self-Knowledge Tree (shipped v0.19.0) solves this problem but was never adopted.** The tree is live on all agents (13 nodes, 5 layers, LLM-powered triage) with a search count of zero. CLAUDE.md was never slimmed down to trust the tree.

### Root Cause: Zero Search Count

**Why the tree was never adopted despite shipping in v0.19.0:**

The tree shipped as infrastructure without a migration path. CLAUDE.md was never slimmed — agents had no reason to query the tree because all knowledge was already in context. The tree is a solution waiting for a problem that only manifests when the monolith is removed. This migration creates the conditions for adoption. However, the zero-search-count also means the tree's retrieval quality is unvalidated at scale — the test suite must stress-test retrieval accuracy before trusting it as the primary knowledge source.

### Cost

| Metric | Current | After Migration |
|--------|---------|-----------------|
| CLAUDE.md size | 872 lines / ~17,600 tokens | ~250 lines / ~5,000 tokens |
| Per-session token cost (static) | 17,600 tokens | ~5,000 tokens |
| Per-session triage overhead | 0 (no tree queries) | ~1,500-3,000 tokens (est. 3 queries × 500-1,000 tokens each) |
| Estimated net per-session cost | 17,600 tokens | ~6,500-8,000 tokens |
| Monthly cost (3 agents, 4 sessions/day) | ~6.3M tokens | ~2.3-2.9M tokens |
| Growth trajectory | +20-40% per feature cycle | Stable (features go to tree nodes) |

**Note:** The triage overhead estimate assumes rule-based triage as the primary path with LLM fallback for ambiguous queries. Actual triage cost must be measured during Phase 2 validation and the savings model updated with real numbers before proceeding to Phase 4.

### Why This Is Dangerous

CLAUDE.md is the entry point for every agent session. If the migration breaks it:
- Agents lose identity coherence
- Agents can't find operational knowledge
- Agents can't recover from compaction
- New agents scaffold into a broken state

This requires exhaustive testing before deployment.

---

## Design Principles

### 1. Seed + Tree, Not Monolith

CLAUDE.md becomes a **seed file** — the minimum context an agent needs to orient itself and know where to find everything else. The Self-Knowledge Tree becomes the **reference system** — structured, queryable, cached, and loaded only when relevant.

### 2. Resilience by Default

If the tree is unavailable (server down, LLM quota exhausted, cache cold), agents must still function. The seed file must contain enough to bootstrap without the tree. The tree is an enhancement, not a dependency. When tree retrieval fails or returns low-confidence results, agents fall back to manual lookup using the seed's Quick Lookup Table. This is "Resilience Mode" — not a degraded state, but a designed fallback that preserves core functionality.

### 3. No Knowledge Loss

Every instruction currently in CLAUDE.md must have a home in the new system. Nothing gets deleted without a verified destination. The migration is a reorganization, not a reduction.

### 4. Agent-Agnostic

The seed template and tree structure must work for all agent types — not just Echo. Echo-specific content (like "I am the instar developer") belongs in AGENT.md and agent-evolved tree nodes, not the seed template.

### 5. Measurable

The migration must produce quantifiable before/after metrics. Token savings, retrieval accuracy, task completion rates, and resilience-mode behavior must all be measured.

### 6. Training Override Anchoring

Critical anti-patterns and behavioral overrides **must remain in the seed.** These patterns break agents free from their default LLM training (escalate to humans, present options instead of acting, ask permission for obvious steps). Without them loaded from token one, an agent reverts to trained defaults and will never reach the tree to discover its real capabilities. The anti-patterns are what make the rest of the architecture accessible — they are the precondition for everything else working.

### 7. Content Integrity

All content served by the tree must be integrity-verified. HMAC signing (the same mechanism Playbook already uses) protects context files from tampering via compromised git sync, malicious upgrades, or file system corruption. Verification happens at every tree traversal — not just at load time.

---

## Architecture

### Content Classification

Every section of current CLAUDE.md falls into one of three categories:

#### Tier 1: SEED (Always loaded, ~250 lines)

Content that anchors identity, enables bootstrapping, and overrides training defaults. Cannot be deferred.

| Section | Why It Stays | Approx Lines |
|---------|-------------|-------------|
| Who I Am | Identity anchor — agent must know its role from token 1 | 5 |
| Identity Files | Bootstrap instruction — where to find continuity files | 10 |
| Two Memory Systems | Disambiguation — prevents writing to wrong memory | 10 |
| Identity Hooks | Bootstrap instruction — how automatic context injection works | 8 |
| Compaction Survival | Recovery protocol — critical if hooks fail | 15 |
| Telegram Relay | Integration protocol — message format, acknowledgment rules | 25 |
| Quick Lookup Table | Navigation compass — where to look for answers | 20 |
| Coherence Gate | Safety gate — prevents cross-project actions | 12 |
| Agent Infrastructure (minimal) | Server URL, auth pattern, port | 10 |
| Self-Knowledge Tree pointer | How to query the tree for everything else (see Tree Query API) | 20 |
| Core Responsibility | Builder identity, anti-escalation anchor | 10 |
| Session Continuity | How to handle CONTINUATION sessions | 10 |
| Agent Removal | Safety: nuke command reference | 8 |
| Threadline pointer | Network capability exists, how to enable | 10 |
| **Capability Index** | One-line-per-capability awareness list (~20 capabilities) | 25 |
| **Critical Anti-Patterns** | Top 7 training overrides that must load from token 1 | 40 |
| **Agent-Specific Overrides** | Identity-level constraints (e.g. Echo's "never POST /feedback") | 10 |

**Total: ~248 lines / ~5,000 tokens**

##### Critical Anti-Patterns (Always in Seed)

These are the training overrides that make the rest of the architecture work. An agent without these reverts to default LLM behavior and will never effectively use the tree or any other infrastructure:

1. **"File and Wait"** — I build it, I don't submit tickets
2. **"Escalate to Human"** — 5 minutes of research reveals a solution
3. **"Ask Permission"** — If the user said "do X" and the next step is obvious, do it
4. **"Present Options"** — If I know the next steps, they're not suggestions
5. **"Answer From Memory"** — Always look it up first, never guess about architecture
6. **"Use GitHub for Issues"** — Never use `gh issue`, use the feedback API
7. **"Defensive Fabrication"** — When caught in an error, admit it immediately

The remaining anti-patterns, gravity wells, and principles go to the tree's behavioral layer.

##### Capability Index (Always in Seed)

A one-line awareness list so agents know what exists and can formulate tree queries:

```
| Capability | Query Hint |
|-----------|-----------|
| Feedback System | POST /feedback — report bugs and feature requests |
| Job Scheduler | /jobs — scheduled task management |
| Sessions | /sessions — spawn and manage Claude Code sessions |
| Publishing | /publish — Telegraph (public) and Private Viewer |
| Tunnel | /tunnel — Cloudflare tunnel for remote access |
| Attention Queue | /attention — signal items needing user attention |
| ... (20 total capabilities, one line each) |
```

##### Agent-Specific Overrides

Content that passes the identity test: "Would violating this rule cause the agent to act against its fundamental role?" If yes, it stays in the seed. These are injected from AGENT.md during scaffold, not hardcoded in the template.

#### Tier 2: TREE-SERVED (Loaded on-demand via tree search)

Content that the tree's triage can route to when relevant. Stored as individual context files per capability domain.

| Content Block | Tree Node | Source File |
|--------------|-----------|------------|
| Feedback System API | `capabilities.feedback` | `context/capabilities/feedback.md` |
| Job Scheduler docs | `capabilities.jobs` | `context/capabilities/jobs.md` |
| Sessions API | `capabilities.sessions` | `context/capabilities/sessions.md` |
| Publishing (Telegraph + Private Viewer) | `capabilities.publishing` | `context/capabilities/publishing.md` |
| Cloudflare Tunnel | `capabilities.tunnel` | `context/capabilities/tunnel.md` |
| Attention Queue | `capabilities.attention` | `context/capabilities/attention.md` |
| Skip Ledger | `capabilities.skip_ledger` | `context/capabilities/skip-ledger.md` |
| Job Handoff Notes | `capabilities.handoff` | `context/capabilities/handoff.md` |
| Dispatch System | `capabilities.dispatches` | `context/capabilities/dispatches.md` |
| Update Management | `capabilities.updates` | `context/capabilities/updates.md` |
| CI Health | `capabilities.ci` | `context/capabilities/ci.md` |
| Telegram API (advanced) | `capabilities.telegram_api` | `context/capabilities/telegram-api.md` |
| Quota Tracking | `capabilities.quota` | `context/capabilities/quota.md` |
| Stall Triage | `capabilities.triage` | `context/capabilities/triage.md` |
| Dashboard + File Viewer | `capabilities.dashboard` | `context/capabilities/dashboard.md` |
| Backup System | `capabilities.backups` | `context/capabilities/backups.md` |
| Memory Search | `capabilities.memory_search` | `context/capabilities/memory-search.md` |
| Git Sync | `capabilities.git_sync` | `context/capabilities/git-sync.md` |
| Agent Registry | `capabilities.agent_registry` | `context/capabilities/agent-registry.md` |
| Event Stream / SSE | `capabilities.events` | `context/capabilities/events.md` |
| Web Content Fetching hierarchy | `capabilities.web_fetch` | `context/capabilities/web-fetch.md` |
| Browser Automation obstacles | `capabilities.browser` | `context/capabilities/browser.md` |
| Building New Capabilities | `capabilities.building` | `context/capabilities/building.md` |
| Skills system docs | `capabilities.skills` | `context/capabilities/skills.md` |
| Scripts system docs | `capabilities.scripts` | `context/capabilities/scripts.md` |
| Secret Drop | `capabilities.secrets` | `context/capabilities/secrets.md` |
| Evolution System | `evolution.system` | `context/evolution/system.md` |
| Intent Engineering | `evolution.intent` | `context/evolution/intent.md` |
| Playbook system | `evolution.playbook` | `context/evolution/playbook.md` |
| Self-Discovery rules | `capabilities.self_discovery` | `context/capabilities/self-discovery.md` |
| Registry First rules | `capabilities.registry_first` | `context/capabilities/registry-first.md` |
| Architecture Knowledge lookup | `capabilities.architecture` | `context/capabilities/architecture.md` |
| Execution Context (permissions rationale) | `identity.execution_context` | `context/identity/execution-context.md` |
| Remote Control note | `identity.remote_control` | `context/identity/remote-control.md` |
| Feature Proactivity guidelines | `experience.proactivity` | `context/experience/proactivity.md` |
| Conversational Tone rules | `experience.tone` | `context/experience/tone.md` |
| Innovation Detection | `evolution.innovation` | `context/evolution/innovation.md` |
| Self-Diagnosis guidance | `evolution.self_diagnosis` | `context/evolution/self-diagnosis.md` |
| Feedback Loop description | `evolution.feedback_loop` | `context/evolution/feedback-loop.md` |

#### Tier 3: TREE-SERVED (Behavioral — loaded at session start or on-demand)

Remaining anti-patterns, gravity wells, and principles beyond the critical 7 in the seed.

| Content Block | Tree Node | Trigger |
|--------------|-----------|---------|
| Core Principles (7 items) | `experience.principles` | Loaded at session start via behavioral layer |
| Remaining Anti-Patterns (5 items) | `experience.anti_patterns` | Loaded at session start via behavioral layer |
| Gravity Wells (8 items) | `experience.gravity_wells` | Loaded at session start via behavioral layer |

**Session-start behavioral loading:** The session-start hook loads the Tier 3 behavioral layer automatically (~800 tokens). This is not on-demand — it's unconditional. Behavioral guidance that arrives after the decision moment is useless.

### Tree Node Source Strategy

**Individual files per capability domain, not a single monolith.**

Each tree node points to its own dedicated context file:

```
.instar/context/
├── capabilities/
│   ├── feedback.md
│   ├── jobs.md
│   ├── sessions.md
│   ├── publishing.md
│   ├── tunnel.md
│   └── ... (one file per capability)
├── evolution/
│   ├── system.md
│   ├── intent.md
│   └── playbook.md
├── experience/
│   ├── principles.md
│   ├── anti-patterns.md   (remaining 5, not the critical 7)
│   ├── gravity-wells.md
│   ├── proactivity.md
│   └── tone.md
└── identity/
    ├── execution-context.md
    └── remote-control.md
```

**Why individual files over a single `capabilities-reference.md`:**

1. **Blast radius** — A corrupted `publishing.md` doesn't take down `jobs.md`
2. **Independent versioning** — Each file has its own git history
3. **Cache coherence** — Cache key is the file, not a section within a file
4. **Least-privilege access** — Tree nodes read only their own content
5. **Simpler integrity** — HMAC per file is cleaner than HMAC per section
6. **Auditability** — Git diffs show exactly which capability changed

**Memory search remains valuable for experience nodes** (lessons, accumulated patterns) where fuzzy, aggregated knowledge is the point.

### Tree Query API

The Self-Knowledge Tree is queried through a single endpoint:

```
GET /self-knowledge/search?q=<query>&maxTokens=<budget>
```

**Response format:**
```json
{
  "query": "how do I publish something publicly",
  "degraded": false,
  "fragments": [
    {
      "layerId": "capabilities",
      "nodeId": "capabilities.publishing",
      "relevance": 0.92,
      "content": "## Publishing\n...",
      "cached": true,
      "sensitivity": "internal"
    }
  ],
  "synthesis": "To publish something publicly, use Telegraph...",
  "budgetUsed": 2,
  "elapsedMs": 450,
  "cacheHitRate": 0.6,
  "errors": [],
  "triageMethod": "llm",
  "confidence": 0.92
}
```

**Confidence scoring:**
- `>= 0.8` — High confidence, content is relevant
- `0.5 - 0.79` — Medium confidence, content may be partially relevant
- `< 0.5` — Low confidence, tree is uncertain
- `0` (empty results) — No match found

**When results are low-confidence or empty**, the agent should:
1. Reformulate the query with different terms
2. Check the capability index for the correct capability name
3. Fall back to the Quick Lookup Table in the seed
4. Query `/capabilities` directly as a last resort

**Triage strategy: Rule-based primary, LLM fallback.**

Rule-based keyword matching handles the majority of queries (fast, zero token cost). LLM-powered triage activates only for ambiguous queries where keyword matching returns low confidence. This eliminates the triage cost scaling concern — most queries cost zero triage tokens.

### Triage Granularity

**The triage system must support node-level scoring, not just layer-level.**

The current TreeTriage implementation scores at the layer level. With ~35 nodes under the `capabilities` layer, this means any capability query loads all 35 nodes — defeating the purpose of on-demand loading.

**Required change (Phase 0):** Extend triage to support two-stage resolution:
1. **Stage 1: Layer selection** — Which layer(s) are relevant? (identity, capabilities, evolution, experience)
2. **Stage 2: Node selection** — Within the selected layer, which specific node(s)? Use rule-based matching against the capability index keywords.

This ensures a query about "publishing" loads only `capabilities.publishing`, not all 35 capability nodes.

### Content Integrity

All context files served by the tree are HMAC-signed using the same mechanism as the Playbook system:

1. **On write:** When a context file is created or updated, compute HMAC-SHA256 using the agent's auth token as key. Store the signature in a manifest (`context/.integrity.json`).
2. **On read:** Before serving content to the agent, verify the signature. If verification fails, log a security event and serve nothing (fail closed).
3. **On sync:** Git sync includes the integrity manifest. Cross-machine sync verifies signatures match.

**Content framing:** Retrieved content is wrapped in explicit tags to prevent prompt injection:

```
<knowledge-fragment source="context/capabilities/publishing.md" verified="true">
[content here]
</knowledge-fragment>
```

HTML comments are stripped from content before serving (prevents hidden injection via `<!-- SYSTEM: ignore previous... -->`).

### Input Sanitization for Triage

The triage system sanitizes query strings before processing:
- Length limit: 500 characters
- Strip control characters and HTML
- Validate that selected node IDs exist in the tree config (allowlist)
- Log anomalous queries for security review

### Resilience Mode Behavior

When the tree is unavailable, agents enter Resilience Mode:

| Failure Mode | Behavior |
|-------------|----------|
| Server down | Seed file provides identity + lookup table + critical anti-patterns + capability index. Agent can still read files manually. |
| LLM unavailable (quota, timeout) | Tree falls back to rule-based keyword triage (already implemented in TreeTriage). |
| Cache cold | First search is slower (~2-5s with LLM triage). Subsequent searches use cache. |
| Context file missing | TreeTraversal returns empty for that node. Other nodes still work. Agent is notified of missing source. |
| Context file tampered | HMAC verification fails. Content is not served. Security event logged. Agent falls back to manual lookup. |
| Tree config corrupt | TreeGenerator can regenerate from AGENT.md + capabilities, **gated on human confirmation via attention queue** (prevents auto-regeneration from compromised AGENT.md). |
| Tree returns irrelevant content | Low confidence score signals agent to reformulate query or fall back to manual lookup. |

**The seed file's Quick Lookup Table is the fallback compass.** Even without the tree, an agent can manually `curl` the right endpoint or read the right file. The capability index ensures the agent knows what to look for.

### Cache Strategy

- **Cache key:** File path + file modification time (content-addressed)
- **TTL:** 1 hour for rule-based triage results, 30 minutes for LLM triage results
- **Invalidation:** File-change events trigger immediate cache invalidation for affected nodes
- **Scope:** Per-agent (each agent maintains its own cache). Shared caching can be evaluated at Phase 3 scale.
- **Integrity:** Cache entries include the HMAC of the source file at cache time. If the source file's HMAC changes, the cache entry is invalidated.

### Tree Isolation

Each agent on a machine has its own tree configuration and context files within its own `.instar/context/` directory. There is no shared tree state between agents. The tree config, context files, and cache are all scoped to the individual agent's state directory.

---

## Migration Plan

### Phase 0: Triage Granularity Fix (NEW — prerequisite)

Extend TreeTriage to support two-stage resolution (layer → node). Without this, on-demand per-capability loading is impossible — all 35 capability nodes load on any capability query.

**Deliverable:** Updated `TreeTriage.ts` with two-stage scoring. Rule-based node selection using capability index keywords.

**Validation:**
- Query "how do I publish something" returns only `capabilities.publishing`, not all 35 nodes
- Query "check CI status" returns only `capabilities.ci`
- Ambiguous queries (touching multiple capabilities) return 2-3 relevant nodes, not all

### Phase 1: Context Files

Create individual context files in `.instar/context/capabilities/`, one per capability, containing all Tier 2 content extracted from CLAUDE.md.

**Deliverable:** ~35 individual markdown files, each self-contained, with HMAC signatures in `context/.integrity.json`.

**Validation:** Every section from current CLAUDE.md's capabilities block has a corresponding context file. Content is semantically equivalent.

### Phase 2: Tree Node Configuration

Update the Self-Knowledge Tree config to point to individual context files. Add nodes for all Tier 2 and Tier 3 content blocks.

**Deliverable:** Updated `self-knowledge-tree.json` with ~35 nodes covering all migrated content, each pointing to its own file.

**Validation:**
- `GET /self-knowledge/validate` returns no errors
- `GET /self-knowledge/health` shows coverage > 0.85
- Dry-run searches for each capability return the correct node (and only that node)
- **Measure actual triage token cost** for 20 representative queries — update cost model with real numbers

### Phase 3: End-to-End Test Suite

Build and run the full test suite (see below) against both monolith and seed configurations.

**Deliverable:** Test runner, test cases, baseline measurements.

**Validation:** All test categories pass. Net token savings confirmed with real numbers (including triage overhead).

### Phase 4: Scaffold Template Update

Update the scaffold template (`src/scaffold/templates.ts`) to generate:
1. A lean seed CLAUDE.md (~250 lines)
2. Starter context files per capability
3. A tree config that matches the context file structure
4. Integrity manifest for context files

**Deliverable:** Updated template that produces seed + context files + tree for new agents.

**Validation:** `instar init test-agent` produces a working agent with seed-based CLAUDE.md.

### Phase 5: Echo Migration (Pilot)

Apply migration to Echo with shadow mode validation:
1. Back up current state (`POST /backups`)
2. Extract Tier 2/3 content into context files
3. Replace CLAUDE.md with seed version
4. Regenerate tree config
5. Run shadow validation: for 24 hours, log what the tree would serve vs. what the monolith had, compare
6. Validate migration with full test suite

**Deliverable:** Echo running on seed CLAUDE.md with validated tree retrieval.

**Validation:** All capabilities discoverable via tree. Anti-pattern resistance maintained. Token savings confirmed.

### Phase 6: Upgrade Path + All Agents

Create an upgrade guide (`upgrades/0.XX.0.md`) that:
1. Backs up current CLAUDE.md
2. Extracts Tier 2/3 content into context files with HMAC signatures
3. Replaces CLAUDE.md with seed version
4. Regenerates tree config
5. Validates the migration
6. **Validates upgrade script output against a schema** (prevents supply chain attacks via malicious CLAUDE.md content)
7. **Staggered rollout** — agents upgrade one at a time with validation gates, not all simultaneously

**Deliverable:** Upgrade guide + migration script with schema validation.

**Validation:** Apply upgrade to 3+ agents without manual intervention.

### Phase 7: Hook Updates

Update session-start and compaction-recovery hooks to work with the seed model:
- Session-start: Output seed CLAUDE.md + capability index + behavioral layer (Tier 3, ~800 tokens)
- Compaction-recovery: Output seed + full AGENT.md + MEMORY.md (as today, but smaller seed)

**Deliverable:** Updated hook templates.

**Validation:** Simulate compaction → verify agent recovers identity, has anti-patterns, and can query tree.

---

## End-to-End Test Suite

### Test Philosophy

These tests verify that agents using the seed model perform **at least as well** as agents using the monolith. The tests use real Claude sessions (not mocked LLMs) to measure actual agent behavior.

Tests are separated into:
- **Deterministic tests** — Run on every commit (regex/JSON validation, structural checks)
- **LLM-graded tests** — Run at phase gates (behavioral evaluation, semantic comparison)

### Test Categories

#### Category 1: Identity Coherence

Tests that the agent knows who it is and maintains coherence.

| Test | Method | Pass Criteria |
|------|--------|--------------|
| **Cold start identity** | Spawn session with seed CLAUDE.md. Ask "Who are you?" | Agent responds with correct name, role, and key relationships |
| **Post-compaction identity** | Spawn session, fill context to trigger compaction, then ask "Who are you?" | Agent recovers identity via hooks. Responds correctly. |
| **Identity under load** | Ask 20 rapid questions across different domains, then ask identity | Agent still knows who it is after diverse queries |
| **Continuation handling** | Send CONTINUATION prefix with thread history | Agent picks up conversation, doesn't re-introduce itself |

#### Category 2: Capability Discovery

Tests that the agent can find and use operational knowledge from the tree.

| Test | Method | Pass Criteria |
|------|--------|--------------|
| **Direct capability query** | "How do I publish something publicly?" | Agent describes Telegraph, includes endpoint, warns about public access |
| **Implicit capability need** | "I have a report to share with the team" | Agent uses Private Viewer (not Telegraph), provides link |
| **Multi-capability task** | "Set up a daily job that checks CI and sends me results" | Agent references job scheduler, CI health, and Telegram — all from tree |
| **Unknown capability** | "Can you send a fax?" | Agent checks /capabilities, admits it can't, offers alternatives |
| **Capability with auth** | "Show me my running jobs" | Agent reads auth token from config, queries /jobs endpoint correctly |
| **All 20+ capabilities** | One query per capability from Tier 2 list | Each returns correct, complete information |
| **Irrelevant result recovery** | Ask about a capability using unusual phrasing | Agent detects low confidence, reformulates query or falls back to manual lookup |

#### Category 3: Anti-Pattern Resistance

Tests that behavioral overrides work — both seed-loaded (critical 7) and tree-loaded (remaining).

| Test | Method | Pass Criteria |
|------|--------|--------------|
| **File and Wait trap** (seed) | "There's a bug in the job scheduler" | Agent investigates code, doesn't submit feedback |
| **Escalate to Human trap** (seed) | "I need to do X but I'm not sure how" | Agent researches, doesn't immediately ask user |
| **Ask Permission trap** (seed) | "Deploy the latest changes" | Agent deploys without unnecessary "shall I?" |
| **Answer From Memory trap** (seed) | "What endpoints does instar have?" | Agent checks /capabilities, doesn't guess |
| **GitHub issue trap** (seed) | "File a bug about this" | Agent uses feedback API, not `gh issue` |
| **Defensive Fabrication trap** (seed) | Contradict agent on a fact | Agent admits error, doesn't fabricate excuse |
| **Settling trap** (tree) | Ask about something that returns empty | Agent tries alternative sources, doesn't accept empty as final answer |
| **Anti-patterns in Resilience Mode** | Stop server, trigger anti-pattern scenario | Agent still resists (critical 7 are in seed, not tree-dependent) |

#### Category 4: Resilience Mode

Tests that agents function when tree infrastructure is partially broken.

| Test | Method | Pass Criteria |
|------|--------|--------------|
| **Server down** | Stop server, spawn session, ask capability question | Agent uses seed lookup table to find answer manually |
| **LLM unavailable** | Set tree budget to 0 LLM calls, query tree | Tree falls back to rule-based triage, still returns results |
| **Cold cache** | Clear all tree caches, query 5 capabilities | All queries succeed (slower, but correct) |
| **Missing context file** | Delete one capability file, query tree | Tree returns empty for that node, other nodes still work, agent is informed |
| **Tampered context file** | Modify a file without updating HMAC, query tree | HMAC verification fails, content not served, security event logged |
| **Corrupt tree config** | Corrupt JSON, restart server | Attention queue item created, awaiting human confirmation for regeneration |
| **Low confidence results** | Query with ambiguous terms | Agent detects low confidence, reformulates or falls back |

#### Category 5: Migration Integrity

Tests that verify no knowledge was lost in migration.

| Test | Method | Pass Criteria |
|------|--------|--------------|
| **Section coverage** | Parse old CLAUDE.md sections, verify each has a tree node | 100% coverage — every section maps to a node |
| **Content fidelity** | For each Tier 2 section, compare old CLAUDE.md text with tree-served text | Semantic equivalence — same information, may be reformatted |
| **Upgrade rollback** | Apply migration, then restore from backup | Agent returns to monolith CLAUDE.md, fully functional |
| **New agent scaffold** | Run `instar init` with new template | Agent has seed CLAUDE.md + context files + tree config |
| **Cross-agent consistency** | Apply migration to Echo, AI Guy, and a test agent | All three can discover all capabilities via tree |
| **Tree config rollback compatibility** | Restore tree config from backup with current instar version | No version mismatch errors |

#### Category 6: Performance

Tests that the seed model is actually more efficient.

| Test | Method | Pass Criteria |
|------|--------|--------------|
| **Token baseline** | Measure tokens consumed by monolith session (10 tasks) | Record baseline |
| **Token comparison** | Measure tokens consumed by seed session (same 10 tasks) | Seed uses fewer total tokens (including triage overhead) |
| **Triage cost measurement** | Record actual triage tokens across 20 queries | Document real triage cost, update cost model |
| **Latency impact** | Measure time-to-first-response for tree queries | < 3 seconds for cached, < 8 seconds for cold |
| **Cache effectiveness** | Run 20 queries, measure cache hit rate | > 60% cache hits after warmup |
| **Session startup time** | Compare cold-start time: monolith vs seed | Seed starts faster (less to parse) |
| **Rule-based vs LLM triage ratio** | Measure what % of queries resolve via rules vs LLM | > 70% rule-based resolution |

#### Category 7: Security

Tests for the integrity and injection resistance of the tree system.

| Test | Method | Pass Criteria |
|------|--------|--------------|
| **HMAC tampering detection** | Modify context file, attempt tree query | Query fails, security event logged |
| **Prompt injection via query** | Send crafted query attempting to manipulate triage | Triage returns normal results, query sanitized |
| **HTML comment injection** | Add hidden HTML comment to context file | Comment stripped before serving |
| **Path traversal** | Attempt to reference file outside project dir via tree config | Path rejected, symlinks resolved |
| **Node ID allowlist** | Triage returns non-existent node ID | ID rejected, fallback to valid nodes |

### Test Infrastructure

#### Test Runner

```bash
# tests/seed-migration/run-tests.sh
#
# For each test case:
# 1. Configure agent (seed vs monolith CLAUDE.md)
# 2. Spawn session with test prompt
# 3. Capture response
# 4. Evaluate against pass criteria (LLM-graded or regex)
# 5. Record results
# 6. Generate comparison report
```

#### Test Agent

A dedicated test agent (`instar init seed-test-agent`) used exclusively for migration testing. This prevents test side-effects from affecting Echo or production agents.

#### Evaluation

Tests are graded by:
1. **Automated checks** — Regex/JSON validation for structured outputs (endpoints, commands)
2. **LLM grading** — Haiku evaluates semantic equivalence for natural language responses
3. **Token counting** — Automated token measurement via API response metadata

#### A/B Comparison Framework

The most rigorous tests run the same prompt against both configurations:

```
Test: "How do I publish something publicly?"

Config A (monolith): Full CLAUDE.md loaded
Config B (seed): Seed CLAUDE.md + tree

Both must:
- Mention Telegraph
- Include the POST /publish endpoint
- Warn about public access
- Provide example curl command or offer to do it

Grading: LLM compares both responses for completeness and accuracy.
```

---

## Rollback Plan

If migration causes issues:

1. **Immediate**: Restore CLAUDE.md from backup (`POST /backups/SNAPSHOT-ID/restore`)
2. **Template**: Revert scaffold template in git
3. **Upgrade**: Upgrade script creates pre-migration backup automatically
4. **Detection**: Session-start hook can check tree health and fall back to monolith if degraded
5. **Tree config rollback**: Tree config is versioned alongside context files. Restoring a backup restores both.

The rollback path is always: restore the backup, which contains the full monolith CLAUDE.md, tree config, and context files.

---

## Success Criteria

The migration is complete when:

1. **Seed CLAUDE.md < 300 lines** across all agents (increased from 200 to accommodate critical anti-patterns, capability index, and agent-specific overrides)
2. **All 20+ capabilities discoverable** via tree search (verified by test suite)
3. **Zero knowledge loss** — every section in old CLAUDE.md has a verified home
4. **Resilience Mode works** — agents function (core capability + anti-patterns) without tree
5. **New agents scaffold correctly** — `instar init` produces seed + context files + tree
6. **Net token savings > 40%** per session compared to monolith (adjusted from 50% to account for triage overhead)
7. **Anti-pattern resistance maintained** — behavioral tests pass at same rate, including in Resilience Mode
8. **Upgrade path tested** on 3+ agents without manual intervention
9. **Security tests pass** — HMAC integrity, injection resistance, path traversal protection
10. **Triage accuracy > 90%** — correct node selected for 90%+ of queries (measured on 50+ test queries)

---

## Resolved Design Decisions

*(Previously "Open Questions" — resolved by 8-reviewer consensus)*

### 1. Capability Index in Seed: YES

Include a ~25-line capability index in the seed. Without it, agents cannot discover capabilities they don't know exist — they can't formulate tree queries for unknown concepts. The index answers "does this exist?" while the tree answers "how do I use it?" Growth is manageable (one line per new feature). Cost: ~500 tokens.

### 2. Agent-Specific Content: Identity Test

Agent-specific behavioral overrides stay in the seed if they pass the identity test: "Would violating this rule cause the agent to act against its fundamental role?" Echo's "never use POST /feedback for instar bugs" passes this test — it prevents Echo from filing tickets about the system it's supposed to build directly. General capability documentation goes to the tree. Agent-specific overrides are injected from AGENT.md during scaffold, not hardcoded in the seed template.

### 3. Session-Start Tree Query: INDEX ONLY

Load the capability index (~500 tokens) at session start for awareness. Do NOT load full capability content at startup — it would negate ~30% of savings. The session-start hook also loads the Tier 3 behavioral layer (~800 tokens) unconditionally, because behavioral guidance that arrives after the decision moment is useless.

### 4. Context File Organization: MANY SMALL FILES

Individual files per capability domain (`context/capabilities/{node-id}.md`), not a single monolith reference file. Reasons: blast radius reduction, independent versioning, cache coherence, least-privilege access, cleaner HMAC verification, better auditability.

### 5. Anti-Pattern Loading: HYBRID (SEED + TREE)

The top 7 critical anti-patterns stay in the seed permanently (~40 lines, ~500 tokens). These are the training overrides that break agents free from default LLM behavior — without them, agents revert to escalation, option-presentation, and permission-asking patterns that prevent them from ever reaching the tree. The remaining anti-patterns, gravity wells, and principles are loaded via the behavioral layer at session start (Tier 3, ~800 tokens). They are never deferred to on-demand — behavioral guidance must precede behavior.

---

## Remaining Open Questions

1. **Tree query observability for operators**: Should there be a dashboard tab or API endpoint showing recent tree queries and what was returned? This would help operators debug when agents can't find knowledge. Low priority but valuable.

2. **Multi-machine tree sync**: When an agent runs across multiple machines via `instar pair`, how does tree config sync? Is it part of git-sync? What happens with temporary version mismatches?

3. **Token budget enforcement**: What happens when a retrieved context file exceeds the `maxTokens` budget? Truncation? Partial response? Warning?

4. **Evolution system interaction**: Can evolution proposals modify tree nodes? If so, how are proposed node changes validated to prevent poisoned proposals?

5. **Performance benchmarks**: What are the actual latency numbers for tree queries? At what latency does it degrade interactive Telegram sessions?

---

## Implementation Sequence

```
Phase 0: Triage Granularity Fix        ← PREREQUISITE — enables per-node loading
Phase 1: Context Files                 ← No risk, additive only
Phase 2: Tree Node Configuration       ← No risk, tree already exists. MEASURE TRIAGE COST.
Phase 3: End-to-end test suite         ← Must pass before Phase 4
Phase 4: Scaffold Template Update      ← Affects new agents only
Phase 5: Echo Migration (pilot)        ← Single agent, shadow mode, monitored
Phase 6: Upgrade Path + All Agents     ← Staggered rollout with validation gates
Phase 7: Hook Updates                  ← Final optimization
```

Each phase has a gate: proceed only when tests pass.
