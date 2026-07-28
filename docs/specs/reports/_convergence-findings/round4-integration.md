# Round 4 — Integration / Multi-Machine lens (FINAL)

Verified the three round-3 fixes against live code. All sound. **0 new material.**

## R3-3a — §8 marker `run off Claude by default` (concrete + collision-free?) — SOUND
- Marker absent from `src/` (grep clean) → concrete new identifier, no pre-existing collision.
- pi-cli migration guard at `PostUpdateMigrator.ts:5525` fires on `content.includes('Per-Component Framework Routing') && !content.includes("pi-cli")`. The new marker contains no `pi-cli` token, so it neither trips that guard nor is gated by it. The §8 explicit warn-off ("Do NOT use a marker containing the bare token `pi-cli`") is correctly grounded — that guard's content-sniff is exactly `!content.includes("pi-cli")`.

## R3-3b — §5 `swapAttemptTimeoutMs` inline-defaulted, no migration (vs codexExecJson) — SOUND
- `codexExecJson` confirmed: NO `migrateConfig`/`ConfigDefaults` entry (only a CLAUDE.md awareness mention at `PostUpdateMigrator.ts:4628`); read with an inline boolean resolver + env fallback (`CodexCliIntelligenceProvider.ts:146-168`), absence ⇒ default.
- `swapAttemptTimeoutMs` (read `?? 5000`, no persisted block) is a faithful application of that real precedent.

## R3-1 / §4.6 — live-read + layer (any new migration/multi-machine concern?) — SOUND, none
- CartographerSweep mutates the live config object at `server.ts:11266-11268` (`overrides.CartographerSweep = <framework>`), AFTER boot. Current `resolveConfig: () => config.sessions?.componentFrameworks` (`server.ts:4693`) reads it live by reference.
- A frozen/memoized computed-default would ignore this → break the sweep. §4.6's "read live + layer computed default UNDER live override" preserves the injection. Confirmed the injected slot is `overrides.CartographerSweep` (a `job`-category override), which the §4.1 `job` exclusion means the computed default (`categories.sentinel/gate/reflector` + `failureSwap` only) never writes → no slot contention.
- Multi-machine: active-set stays runtime-computed/machine-local (§5), never persisted or replicated. The R3-1 layering changes nothing about that posture. No new migration entry implied (default is the new code shipping; §5 already covers the no-persisted-block + machine-local design).

## Swap-loop grounding (incidental confirm)
- `IntelligenceRouter.ts:202` `await tp.evaluate(...)` is the exact §4.5 race insertion point; line 203 `onDegrade({ reason })` is a real shipped hook carrying the R3-4 `swap-attempt-timeout: <target>` reason. Gating-only swap + per-target `resolveProvider` skip + re-throw-when-all-down (lines 190-217) match §2/§4.5/§6.1 verbatim.
