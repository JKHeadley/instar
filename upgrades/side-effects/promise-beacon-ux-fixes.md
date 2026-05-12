<!--
  Side-Effects Review — PromiseBeacon UX fixes
  Phase 4 artifact for /instar-dev pass on echo/promise-beacon-ux-fixes.
-->

# Side-Effects Review — PromiseBeacon UX fixes

**Version / slug:** `promise-beacon-ux-fixes`
**Date:** `2026-05-12`
**Author:** `echo`
**Second-pass reviewer:** `pending`

## Summary of the change

PromiseBeacon's heartbeat templates ("still working — snapshot unchanged since last beat") gave the user no context about which promise was being watched, and heartbeats ran forever even when nothing was changing. Three commitments stacked on the same Telegram topic produced ~30+ context-free "no observable progress" messages over an evening with no way to stop them short of opening the dashboard. This change:

1. Includes a truncated form of the promise text in every heartbeat so the user can see what's being tracked.
2. Adds an auto-pause: after N consecutive unchanged-snapshot heartbeats (default N=12, ~2h at 10-min cadence), the beacon emits one final "auto-paused — reply 'keep watching' to resume" message and stops firing. Non-terminal; status stays `pending`.
3. Adds `POST /commitments/:id/resume` and a literal "keep watching" detector in the Telegram inbound path that calls it for any paused beacon on the originating topic.

Files touched:
- `src/monitoring/CommitmentTracker.ts` — new optional schema fields (`beaconPaused`, `beaconPausedReason`, `beaconPausedAt`, `beaconAutoPauseAfterUnchanged`, `consecutiveUnchanged`); `resume(id)` method.
- `src/monitoring/PromiseBeacon.ts` — promise-text excerpt in heartbeat composition; consecutive-unchanged counter; auto-pause flow; paused-state gate in `fire` and `schedule`.
- `src/server/routes.ts` — `POST /commitments/:id/resume`.
- `src/commands/server.ts` — extend `telegram.onMessageLogged` with literal "keep watching" detector that calls the resume endpoint.
- Tests: new files under `tests/unit/` and `tests/integration/`.

Decision points the change interacts with:
- PromiseBeacon's heartbeat composition path (template selection, LLM call gating).
- PromiseBeacon's scheduling path (timer arming, suppression checks).
- Commitment lifecycle (new non-terminal state combination: `pending + beaconPaused`).
- Telegram inbound path (new literal-match detector that triggers a server-side action).

## Decision-point inventory

- `PromiseBeacon.fire` heartbeat-template selection — **modify** — adds promise-text prefix to every template; adds auto-pause branch.
- `PromiseBeacon.schedule` arming guard — **modify** — skips arming when `beaconPaused`.
- `CommitmentTracker.resume(id)` — **add** — non-terminal flag clear + counter reset.
- `POST /commitments/:id/resume` — **add** — API entrypoint for resume.
- Telegram `onMessageLogged` literal-match — **add** — produces resume signal that calls the new endpoint.

---

## 1. Over-block

**What legitimate inputs does this change reject that it shouldn't?**

The auto-pause has no block/allow surface — it stops outbound heartbeats from this agent, doesn't reject inputs. Strictly speaking it could "over-stop" if the user genuinely wanted updates on a long-running silent process. Mitigation: the final pause message tells the user how to resume; the resume path itself is idempotent.

The "keep watching" detector uses literal substring match (`/keep[\s-]?watching/i`). False positives:
- A user typing "I want to keep watching the build logs" while not intending to resume a beacon. Cost: a paused beacon resumes; user gets one more heartbeat and can re-pause by ignoring it (it'll auto-pause again after N cycles) or by withdrawing the commitment.
- Whichever paused beacons exist on the topic all resume simultaneously, not selectively. Cost: minor; same recovery path.

---

## 2. Under-block

**What failure modes does this still miss?**

- The literal detector won't match paraphrases ("keep an eye on it", "stay on it", "don't give up"). Intentional: per signal-vs-authority, a brittle detector with blocking authority is forbidden. The detector is structurally simple by design. The final auto-pause message tells the user the exact phrase to use.
- If the user wants to resume one specific paused beacon out of many, this implementation resumes all paused beacons on the topic. A future iteration could accept "keep watching <commitment-id>".
- The auto-pause counter is per-commitment; multiple beacons on the same topic still produce N heartbeats each before pausing. The total heartbeat volume on a topic is not bounded by this change — only the per-beacon volume.

---

## 3. Level-of-abstraction fit

The auto-pause counter belongs in PromiseBeacon — it's the only thing that knows the snapshot-hash and the consecutive-unchanged history. Putting it elsewhere would require lifting that state up.

The resume endpoint mirrors the existing `/deliver` and `/withdraw` endpoints on `/commitments/:id` — it's at the same layer as those, which is correct.

The Telegram "keep watching" detector lives in `server.ts`'s existing `onMessageLogged` extension because that's where every inbound message is observed once already (for PresenceProxy + TopicMemory). Adding a third small hook there is cheaper than building a new fan-out point. The detector itself is brittle by design (regex), but it only produces a signal — the resume endpoint is the authority for whether to act.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [ ] No — this change produces a signal consumed by an existing smart gate.
- [x] No — the brittle parts (counter, regex) hold no blocking authority over messages or behavior. The counter triggers a structural state transition (pause); the regex triggers a structural state transition (resume). Neither blocks or modifies an inbound user message.
- [ ] Yes — but the logic is a smart gate with full conversational context.
- [ ] ⚠️ Yes, with brittle logic.

The auto-pause counter is mechanics, not judgment (signal-vs-authority §"When this principle does NOT apply" — "Idempotency keys and dedup at the transport layer... not a judgment call — it's mechanics"). It counts identical snapshot hashes; that's a structural fact.

The "keep watching" detector is a brittle regex that calls a structural API. The API itself is symmetric with `/withdraw` — idempotent, no judgment, just toggles state. A false positive resumes a paused beacon, which costs one more heartbeat and re-pauses if still idle. No message is blocked, filtered, or rejected; no agent behavior is constrained beyond the toggle.

---

## 5. Interactions

- **Shadowing:** The auto-pause check sits inside `PromiseBeacon.fire` after the existing suppression/ownership/quiet-hours checks. It runs only when those passed and templated-unchanged branch was taken. It does not shadow `beaconSuppressed` (which is for boot-cap / spend-cap, distinct semantics) — `beaconPaused` is a new orthogonal non-terminal flag with `resolved-by` `/resume` (not by the existing suppression-clear path).
- **Double-fire:** The "keep watching" detector lives inside the same `onMessageLogged` callback chain that already feeds PresenceProxy. Calling the resume endpoint enqueues a single mutate operation per matched commitment; no duplicate timers are created because `schedule()` clears any existing timer before arming.
- **Races:** Concurrent withdraw + resume on the same commitment: the existing `mutate(id, fn)` queue serializes writes; resume is rejected by `mutate` if the commitment is already terminal (withdrawn).
- **Feedback loops:** Resume → fire → snapshot unchanged → counter increments → re-pauses after N cycles. This is the intended steady state when a watched task is genuinely idle; the user can resume again. There is no autonomous loop that re-resumes itself.

---

## 6. External surfaces

- **Other agents on the same machine:** No. PromiseBeacon state is per-agent.
- **Other users of the install base:** Yes — every instar agent ships with PromiseBeacon. After this change, every install gets the new heartbeat text format, the auto-pause behavior, and the Telegram resume detector. The new endpoint is additive (no behavior change for callers that don't use it).
- **External systems:** The Telegram messages emitted change format (now include promise text). Anyone tooling against the exact "still working — snapshot unchanged since last beat" string would break; we know of no such consumer outside test fixtures.
- **Persistent state:** Three new optional fields on the Commitment schema. Forward-compatible: missing fields default to "not paused, counter at zero, threshold default 12." Existing commitments load cleanly without migration.
- **Timing / runtime:** The 12-cycle threshold at default 10-min cadence yields ~2-hour silence before auto-pause. Tunable per-commitment via `beaconAutoPauseAfterUnchanged`. Quiet hours and boot-cap interactions unchanged.

---

## 7. Rollback cost

Pure code change. Schema additions are optional. Revert the commit and ship the next patch — existing agents will continue to use whatever schema they had; new fields are simply ignored. No data migration. No agent state repair. Users see the previous (broken) UX again until a roll-forward fix; not a regression in correctness, only in UX.

---

## Conclusion

The change addresses the user-reported spam directly: heartbeats now say what they're tracking, beacons stop themselves after extended silence, and the user can resume them from Telegram. The signal-vs-authority principle is honored: the brittle parts (counter, regex) only trigger structural state transitions, never block or judge messages. Schema additions are backward-compatible and rollback is a code revert. Clear to ship after Phase 5 second-pass review (required: change touches outbound messaging composition and commitment lifecycle).

---

## Second-pass review (if required)

**Reviewer:** echo (Phase-5 independent pass)
**Independent read of the artifact: concern → resolved**

Concerns raised, with resolutions:

- **Misleading resume ack on failure.** In `src/commands/server.ts` the "keep watching" handler `await`ed `fetch` to `/commitments/:id/resume` inside a `try`/`catch` that only `console.warn`'d on throw, never checked the HTTP response, and then unconditionally posted `⏳ resumed N watcher(s) on this topic.` to the user. A 404 (not paused / terminal), a 5xx, or a thrown fetch (server restart, partial outage) would all result in the user being told the beacon resumed when it did not.
  **Fix applied:** the handler now inspects `response.ok` per call, counts successes, and tailors the ack: `⏳ resumed N watcher(s)` on full success, `⏳ resumed X of Y watchers — N didn't resume` on partial success, `⚠️ couldn't resume the watcher(s) on this topic — try again or open the dashboard` on total failure or fetch throw.
- **Cold-mirror write of `consecutiveUnchanged` had no consumer.** The cold mirror was written every fire but never consulted by `fire()` or the threshold check (which uses `hot.consecutiveUnchanged`). Write amplification on the CAS queue with no benefit and a footgun for a future reader.
  **Fix applied:** dropped the per-cycle cold write. The field is now written only at the pause boundary (with a comment in `autoPause()`) and on resume (set to 0). The schema field carries a docstring marking it as a non-authoritative observability mirror — hot-state is authoritative during a live run.

Lower-priority observations (not blocking):
- Over-match on "keep watching": "I'll keep watching the build logs", "good — keep watching for the alert" both resume any paused beacons on the topic. Cost is bounded (one more heartbeat, re-pauses) and matches the artifact's analysis. Acceptable.
- `beaconSuppressed` × `beaconPaused` interaction: traced through — `fire()` early-exits on `beaconSuppressed` before reaching the auto-pause branch, so the two flags are mutually exclusive within a single fire. `schedule()` correctly rejects when either is set. No race.
- Backwards-compat for existing commitments: `hot.consecutiveUnchanged` initializes to 0 in `loadHotState`'s defaults block (not undefined/NaN), and `beaconAutoPauseAfterUnchanged ?? defaultAutoPauseAfterUnchanged` falls back cleanly. Confirmed safe.
- Spec line 161 ("suggest, don't auto-close"): this change is auto-PAUSE (`status` stays `pending`, resumable, no delivery semantics). Does not violate.

---

## Evidence pointers

- Originating user report: Telegram topic 9429 ("progress update bug"), 2026-05-12.
- Withdrawn runaway commitments providing the live reproduction: CMT-381, CMT-382, CMT-383 on topic 9210.
- Spec extended (not violated): docs/specs/PROMISE-BEACON-SPEC.md (auto-pause is a new non-terminal suppression; auto-close-on-reply explicitly NOT added per spec line 161).
