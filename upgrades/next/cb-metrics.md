<!-- bump: patch -->
## What Changed

The context budget gets its measurement backend (context-budget-layered-summaries §11; Phase 1 S13), and the token ledger stops missing most sessions.

- **The token ledger now reads every login's transcripts.** It used to scan only `~/.claude/projects`. A session routed to a subscription-pool login keeps its transcript under that login's config home (`~/.claude-followme-<account>/projects`), so on a pooled agent the ledger missed nearly every session (feedback fb-7e0b2088-ae5). It now scans the process default home, every `~/.claude*` home on the machine, and every claude-code account in the subscription pool, re-read on each scan. A session copied into two homes counts once. The scan stays read-only, bounded per tick and incremental.
- **New ledger records (additive).** The 1-hour share of each request's cache writes; a hash of each Read path and Bash command (never the text); which operator Telegram prompts reached which session; and compaction boundaries. They age out with the ledger's retention.
- **`GET /context-budget/metrics`** (optional `?topic=`, `?sinceHours=`; 503 while `contextBudget.enabled` is off) reports, per session and per topic:
  - cost-weighted tokens per request, with the Phase 0 weights (cache read 0.1, 1-hour write 2.0, 5-minute write 1.25, output 5.0);
  - live context size over time;
  - rework: files re-read and commands re-run within 30 turns, shown as `pending` while the ledger is behind on that session;
  - the share of operator messages still verbatim in the session's context;
  - U size, archive bytes and layer bytes;
  - layer-update spend against its reserve;
  - extractor calls and provider-reported tokens per day, split by message turn and transcript tick;
  - G/C record growth, the input for sizing the live-set budget.
  Anchor stability reads `unavailable: anchor-ledger-not-built` until Anchors exist.
- **`LayerUpdate` on `/metrics/features`.** Every layer-update attempt is now a row there (fired, no-op, shed or error). The tokens stay on the extractor's own rows, so nothing is counted twice.

## What to Tell Your User

My token accounting was blind to most of my conversations on machines where I switch between subscription logins. It now sees all of them. On development agents I also measure what each conversation costs per turn, how much work gets redone, and how much of what you wrote is still word-for-word in my working memory. That is the evidence for whether the coming context savings actually work.

## Summary of New Capabilities

- The token ledger covers every Claude login's transcripts on the machine.
- `GET /context-budget/metrics`: cost-weighted tokens, context size, rework, verbatim share, U size, layer spend and growth.
- `LayerUpdate` rows on `/metrics/features`.

## Evidence

- Unit: `tests/unit/context-budget-metrics.test.ts`.
- Integration: `tests/integration/context-budget-metrics-route.test.ts` (real ledger over two config homes, the real route behind auth).
- E2E: `tests/e2e/context-budget-metrics-alive.test.ts`.
