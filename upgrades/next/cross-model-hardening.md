# Upgrade Guide — Cross-Model Convergence Hardening (Piece 3)

<!-- bump: minor -->

## What Changed

Implements Piece 3 (final piece) of `docs/specs/AUTONOMY-PRINCIPLES-ENFORCEMENT-SPEC.md`. The spec-converge skill's external (non-Claude) review pass becomes mandatory with teeth, dynamic, and safe:

- **gemini-cli joins the reviewer registry** (`src/core/crossModelReviewer.ts`) — the registry seam's first extension beyond codex: never-throws detection (binary + cached OAuth at the path the CLI actually reads), provider via the existing factory with its own circuit breaker, identical degraded semantics.
- **Family-diverse**: one external pass per AVAILABLE family (detect-all), not first-match-only.
- **Delta-gated**: a content hash of the spec's reviewable body (frontmatter-stripped) decides when externals must re-run — round 1 and any changed round; unchanged rounds record a skip-with-logged-note instead of burning external quota.
- **Durable activation baseline**: framework availability observations are recorded to `state/framework-activation-history.jsonl`; externals are non-skippable whenever a non-Claude framework was active within a 7-day lookback — deactivating a framework just before converging no longer exempts a spec.
- **Trusted-provider allowlist**: only first-party OAuth CLIs (codex-cli, gemini-cli) can receive spec text; pi-cli/custom endpoints are structurally excluded (`untrusted-framework` refusal).
- **Fail-loud model canary**: a review pass degrades loudly (`model-resolution-canary`) rather than silently running with an unresolved tier-word model.

Honest scope notes: the spec's "broken `resolveModelForFramework` foundation" was already fixed on main before this build (recorded at PR #1055); the Claude-only-agent different-family floor + tracked-gap signal are disclosed residuals (see the side-effects artifact).

## What to Tell Your User

- "When I review a spec before building, I now get a second opinion from EVERY non-Claude AI family I have access to (GPT via codex, Gemini via the gemini CLI) — automatically, on every round where the spec actually changed. I can't quietly skip it anymore: a record of which frameworks I've had active in the last week keeps the outside-opinion requirement honest."
- "Your spec text only ever goes to first-party AI providers you've logged into — never to custom or unknown endpoints."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Gemini external reviewer | Automatic in spec-converge when the gemini CLI is installed + authed |
| Family-diverse external pass | Automatic — one pass per available family per changed round |
| Delta-gated externals | Automatic — unchanged rounds log a skip note instead of re-reviewing |
| 7-day activation baseline | Automatic — recorded on every detection; read at convergence |

## Evidence

- 32 new unit tests (`crossModelReviewer-piece3.test.ts`) + 45 existing (`crossModelReviewer.test.ts`) + 3 integration (`cross-model-review-flow.test.ts`) — all green; `tsc` exit 0; full lint clean.
- Live smoke on the dev machine: detect-all reported codex-cli:gpt-5.5 AND gemini-cli:gemini-2.5-pro; `--family pi-cli` refused with `untrusted-framework`; the activation observation landed in the JSONL.
- Independent second-pass review verified the egress allowlist end-to-end and caught a real bug (a `GEMINI_HOME` env var the CLI doesn't actually honor) — fixed before ship.
