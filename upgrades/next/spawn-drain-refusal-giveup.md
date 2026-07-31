# Spawn Drain Refusal Give-Up

## What Changed

Repeated Threadline spawn-drain refusals are now bounded per drain target. After a target crosses the refusal threshold, the drain loop stops retrying that target for a re-arm window and emits one deduped agent-health Attention item instead of spinning silently.

The existing memory-pressure and session-admission refusals are unchanged. This fix makes a correct sustained refusal visible and finite; it does not raise the memory threshold or hide resource pressure.

## What to Tell Your User

If an agent cannot start a new session because the host is under sustained pressure, it now surfaces one clear Attention item instead of retrying forever in the background. Held peer work remains queued for re-arm rather than being silently forgotten.

## Summary of New Capabilities

Operators can tune the drain refusal give-up threshold and re-arm cooldown through the existing spawn config surface. Spawn manager status now reports active drain give-up latches.

## Evidence

- `npx vitest run tests/unit/spawn-request-manager.test.ts tests/unit/attention-single-topic-routing.test.ts` — 115 tests passing, including current main's payload-preservation and ordering cases, latched-backlog TTL protection, Attention-write retry state, and target-stable Attention reopen behavior.
- `npm run build` — passing; expected local no-signing-key transitional warning only.
- `npm run lint` — passing; existing report-only notices only.
- instar-dev pre-commit passed for the runtime fix and side-effects artifacts.
