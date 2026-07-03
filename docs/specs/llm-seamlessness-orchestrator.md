---
kind: "spec"
id: "llm-seamlessness-orchestrator"
title: "LLM-Driven Seamlessness Orchestrator"
summary: "Background LLM loop that proactively coordinates working-set sync, machine placement, and lazy-loading across a multi-machine agent."
---

# LLM-Driven Seamlessness Orchestrator

**Status:** DRAFT
**Owner:** Echo  
**Created:** 2026-07-03  
**Goal Alignment:** Goal B (Seamless agent across machines)

## Problem

Multi-machine seamlessness is currently **deterministic + heuristic only**:
- Working-set sync happens on-demand (when you ask for a file)
- Machine placement is least-loaded + manual pins
- Session mobility is **not proactive** (you wait for a reaper kill or manual move)
- There is **no background intelligence** proposing "this conversation should move to Machine X" or "sync this project now before you need it"

Goal B requires seamlessness to feel **automatic and intelligent**, not like pulling teeth.

## Design

A background **tier-1 supervised LLM loop** (Haiku, ~5m cadence) reads:
- The current machine pool state (who's online, load, quota)
- Open topics (which machine holds each, session idle time, current project context)
- Known projects (where they live, last access, size)

And **proposes**:
- Sync a project to the current machine before the user asks (need-driven preload)
- Move a conversation to a quieter machine (load-balancing proposal)
- Pre-fetch a working-set item that's been referenced but not yet synced

Then **actuates** through existing funnels:
- Working-set fetcher: `POST /coherence/fetch-working-set` (already exists)
- Topic transfer: `POST /pool/transfer` with `confirm:false` to propose, `confirm:true` to execute (already gated)
- Lazy-load hints to the session: internal message to spawn a background fetch

## Implementation Strategy

### Phase 1: The LLM loop skeleton
- Scheduled job: cadence (default 5m), quota + budget gating, tier-1 supervision
- Read state: `GET /sessions`, `GET /topics`, `GET /projects`, `GET /pool`
- LLM prompt: "Given current pool state, open topics, and project catalog, propose 3 seamlessness improvements"
- Response schema: `[{ action, targetTopic, detail, confirmRequired }]`

### Phase 2: Action classification
- `sync-project`: Propose fetch-working-set for `<topic>` + `<project-path>`
- `move-topic`: Propose transfer of `<topic>` from current machine to `<machine-nickname>`
- `lazy-load-hint`: Suggest background fetch of `<path>` as anticipatory load for the next turn

### Phase 3: Dry-run gate
- Ships DARK behind `intelligence.seamlessOrchestratorEnabled: false`
- When enabled, ships in DRY-RUN: logs proposed actions but does NOT actuate
- Dry-run metrics: `POST /intelligence/orchestrator/tick --dry-run` returns all proposed actions

### Phase 4: Live actuation (graduated rollout)
- `confirmRequired:false` actions (e.g., preload hints) actuate automatically
- `confirmRequired:true` actions (e.g., topic move) wait for operator confirm or auto-confirm if the action is load-shedding-driven
- All actuations audited to `logs/orchestrator-actions.jsonl`

### Phase 5: Feedback loop
- Monitor whether proposed actions improved user experience (latency, session consistency)
- LLM learns: "moving topics when both machines are loaded made it worse; don't propose that again"

## Test Plan

**Tier 1 (Unit):**
- LLM response parsing: proposed actions map to valid schema
- State reading: `GET /sessions`, `GET /pool` return expected fields

**Tier 2 (Integration):**
- Orchestrator reads live server state correctly
- Dry-run mode produces audit trail
- Action actuations route to correct endpoints

**Tier 3 (E2E):**
- Enable orchestrator in dry-run on the real pair
- Confirm proposed actions are sensible (no cross-talk, no nonsense)
- Switch to live on one machine, verify actions improve measurable metrics:
  - Reduction in "file not found" cold-starts
  - Faster context switches between machines
  - More balanced load across machines

## Success Criteria

- [ ] Orchestrator loop reads all required state (sessions, topics, projects, pool)
- [ ] LLM proposes 1-3 sensible actions per tick (no spam)
- [ ] Dry-run audit trail shows sane proposals
- [ ] Live actions correctly actuate through existing funnels
- [ ] No interference with user-driven decisions (manual moves, pins, etc.)
- [ ] Metrics show measurable improvement in seamlessness

## Failure Modes

- **Thrashing:** Orchestrator keeps moving a conversation back and forth. Mitigated by: move cooldown, proposal dedup, load threshold.
- **Stale state reads:** Pool state is wrong → wrong machine targeted. Mitigated by: freshness checks on state reads.
- **LLM hallucination:** Proposes invalid machine nickname or project path. Mitigated by: strict schema validation + enumerating valid targets in the prompt.

## Autonomy Notes

The orchestrator is **transparent**, not autonomous. Every proposed action is logged + visible. The operator can inspect `/intelligence/orchestrator/audit` and veto a category of actions if needed (e.g., "don't move topics on Fridays"). It never commits the agent to anything irreversible — all proposals wait for confirm or a heuristic gate.

---

**Related specs:** slack-multi-machine-parity, intelligent-working-set-lazy-sync
