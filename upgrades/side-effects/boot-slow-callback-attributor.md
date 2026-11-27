# Side-Effects Review — Boot slow-callback attributor

**Version / slug:** `boot-slow-callback-attributor`
**Date:** `2026-11-18`
**Author:** `echo (echo-machine-stewardship)`
**Second-pass reviewer:** `independent subagent`

## Summary of the change

This adds `src/monitoring/BootSlowCallbackAttributor.ts` and starts it as the first statement after config loads in `startServer` (`src/commands/server.ts`). It uses an `async_hooks` hook to time each callback (from `before` to `after`). For the first 120 s, any callback over 1 s is logged as one `[boot-slow-callback]` line. The line names the resource type and the stack that scheduled the callback.

Stacks are captured at `init` only for non-promise resources. Each promise keeps an object reference to its parent record (its trigger, or the running callback at `init`) and, when it resolves, the anchor of the callback that resolved it. A slow continuation is traced through these references, even after the parent has left the map, to the timer, IO or immediate that started or resolved its chain. Retained chains are capped at 64 links. A chain that began before the hook was enabled is reported as unknown.

The attributor turns itself off when the window ends, or on any error of its own. It is dev-gated by `monitoring.bootSlowCallbacks` through `resolveDevAgentGate`: live on development agents, dark on the fleet. A ladder entry with disposition `retire` marks it for removal after fb-756ec068-89d is fixed.

Why it exists: the Studio blocks ~22.5 s at every boot (2 of 2 boots on 2026-11-18). We can't profile the live server, because doing so crashed it once.

## Decision-point inventory

*(none)*. The attributor only observes and logs. It makes no allow/block/route decision.

## 1. Over-block

No issue identified. It rejects nothing.

## 2. Under-block

- **Promise chains that began before the hook.** A continuation whose chain started before the hook was enabled (for example, `startServer`'s own top-level awaits) has no anchor. The line says so plainly and points to the log lines on either side.
- **Work outside the window.** Work slower than 1 s that starts after 120 s is not covered. The boot block falls inside the window.
- **Synchronous code before the first await.** Top-level code that runs before `startServer`'s first await belongs to no callback, so it is not timed. The block we are chasing is in deferred work, as the Explore pass showed, so this does not cover the case at hand.

## 3. Level-of-abstraction fit

`async_hooks` is the one place that sees every callback boundary, so it is the only layer that can attribute deferred work. Per-site stamps would need a guess about where to put them. Those are the next step if this points at a broad promise chain.

## 4. Signal vs authority compliance

Signal only. It holds no authority, and an error inside it disables the diagnostic, never the callback.

## 4b. Judgment-point check

Not applicable: there is no decision point.

## 5. Interactions

- **Overhead.** The hook adds per-callback overhead, plus a structured stack capture (14 frames) on every non-promise init, for 120 s on development agents. The stack is formatted only if reported, and promises share their parent's anchor by reference. Boot is somewhat slower on development agents, and each long-lived tracked resource holds one captured stack until it is destroyed. An unformatted holder keeps V8's raw call-site objects, which hold their functions and `this` values, so ancestors referenced by a chain stay in memory until the window ends. This is acceptable for 120 s on a development agent, and `stop()` releases it all. Bounds: at most 200,000 tracked resources (records are deleted on `destroy`, on `promiseResolve`, and after a promise's `after`), and at most 20 reports. The window timer is `unref`'d, so it never holds the process open.
- **Other hooks.** The other `async_hooks` users in src are provider adapters. Hooks compose, and this one does not use AsyncLocalStorage.
- **SleepWakeDetector.** Its block detection is untouched. The attributor adds a "who" next to that detector's "when".

## 6. External surfaces

Log lines only, on development agents. Nothing changes in routes, config defaults, or messages.

## 7. Multi-machine posture (Cross-Machine Coherence)

Machine-local by design (`machine-local-justification: hardware-bound-resource`). It measures this process's own event loop on this machine, and each machine logs its own boot.

## 8. Rollback cost

Revert the commit, or set `monitoring.bootSlowCallbacks: false`. There is no state and no migration.

## Conclusion

A small, temporary diagnostic that only observes. It lets the next Studio boot name the 22 s step without profiling a live server.

## Second-pass review (if required)

**Round 1 (independent subagent, 11:45 PT): concern raised.**
1. **Trigger-chain walk failed.** A parent promise's record was deleted before its child ran, so promise continuations came back unattributed. Fixed: each promise holds an object reference to its parent record (kept even after map deletion) plus the anchor of the callback that resolved it. Two tests now require a non-null scheduling stack: a `.then` after a timer, and a promise started inside a timer callback.
2. **Stacks were formatted eagerly.** Fixed: the structured holder is stored and formatted only when reported, and the overhead section now says this.
3. **`Error.stackTraceLimit` was not restored on a throw.** Fixed with try/finally.
4. **Missing from `DEV_GATED_FEATURES`.** Added as `bootSlowCallbacks`.

The reviewer found these fine: crash safety, recursion, timer and ordering, and the fleet staying dark.

**Round 2 (same reviewer, 11:49 PT): Concur with the review.** The reviewer checked that the `from` chains are bounded (64 links, a 200k-entry map, all cleared by `stop()`), that `promiseResolve` cannot throw out of the hook, and the try/finally and the registry entry. tsc is clean and the unit file passes 9/9. The reviewer's non-blocking memory note is now in the overhead section above.

