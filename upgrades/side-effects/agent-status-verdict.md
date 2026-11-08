# Side-Effects Review — unsorted items are notes on a running agent; "unsure" only for a failed reading

**Version / slug:** `agent-status-verdict`
**Date:** `2026-11-07`
**Author:** `Echo`
**Second-pass reviewer:** `not required`

## Summary of the change

Tier 1, 7 files.

- `src/monitoring/healthIssues.ts`: the verdict no longer maps unsorted items to `unsure`. It is `attention` (something affects the person), else `unsure` only when the /health body is unreadable, else `running` (unsorted, internal or hidden items), else `healthy`. The headline counts notes.
- `src/server/mobileHealthRoutes.ts`: the 500 answer carries `verdict: 'unsure'`, a `reason` and a plain `detail`.
- `dashboard/console/health-model.js`: an older server's unsure, with nothing affecting the person, reads running with a note count.

Asked for by Justin in topic 134088 on 2026-11-07 at 13:03 ("so many agents just say can't tell"). The app side is on app branch `echo/agent-status-robust`.

## Decision-point inventory

The verdict is a display label read by the phone's dot and the dashboard. It is **modified**: unsorted items no longer produce `unsure`. It gates nothing.

---

## 1. Over-block

No block/allow surface.

## 2. Under-block

An unsorted note that does affect the person no longer turns the dot grey. It shows as "Running · N notes" with the note listed. Previously it showed as "Can't tell", which hid the agent's actual state. Notes still keep the agent off "Healthy".

## 3. Level-of-abstraction fit

This sits in the single summarizer both surfaces read.

## 4. Signal vs authority compliance

The verdict is a signal for display; it is not an authority.

## 4b. Judgment-point check (Judgment Within Floors standard)

There is no judgment point.

## 5. Interactions

- **Counts and hidden rows:** unchanged.
- **Older apps:** they read `running` as "Running", which is correct. They no longer show "Can't tell" for answering agents.
- **Health route failure:** the 500 answer gains fields (`verdict`, `reason`, `detail`); it is still a 500.

## 6. External surfaces

The `verdict` and `headline` values on `GET /mobile/health-issues` change for agents with unsorted items, and the failure body gains fields.

## 6b. Operator-surface quality (Operator-Surface Quality standard)

This is the improvement itself: grey is reserved for genuinely unknown, and "unsure" carries its reason.

## 7. Multi-machine posture (Cross-Machine Coherence)

Machine-local by design and unchanged: each machine's reading of its own /health.

## 8. Rollback cost

Pure code: revert and ship a patch.

---

## Conclusion

Clear to ship.

## Second-pass review (if required)

Not required.

## Evidence pointers

Unit tests (89 pass) and the integration tests listed in the release note.

---

## Class-Closure Declaration (display-only mirror)

- **defectClass:** `unbounded-self-action`
- **closure:** `n/a` (negative declaration)
- **reason:** no action is taken. The change only computes a status label and its words.
