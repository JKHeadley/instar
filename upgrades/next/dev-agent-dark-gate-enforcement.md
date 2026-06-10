# Upgrade Guide — Dev-Agent Dark-Gate Enforcement

<!-- bump: minor -->
<!-- Valid values: patch, minor, major -->

## What Changed

Closes the hole that let the cartographer features ship dark for **everyone** — including the development agents meant to dogfood them — and makes the dev-agent dark-gate convention structurally enforceable.

- **Cartographer dogfoods on dev agents.** `cartographer.enabled` and `cartographer.conformanceAudit.enabled` now resolve through the existing `resolveDevAgentGate` (omit `enabled` in defaults → live on `developmentAgent:true`, dark on the fleet). The conformance route's strict `!== true` gate is converted to the resolver so it no longer 503s on a dev agent. A one-shot, dev-agent-only migration strips the default-shaped `false` on existing dev agents so they light up on update (never the cost-bearing sweep).
- **The freshness sweep stays an explicit opt-in** (`cartographer.freshnessSweep.enabled: true`) even on dev agents — it is the one ongoing-cost surface (off-Claude codex calls). The redundant `egressAcknowledged` second gate is removed (the privacy framing was incoherent — source already egresses to a model every turn); the off-Claude routing probe is unchanged (cost guard, not privacy).
- **Lint assertion C** (`scripts/lint-dev-agent-dark-gate.js`): every `enabled: false` default in `ConfigDefaults.ts` must now be DECLARED — either dev-gated (omit + register in `DEV_GATED_FEATURES`) or listed in the new `DARK_GATE_EXCLUSIONS` registry with a closed-enum `category` and a ≥12-char `reason`. A brace-in-string loud-fail guard, a hand-authored golden-path drift canary, and a required `justification` on every dev-gated entry back it up. All 21 existing dark defaults are classified, so the exact way cartographer slipped through cannot recur silently.

🧪 **Mostly internal.** On the fleet nothing changes (cartographer stays dark). On a development agent, cartographer's zero-cost read surfaces (map, navigation, conformance audit) now run live. The `egressAcknowledged` field is retained for back-compat but is now inert on the sweep (which still needs explicit `enabled:true`).

## What to Tell Your User

- "Cartographer's read-only surfaces (the codebase map, navigation, and the standards audit) now run live on me as a development agent so they actually get dogfooded — they stay off for everyone else until you flip them on. The one part that spends money (the summary sweep) still needs an explicit one-line opt-in even on me."
- "I also closed a gap that let those features ship off-for-everyone by accident: every 'off by default' feature now has to declare itself, or the build fails."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Cartographer live on dev agents | Automatic on `developmentAgent:true` (read surfaces); existing dev agents lit up by a one-shot migration on update |
| Freshness sweep opt-in | `cartographer.freshnessSweep.enabled: true` (explicit, even on dev agents — ongoing off-Claude spend) |
| Dark-gate enforcement lint | `node scripts/lint-dev-agent-dark-gate.js` (in `npm run lint`) — fails on any unclassified `enabled:false` default |
| `DARK_GATE_EXCLUSIONS` registry | Declare a deliberately-off-for-everyone feature with `{configPath, category, reason}` in `src/core/devGatedFeatures.ts` |

## Evidence

- Unit (42): `devGatedFeatures` both-sides wiring auto-covers the two new entries (live-on-dev / dark-on-fleet); lint assertion-C cases (unclassified FAILS, excluded PASSES, registered-but-hardcoded FAILS, junk/short reason + unknown category FAIL); hand-authored golden-path drift canary; brace-in-string loud-fail fixture; destructive-not-gated guard (mcpProcessReaper stays excluded); one-shot dev-agent-only migration.
- Integration (6): `GET /conformance/coverage` returns 200 under a `developmentAgent:true` config and 503 under a fleet config (the route-gate fix).
- E2E (3): production init path — cartographer read routes live on a dev agent (200, not 503), 503 on the fleet, and the cost-bearing sweep poller is NOT started without explicit `freshnessSweep.enabled:true`.
- `npx tsc --noEmit` exit 0; full `npm run lint` chain clean. Spec converged 3 rounds + approved (see `upgrades/side-effects/dev-agent-dark-gate-enforcement.md` and `docs/specs/reports/dev-agent-dark-gate-enforcement-convergence.md`).
