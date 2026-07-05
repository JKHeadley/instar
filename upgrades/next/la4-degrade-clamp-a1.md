---
user_announcement:
  - audience: agent-only
    maturity: stable
---

## What Changed

Closed a real fail-open in the internal LLM router's degrade path (S4 Increment A1, the standalone LA4
safety clamp). When a component's routed framework binary is missing, `IntelligenceRouter.evaluate()`
degrades to the default provider — and it did so UNCLAMPED. With a `claude-code` default and a `capable`
request, that degrade landed on Opus-via-the-Claude-CLI, which the INSTAR-Bench v3 corrected battery
proved is the one measured-banned route for a bounded/gating verdict (99.1% via a clean API vs 81.7% via
the CLI; the emergency-stop classifier missed canonical STOP commands at 73%). The already-merged S2 clamp
(`clampClaudeCliSwapModel`) only guarded the failure-swap loop; this degrade exit was left open.

A1 extends that clamp's REACH to the degrade path: for a bounded/gating call (a mapped non-`WRITE` nature,
or an explicit `attribution.gating`), a would-be Opus-on-Claude-CLI degrade is clamped to the sanctioned
Sonnet-4.6-CLI reserve — the SAME reserve S2 uses. This fires **unconditionally**, regardless of
`sessions.natureRouting` (the parent nature-routing feature ships dark on the fleet, but this fail-open
lives in the shipped code independent of it — so a feature-gated clamp would leave the real hole open).
Open-ended `WRITE` calls (where Opus-via-CLI is legitimately the best route) and unmapped, non-gating
calls are deliberately left unchanged. This is the one intentional, honest deviation from
"byte-identical on the degrade path" — strictly the safe direction (a measured-worse route to the
sanctioned reserve), and nothing else changes.

## What to Tell Your User

Nothing proactive — this is an internal safety fix with no user-facing surface. If a user ever asks why a
background safety check quietly switched which model it used when its first choice was unavailable, the
answer is: the agent used to fall back to the single worst model-and-tool combination for that kind of
check, and now it falls back to the safe, sanctioned one instead — always, even when the newer routing
feature is turned off. Nothing they do changes, and no setting is required.

## Summary of New Capabilities

- The router's degrade-to-default path now clamps a bounded/gating Opus-via-Claude-CLI landing down to the
  Sonnet-CLI reserve, closing the LA4 fail-open on the shipped code.
- The clamp is unconditional (independent of the dark nature-routing feature) and strictly narrowing —
  never an upgrade, never a block.
- Open-ended writing keeps its legitimate Opus-via-CLI quality lane; unmapped, non-gating calls and
  non-Claude default doors are untouched.
- No config, no new route, no persistent state.

## Evidence

- `tests/unit/la4-degrade-path-clamp.test.ts` — 13 cases: the `routingNatureFor` map lookup, the
  `isBoundedGatingDegrade` predicate (incl. a property test over the whole `LLM_ROUTING_NATURE` map that
  the discriminator is exactly non-`WRITE`), and the `evaluate()` integration proving the clamp fires with
  `natureRouting` unset, does not over-clamp unmapped/non-gating calls, and never clamps a non-Claude
  default door.
- Regression: `opus-claude-cli-gating-guardrail.test.ts` (14) + `intelligence-router.test.ts` (17) +
  `provider-fallback-swap-timeout.test.ts` (11) stay green; `tsc --noEmit` clean.
- Spec: `docs/specs/nature-axis-routing.md` FD4 (LA4) / FD9 (the A1/A2 increment split).
