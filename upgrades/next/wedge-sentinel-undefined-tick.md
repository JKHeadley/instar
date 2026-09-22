# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

`ContextWedgeSentinel` — the background check for sessions stuck on the thinking-block 400 or the Usage-Policy rejection loop — was scanning every ~1ms instead of every 20s on every agent whose config did not spell out `tickIntervalMs` (the shipped default). `server.ts` passes `{ tickIntervalMs: wedgeCfg.tickIntervalMs, … }`, so an omitted field arrived as an explicit `undefined`, and the constructor's `{ ...DEFAULT_CONFIG, ...cfg }` spread copied that `undefined` over the 20s default; `setInterval(tick, undefined)` then ran at Node's 1ms floor. Each tick captured every live session's tmux pane synchronously. On an agent with five live conversations that blocked ~78% of the server's main thread, which expired the 250ms Telegram send-capacity grant and parked replies on the 15-minute recovery pacing — replies arrived 5–25 minutes late and out of order.

The fix closes the whole class, not just this instance:

- New `mergeDefaults(defaults, …overrides)` helper (`src/core/mergeDefaults.ts`): spread semantics, except an `undefined` value never erases a default. Plus `resolveTimerMs(value, fallback, floor)` for config-driven timers.
- The sentinel resolves its timing through both: a missing value falls back to 20s / 45s, and the scan period is floored at 1s.
- 96 of the 98 defaults-merge sites in `src/` now go through the helper (one pure key-union was rewritten explicitly instead). That includes `SystemReviewer`, which had been patched locally for this same class before. The last 2 are in `InboundDeliveryStore.ts`, a Stage-B certified file that can only change with a fresh approved canary; they read JSON config (which cannot carry `undefined`) and are a capped, tracked lint exception until that rebind.
- New lint `scripts/lint-no-undefined-erasing-default-merge.js` (in `npm run lint`, built on the TypeScript AST) refuses the raw spread-merge pattern in new code.

No config migration: explicit timing values are honoured exactly as before, and nothing is written to disk.

## What to Tell Your User

If your agent has felt sluggish, or its Telegram replies have sometimes arrived many minutes late or out of order, this update fixes the main cause. A background check that is meant to look at your conversations every 20 seconds was, because of a missing setting, running about a thousand times a second, and the more conversations were open, the more it slowed everything down. It now runs at its intended pace, and the same kind of mistake has been fixed everywhere else it appeared in instar, with an automatic check to keep it from coming back.

## Summary of New Capabilities

- Background monitors keep their defaults when a setting is omitted, so none can be driven into a busy loop by an unset timing value.
- Faster server responses and more reliable Telegram delivery on agents with several live conversations.
- A new lint guards against the "missing value erases the default" mistake in future code.

## Evidence

- Measured live on an affected agent (5 live sessions, v1.3.1248): 78% of main-thread samples inside synchronous child-process spawns. A CPU profile attributed 91% of that to `ContextWedgeSentinel.tick → scanSession → captureOutput`: 680 pane captures in 20 seconds, where 5 were intended. After an interim config-only fix (explicit `tickIntervalMs: 20000`) and a restart, spawn time fell to 0.6% and `/health` median fell from 52ms to 3ms.
- Over 7 days that agent had 389 of 1,131 Telegram send attempts held as `credential-capacity-unavailable`, and 272 of those had no other send within ±1.25s, which rules out the burst rate cap. Individual replies were delayed up to 22 minutes.
- Tests: `tests/unit/core/mergeDefaults.test.ts` (12, including `__proto__` parity with spread); `tests/unit/monitoring/ContextWedgeSentinel.test.ts` (+5 timing-regression cases); `tests/integration/context-wedge-sentinel-wiring.test.ts` (+1 cadence through `buildContextWedgeDeps`, which fails against the pre-fix code); `tests/e2e/context-wedge-sentinel-lifecycle.test.ts` (+1 real-timer: no scan inside the period with the shipped cfg shape); `tests/unit/lint-no-undefined-erasing-default-merge.test.ts` (18, including regex-literal fixtures and an assertion that the live `src/` tree is clean). Replayed against the pre-fix tree, the lint finds all 98 instances.
