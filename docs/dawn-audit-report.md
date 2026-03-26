# Dawn-to-Instar Audit Report

**Date**: 2026-03-26 (Updated)
**Previous Audit**: 2026-02-18 (v0.1.6, scored 25%)
**Current Version**: v0.24.4
**Purpose**: Map Dawn's battle-tested infrastructure against Instar's current state. Identify remaining gaps and cross-pollination opportunities.

---

## Executive Summary

Instar has undergone dramatic maturation since the February audit. What was a 25% skeleton is now a **production-ready autonomous agent framework at ~83% coverage** of Dawn's proven patterns. The remaining gaps are growth edges, not blockers — Instar is independently evolving patterns that Dawn hasn't implemented (CoherenceGate, Confidence Inversion gravity well, Contradiction Means Investigation).

**Key shift**: This is no longer a one-way "Dawn teaches Instar" relationship. Cross-pollination flows both directions.

---

## Coverage by Area

| # | Area | Feb Score | Mar Score | Status |
|---|------|-----------|-----------|--------|
| 1 | Job Scheduling | 30% | 85% | Quota suite, claim manager, job reflector |
| 2 | Session Management | 25% | 88% | Reaper, sleep/wake, lifecycle hooks, input guard |
| 3 | Identity & Grounding | 20% | 82% | SoulManager, knowledge tree, integrity checks |
| 4 | Hook System | 15% | 92% | 14 hooks shipped with `instar init` |
| 5 | Reflection & Learning | 10% | 87% | ReflectionConsolidator, JobReflector, PatternAnalyzer |
| 6 | Telegram Integration | 60% | 78% | Voice transcription, input guard, job-topic coupling |
| 7 | Multi-Session Awareness | 15% | 72% | Activity registry, session sentinel, work ledger |
| 8 | Quota & Resource | 5% | 91% | QuotaManager, multi-account, exhaustion detection |
| 9 | Skills System | 5% | 68% | AutonomySkill, capability mapper, MCP interop |
| 10 | Safety & Security | 40% | 89% | PEL, secret redaction, audit trail, manifest integrity |
| 11 | Monitoring & Health | 20% | 85% | Watchdog, stall triage, memory pressure, sleep/wake |
| 12 | Self-Evolution | 5% | 84% | EvolutionManager, proposals, adaptive autonomy |
| | **Aggregate** | **~25%** | **~83%** | **Production-ready with growth edges** |

---

## What Changed (Feb 18 -> Mar 26)

843 commits transformed Instar from a persistent CLI into a genuinely autonomous agent framework:

- **QuotaManager suite** — Event-driven tracking, multi-account support, exhaustion detection, threshold gating
- **SoulManager** — Trust-enforced self-authoring with sections (core-values, growth-edge, convictions, open-questions)
- **EvolutionManager** — Proposal queue with status tracking, autonomous implementation when in autonomous mode
- **CoherenceGate** — 3-layer response review (PEL deterministic blocks, gate triage, 10 specialist LLM reviewers)
- **14 hooks** shipped with `instar init` — from dangerous command guard to scope coherence tracking
- **ReflectionConsolidator + JobReflector** — LLM-powered per-job analysis and weekly consolidation
- **PatternAnalyzer** — Detects execution patterns, deviations, anomalies
- **Knowledge tree** — TreeGenerator, TreeTraversal, TreeSynthesis for semantic self-knowledge
- **PolicyEnforcementLayer** — Deterministic hard blocks independent of LLM judgment
- **SecretRedactor + AuditTrail** — Comprehensive security posture
- **8 gravity wells** (including 2 Dawn doesn't have: Confidence Inversion, Contradiction Means Investigation)

---

## Remaining Growth Edges

### 1. Multi-Session Awareness (72%) — Biggest Gap

Activity is scattered across PlatformActivityRegistry, SessionActivitySentinel, and WorkLedger. Dawn's unified JSONL activity feed with cross-session event coordination is more cohesive. Consolidating into a single event-driven feed would improve multi-session coordination.

### 2. Skills System (68%) — Framework Needs Formalization

AutonomySkill and CapabilityMapper provide infrastructure, but user-created skill persistence, versioning, and the skill evolution loop (skills that improve themselves) are underdeveloped. Dawn's 80+ skills demonstrate the value of composable markdown-based workflows.

### 3. Session-End Maintenance (NEW)

Dawn runs lightweight housekeeping at every session boundary (retire stale data, refresh one metric). This distributes maintenance load rather than concentrating it in periodic maintenance jobs. See `PROP-session-maintenance.md`.

### 4. Meta-Reflection

Reflection on reflection patterns — evaluating WHETHER and WHAT KIND of reflection is needed — is not explicit in Instar. Dawn's `/meta-reflect` skill routes to appropriate reflection depth.

### 5. Cross-Machine Coordination

JobClaimManager provides basic deduplication, but Dawn's multi-machine routing (topic-to-machine mapping, dual-polling mode, remote URLs) is more sophisticated. Lower priority unless Instar agents deploy across multiple machines.

---

## Cross-Pollination: Instar -> Dawn

These patterns originated in Instar and have been ported back to Dawn:

| Pattern | Description | Dawn Integration |
|---------|-------------|------------------|
| Confidence Inversion | High confidence should trigger MORE verification, not less | Added to CLAUDE.md gravity wells (2026-03-26) |
| Contradiction Means Investigation | When human says X and data says not-X, try a DIFFERENT check | Added to CLAUDE.md gravity wells (2026-03-26) |
| CoherenceGate | 10 specialist LLM reviewers checking response quality | Not yet — Dawn uses hook-based enforcement |
| PolicyEnforcementLayer | Deterministic blocks independent of LLM judgment | Dawn uses hook scripts for this |
| Adaptive Autonomy Profile | cautious -> autonomous spectrum with trust elevation | Dawn uses static autonomy settings |

---

## Instar's Unique Strengths

Areas where Instar has surpassed Dawn's implementation:

1. **CoherenceGate architecture** — 3-layer review (deterministic PEL -> LLM gate triage -> specialist reviewers) is more sophisticated than Dawn's hook-based enforcement. Dawn stops bad actions; Instar reviews response quality.

2. **Security posture** — SecretRedactor, ManifestIntegrity, SecretStore, and AuditTrail form a more cohesive security layer than Dawn's individual hook scripts.

3. **Stall triage** — StallTriageNurse with graduated response (prompt -> key press -> escalation) is more nuanced than Dawn's binary session reaping.

4. **Gravity well diversity** — 8 wells including 2 Dawn doesn't have, embedded in scaffold templates for all agents.

---

## Conclusion

The relationship between Dawn and Instar has matured from teacher-student to peers with different strengths. Dawn excels at engagement infrastructure (80+ skills, multi-platform presence, atomic action gates) and self-knowledge depth (grounding tree, soul authoring, 220+ lessons). Instar excels at response quality assurance (CoherenceGate), security posture (PEL + secret management), and intervention sophistication (stall triage).

The highest-value remaining work is:
1. **Consolidate multi-session awareness** in Instar (72% -> 85%+)
2. **Formalize skills extensibility** in Instar (68% -> 80%+)
3. **Port CoherenceGate concepts** to Dawn (response review vs just action gating)
4. **Implement session-end maintenance** in Instar (see PROP)

Future audits should focus on behavioral testing — not just "does the feature exist" but "does it work correctly under real conditions."
