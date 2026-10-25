# Side-Effects Review — Chrome CDP profile cleanup race

**Version / slug:** `chrome-cdp-profile-cleanup-race`
**Date:** `2026-08-28`
**Author:** `echo`
**Second-pass reviewer:** `chrome_cleanup_review`

## Summary of the change

`ChromeCdpReloginBrowser.close()` now waits for the spawned Chrome browser process to exit before returning. If a graceful CDP close does not finish, shutdown escalates through bounded SIGTERM and SIGKILL waits. The real-process integration test closes the browser from a `finally` block and gives Chrome's short-lived profile-writing helpers a bounded thirty-second retry window before failing cleanup. The test also uses an explicit thirty-second launch allowance because eight simultaneous real-Chrome CI shards can exceed the production-default startup window under runner contention. This prevents CI load from masquerading as a browser defect without weakening production bounds or the filesystem safety funnel.

## Decision-point inventory

- `ChromeCdpReloginBrowser.close()` — modify — deterministic child-process lifecycle and bounded shutdown escalation.

---

## 1. Over-block

No block/allow surface — over-block is not applicable. A slow Chrome shutdown can add up to seven seconds to `close()`, but it does not reject a legitimate login action.

## 2. Under-block

An operating-system defect could leave an unkillable process after SIGKILL. The method still returns after the final bounded wait rather than hanging forever; a later filesystem cleanup can still report the honest failure. The change does not attempt to discover or kill unrelated Chrome processes.

## 3. Level-of-abstraction fit

The browser adapter owns the child it spawns, so it is the correct layer to await that child's termination. Linux Chrome launchers can still exit well before their profile-writing helpers under loaded CI, so the disposable integration-test directory also needs a narrow retry for `ENOTEMPTY`, `EBUSY`, and `EPERM`. The lifecycle fix, the test retry, and the test-only launch allowance address distinct layers; none replaces another or changes production browser timeouts.

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — this change has no block/allow surface.

This is deterministic owned-process cleanup, not a judgment over user input or agent behavior.

## 4b. Judgment-point check (Judgment Within Floors standard)

No new static heuristic at a competing-signals decision point. Process exit, signal delivery, and fixed time bounds are enumerable lifecycle mechanics.

## 5. Interactions

- **Shadowing:** no existing shutdown authority is bypassed; CDP `Browser.close` remains the first graceful action.
- **Double-fire:** `close()` remains safe when Chrome already exited. The saved child reference and exit/signal checks prevent unnecessary signals.
- **Races:** the parent-process race is closed by awaiting the child exit event before returning. The listener is registered before the second exit-state check, and an idempotent settlement guard closes the check-then-listen race identified during second-pass review. The remaining launcher-helper tail is handled only in disposable test cleanup by a thirty-second, typed retry with a constant 250 ms pause and an explicit thirty-five-second hook timeout. CI launch contention is separately bounded at thirty seconds.
- **Feedback loops:** none; teardown creates no durable state or retry loop.

## 6. External surfaces

Callers now receive a stronger `close()` completion guarantee and may wait up to seven seconds for a wedged owned Chrome process. There are no API, dashboard, credential, message, or persistent-state shape changes. No operator-facing actions are added.

## 6b. Operator-surface quality (Operator-Surface Quality standard)

No operator surface — not applicable.

## 7. Multi-machine posture (Cross-Machine Coherence)

**Machine-local BY DESIGN:** Chrome processes and their profile directories are physical-machine resources. Each browser adapter waits only for the child it spawned locally. The change emits no notices, holds no new durable state, and generates no URLs, so no one-voice, transfer, or cross-machine URL handling is needed.

## 8. Rollback cost

Pure code change: revert and publish a patch. No data migration or agent-state repair is required. Rollback would restore the cleanup race until the reverted version propagated.

## Conclusion

The fix belongs in the process owner, preserves bounded teardown, and closes the observed CI race without broadening process-kill scope. It is clear to ship once the second-pass lifecycle review and CI concur.

## Second-pass review (if required)

**Reviewer:** `chrome_cleanup_review`
**Independent read of the artifact:** concur after revision

The reviewer identified a check-then-listen race in the first `waitForChildExit()` implementation. The implementation now registers the listener first, immediately rechecks process state, and settles idempotently. With that correction, the reviewer concurred with the ownership layer, bounded escalation, `finally` cleanup, authority analysis, and side-effects conclusions.

## Evidence pointers

- `tests/integration/chrome-cdp-relogin-browser.test.ts`
- Sixty consecutive local real-Chrome stress passes across the three revisions, plus one pass inside the 50,310-test repository run.
- `npm run build` passed.

## Class-Closure Declaration (display-only mirror)

`defectClass: unbounded-self-action`, `closure: n/a`, `reason: one-shot close() teardown for one explicitly opened browser child, not a self-triggered loop or controller`.

This change modifies process-signaling code, so the structural classifier correctly asks for an explicit declaration. The operation is invoked once by the bounded repair worker's cleanup path; it does not schedule itself, retry across episodes, or create an autonomous control loop.
