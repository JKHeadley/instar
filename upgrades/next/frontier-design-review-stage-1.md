<!-- bump: patch -->
## What Changed

Stage 1 of the frontier design and review standard (`docs/specs/frontier-design-review-standard.md`, approved 2026-11-17).

- The model registry names one **design model** per door (`designLane`): Claude Fable 5.2, GPT-6 Astra, Gemini 4 Argon. Fable 5.2 and Gemini 4 Argon are promoted to frontier by recorded operator ratification. The freshness lint checks that each lane is a frontier id and that the code pin equals the registry.
- New `src/core/designLane.ts`. The Claude reviewer's default model (`CLAUDE_REVIEWER_DEFAULT_MODEL`) is now the Claude design model; `claude-fable-5` stays accepted as an override.
- `POST /sessions/spawn` accepts `workKind` (`design`, `build`, `other`) and `reviewHandoff: true`. On a development agent a design spawn (declared, or judged by one fast classifier call) launches on the design model when an account has a recorded review that answered on it and has room; otherwise it runs on today's model. The decision is recorded on the session (`workKind`, `workKindSource`, `designRouting`) and in the feature-evidence log. An explicit model, a remote target and a topic with `escalationOverride: suppress` are never routed.
- `accountRoom` can be asked for a model; for a Fable model it reads the Fable window too.
- New maturation ladder entry `frontier-design-review`, on where `developmentAgent` is set.

## What to Tell Your User

Nothing changes for most agents yet. On the development agent, a session started to write a plan or design now runs on the strongest model, once a review has confirmed that model is on the account. Building still runs on the usual model.

## Summary of New Capabilities

- Design routing at spawn (development agents only for now): `workKind` on `POST /sessions/spawn`, and the routing decision on each session record.

## Evidence

- Unit: `tests/unit/designRouting.test.ts` (34 cases), `tests/unit/crossModelReviewer-clean-door.test.ts`, the LLM-registry and ladder ratchets.
- Integration: `tests/integration/sessions-spawn-design-routing.test.ts`.
- E2E: `tests/e2e/design-routing-spawn-lifecycle.test.ts` (production server composition: alive, classified routing, no respawn after restart, fleet unchanged).
- `node scripts/lint-model-registry-freshness.mjs`: PASS.
