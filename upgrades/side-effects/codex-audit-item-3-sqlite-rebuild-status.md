# Side-effects review — Codex-instar audit Item 3: SQLite native rebuild self-heal (status doc)

**Scope:** Documentation-only assessment for Item 3 of the 2026-05-22 codex-instar audit. After tracing the actual codepaths and surfacing the real failure mode on codey live during the audit, **no source change ships under Item 3** — the self-heal infrastructure codey asked for is already in place. The real residual is upstream-dependency / Node-version selection, which is operational rather than instar source.

This file documents what's in place, what failed on codey, and why no source-level change ships under this audit item.

## What codey asked for (audit Item 3)

> SQLite/native module fragility after Node changes
> - Evidence: health degradation shows sqlite-backed subsystems offline and queue layer disabled after runtime/version shifts.
> - Impact: knowledge graph, conversation summaries, feature discovery persistence, and durable queue degrade together.
> - Recommended fix:
>   - Make native rebuild + process restart path deterministic and self-healing.
>   - Add explicit health split between transient rebuild-in-progress vs persistent native mismatch.

## What's already in place

**1. `src/memory/NativeModuleHealer.ts`** — in-line self-heal at the open() callsite. When `MemoryIndex.open` (or any caller using `openWithHeal`) hits a `NODE_MODULE_VERSION` error, NativeModuleHealer:
- Runs `npm rebuild --build-from-source --ignore-scripts better-sqlite3` against the configured prefix. `--build-from-source` is the critical flag — without it, prebuild-install can fetch the SAME wrong-ABI cached binary that was there before, producing the "rebuild succeeded but module still fails to load" pattern.
- Persists a HealEvent jsonl entry for observability.
- Clears the require cache for better-sqlite3 so a retry sees the fresh binding.
- Retries the opener exactly once. If still failing, surfaces the original error with `(in-line heal failed — see heal-events.jsonl)` appended.
- Uses a `healAttempted` flag to prevent repeated heal attempts within the same process.

**2. `src/lifeline/ServerSupervisor.ts:730-787`** — preflight rebuild path. Before spawning the server, the supervisor:
- Locates every shadow-install copy of better-sqlite3.
- Attempts to load it with the SERVER's node binary.
- If load fails with `NODE_MODULE_VERSION`, runs the same `--build-from-source` rebuild.
- Verifies the rebuild by attempting to require the .node binary.
- On verification failure, logs an explicit error including the stderr tail (which contains the two clashing NODE_MODULE_VERSION numbers and the upstream module's "Please try re-compiling or re-installing" guidance).

**3. `[DEGRADATION] sqlite-runtime-broken`** — when the runtime open fails after all heal attempts, MemoryIndex (and parallel callers like PendingRelayStore) emit a typed degradation via DegradationReporter naming the package, the impact, and the operator-action ("rebuild better-sqlite3 for this platform"). The degradation surfaces in `/health` and `/degradations`.

**4. Supervisor restart-cycle protections** — exponential backoff (`restartBackoffMs * 2^(restartAttempts-1)`), max-attempt cap (`maxRestartAttempts`), circuit breaker (`circuitBreakerThreshold` failures in `circuitBreakerWindowMs` window). When the supervisor exhausts restart attempts, it cools down for `retryCooldownMs` (default minutes, not seconds) before retrying. This is exactly the "explicit health split between transient rebuild-in-progress vs persistent native mismatch" codey asked for — the circuit breaker is the persistent-mismatch state.

## What actually failed on codey during the audit

codey's `.instar/bin/node` is `v25.6.1` (`NODE_MODULE_VERSION 141`). The `better-sqlite3` binary in the shadow-install was compiled against Node 22 (`NODE_MODULE_VERSION 127`). The supervisor's preflight ran the `--build-from-source` rebuild path. `prebuild-install` reported success (because it fetched the SAME wrong-ABI cached binary again — the cache key didn't account for the Node ABI mismatch). `node-gyp rebuild --release` was tried directly: it fails to compile because `better-sqlite3@12.10.0`'s C++ source uses `v8::Context` features whose templates conflict with Node 25's v8 headers (errors in `v8-context.h` lines 481/501 about `expected expression` in `I::ReadExternalPointerField<{...}>` initializer-list arguments).

This is NOT a code bug in instar. It's an **upstream package compatibility issue**: `better-sqlite3@12.10.0` does not support Node 25's v8 ABI. The fix is operational — either:
1. Pin `.instar/bin/node` back to Node 22 (the version `better-sqlite3@12.10.0` was built against), or
2. Upgrade `better-sqlite3` in `package.json` to a version with Node-25 support (when one ships from upstream).

Neither is a "self-heal" instar can perform without intervention. Pinning node is a one-time operator decision; upgrading the dep is a code change but not under the audit-Item-3 contract.

**Self-heal correctly reaches its limit.** The codey case exercises the entire heal stack: prebuild-install succeeded (false positive), node-gyp source compile failed, the system surfaced both NODE_MODULE_VERSION numbers in the degradation, the server kept running with sqlite layer disabled (graceful degradation, durable queue off, direct-send paths working). codey stayed up. That's the correct outcome for an upstream-uncompilable dependency.

## What might still merit follow-up (not landed under this audit)

- A high-visibility startup banner when DegradationReporter sees `sqlite-runtime-broken` persisting across boots (>= 2 successive boots with the marker). Currently the degradation is surfaced in `/health` but not in the startup banner / Telegram alert path.
- A self-test for `npm prebuild-install`'s cache: if the cached binary's NODE_MODULE_VERSION doesn't match the runtime's, evict it before retry.
- An operator-facing helper `instar repair native-modules` that runs through every shadow-install's native deps, rebuilds, verifies, and reports the operator's options if the rebuild persistently fails.

Each is a separate small feature, not within audit Item 3's framing. Flagging in case the operator wants to scope a follow-up.

## Decision-point inventory

1. **Ship code change vs. document status.** Given the existing implementation correctly handles every case except upstream-incompatible source code (which no self-heal can fix), shipping additional code under Item 3 would be paint over a non-existent bug. Documentation captures the reality + flags the operational residual.
2. **Don't ship a "force node-version pin" auto-heal.** Auto-changing the Node major version is exactly what `instar-boot.cjs:selfHealNodeSymlink` already explicitly refuses to do, and for good reason — every prebuilt native module in shadow-install is keyed to a specific Node ABI. Auto-pinning would be a bigger break than the current degraded state.
3. **No new tests beyond existing.** `NativeModuleHealer` has its own test suite; `ServerSupervisor` preflight is integration-tested via the lifeline-launchd path. Adding a fault-injection test that simulates "prebuild-install returns wrong-ABI binary" is possible but isolating the failure mode in a test requires either mocking npm or shipping a wrong-ABI binary in test-fixtures — disproportionate to the value.
