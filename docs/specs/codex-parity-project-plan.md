---
kind: project
id: codex-full-parity
title: Codex ↔ Claude Full Parity
status: active
owner: echo
target_repo_path: /Users/justin/.instar/agents/echo/.worktrees/codex-enforcement-hooks
source_docs:
  - docs/specs/codex-parity-ledger.md
  - docs/specs/codex-parity-followups.md
  - docs/specs/codex-enforcement-hook-layer.md
goal: Reach full feature + UX parity between the Codex and Claude Code engines in Instar, with every Codex-applicable capability proven in the wild via test-as-self on codey. Claude-only capabilities are explicitly marked N/A with reason. The durable scoreboard is docs/specs/codex-parity-ledger.md.
---

# Codex ↔ Claude Full Parity — Project Plan

Bundles the parity work into ordered rounds. Each round drives ledger entries
from gap/works-unproven to proven-via-test-as-self. One master-spec approval
from Justin gates the code-shipping rounds (the instar-dev gate requires it).

### Tier 0 — Foundation (proving infrastructure)

| # | Item | Source | Effort |
|---|------|--------|--------|
| 0 | Get codey's real codex-cli ≥0.133 healthy, on current instar, server un-degraded | docs/specs/codex-parity-ledger.md | M |
| 1 | Confirm echo + codey both run latest instar; fix patch-no-auto-restart drift | docs/specs/codex-parity-followups.md | S |

### Tier 1 — Enforcement-hook proof (test-as-self)

| # | Item | Source | Effort |
|---|------|--------|--------|
| 2 | Drive codey live to prove each wired gate fires (external-op, grounding, response-review, deferral, scope-coherence, session-start, telegram-context) | docs/specs/codex-parity-ledger.md | L |
| 3 | Confirm PermissionRequest fires-or-suppresses under bypass; resolve P4 | docs/specs/codex-enforcement-hook-layer.md | M |

### Tier 2 — Claude-hook ports to Codex

| # | Item | Source | Effort |
|---|------|--------|--------|
| 4 | Port slopcheck-guard onto Codex PreToolUse | docs/specs/codex-parity-followups.md | M |
| 5 | Port claim-intercept-response onto Codex Stop | docs/specs/codex-parity-followups.md | M |
| 6 | Port external-communication-guard onto Codex (after applicability check) | docs/specs/codex-parity-followups.md | M |

### Tier 3 — Compaction-recovery redesign

| # | Item | Source | Effort |
|---|------|--------|--------|
| 7 | Design + ship Codex compaction-recovery (PostCompact can't inject; UserPromptSubmit-ride or systemMessage path) | docs/specs/codex-parity-followups.md | L |

### Tier 4 — Messaging / UX parity

| # | Item | Source | Effort |
|---|------|--------|--------|
| 8 | Verify Telegram reply relay from Codex sessions matches Claude | docs/specs/codex-parity-ledger.md | M |
| 9 | Codex-specific enforcement awareness note in AGENTS.md briefing | docs/specs/codex-enforcement-hook-layer.md | S |

### Tier 5 — Full-surface audit

| # | Item | Source | Effort |
|---|------|--------|--------|
| 10 | Classify every remaining instar capability (scheduler, sentinels, token-ledger, views/tunnel/dashboard, secret-drop, playbook, coherence gate, backup/sync, feedback, evolution) as proven/works/gap/NA on Codex | docs/specs/codex-parity-ledger.md | L |
