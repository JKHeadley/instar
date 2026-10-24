# Side-Effects Review — feedback executor: attempt clones receive the base commit; a failed preparation stops the tick

**Version / slug:** `executor-clone-base-objects`
**Date:** `2026-10-23`
**Author:** `Echo`
**Second-pass reviewer:** `not required (Tier 1 bug fix; no gate, authority or confinement change)`

## Summary of the change

Live incident, 2026-10-23 18:33 PDT (topic 18330): one executor tick claimed 8 work items in two minutes and every one ended `prepare-failed`. Reproduced by hand: `git clone` of the agent-home checkout copies only objects reachable from its branches and tags; the base is `origin/main`, a remote-tracking ref that no local branch contained after main moved past every local branch, so `git checkout --detach <base>` in the clone died with `fatal: unable to read tree`.

- `SafeAttemptGit.fetchBase` now fetches `+refs/heads/main` into both `refs/remotes/origin/main` and a local branch `feedback-execute/base` (`BASE_BRANCH`), and reads the base from that branch. The plain clone then carries the base's objects. Same verb (`fetch`), same read-tier opt-in, same hardened config.
- `startNew` stops claiming after the first preparation that returns false (any reason), so a machine-level fault spends one start and one item attempt, not every queued item's.
- `prepare-failed` detail: the triage audit keeps only id-shaped values, so the scrubbed message added in PR 2322 was recorded as `[text:300]`. The scrubbed message is now kept in executor meta `exec:prepare_failed_last` and exposed as `summary().lastPrepareFailure`; the audit row carries `step` (`prepareFailureStep`: fetch-base / checkout-base / clone / link-deps / evidence / other / unknown).

- Canary: a failing must-succeed probe (lint gate, base unit smoke, sqlite, git) records the tail of its output (`outputTail`, ANSI and macOS xcrun cache noise stripped, last 240 chars) instead of `exit N` alone. The 19:27 run's `base-unit-smoke` failure recorded only `exit 1` and could not be reproduced by hand (lint then smoke on a fresh copy, server PATH, real sandbox: both pass). The detail is scrubbed and capped at 300 chars by the existing `profileUnenforceable` path before storage.

## Decision-point inventory

None added. `prepareFailureStep` is a deterministic label for observability; it decides nothing.

## 1. Over-block

The brake can delay a second candidate whose preparation would have succeeded (an item-specific failure). Cost: one tick (30 min). Preparation failures are machine-level in practice (clone, deps, sandbox), and the previous behaviour turned one fault into N failed items.

## 2. Under-block

None: no gate, allowlist, sandbox profile, publish or merge rule changes. The new local branch is written by the trusted server in its own checkout, never by a confined session.

## 3. Level-of-abstraction fit

The base-branch fix sits in the git port where the base is fetched; the brake sits in the claim loop beside the existing availability break; the detail uses the existing meta + summary pattern (`exec:canary_last`).

## 4. Signal vs authority compliance

Status and audit fields are signals. The brake only reduces actions.

## 4b. Judgment-point check

No judgment added.

## 5. Interactions

- `git branch` in the agent home now lists `feedback-execute/base`; it is force-updated to origin/main on every attempt. Nothing else reads it.
- Later clones (verify base clone, publish of a held change set) use the stored base SHA; main fast-forwards, so an earlier base stays reachable from the branch.

## 6. External surfaces

`GET /feedback-factory/execute/status` gains `lastPrepareFailure` (scrubbed, ≤300 chars). Additive.

## 7. Multi-machine posture

Per machine, as before: the executor runs on the lease holder against its own checkout.

## Addendum: update-pending brake

`executorUpdatePending` (pure) replaces `Boolean(getStatus().pendingUpdate)` in the executor's admission wiring: the brake now holds only when `config.autoApply === true` and an update is pending, the same rule local-verify uses (`updatePendingFromAutoUpdater`). Side effect: with auto-apply off, attempts can start while a newer version is known; a later manual apply still restarts the server, and an interrupted attempt is reconciled at boot as before. An unreadable updater still refuses admission. Test: `execute-wiring.test.ts`.

## Addendum: second-pass review fixes (Codex, 2026-10-24)

The independent review of head `8d94c794` blocked on two findings, both fixed here:

1. **Canary output could persist a secret.** `outputTail` shortened raw output before `profileUnenforceable()` scrubbed it, so a long `password=<value>` could lose its label and keep its value, and the canary nonce was never redacted. `outputTail` now keeps whole lines (last 40), replaces the canary nonce, scrubs with `scrubForStore`, and only then shortens; a scrub failure withholds the tail. Tests: `execute-units.test.ts` (240-char `password=` value never survives; nonce never survives).
2. **The update-pending brake could starve the executor.** A failed install keeps `pendingUpdate` set, so the brake refused every tick indefinitely. It now holds only while the pending update is younger than `UPDATE_PENDING_BRAKE_MAX_MS` (6 h); a missing or unparseable detection time keeps the brake. Tests: `execute-wiring.test.ts` (fresh, boundary, stale, missing timestamp).

Second round (re-review of `74d43ac3`): joining lines before scrubbing still separated a label from a value on the next line (and broke PEM matching). `outputTail` now scrubs each complete stream with newlines intact before any selection, joining or shortening; an oversize stream is replaced wholesale by the scrubber. Test: label on its own line, and a multiline PEM block, never survive. The 6 h brake bound relies on `pendingUpdateDetectedAt` being set once on first detection, persisted, and cleared only on a successful install (`AutoUpdater.ts` first-detection guard and success path), which holds.

Third round (re-review of `648c7768`): ANSI stripping ran after the scrub and the nonce replacement, so `password=<ESC>[31m<value>` or a nonce split by an escape was re-joined after the checks. `outputTail` now normalises each stream to plain text first (ANSI/OSC sequences and control characters removed, line endings unified, space runs collapsed), then redacts the nonce, then scrubs; afterwards only trimming, filtering, joining and shortening remain. Tests: colour code, OSC title, backspace and carriage return inside a labelled secret; nonce split by an escape or a NUL.

Fourth round (re-review of `fc3ef7d8`): the shared scrubber only recognises credential shapes, so `password=!A1b2…` passed. Rather than widen shared patterns, `outputTail` now withholds any line naming a credential (password, secret, token, api key, private key, auth, bearer, credential, cookie, session id) together with the line after it; the scrubber remains the second layer. Residual risk: an unlabelled secret on a line naming none of these words, which no shape- or label-based check can see; the canary runs inside the confinement profile, which denies credential reads by design. Over-block: an ordinary error line containing one of these words is withheld from the diagnostic.

Over-block / under-block: the brake can now admit a start during a genuinely long restart deferral past 6 h; the restart gate already caps deferral, and a start interrupted by a restart is reconciled on the next tick, so the cost is one wasted start.

## 8. Rollback cost

Revert the commit. The leftover local branch is harmless (`git branch -D feedback-execute/base`).

## Conclusion

Fixes the live failure with one refspec, bounds the blast radius of the next preparation fault, and makes its reason readable.

## Evidence pointers

- Hand reproduction: clone of the agent home at origin/main `230aa85ad` → `fatal: unable to read tree`; adding the fetch → checkout OK in 0.2 s.
- Tests: `execute-attempt-git.test.ts` (base only on origin/main still checks out; fails without the fix), `execute-reroute-capacity.test.ts` (one failed preparation per tick; `lastPrepareFailure` + audit `step`). Executor unit 145/145, integration 9/9, e2e 2/2, `npm run lint` clean.
