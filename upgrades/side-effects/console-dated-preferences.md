# Side-Effects Review — dated learned preferences (GET /preferences + Learned page)

**Version / slug:** `console-dated-preferences`
**Date:** `2026-11-14`
**Author:** `echo`
**Second-pass reviewer:** `not required`

## Summary of the change

Adds a read-only `GET /preferences` route that returns the learned preferences as structured entries (`dedupeKey`, `learning`, `recordedAt`, `confidence`, `dedupeCount`, optional `origin`, optional `textRedacted`) plus `total`, `truncated` and `scope`. It reads the same sources, with the same precedence and the same `monitoring.correctionLearning.enabled` gate, as the existing `GET /preferences/session-context` (foundation union, then the WS2.1 merged view, then the own store). A new pure module `src/core/PreferencesListView.ts` builds the entries: it never serves `violationPattern`, `provenance` or replication bookkeeping, runs every `learning` through the existing credential scrubber (`redactForLiveTail`), sorts newest first and caps at 500. The console Learned page (`dashboard/console/learned.js`, `learned-model.js`) now reads this route and shows when each preference was last seen, a "New this week" mark, and the machine that learned it when there is more than one machine; it falls back to the old session-context parse when an older server answers 404. Agent awareness: one CLAUDE.md template line, one `migrateClaudeMd` bullet (content-sniffed), and one CapabilityIndex endpoint line. Redoes the "structured preferences" piece of closed PR 2377 against current main.

## Decision-point inventory

No decision point is added or changed. The route is a read; the only gate is the existing feature flag, reused unchanged.

---

## 1. Over-block

No block/allow surface — over-block not applicable. The route answers 503 exactly when the sibling session-context route does.

---

## 2. Under-block

No block/allow surface — under-block not applicable. For leakage: the scrubber is the same one replication uses, so a credential shape it does not recognise would also pass the existing session-context block; this route does not widen that.

---

## 3. Level-of-abstraction fit

Right layer. The formatting for the session-start hook stays in `PreferencesManager`; the console needed structured fields, so a separate pure view builder sits next to it rather than the page parsing prose. It reuses the existing readers (union reader, merge, store) instead of adding a new one.

---

## 4. Signal vs authority compliance

- [x] No — this change has no block/allow surface.

It only reads and displays. Nothing here gates a message or an action.

---

## 4b. Judgment-point check (Judgment Within Floors standard)

No new static heuristic at a competing-signals decision point. "New this week" (seen once in the last 7 days) is a display label, not a decision.

---

## 5. Interactions

The route shares its gate and source precedence with `/preferences/session-context`, so the page and the injected block cannot disagree about what is kept. Express matches `/preferences` exactly, so it does not shadow `/preferences/session-context`. Memory privacy: a memory-boundary session token is refused by the default-deny `memorySessionGuard` (the route is not on its allow-list), the same as the session-context route; the owner bearer token and the console are unchanged. Three existing Learned-page DOM tests gained a `/preferences` fixture so they exercise the new read instead of a failed one.

---

## 6. External surfaces

New route on the agent API (owner bearer token only). The Learned page shows dates and a "New this week" pill. The phone app's `/mobile/learned` is unchanged. No timing dependence beyond "this week" being relative to the viewer clock.

---

## 6b. Operator-surface quality (Operator-Surface Quality standard)

1. **Leads with the primary action?** Yes. The page is read-only; the preference cards stay first in their section, the date sits in the existing sub line, so nothing new is pushed above them.
2. **Zero raw internals as primary content?** Yes. The machine is shown by its pool nickname only; an origin the pool does not name is not shown at all (never a raw machine id). The dedupe key stays in the existing collapsed "details" line.
3. **Destructive actions de-emphasized?** No destructive action on this page; unchanged.
4. **Plain language + phone width?** "last seen Oct 25 · seen 3 times · sure", "New this week". The pill is a small inline element in the card column; no new wide element.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

**proxied-on-read / replicated, inherited.** The route follows the session-context read exactly: with the foundation union on it serves every machine's variants (each stamped with its origin); with the WS2.1 pool on it serves the merged view stamped with the winning machine; otherwise this machine's own store (stamped with this machine when its mesh id is known). `scope` says `mesh` or `local`. No notices, no durable state, no URLs. **Status surfaces:** CapabilityIndex `correctionLearning` gains one endpoint line; its `enabled` verdict is unchanged (this machine's config).

---

## 8. Rollback cost

Pure code change. Revert and ship a patch. No persistent state is written. A rolled-back server answers 404 on `/preferences` and the page already falls back to the session-context parse, so there is no user-visible break during the rollback window.

---

## Conclusion

Small, read-only, reversible. The review kept the machine name off when the pool cannot name it (the old PR showed the raw id) and kept the session-context fallback so a mixed-version pool still renders the page. Clear to ship.

---

## Evidence pointers

- `tests/unit/console-dated-preferences.test.ts` (list builder, page model, awareness line, migration once-only, jsdom render + 404 fallback)
- `tests/integration/preferences-list-route.test.ts` (401 / 503 / empty / dated entries / scrubbing)
- `tests/e2e/preferences-list-alive.test.ts` (200 on the AgentServer boot path, 503 when off)

---

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect — not applicable.
