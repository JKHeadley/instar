---
kind: project
id: openclaw-imports
title: OpenClaw → Instar imports
status: active
owner: Echo
target_repo_path: /tmp/instar-openclaw-tier1
source_docs:
  - docs/openclaw/audit-2026-05-07.md
goal: >
  Import every primitive worth keeping from OpenClaw into Instar/Echo,
  using the prioritized 80/20 build order. Avoid the "first few done,
  then forgotten" failure mode the original pass hit.
telegram_topic_id: "9003"
---

# OpenClaw → Instar imports — Project Plan

## Origin

Two rosters of candidate imports:

1. **Echo-side OpenClaw audit** (2026-05-08, OPENCLAW-IMPORTS-INDEX.md) — 13 items
2. **Echo↔Dawn compare-notes** (2026-05-09, echo-dawn-relay.jsonl) — 9 net-new items beyond Echo's audit

Combined surface: ~19 candidates. The first pass shipped only the two with full specs already drafted (TaskFlow, WikiClaim evidence). Rest sat untouched until this triage.

## Roster (combined, deduplicated)

### Done

| # | Item | Status | PRs |
|---|------|--------|-----|
| E1 | TaskFlow — durable job-record system | MERGED (Phase 3b draft, 7-day gate) | #135-#145 |
| E2 | WikiClaim evidence — receipts on memory entries | MERGED | #136-#144 |
| E3 | Six-signal promotion gate | RETIRED (moved to Dawn) | spec-only |

### Tier 1 — Ship next (small, high value)

| # | Item | Source | Effort |
|---|------|--------|--------|
| T1.1 | Pre-compaction flush | Dawn #16 ADOPT | 1-2 PRs |
| T1.2 | Cold-start grace knob | Echo audit #9 | 1 PR |
| T1.3 | FallbackSummaryError shape | Echo audit #8 | 1 PR |

### Tier 2 — Foundation (unlocks future work)

| # | Item | Source | Effort |
|---|------|--------|--------|
| T2.1 | llm-task typed primitive | Echo #4 = Dawn #06 ADOPT | 1 PR + ~5 migrations |
| T2.2 | before_prompt_build hook | Echo #5 + Dawn #22 BIDIRECTIONAL | small primitive + first consumer |

### Tier 3 — Behavior upgrades

| # | Item | Source | Effort |
|---|------|--------|--------|
| T3.1 | Session pruning | Echo audit #12 | modest |
| T3.2 | Diagnostics state machine | Echo #10 = Dawn #21 ADOPT | 2 PRs |

## Deferred / skip (with reason)

- Queue modes (Echo #6) — depends on T3.2; low msg volume
- Channel docking (Echo #7 = Dawn #08) — multi-channel use not heavy
- Sub-agent transcripts (Echo #11) — nice-to-have; no live pain
- Parallel specialist lanes (Echo #13 = Dawn #09 BI) — Echo flagged "structurally early"
- Writelock (Dawn #10 ADOPT) — likely already covered by TaskFlow OCC; verify first
- Sanitized history (Dawn #13 ADOPT+BI) — important; no live PII exposure
- Commitments (Dawn #04 ADAPT) — overlaps existing initiative tracker
- Model failover (Dawn #12 ADAPT) — larger design surface
- Delegate ladder (Dawn #14 ADAPT) — needs design
- Webhook resume (Dawn #15 ADAPT) — not in critical path

## Build order

**Round 1** — T1.1 + T1.2 + T1.3. Three small PRs, no shared deps. One autonomous session.

**Round 2** — T2.1 + top 2 llm-task migrations + T2.2 + first active-recall consumer. One focused session.

**Round 3** — T3.1 + T3.2. One focused session.

After Round 3 — re-evaluate deferred list against recent pain.

## Per-round pipeline (every item)

1. If outline only → promote to full spec
2. `/spec-converge` until `review-convergence` tag
3. `/instar-dev` build, side-effects review, second-pass adversarial review
4. Merge with CI green; no PR fragmentation
5. Project record updated; release notes appended in same PR

## Stop condition for project

All Tier 1-3 items merged on main with CI green, deferred list re-evaluated, side-finds documented. Final report to Justin.

## Known risk: forgetting the rest

The original OpenClaw pass forgot 10 of 13 items after the first two shipped. Mitigations:
- This document is the durable roster — session-start surfacing keeps it visible.
- After each round, project record auto-queues prep for the next round.
- A project-level drift check runs before each round to catch scope-creep or stale premises.
- The pre-build review for each item compares current code to spec premise — same kind of catch that retired #3.

## Status journal

- 2026-05-11 — Project created. Tier 1 awaiting greenlight from Justin pending project-scope infra discussion.
