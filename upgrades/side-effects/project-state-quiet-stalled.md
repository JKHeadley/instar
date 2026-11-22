# Side-Effects Review — every project has a plain state (quiet / stalled / couldn't check)

**Version / slug:** `project-state-quiet-stalled`
**Date:** `2026-11-19`
**Author:** `echo`
**Second-pass reviewer:** `not required` (display-only read model; no gate, sentinel, lifecycle or messaging decision)

## Summary of the change

Tier 1, 7 source files plus one new test file, about 130 lines. Effort: no spec rounds (Tier 1), first commit attempt. The Work door's project read (`src/server/workProjectsRoutes.ts`) settles a row whose Chief of Staff verdict is `unknown` from facts the checks did read: `quiet` ("Quiet since …") or `stalled` ("Stalled since …", after max(48 h, 2 × cadence) with nothing happening and a done item open). `unknown` stays only for no check yet, an unreadable newest check, or checks that stopped landing, with the reason in `stateWords`. A judge-given `stalled` reads "Stalled since …". New row field `stateSince`. `ChiefOfStaffLoop.projectsOverview()` adds `lastProgressAt`, `lastEvidenceChangeAt` (from the check-events' evidence hashes, in the same union pass), `lastCheckUnreadable` and `cadenceHours`. `routes.ts` passes the agent's `timezone` for day words. Also: the console tone map gains `quiet`, the CapabilityIndex description and one awareness entry name the new words.

## Decision-point inventory

- Work door project state words — modify — which state name and words a row shows. Display only: no verdict, check cadence, restart, park, note or message reads these values. `rowExtras` (actions, waiting-on-you, stopped) still keys off the verdict's state.

---

## 1. Over-block

No block/allow surface — over-block not applicable.

---

## 2. Under-block

No block/allow surface. The analogous miss: "Stalled" for a project whose done list is plain words is measured from activity (conversation, run, session, commitments), not from progress, because the tracker cannot see progress there. A project that moved forward entirely off-record (no message, no run change) for two days would read "Stalled". That is the honest reading of what the tracker can see, and the ELI16 and awareness entry say so.

---

## 3. Level-of-abstraction fit

Right layer. The Work door read already owns the state words for every surface ("the server owns them so every surface says the same thing"). The facts come from the loop's existing fold of check-events; nothing re-derives them client-side.

---

## 4. Signal vs authority compliance

- [x] No — this change has no block/allow surface.

It renders existing check records as words. Nothing consumes `quiet`/`stalled` from this read to act.

---

## 4b. Judgment-point check (Judgment Within Floors standard)

No new static heuristic at a competing-signals decision point. The 48 h / 2 × cadence threshold only picks the label shown to a person; it gates no action. The Chief of Staff's own judged verdict, where one exists, always wins.

---

## 5. Interactions

- **Shadowing:** a judged verdict (moving, waiting-on-you, claims-done, drifting, done, paused, stopped-retrying) is never replaced; only `unknown` is settled.
- **Double-fire:** none; no events or notices.
- **Races:** `projectsOverview` reads one union snapshot as before; the new per-project check list comes from the same pass.
- **Feedback loops:** none; the loop never reads this answer.
- **Found while building:** a failed gather records `evidenceHash: 'x'.repeat(64)`, which the store's schema refuses (`SHA256_HEX_RE`), so gather failures leave no check record. The read handles that case by reading checks that stopped landing for the stalled threshold as "Couldn't check: no check has run since …" rather than "Stalled". The dropped record itself is filed to the feedback queue (loop behaviour, not part of this display change).

---

## 6. External surfaces

- Clients: `state` can now be `"quiet"` (new) and more rows are `"stalled"`. Every client already tolerates unknown values: iPhone/Mac `ProjectsData.tone` defaults to `unknown` and shows `stateWords`. `ConversationTree.chip` shows no chip for an unknown value. Android `ProjectChip` styles unknown values neutral and shows `stateWords`, and its tests already parse `"quiet"`. The dashboard maps `quiet` to its quiet tone in this change. `stateWords` is always present. `stateSince` is additive.
- `PROJECTS_SCHEMA_VERSION` stays 1 (additive).
- No operator-facing actions added.

---

## 6b. Operator-surface quality (Operator-Surface Quality standard)

`dashboard/console/projects-model.js` changes one tone mapping.

1. **Leads with the primary action?** Unchanged layout. The state chip still leads each row, and now carries words that answer "is it stuck?".
2. **Zero raw internals as primary content?** Yes. The words are plain ("Quiet since yesterday", "Stalled since Nov 13", "Couldn't check: no check has run since Nov 17"), with no codes or hashes.
3. **Destructive actions de-emphasized?** No destructive actions touched.
4. **Plain language + phone width?** Plain words, at most about 60 characters. The chip already wraps at phone width, and no layout changed.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

Replicated by the existing path: the facts come from the Chief of Staff's coherence-journal union (check-events from every machine), the same source the read already used. Any machine serving the read computes the same state from the same union. No notices, no new durable state, no URLs. Status surfaces: `/work/projects` and `/mobile/work/projects` rows only, whole-agent scope as before. The capability description changes in wording only.

---

## 8. Rollback cost

Revert the commit. No stored data, config or migration. During rollback the rows go back to "Not known yet".

---

## Conclusion

Clear to ship as a display-only Tier-1 change. The review changed the design once. The gather-failed record cannot land (schema refuses its hash), so a check that silently stops would otherwise make old reads look like "Stalled". Rows whose checks stopped landing now say "Couldn't check: no check has run since …".

---

## Evidence pointers

- Live data, 2026-11-19 16:40Z: `GET /work/projects` gave 8 unknown rows. `GET /chief-of-staff/projects/<key>` for each showed daily checks citing `run, reconciler, session, commitments, owner-last, agent-last, tail`, with `progressSeen: false` and every done item unreadable (no linked repos, plain-words items).
- `tests/unit/work-projects-quiet-stalled.test.ts` (14 pass). `work-projects-read`, `work-door-project-rows`, `console-project-rows` still pass (56).

---

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect — not applicable. The awareness entry is updated to describe new behaviour, not to fix a defective instruction.
