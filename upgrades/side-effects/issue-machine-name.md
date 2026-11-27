# Side-Effects Review — each health problem names its machine

**Version / slug:** `issue-machine-name`
**Date:** `2026-11-06`
**Author:** `Echo`
**Second-pass reviewer:** `not required`

## Summary of the change

Tier 1, 7 files, about 90 lines with tests. GET /mobile/health-issues (and the two choice routes, which return the same answer) now add `machine: { key, name }` to the answer and to every issue row (`withMachine` in src/server/mobileHealthRoutes.ts, a new optional `machine` dep wired in src/server/routes.ts). The key is `machineKey(meshSelfId)`, now exported from src/server/mobileOpsRoutes.ts so it matches GET /mobile/machines. The name is the verified pool nickname, else this computer's hostname with `.local` dropped, through `verifiedEntityName`. The dashboard Health card prints "On <name>" under the title, and Home's health row puts it first in its detail (dashboard/console/health.js, health-model.js `machineWords`). Operator request 2026-11-06 08:01 PST, topic 134088: "this doesn't specify which machine has the issue". Effort: one review pass, one commit attempt.

## Decision-point inventory

No decision-point surface: an additive, read-only display field. Nothing is blocked, filtered, gated or stored.

---

## 1. Over-block

No block/allow surface — over-block not applicable.

---

## 2. Under-block

No block/allow surface — under-block not applicable.

---

## 3. Level-of-abstraction fit

The field is added at the route, where the machine that answered is known, not inside `summarizeHealth`. That keeps the pure summarizer machine-agnostic and its tests unchanged. The name reuses the machines list's verified nickname and key instead of a new naming rule.

---

## 4. Signal vs authority compliance

Not a decision point. The field is information for the person, with no authority over anything.

---

## 4b. Judgment-point check (Judgment Within Floors standard)

No judgment point. It is a deterministic lookup with a safe absent case.

---

## 5. Interactions

- The quick-action routes return `...page(answer(raw))`, so their answers carry the machine too. The app and dashboard redraw from those answers; the extra field is ignored by older clients.
- Choices are keyed by issue `keys`, not by the row object, so the new row field cannot change what a choice binds to.
- The 5-second read cache is unaffected: the machine is added after the cached read, on each answer.

---

## 6. External surfaces

One new optional JSON field on an owner-only read. Older apps and dashboards ignore it. The name is a pool nickname or hostname that the owner already sees on the machines list. No id is exposed: the key is the same one-way hash the machines list already serves.

---

## 6b. Operator-surface quality (Operator-Surface Quality standard)

It makes an existing warning actionable: "someone at this Mac" now comes with which Mac. It adds one short caption line ("On Mac Studio") and no new controls.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

**Machine-local by design.** Each reading is built from the answering machine's own /health over loopback, so every problem in it belongs to that machine, and this change labels that truth. No status surface's scope changes: /mobile/health-issues stays this machine's reading, and the label now says so. No merged or pool read of health problems exists to extend. There are no notices, no durable state and no URLs.

---

## 8. Rollback cost

Pure code change: revert and ship a patch. There is no persistent state. During a rollback, users see the machine caption disappear.

---

## Conclusion

Clear to ship. The review confirmed the per-row label is truthful, because the reading is machine-local, and that a missing or failing name lookup leaves the answer exactly as before.

---

## Second-pass review (if required)

Not required: no gate, sentinel, session lifecycle or messaging decision.

---

## Evidence pointers

- tests/integration/mobile-health-issues.test.ts (2 new cases)
- tests/unit/console-health.test.ts (2 new cases)
- tests/e2e/mobile-health-issues-alive.test.ts (production wiring names a machine)
- All passed locally on 2026-11-06.
