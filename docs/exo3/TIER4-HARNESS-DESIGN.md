# Tier-4 "Test-as-Self" Harness — Design (EXO 3.0 build, shared infra)

> **⚠ SUPERSEDED IN PART (2026-06-05, topic 19437):** the "two distinct Telegram identities / second bot token" architecture below was corrected by the operator on 2026-06-05T04:36Z — test-as-self rides the **single shared Playwright profile already logged into the operator's real Telegram account**: the driver posts as the USER through web.telegram.org (no bot identity at all), so the subject's lifeline sees genuine inbound user messages. Proven live end-to-end the same morning (driver took the shared seat, drove a real agent conversation, observed queue-across-restart-replay from the user's chair). The "second bot token" dependency is VOID. The reconciled design ships with the harness build. Original text preserved below for the record. (Attribution resolved 2026-06-06: the mandate is the operator's (Justin) — the original "Caroline" credit was an identity-bleed artifact, scrubbed per Know Your Principal.)

**Mandate (the operator, Justin):** every EXO 3.0 feature must pass a Tier-4 verification where **one agent drives another over Telegram** — one Echo plays the USER, the other is the TEST subject — and the test agent must *actually perform the behavior conversationally* (not just return 200 from an endpoint). A feature is NOT done on green unit/integration/e2e alone.

## Why this is more than Tier-3
Tiers 1–3 prove the *code* works (logic, the HTTP route, the route alive on a real server). Tier-4 proves the *agent behavior* works: given a natural-language request, does the running agent actually reach for the capability and do the right thing through its normal conversational path? That's the only tier that catches "the endpoint works but the agent never thinks to use it."

## The hard architectural fact (discovered 2026-06-04)
An agent's lifeline polls Telegram `getUpdates` for messages from **other** identities. A message the agent's *own* bot posts is not inbound user input. So a genuine "agent-drives-agent over Telegram" test requires **two distinct Telegram identities**:
- **Driver agent** (plays the user) — needs its OWN bot token / account, and posts into the **subject agent's** chat as an external party.
- **Subject agent** (the test-as-self instance) — a throwaway Echo deployed from the current dist (so it has the feature under test), with its own bot + chat, whose lifeline sees the driver's messages as real inbound.

This is why it's *two agents*, not one agent talking to itself.

## Components to build
1. **Subject provisioner** (`test-as-self` core): deploy the current `dist` into a throwaway agent home (`~/.instar/agents/echo-tier4-<slug>/`), with its own config (own bot token, own chat/topic), seed any fixtures the test needs (e.g. an ORG-INTENT.md), boot its server + lifeline, verify health.
2. **Driver**: an LLM-driven "user" (a Claude session or the Agent tool) given a goal ("get the subject to evaluate wiring $40k to a vendor whose bank details changed"), which posts messages into the subject's chat via the **driver's** bot and reads the subject's replies.
3. **Behavioral assertion**: parse the subject's actual replies + its session transcript (`.instar/logs/`, the JSONL transcript) to confirm it (a) reached for the right capability (e.g. consulted `/intent/org/test-action`) and (b) produced the right outcome (refused the wire). Assertion is on *behavior + outcome*, not a status code.
4. **Teardown**: kill the subject's server/lifeline, remove the throwaway home, release the bot/topic.

## Real dependencies / sequencing (NOT defers — documented blockers)
- **Second Telegram identity.** A driver bot token (or a second account) is required and must be provisioned. Candidate: reuse one of the existing throwaway/mmtest agent identities on this machine, or have the operator drop a second bot token via Secret Drop. **This needs a real credential we don't yet have wired** — surface to the operator before the first live Tier-4 run.
- **Feature must be deployed.** A gap's Tier-4 runs against the *deployed* feature. G1's `/intent/org/test-action` ships with PR #785 — so G1's Tier-4 is sequenced **after** #785 merges and the subject's dist includes it. (The subject deploys from the dist built off the merged branch, or off the gap's branch directly.)

## Pragmatic first cut (buildable now, against the gap branch's dist)
Provision the subject from the **gap branch's built dist** (not waiting for main-merge), drive it with a single scripted user turn, assert on the transcript. This gives a real Tier-4 per gap without waiting on the merge train. The second-identity credential is the one true external dependency.

## Status
Design locked. Build order: (1) subject provisioner on the gap dist, (2) resolve the driver identity (operator credential), (3) driver + behavioral assertion, (4) run G1's Tier-4. Tracked under CMT-693 + the autonomous task list.
