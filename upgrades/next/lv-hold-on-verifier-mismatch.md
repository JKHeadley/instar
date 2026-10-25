## What Changed

- **A release no longer empties the local-verify queue.** When the auto-updater replaces the instar files on disk, the old server keeps running until its restart about a minute later, and every verify child it spawned in that window refused with `verifier-mismatch` (its code no longer matched the server's). The service recorded that refusal as the pull request's own error, retried once, erred again and moved to the next entry — the whole queue (9 PRs at 2026-10-24T00:12:52Z, 4 at 10:36:40Z, 10 at 2026-10-25T02:59:55Z) was burned to error records within a second — and posted to GitHub as 21 `failure` statuses —, each record removing its entry from the durable queue, so the next boot restored nothing (`queue-restored restored:0` at 03:01:50Z) and every PR had to be re-requested by hand. A `verifier-mismatch` is now a hold: the entry goes back to the head of the queue with its attempt uncounted and no record written, one `verifier-changed` audit event is logged, and nothing more starts until the process restarts. The next boot resumes the queue in order.
- **The hold is entered before spawning when the files already differ.** A new `installedVerifierVersion` seam recomputes the verifier version from the files on disk right before a start; a mismatch holds without spawning a child that would only refuse. An unknown answer (no seam, a read error mid-replacement) never holds — the child's own check still decides.
- **A hold cannot stall the queue silently.** Files that compute the server's version again release it on the next tick (`verifier-hold-released`); a hold older than 15 minutes raises one `local-verify:verifier-hold` attention signal (`verifier-hold-overdue`), then stays quiet. `GET /local-verify` carries `verifierHold` (`since`, `detail`, `where: run | before-start`) or `null`.

## What to Tell Your User

Nothing to do. If my pull requests kept showing up as "verify error" right after a release and then vanished from the verify queue, that was this: the release replaced my verifier under its still-running server. Now the queue simply waits for the restart and continues where it left off; a pull request only needs re-requesting if it genuinely failed.

## Summary of New Capabilities

- `LocalVerifyServiceSeams.installedVerifierVersion?()` (wired in `buildLocalVerifyService` to `computeVerifierVersion` over the installed `mainEntry` directory).
- Exports in `src/localVerify/LocalVerifyService.ts`: `isVerifierMismatch`, `VERIFIER_HOLD_SIGNAL_MS`, `VerifierHold`; `snapshot().verifierHold`.
- Audit events in `logs/local-verify.jsonl`: `verifier-changed`, `verifier-hold-released`, `verifier-hold-overdue`. Attention signal key `local-verify:verifier-hold`.

## Evidence

- `tests/unit/localVerify/LocalVerifyService.test.ts` ("verifier changed on disk"): the mismatch re-queues at the head with attempts/errorRetries unchanged and starts nothing across ticks and new requests; no record, journal absent; after a simulated restart the restored queue runs in order on the new version (restored 3, dropped 0); a `main` entry is re-queued with main health untouched; the pre-start check holds without spawning and releases when the files match again; an unknown/throwing seam never holds; the overdue signal fires once; an ordinary crash is still an error record with one re-run. All 10 fail against the previous service code.
- `tests/e2e/local-verify-lifecycle.test.ts`: the production wiring carries a real `installedVerifierVersion` equal to the config's `verifierVersion` at boot; `GET /local-verify` reports `verifierHold: null`.
- Live: `logs/local-verify.jsonl` holds 46 `record … errorStep:verifier-mismatch` events across the three bursts (9 + 4 + 10 PRs × 2 attempts; the journal keeps 14 of the records today) and shows the cascade shape at 00:12:52Z: `started` → `run-error verifier-mismatch` → `error-auto-retry` → `started` (attempt 2) → `run-error` → next PR, ~90 ms per PR, with a `main` run erroring at the same instant; the boot after the 02:59Z burst logged `queue-restored restored:0 dropped:0`.
