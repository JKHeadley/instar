# Side-Effects Review — Local Verify: the age of an unverified main survives a restart

**Version / slug:** `local-verify-main-age-survives-restart`
**Date:** `2026-11-18`
**Author:** `echo`
**Second-pass reviewer:** pending (run separately by the coordinating session before push)

## Summary of the change

Tier 1. Local Verify decides when a healthy `main` goes ahead of waiting pull requests from one number: when the oldest merge with no green `main` verify after it was first seen. That number lived only in memory, so each restart set it back to zero. On 2026-11-18 the coordinator booted 12 times, never more than 79 minutes apart, and no `main` verify started for ten hours (feedback fb-a28ace2f-93c).

The change stores that time in the existing `state/local-verify/main-health.json` watermark as two optional fields (`oldestUnverifiedAt`, `unknownSince`), written by the existing atomic writer in `MainHealth`. It is read once per process start. When there is no usable stored value, the age is unknown, and unknown counts as due in `decideStart`. The 3-hour `local-verify:main-unverified` signal uses `unknownSince` as a lower bound and says `atLeast: true`.

Files: `src/localVerify/mainHealth.ts`, `src/localVerify/LocalVerifyService.ts`, `src/data/state-coherence-registry.json` (the row's description and retention note), `src/data/feature-ladders.json` (a finished entry, `localVerify.mainAgeDurable`), three test files, this artifact and a release note. Spec: `docs/specs/local-verify-main-age-survives-restart.md` (converged in 3 rounds, approved by the Chief of Staff).

**Proportion:** Tier 1. 4 source files (162 lines added in the two `.ts` files, 2 data rows), 4 test files (about 550 lines added). 3 spec review rounds, which is high for a Tier 1 change: the rounds were spent on the unknown case and on lease re-acquisition, not on the size of the code. Commit attempts are stated in the PR body.

## Decision-point inventory

- `decideStart` in `src/localVerify/LocalVerifyService.ts` (healthy `main` versus waiting pull requests) — modify — the rule and the 90-minute limit are unchanged; its input is now durable and gains a third state, unknown, which is due.
- `MainHealth.noteUnverifiedAge` (the 3-hour `main-suspect` entry and signal) — modify — the same limit; when the age is unknown the input is a lower bound and the detail carries `atLeast: true`.
- `MainHealth.load` (boot and lease acquisition) — modify — restores the age once per process; a foreign holder or an epoch gap makes it unknown.
- Merge admission, the red-main hold, peer dispatch, the resumed-run rule — pass-through.

---

## 1. Over-block

Nothing is refused that was allowed before. The cost is ordering: when the age is unknown, one `main` verify starts ahead of a ready pull request, once per unknown episode (a boot with no usable stored value, or the lease coming back from another machine). The first boot on the new build is such an episode on every agent that has an unverified head. A stale stored value (a release-collapse clear whose write failed) can schedule `main` early and can raise the 3-hour signal early; the next green `main` verify ends it. Both are accepted in the spec's Frontloaded Decisions 5 and 6.

One more ordering effect, stated in the spec: after a green verify of an older head ends an unknown age, the age of the newer head starts at the next observation, so it is young by at most one verify's duration.

---

## 2. Under-block

- If the watermark write keeps failing while `main` is healthy, the old file stays, so a restart restores an older value (early scheduling) or no value (unknown, due). `main` is never left waiting; the existing `main-health-write-failed` audit line is the trace.
- If an unusable `unknownSince` meets repeated write failures and restarts less than 3 hours apart, the signal is pushed back each time. `main` still stays due throughout.
- At a boot with no stored value, a stale first read that shows the last green head is read as "nothing unverified", and the age of the real head then starts at the next read. That loses at most the time since the merge, once, and only when nothing was stored.
- A wall clock that jumps forward makes `main` due early; a jump backward leaves a time in the future, which is read as unknown.
- Frequent lease changes on the coordinator are not treated here (PR 3460).

---

## 3. Level-of-abstraction fit

The value is held by `MainHealth`, which already owns the watermark, its atomic writer and its read at boot and lease acquisition. No new file, store, timer or alarm. The service keeps its in-memory mirror (`mainObs.oldestUnverifiedAt`) and updates it only from `MainHealth`, so the two cannot drift. Unknown has one encoding (`unknownSince` present), in memory and on disk, and the two fields are never written together. Deriving the age from git history was rejected in the spec: the head may be absent from the verifier's clone, and which release commits were collapsed is not durable.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

**Does this change hold blocking authority with brittle logic?**

- [ ] No — this change produces a signal consumed by an existing smart gate.
- [x] No — this change has no block/allow surface.
- [ ] Yes — but the logic is a smart gate with full conversational context (LLM-backed with recent history or equivalent).
- [ ] ⚠️ Yes, with brittle logic — STOP.

It adds no new blocking authority. It makes an existing deterministic scheduler input durable. `decideStart` only orders two kinds of work that were both going to run. The 3-hour `main-suspect` entry is an existing restriction with an unchanged limit; it can now fire across restarts, which is the true state the lost value was hiding. Nothing here judges meaning or intent.

---

## 4b. Judgment-point check (Judgment Within Floors standard)

No new static heuristic at a competing-signals decision point. The input to `decideStart` has three enumerable states (no age, a known age, unknown), each with one fixed outcome; the spec's "Decision points touched" classifies it as an invariant on that basis. The 90-minute and 3-hour limits are inherited unchanged from `docs/specs/local-verify-merge-authority.md`.

---

## 5. Interactions

- **PR 3451 (SEC-113, merged as 15bc91358):** it added a second clock, `notLocallyVerifiedAt`, in `peer-trust.json`, combined with this one by `olderClock` in the tick. That clock was already durable. This change feeds `olderClock` with `unknownSince` when the age is unknown and passes `atLeast` when it is; the second clock, its file and its rules are untouched. A peer's green still moves the first clock exactly as before, through the same value handed to `onVerify`.
- **PR 3460 (open):** it edits `pollPeers`, `dispatchOnce` and `RemoteMarker`. It does not edit `MainHealth`, `decideStart`, `noteMainHead` or the green-verify path. A textual merge conflict is possible in `LocalVerifyService.ts` only by proximity; there is no shared state.
- **Shadowing:** the resumed-run rule in `decideStart` runs first and is unchanged: a pull request run that a restart killed still goes ahead of an unknown-age `main` (tested).
- **Double-fire:** `main-age-unknown` is audited once per process start. The `local-verify:main-unverified` signal stays deduped by `MainHealth.raise`.
- **Races:** the watermark has one writer, `MainHealth.writeWatermark`, synchronous and atomic (temp file, rename). The green verify's age is written in the same write as `lastGreenHead`. A green verify that cannot clear a red `main` still writes the age.
- **Self-action model:** `local-verify-main-schedule` in `src/testing/selfActionRegistry.ts` drives `decideStart` with the same inputs; the new field is optional and absent there, so the model is unchanged. Unknown adds at most one earlier `main` start per episode: still one pending `main` entry, one verify per head, three error retries.
- **Feedback loops:** none. A `main` verify that errors does not end unknown, and its retries are bounded as before.

---

## 6. External surfaces

- **Persistent state:** two optional fields in `state/local-verify/main-health.json`. Version stays `v: 1`. An older build ignores them and drops them at its next write.
- **Audit log:** one new line, `main-age-unknown` with a reason (`field-absent`, `file-unreadable`, `future`, `non-finite`, `other-machine`, `carried`).
- **Signal detail:** `local-verify:main-unverified` may carry `atLeast: true`. Readers that use only `ageMs` are unaffected.
- **Routes, config, dashboards:** unchanged. A new method `LocalVerifyService.mainUnverifiedAge()` is used by tests and is not served by a route.
- **Other agents and users:** every agent with unverified merges sees one `main` verify go first at its first boot on this build.
- **Operator surface:** no operator-facing actions.

---

## 6b. Operator-surface quality (Operator-Surface Quality standard)

No operator surface — not applicable.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

**Machine-local BY DESIGN.** The fields live in a store already declared machine-local (`src/data/state-coherence-registry.json`, category `local-verify-main-health`: `scope: machine-local`, `transport: none`, `conflictShape: single-writer`), beside `lastGreenHead`. The time a machine first saw an unverified merge is that machine's own observation; another machine's value is not trusted and is dropped at load (`other-machine`).

A new coordinator has no value of its own, so it reads unknown, and unknown is due: one `main` verify goes first. Such a machine is also in `main-suspect` after a foreign holder, where `main` already has priority. When the lease comes back from another machine, this machine's earlier age becomes the lower bound (`unknownSince = min(own age, now)`), so lease changes cannot keep pushing the 3-hour signal back.

It emits no user-facing notice of its own (the existing signal is unchanged and deduped), holds no state that follows a topic, and generates no URLs. **Status surfaces:** none added or changed.

---

## 8. Rollback cost

- **Hot-fix release:** revert the commit. The age again resets at each boot.
- **Data migration:** none. The older build ignores the two fields and drops them at its next watermark write.
- **Agent state repair:** none.
- **User visibility:** none during rollback; the original defect returns.

---

## Conclusion

The review found no new authority and no new store. The trade is stated: one `main` verify goes first per unknown episode, including the first boot on this build, and a stale value can schedule `main` early. Five existing unit tests assumed that a boot which finds an unverified head with nothing stored knows its age. That age is now unknown by design, so those tests seed a last green head or a stored age and keep their original meaning. Clear to ship after the second-pass review.

---

## Second-pass review (if required)

**Reviewer:** pending
**Independent read of the artifact: pending**

---

## Evidence pointers

- `tests/unit/localVerify/mainHealth.test.ts`: the watermark fields, restore, validation, foreign holder, release collapse, `atLeast`, and `decideStart` with an unknown age.
- `tests/unit/localVerify/LocalVerifyService.test.ts`: nine service cases, including two boots 50 minutes apart with `main` due 90 minutes after the first observation.
- `tests/e2e/local-verify-lifecycle.test.ts`: a stored `oldestUnverifiedAt` restored through the production-built service.

---

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect — not applicable. No self-triggered action is added: the change alters when an existing, already bounded `main` verify starts, not whether or how often one is enqueued.
