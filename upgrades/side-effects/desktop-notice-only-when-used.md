# Side-Effects Review — Remote Desktop permission card only after recent use

**Version / slug:** `desktop-notice-only-when-used`
**Date:** `2026-11-20`
**Author:** `echo`
**Second-pass reviewer:** `not required (narrows a notify path; no block/allow, session lifecycle or gate authority)`

## Summary of the change

`DesktopHelperPermissionNotice` raised a HIGH, needs-user Attention item ("<Mac>: Remote Desktop needs its Mac permission again") whenever the desktop helper lacked macOS permission after a helper change, whether or not anyone uses Remote Desktop on that Mac. The operator (topic 134088, 2026-11-20) got that card for the Mac Studio, which has no desktop session on record in the 30-day audit window, and asked that cards only cover features the user actually uses. The notice now takes a `recentlyUsed()` dependency and raises only when it is true; it is checked before `claim()` so an unused agent leaves the notice to a sibling agent on the same Mac that is used. `DesktopAccessAudit.hasStartWithin(windowMs)` answers it from the existing local audit (`logs/desktop-access-*.jsonl`, `kind: "start"`). `AgentServer` wires a 30-day window. Clearing is unchanged: a granted probe still closes any open card. Files: `src/core/DesktopAccessAudit.ts`, `src/core/DesktopHelperPermissionNotice.ts`, `src/server/AgentServer.ts`, two unit test files. Tier 1: 3 source files, ~45 LOC, one implementation pass.

## Decision-point inventory

- `DesktopHelperPermissionNotice.check` raise condition — modify — adds "used recently" to the conditions for raising the card. No block/allow authority over anything; it only decides whether to notify.

---

## 1. Over-block

No block/allow surface. The notify path now stays quiet in one legitimate case: someone wants to start using Remote Desktop on a Mac for the first time in 30 days and permission is missing. That person learns it at the moment of use: the desktop page and the Machines page already show the probe's unavailable reason (`desktopProbeUnavailableReason`) with the same fix steps, and once a session starts the next 15-minute check raises the card.

## 2. Under-block

No block/allow surface. Use recorded on a different agent home on the same Mac counts only for that agent; that agent then raises the card (it reaches `claim()` first because unused agents no longer claim). Use older than 30 days is not counted, by design.

## 3. Level-of-abstraction fit

Right layer: the notice owns the "is this worth the operator's attention" decision, and the audit already records desktop sessions per agent. No new store. The broader principle (relevance before any Needs-you card) belongs to every producer; this change applies it to the producer that misfired and the general ask is filed as operator feedback for the Needs-you model.

## 4. Signal vs authority compliance

Complies. The notice is a signal producer with no blocking authority; this makes it emit less. The usage check is a plain read of local evidence, used only to suppress a notification, never to block an action.

## 4b. Judgment-point check

Not a competing-signals decision point: "has a desktop session started here in 30 days" is a factual read, not a judgment among signals. A static rule is appropriate.

## 5. Interactions

- `claim()`/`release()` marker shared by agents on one Mac (`DesktopHelperRetention`): usage is checked before claim, so an unused agent no longer takes the claim and starves a used sibling. Covered by a unit test.
- Attention lifecycle: an already-open card still closes when permission returns (unconditional clear path). An open card on an unused Mac is not closed by this change; it ages out under the lifecycle's existing expiry, and the operator can close it (the Studio card was closed by hand 2026-11-20).
- Machines page `desktopPermissionFixes` reads open cards: with no card it shows nothing extra; the machine's own readiness line still says not ready.

## 6. External surfaces

Operator-visible: fewer Needs-you cards / Telegram attention posts. No route, config or wire format changes. No dashboard file touched.

## 7. Multi-machine posture (Cross-Machine Coherence)

Machine-local by design: Remote Desktop permission is a property of one Mac, the audit is recorded on the Mac whose screen was used, and the notice runs per machine. No replication needed; cards still carry `machineId` for the pooled Attention view. No status surface changed.

## 8. Rollback cost

Revert the PR. No state, migration or config to repair.

## Conclusion

Narrows one notifier to the operator-stated relevance rule; safe, local, reversible. Ship.

## Evidence pointers

- `tests/unit/DesktopHelperPermissionNotice.test.ts` — no card and no claim when unused; card once used; clear still runs when unused.
- `tests/unit/DesktopAccessAudit.test.ts` — `hasStartWithin` window edges, stop-only logs, torn lines.
- Live: Mac Studio had no `desktop-access-*.jsonl` file and an OPEN card `desktop-helper-permission:m_9a4a…:91e6…` (closed by hand 2026-11-20 21:17 PST).

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect — not applicable. The notifier is a self-triggered notify path; this change only removes firings, so the existing bound (one card per machine + helper hash, held by the claim marker) still holds and no new control loop is added.
