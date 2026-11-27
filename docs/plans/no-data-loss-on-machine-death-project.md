---
kind: project
id: no-data-loss-on-machine-death
title: "No critical data or work is lost when a machine dies"
status: active
owner: echo
target_repo_path: /Users/dabombstudio/.instar/agents/echo
source_docs:
  - docs/specs/no-data-loss-on-machine-death.md
  - docs/specs/no-data-loss-on-machine-death.eli16.md
goal: "After any one machine of a multi-machine agent is destroyed without warning, every commit, branch, agent file and critical setting is recoverable from the surviving machines with no human memory required, the agent knows whether that is true before a loss, and a monthly wipe-and-rebuild drill proves it. Covers post-mortem issues B1-B12, A5, C1 and fix-table items 6, 7, 8, 9, 10, 11, 16, 19 of the 19-20 November 2026 Mac Studio outage (owner approval: Justin, topic 145840, message 145918)."
auto_advance: true
---

# No critical data or work is lost when a machine dies

Spec: `docs/specs/no-data-loss-on-machine-death.md`. Each row is one build increment from the
spec's "Build increments (ordered)" section, in build order.

### Tier 1 — Stop the bleeding: code has a home

| # | Item | Source | Effort |
|---|------|--------|--------|
| 1 | Repository registry, read-only, plus the disk-post delivery fix | spec §1.1-1.3, §1.7, §6.2 | m |
| 2 | Homing: pool mirrors, credential check, private remotes, backup refs | spec §1.5 | l |

### Tier 2 — Critical state and records survive their machine

| # | Item | Source | Effort |
|---|------|--------|--------|
| 3 | Census correction and the critical list, read-only check | spec §2.1-2.3 | m |
| 4 | Agent-setting and job-run records, authority rules, singleton guard | spec §2.4-2.5 | l |
| 5 | Key-history carriage and bounded unknown re-checks | spec §3.1 | m |
| 6 | Author seals, relaying, retirement checkpoints, attested legacy segments | spec §3.2-3.5 | l |

### Tier 3 — Off-machine copy and visibility

| # | Item | Source | Effort |
|---|------|--------|--------|
| 7 | Folder backup with envelope keys and weekly restore test; retire interim rsync | spec §4 | l |
| 8 | Lives-only-here report, Data safety card, rebuild runbooks | spec §5 | m |

### Tier 4 — Disk, sign-ins, and the proof

| # | Item | Source | Effort |
|---|------|--------|--------|
| 9 | Work-copy budget, reaper pressure mode, upgrade guard | spec §6.1, §6.3 | m |
| 10 | Browser coverage and per-machine sign-in | spec §7 | m |
| 11 | The monthly wipe-and-rebuild drill | spec §9 | l |
