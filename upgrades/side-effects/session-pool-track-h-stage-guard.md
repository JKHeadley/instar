# Side effects — Track H part 2a: stage-write guard (§Rollout, Structure > Willpower)

## What this adds
The structural enforcement that `multiMachine.sessionPool.stage` is StageAdvancer-write-only.

- `src/config/stageWriteGuard.ts` (NEW) — `STAGE_CONFIG_PATH`, a module-private `STAGE_WRITE_TOKEN` capability symbol, `assertStageWriteAuthorized(dotPath, token)` (throws `StageWriteNotPermittedError` / code `stage-write-not-permitted` on a stage write without the token; no-op for any other path).
- `src/config/LiveConfig.ts` — `set(dotPath, value, opts?)` now calls the guard first. A direct runtime write to the rollout stage without the token is refused; every other config write is unaffected (opts is optional, backward-compatible). StageAdvancer's boot wiring passes the token.

## Risk / blast radius
None for existing callers — the guard only fires for the exact stage path, and `opts` is optional so all current `set()` callsites are unchanged. The stage field is already only written by StageAdvancer; this makes that structural (a stray ad-hoc write now throws instead of silently flipping the rollout).

## Tests
- `tests/unit/stageWriteGuard.test.ts` — 6: assert throws without/with-forged token, allows with token, no-op for other paths; LiveConfig refuses a direct stage write (unchanged on disk), allows it with the token, and does not gate other writes.

## Follow-ups (Track H)
StageAdvancer + E2EResultStore boot construction + `GET /session-pool/e2e-results` route + the CI release-boundary check; rebalance; live-ingress interception + outbound mesh client (D11); real-hardware + test-as-self proof.
