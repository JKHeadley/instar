# Side-Effects Review — Reap Log Skipped Disposition

**Version / slug:** `reap-log-skipped-disposition`
**Date:** `2026-05-29`
**Author:** `instar-codey`
**Second-pass reviewer:** `not required by tooling`

## Summary of the change

This change normalizes Reap Log entries so both reaped and skipped rows expose `disposition`. Skipped rows keep their existing `skipped` detail and add `disposition: skipped:<reason>`. The reader also backfills this field for old skipped log lines.

## Decision-point inventory

- `ReapLog.recordSkipped()` — add an outcome disposition when writing skipped rows.
- `ReapLog.read()` — normalize legacy rows in memory.
- Reap Log route tests — assert skipped rows include the normalized disposition.

---

## 1. Over-block

No blocking behavior changes. This is read-only audit normalization.

---

## 2. Under-block

No reap authority behavior changes. Protected-session, lease-holder, KEEP-guard, and in-flight decisions are untouched.

---

## 3. Level-of-abstraction fit

The Reap Log audit sink owns the durable row shape, so it is the right layer to normalize old and new entries. Route handlers continue to read through the existing sink.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — this change has no conversational block/allow surface.

This output is explanatory observability only.

---

## 5. Interactions

- **Shadowing:** None. Session termination authority remains in `SessionManager`.
- **Double-fire:** None. One terminate attempt still creates at most one Reap Log row.
- **Races:** None added. Reads normalize returned objects without rewriting the JSONL file.
- **Feedback loops:** Positive loop: agents and dashboards can answer "what happened?" without special-casing skipped rows.

---

## 6. External surfaces

The `GET /sessions/reap-log` response now includes `disposition` on skipped rows. Existing clients using `skipped` continue to work.

---

## 7. Rollback cost

Rollback is a normal code revert. Newer log rows contain an extra JSON field that older readers ignore.

---

## Conclusion

The change is clear to ship. It fixes a real schema inconsistency found during Reap Log dogfooding without changing reap behavior.

---

## Second-pass review (if required)

**Reviewer:** `not required by tooling`
**Independent read of the artifact:** `not required`

---

## Evidence pointers

- `tests/unit/reap-log.test.ts`
- `tests/integration/reap-log-route.test.ts`
- `tests/e2e/reap-log-lifecycle.test.ts`
