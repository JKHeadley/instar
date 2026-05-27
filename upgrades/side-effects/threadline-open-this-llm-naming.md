# Side-Effects Review — Threadline "open this" LLM topic-name + summary (CMT-567)

**Version / slug:** `threadline-open-this-llm-naming`
**Date:** `2026-05-27`
**Author:** `echo`
**Spec:** `docs/specs/THREADLINE-OPEN-THIS-LLM-NAMING-SPEC.md` (converged 2-round / 4-reviewer, approved)
**Second-pass reviewer:** `not required` (UX continuation of #399, no new external surface; standard 2-round convergence applied)

## Summary of the change

When the deterministic "open this" intercept (CMT-529 / PR #399) promotes a Threadline
conversation into its own topic, the new topic is now named by an LLM (from the conversation
gist) and its first message is an LLM-written orientation summary. A three-tier degrade
guarantees the bind never fails on LLM trouble:

- **Tier A — LLM.** Real conversation (≥2 messages) → Haiku call using the proven PURPOSE-line
  convention (reuses `parsePurposeFromResponse` from `TopicSummarizer`, NOT JSON). PURPOSE →
  topic name; body → summary. Runs on the shared `interactive` LlmQueue lane (operator is
  waiting), `costCents=2`, 3.5s race (timeout + queue-abort, since `intelligence.evaluate`
  honors `timeoutMs` but not an AbortSignal).
- **Tier B — deterministic template.** LLM skipped/failed → `💬 Conversation with <peer> · N
  messages · last activity <when>. Latest: "<scrubbed inbound>"`. Zero cost/latency.
- **Tier C — slug + legacy marker.** No backing conversation (hub-notice-only entry) → existing
  slug name + the legacy "tied to this topic" marker. No LLM call attempted.

Files touched:
- `src/threadline/openConversationBrief.ts` (**add**) — the 3-tier generator. Pure compute; never throws; never returns empty.
- `src/threadline/hubCommands.ts` (modify) — `HubBindDeps.brief?: BriefDeps` (optional); `open` branch calls `generateConversationBrief`, posts `brief.summary` as the first message, adds the `[hub/bind] open …` observability log line. `tie` branch unchanged (still posts the tie-marker; brief NOT invoked).
- `src/commands/server.ts` (modify) — build ONE `briefDeps` after `collaborationSurfacer`; thread to both `getHubDeps` closures + the `AgentServer` ctor.
- `src/server/AgentServer.ts` (modify) — `briefDeps?` on options interface; `briefDeps: options.briefDeps ?? null` into routeCtx.
- `src/server/routes.ts` (modify) — `briefDeps` on `RouteContext`; `POST /threadline/hub/bind` passes `brief: ctx.briefDeps ?? undefined`.
- `tests/unit/threadline/openConversationBrief.test.ts` (**add**) — 19 cases.
- `tests/unit/hubCommands.test.ts` (modify) — +4 brief-path cases (LLM / template / Tier-C / tie-not-invoked).
- `tests/integration/threadline/hub-bind-routes.test.ts` (modify) — +3 cases (LLM happy path; LLM-throws → bind still 200 + template; intelligence:null → bind still 200).
- `upgrades/NEXT.md` (modify) — release note.

## Decision-point inventory

- `generateConversationBrief()` — **add** — three tiers; per-FIELD scrub-degrade (a credential in the PURPOSE degrades only the name, a credential in the body degrades only the summary). Never throws.
- Credential detection — **new, intentionally different from hubCommands.CREDENTIAL_RE.** `SECRET_VALUE_RE` (vendor-prefixed tokens / key blocks / JWT-ish) is applied to LLM output; `SECRET_ASSIGN_RE` (`password|secret|token|api_key… : value`) additionally guards the RAW inbound snippet. The bare-english-word regex used by the existing slug path would false-positive on normal technical prose ("token refresh", "API key rotation") and degrade most real summaries — so it is deliberately NOT reused for the prose summary. The existing slug-path `CREDENTIAL_RE` in `hubCommands.ts` is untouched.
- LlmQueue lane = `interactive` — operator is actively waiting; `background` would let a PresenceProxy arrival abort the in-flight brief (LlmQueue preempts only background victims).
- `HubBindDeps.brief` is OPTIONAL — when absent (existing callers / tests that don't wire it), the `open` path degrades to slug + legacy marker (exact pre-CMT-567 behavior). No back-compat break.
- `BriefDeps.topicNameFallback` is OPTIONAL — server-built `briefDeps` omits it (topicNameFor is private to hubCommands); `bindHubConversation` injects the real `topicNameFor` so the brief's slug matches the legacy path. A built-in `defaultSlug` guards direct callers.
- Single shared `briefDeps` (built once in server.ts) — closes the round-2 finding that the `POST /threadline/hub/bind` route had no scope path to `sharedLlmQueue`. One construction, three consumers (2 closures + ctx).
- Observability — one structured `console.log` per open: `nameSource / summarySource / latencyMs / reason`. Makes silent fallback diagnosable from `logs/server.log`.

## Blast radius / reversibility

- **Additive only.** `tie` path, the deterministic intercept itself, the parent-topic reply surfacing, and all other Threadline routing are untouched.
- **No state files, no migrations.** Pure compute module; no persisted artifacts; `PostUpdateMigrator` needs no entry (verified — no agent-installed file changes).
- **No new agent API.** The agent doesn't call this; it fires inside the operator-invoked "open this". No CLAUDE.md template change needed (Agent Awareness Standard N/A).
- **Rollback:** single revert of the commit restores slug-name + legacy-marker verbatim.

## Tests

- Unit (new module): 19 cases — all three tiers, every fallback cause, per-field credential scrub, technical-vocab-not-scrubbed, input truncation, never-empty invariant (incl. empty/whitespace threadId).
- Unit (hubCommands): +4 — LLM summary posted (not marker), LLM-throws → template, Tier-C marker, tie does not invoke brief.
- Integration (hub/bind route): +3 — LLM happy path names+summarizes; LLM-throws → 200 + template (regression guard: LLM failure NEVER fails the bind); intelligence:null → 200.
- Full threadline suite: 1580 passing, zero regressions. Production build clean (`tsc --noEmit` + `pnpm build`).

## Test-as-self (live, real LLM — completed 2026-05-27)

Two-stage, real-dependency validation (no mocks):

1. **Real-LLM harness (Echo's Claude provider, real threadline data).** Ran the BUILT `generateConversationBrief` against two real Echo threads with a real `ClaudeCliIntelligenceProvider`, real `LlmQueue`, real `ThreadlineObservability`. Produced clean LLM names + summaries (`reason: ok`). **This caught a production-breaking bug the mocks hid:** a real CLI call took ~8-10s, over the original 3.5s timeout — so the happy path would have silently fallen to the template in production. Fixed: default timeout 3.5s → 15s (+ word-boundary cap on the name so a long title doesn't read "…path resol"). Re-ran with the production default: `nameSource=llm`, ~9.7s, clean name "Arm the full response-review stack".

2. **Live deploy on a real peer agent (instar-codey, Codex/gpt-5.2).** Backed up Codey's shadow-install dist + hub state, deployed this build, restarted via launchd, drove a real `POST /threadline/hub/bind action:open` against a 4-message unbound hub conversation. Result: topic 680 created, `topicName="Mentor ledger dedup strategy"` (LLM, not slug), server log `[hub/bind] open threadId=f3d471e9 topic=680 nameSource=llm summarySource=llm` — proving briefDeps booted non-null and the real Codex LLM produced both fields through the live server. Cleaned up: deleted test topic 680 (Bot API), restored dist + hub state, restarted Codey onto the released build, verified f3d471e9 reverted to unbound.

## Post-test-as-self deviations (folded into this commit)

- Default `timeoutMs` 3.5s → **15s** (spec §3a updated with the measured rationale). The LLM tier is now the common outcome; template covers overruns.
- `scrubName` caps on a **word boundary** (no mid-word truncation in the chat-list title).
