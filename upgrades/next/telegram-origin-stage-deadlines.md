# Telegram origin: the recording stages' time budgets can be set (defaults unchanged)

<!-- bump: patch -->

## What Changed

`TelegramOriginService` gave each recording stage a fixed budget: 250 ms to write evidence to the store, 500 ms to the spool, 1250 ms to a peer, 1000 ms each for verified evidence and admission. They were literals at the call sites.

They are now named (`ORIGIN_STAGE_DEADLINES_MS`, same values) and can be overridden per service through `OriginServiceOptions.stageDeadlines`, read at call time. A value is used only if it is a whole number of milliseconds from 1 to 60,000 (`ORIGIN_STAGE_DEADLINE_MAX_MS`); anything else falls back to the default for that stage. Nothing in production sets the option, so production behaviour is unchanged.

Tests: a helper, `allowSlowOriginRecording(service)` in `tests/helpers/telegramOriginStore.ts`, lifts the service budgets to 20 s per stage. Underneath them the store and spool have their own per-request deadline (2 s by default); the fixtures that pass storage options also raise that to the store's 30 s maximum (`SLOW_DISK_STORE_REQUEST_TIMEOUT_MS`), and the fixtures built through `bootTelegramOrigin` cannot, so for those the effective allowance is about 2 s (8x and 4x the 250 and 500 ms budgets). It is applied in the harnesses of the nine test files that Local Verify's records show failing or being retried on a held send with nothing broken: `telegram-origin-runtime-lifecycle`, `telegram-origin-notice-policy`, `telegram-deterministic-notice-origin`, `telegram-origin-browser-outbox`, `telegram-dashboard-edit-rejection`, `telegram-origin-enrollment` (e2e), `lease-renew-unreachable-peer-sends` (integration), `transport-deadlines` and `late-capacity` (unit, the latter through its shared harness helpers, which also serve the integration and e2e late-capacity files: eleven test files change timing in all).

## What to Tell Your User

Nothing changes in the product. Some automated tests about Telegram message recording failed at random on a busy machine because they allowed a disk write a quarter of a second; those tests now allow it longer, so a slow machine is no longer reported as a broken one.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|------------|
| Per-service recording stage budgets | `OriginServiceOptions.stageDeadlines` (tests only today) |

## Evidence

Local Verify records on the Studio, 2026-11-07 to 11-13: 29 times a file in that set failed or was retried with a held send (`TelegramOriginHoldError`, `all-durable-recording-sinks-unavailable`, `execution-admission-unavailable`), in the runs of 17 PRs; the latest is PR 3141 at 17:49Z on 11-13 (`transport-deadlines`). A few of the 29 are the two ordering cases fixed separately in PR 3149, which this change is stacked on.

Mechanism: the evidence spool opens a fresh SQLite file in WAL mode with `synchronous = FULL` and fsyncs its directory (`OriginEvidenceSpool.ts`); the store commits with `durability: 'FULL'`. On the same machine at the same time the server log showed the 10-second config-read budget being exceeded (`origin-config-reader-timeout`), so sub-second disk budgets were being missed with nothing broken.

Tests: `tests/unit/telegram-origin/origin-stage-deadlines.test.ts` (18, new) pins both sides of the store, spool and admission budgets with a real store and deliberately slow calls (each test with every other stage generous), the set-after-construction path, eight kinds of bad value falling back to the default, and the two ends of the accepted range. The four affected unit files pass (115 tests). Three e2e files passed (58 tests) with the helper applied, before the store request deadline was also raised in two of them; they were not re-run after that. Not run locally: `telegram-origin-browser-outbox`, `telegram-dashboard-edit-rejection`, `telegram-origin-enrollment`, `telegram-origin-late-capacity-lifecycle` (e2e), `lease-renew-unreachable-peer-sends` and `telegram-origin-late-capacity` (integration); each gained one helper call, directly or through a shared harness, and Local Verify is their first run.

Not addressed: 37 other test files open a real origin service with production budgets and could fail the same way; none has on record. And the production question stays open: on a loaded host a real send is held and the operator is told recording failed when a commit was only slow (feedback fb-de7ee113-bc8).
