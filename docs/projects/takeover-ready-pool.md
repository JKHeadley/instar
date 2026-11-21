---
kind: project
id: takeover-ready-pool
title: "Takeover-ready pool: losing any machine never silences a multi-machine agent"
status: active
owner: echo
target_repo_path: /Users/dabombstudio/.instar/agents/echo
source_docs:
  - docs/specs/takeover-ready-pool.md
  - docs/specs/takeover-ready-pool.eli16.md
goal: "An Instar agent on more than one machine never becomes unreachable because one machine went down. Built from the owner-approved post-mortem of the 19-20 November 2026 Mac Studio outage (fix items 1-4, 14, 15, 17, 18; issues A1, A2, A4, A6, A7, A8, A9, A10). Done when the weekly pull-the-plug drill passes four weeks running on Echo and Luna, and on each a real owner message has been answered with tools by a survivor within five minutes of losing the lead."
auto_advance: false
telegram_topic_id: "145840"
---

# Takeover-ready pool

The converged design is `docs/specs/takeover-ready-pool.md` (six review rounds, GPT-6.2 Astra external review every
round). Each increment is built through `/instar-dev` against that spec. Increment 1 is standalone and goes first.
The project belongs to the post-mortem effort tracked by the Chief of Staff (conversation 145840).

### Tier 1: Stop the lead bouncing and the holder going quiet

| # | Item | Source | Effort |
| - | ---- | ------ | ------ |
| 1 | Boot claim safety: a restarted machine asks peers before claiming; defers while the preferred machine answers; retires the Laptop/Mini hotpatch (fix id boot-claim-safety) | spec R1 | medium |
| 2 | Hold and poll safety: holder keeps the lease through a peer outage; Telegram 409 tie-break by member ranking; lifeline never strands an owner message | spec R2 | large |

### Tier 2: Any eligible machine can take over and answer

| # | Item | Source | Effort |
| - | ---- | ------ | ------ |
| 3 | Takeover eligibility separate from Telegram polling; pool invariant of two eligible-and-ready machines on the Needs-you list | spec R3 | large |
| 4 | Record signing, readiness gate and takeover kit (owner, owner group, working model, conversation settings) | spec R4 | large |
| 5 | Role changes without a server restart; takeover wait fitted to the five-minute bound; churn guard live | spec R5 | large |
| 6 | A session's reply leaves through whichever machine can send (changes to the forward-to-holder ladder) | spec R8 | medium |
| 7 | One plain owner notice on failover, return, can't-reply and no-takeover-possible | spec R10 | medium |

### Tier 3: Rebuilt machines and stranded conversations

| # | Item | Source | Effort |
| - | ---- | ------ | ------ |
| 8 | Conversations owned by a revoked, replaced or absent machine move to a live one (after fix/unroutable-owner-release merges) | spec R7 | medium |
| 9 | Rebuilt machine replaces its old identity on every member with the owner's tap; split-pool detection by membership digest | spec R6 | large |

### Tier 4: Prove it every week

| # | Item | Source | Effort |
| - | ---- | ------ | ------ |
| 10 | The weekly pull-the-plug drill, automated, as the acceptance test for every requirement | spec R9 | large |

## Depends on

- `fix/unroutable-owner-release` (revoked and unregistered-and-silent owners), consumed by item 8.
- `echo/no-data-loss-on-machine-death` (fix items 6-13: critical-state registry, rebuild command, local-patch register).
- PR #3521 (role restart withdrawal), the fallback path for item 5.
