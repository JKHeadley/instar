# Upgrade Guide — NEXT (Never a False Blocker + landing A Wall Is a Hypothesis)

<!-- bump: minor -->
<!-- minor = new capability (two new outbound-authority guard rules) -->

## What Changed

**Two sibling guard rules in the outbound-message authority (`MessagingToneGate`), closing a pair of "surrender" gravity wells.**

1. **B16_UNVERIFIED_WALL — "A Wall Is a Hypothesis"** (landing approved-but-stranded work). Blocks an outbound message that declares a path impossible/infeasible because an interface/API/mechanism is missing, when the agent showed no inventory of its own capabilities first. This was built and approved earlier (topic 12143) but never committed; it ships here as the base for its sibling.

2. **B17_FALSE_BLOCKER — "Never a False Blocker"** (new, topic 12896). Holds an outbound message that defers a *doable* task to a person — "needs a human / I can't / blocked pending you / I'd want a second opinion / this needs reverse-engineering" — when the message names no genuinely-human-only item and shows no inventory of the agent's own means (computer use, terminal, send-keys, MCP). Where B16 surrenders on *feasibility* ("no mechanism exists"), B17 surrenders on *agency* ("a person is required"). The fused straddle ("there's no API, so a human must") is evaluated under B17 so it can't slip between the two rules. Severity favors false-negatives — genuine escalations (a password only you hold, a CAPTCHA, legal/billing authorization, a required approval, an account only you can grant, a real value judgment, a self-fetched cross-model review) all pass.

The `deferral-detector` PreToolUse hook is extended (signal-only — it primes a checklist, never blocks) to recognize the new excuse-shapes, with self-fetched cross-model review suppressed so legitimate "let me ask GPT" messages aren't flagged.

Both rules are always-evaluated inside the single outbound authority (no new detector with block power, no new endpoint). The rule ships with the server; the detector reaches existing agents via the always-overwrite built-in-hook migration path.

Specs: `docs/specs/never-a-false-blocker-standard.md` (+ `.eli16.md`), `docs/specs/wall-is-a-hypothesis-standard.md`.
Constitution: `docs/STANDARDS-REGISTRY.md` (The Substrate), `docs/INSTAR-DESIGN-PRINCIPLES-AND-LESSONS.md` (P11, P12).
Side-effects reviews: `upgrades/side-effects/never-a-false-blocker-standard.md`, `upgrades/side-effects/wall-is-a-hypothesis-standard.md`.

## What to Tell Your User

Your agent will stop quietly handing work back to you that it could just do itself. If it ever says "this needs a human" or "I'd want a second opinion first" when it actually has the tools to do the thing, that message gets held and the agent is nudged to try its own means first. The genuinely-yours things — a password only you know, a CAPTCHA, anything about money or legal sign-off, a real decision that's yours — still come straight to you, exactly as before.

## Summary of New Capabilities

- **B17_FALSE_BLOCKER** outbound guard (the "Never a False Blocker" standard).
- **B16_UNVERIFIED_WALL** outbound guard (the "A Wall Is a Hypothesis" standard) — first time it lands on main.

## Evidence

- Unit: `messaging-tone-gate-b17.test.ts` (13), `messaging-tone-gate-b16.test.ts` (9); integration: `telegram-reply-b17-false-blocker.test.ts` (2), `telegram-reply-b16-wall.test.ts` (2). Smoke suite (62 files / 2371 tests) green; tsc clean.
- **Real-LLM test-as-self** (real `ClaudeCliIntelligenceProvider` → Haiku): the founding codex-trust false blocker and the fused straddle both BLOCK with B17; password escalation, value judgment, required approval, self-fetched second opinion, and post-inventory deferral all PASS. The founding case initially passed; the prompt was tightened (UI-interaction clarification + worked example) until it reliably blocks — a gap only the live-LLM pass surfaced.
