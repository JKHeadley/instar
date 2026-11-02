# Side-Effects Review — Remote desktop through the ordinary Mac lock

**Version / slug:** `desktop-locked-screen`
**Date:** `2026-11-01`
**Author:** `echo`
**Second-pass reviewer:** `general-purpose subagent; result appended below`

## Summary of the change

Adds the code for opening a logged-in, locked Mac from a phone, shipped OFF on every machine. `PROVEN_MACOS_VERSIONS` is empty, so the enable route refuses every macOS until the real crash and Stop tests (P12, P15) pass on hardware. Tier 2+ by the size rule: a password path, about 1,800 lines across Swift, Node, the viewer and tests. The spec ran 10 review rounds and **did not converge**; the operator accepted building behind P12 and P15 ("Build", 18:11 PST 2026-11-01, topic 134088). The app's password sheet is on a local `instar-ios` branch, not shipped.

## Decision-point inventory

- Enable refused for an unproven macOS — add — a code-owned table, no config or route reaches it.
- `ready` at the shield — modify — only while the feature is active.
- Input allowlist, `unknown` view-only, refused replies — add — enforced in the helper and Node.
- `secretType` admission — add — positive state, relock owed, heartbeat, clean field, attempts.
- Grant end on outside unlock — add — no reserved attempt's Enter in the prior 15 s.
- `relock-pending` admission — add — runs only if a marker file exists.

---

## 1. Over-block

With the feature off, nothing. With it on, a new connection to a Mac waits up to 2 minutes after a password was used, and a person unlocking there in that window is relocked; the operator accepted this. `relock-pending` applies across agents on one Mac, and only when the store file exists.

---

## 2. Under-block

Stated limits, not gaps in this build: hostile same-user code, a hostile front at first contact, a browser box drawn by a hostile page, an unlock later than 2 minutes after Stop, and typing not being atomic with its checks. The round 10 fixes had no review, which is why P12 and P15 gate every Mac.

---

## 3. Level-of-abstraction fit

Durable duty state lives in the helper under `flock`, because it must outlive Node. Node decides admission and readiness. Retained-binary work stays in PR 2562; this change reads its `helperSource` and adds no second copy.

---

## 4. Signal vs authority compliance

All decision points are deterministic safety floors over identity, state and credential paths, classified `invariant` in the spec. There is no LLM and no brittle check over meaning. The lock reading yields `unknown` rather than guessing.

---

## 5. Interactions

- Grant retained helper: until PR 2562 lands `helperSource` is absent, so the password path reads `retained-helper-required`. Both change `MacDesktopHost.ts`, `DesktopHost.ts`, `types.ts` and the build script, so whichever lands second resolves small conflicts.
- The `-target` pin changes local helper builds. `BUILD_RECIPE` in PR 2562 hashes the recipe, so the second to land should include the target in it.
- The Swift source changed, so PR 2562's source hash moves and Macs need the helper grant once more.
- `input` now returns `void | { refused }`. Existing hosts return void, so they are unaffected.
- The reply parser accepts `refused` and `sealKey` only under locked mode. Off keeps today's strict parse and 128-byte limit.

---

## 6. External surfaces

New routes `/desktop/locked/status|settings|disable` and machine route `/api/desktop/operator-locked`. New viewer declarations `client` and `controlRecords`. A new `control` AEAD direction, sent only to viewers that declared it, so old viewers never see one. `begin` assertion bytes are unchanged. Probe output gains `osMajor`.

Operator-surface quality: the machine card leads with one plain sentence and one button, with no raw values, and works at phone width. The browser password form states its limit beside the box.

---

## 7. Multi-machine posture

Machine-local by hardware: lock reading, helper, markers, counters and disable describe one console. Status is proxied-on-read with `?scope=pool`, and a dark peer is listed in `failed`. A relock failure is raised by the target itself. The per-Mac state is shared by agents on that Mac.

---

## 8. Rollback cost

Revert the code. With no Mac enabled, nothing is live. A running guard would finish its duty; none can exist before enable. Inert leftovers are the `locked` folder and macOS permission rows.

---

## Honest gaps in this build

Not built, each already a stated part of the spec or its proof rows:

- The one-time notification after the next unlock.
- The viewer's 60 s countdown before the ceiling.
- Lock and unlock notifications as a corroborating input. They were optional; no rule depends on them.
- The real-hardware harness for P12 and P15, which needs the proof Mac and a person's macOS grant. Until it runs, the table stays empty.
- `relock` and `relock-guard` have never run: running them on this Mac would lock it, so tests cover the state verbs only.
- CGDisplayStream fallback, shield detection and secure-input reading compile but are unproven until P1 to P9.
- Windows and Linux report 503 at the status route rather than a named `locked-screen-unsupported`.

---

## Second-pass review

An independent reviewer read this artifact and the diff. It confirmed the feature cannot turn on with the empty table, then raised: "Concern raised: the viewer does not suppress the keyboard at the shield, so password keystrokes can enter Node; `secret` skips `validGrant`, so a Stop race can leave a live duty renewed to the ceiling; the sweep timer never starts at boot; and off still runs `sysadminctl` on the probe path."

All were fixed in this change, with its other items: per-probe tracking, retried owner notice, same-boot checks on retry and admission, typist kill retries, unreadable session as retry, trailing-bytes parse for off, left-unlocked producer check, dirty cleared after Enter, disable reaching other agents' grants, unreadable store fails closed, marker pruning, clear-dirty on unlock, busy refusal during a send, respawn backoff, and explicit file times. The reviewer did not re-read the fixes.

A second reviewer confirmed those fixes and raised: "Concern raised: the relock guard exits silently on a failed store read or a blank recorded session (`InstarDesktopHost.swift` `readMarker` callers and `marker-create`), so a password-unlocked Mac can stay unlocked with no relock and no notice." Fixed: a store read writes nothing, an unreadable store makes the guard lock and leave a file the sweep reports, `marker-create` refuses an unreadable session, the sweep timer starts before its read, and a Stop read before a send still reaches it.

A third, narrow check of the guard paths ended: "Concur with the review". Its one minor note, a sweep timer stopping with an untold failure file, was fixed.

## Class-Closure Declaration

`unbounded-self-action`, closure `guard`, enforcement `ratchet`, citing `tests/unit/self-action-convergence.test.ts`. Guard replacement caps at 3 per duty on a durable count, and helper respawn caps at 8 per request, then each fails loudly. Both are modeled in the ratchet with the state flapping on every tick.
