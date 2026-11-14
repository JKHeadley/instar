# Side-Effects Review — native "Paste to a session" sheet in Sessions

**Version / slug:** `console-native-paste-sheet`
**Date:** `2026-11-14`
**Author:** `echo`
**Second-pass reviewer:** `not required`

## Summary of the change

Adds the native paste sheet that closed PR 2377 intended, inside the console Sessions page, over the existing `/pastes` routes (no server change). `dashboard/console/paste-model.js` holds every decision, pure and unit-tested: the character and token count, the targets (this machine's conversations first, most recently active preselected and named; scheduled jobs never; "the next session that starts" when nothing runs here), the exact `POST /pastes` body, the answer in words (delivered / waiting / failed with the text kept), live `paste_delivered` / `paste_acknowledged` events, the Recent pastes list (newest 20, this machine only) and the asked-once delete. `dashboard/console/paste.js` renders the sheet. `sessions.js` gains a "Paste to a session" button under the list, a "Paste long text" item in a local session's "⋯" menu (target fixed), and one line that hands each socket frame to the sheet. A stored paste only reaches this machine's sessions, so a session on another machine is offered as "Open that session" (its own message box, which already carries drafts and delivery answers) instead of the old PR's typing-over-the-stream path, so the sheet adds no second input route.

## Decision-point inventory

No decision point is added or changed. The server's `/pastes` routes (rate limit, size limit, target pick) are used unchanged.

---

## 1. Over-block

No block/allow surface — over-block not applicable. The page refuses to send only empty text, a label over 256 characters, or a target on another machine (said in words, with the button that opens that session).

---

## 2. Under-block

No block/allow surface — under-block not applicable. The sheet cannot stop someone pasting a password; it says "Don't paste passwords or keys." the same as the legacy tab.

---

## 3. Level-of-abstraction fit

Right layer: a page over existing routes, with decisions in a pure model like every other console page. Long text for another machine goes to that session's composer, which already owns remote input, rather than a parallel path in this sheet.

---

## 4. Signal vs authority compliance

- [x] No — this change has no block/allow surface.

---

## 4b. Judgment-point check (Judgment Within Floors standard)

No new static heuristic at a competing-signals decision point.

---

## 5. Interactions

Uses `POST /pastes`, `GET /pastes`, `DELETE /pastes/:id` as the legacy Send content tab does (bearer token; the server's 10-per-minute limiter applies). `pasteOnMessage` reads only `paste_delivered` / `paste_acknowledged` frames and only while the sheet is open; the Sessions page keeps handling every frame itself. Open PRs 3100 and 3103 also edit `sessions.js`; this change touches four small, separate spots (an import, one line in `onMessage`, one button under the list, one item in the "⋯" menu plus a helper), so a merge either way is mechanical.

---

## 6. External surfaces

The Sessions page shows a new quiet button and a sheet. Pastes are stored on this machine for the paste system's retention (7 days by default), as before. No new route.

---

## 6b. Operator-surface quality (Operator-Surface Quality standard)

1. **Leads with the primary action?** Yes. The sheet opens on the target, the text box and Send; Recent pastes is collapsed below.
2. **Zero raw internals as primary content?** Yes. Targets are named by their conversation name and how recently they were active; statuses read "delivered", "waiting for a session", "read by the session".
3. **Destructive actions de-emphasized?** Delete is a quiet button inside each collapsed Recent row and asks once ("Delete this paste? The session keeps what it already read.") before acting.
4. **Plain language + phone width?** Full-width controls in the sheet, 44px tap targets, the text box wraps; counts read "12,400 characters, about 3,100 tokens".

---

## 7. Multi-machine posture (Cross-Machine Coherence)

**machine-local BY DESIGN.** The paste store is this machine's (pastes are files delivered to a local tmux session), so the sheet lists and sends only here and says so ("on this machine only"). A session on another machine is reached by opening it, whose composer relays input to its own machine. No notices, no new durable state beyond the existing store, no generated URLs. **Status surfaces:** none.

---

## 8. Rollback cost

Pure dashboard change; revert and ship a patch. Pastes already stored stay in the paste store and keep their retention; the legacy tab still lists them.

---

## Conclusion

Small and reversible. The review replaced 2377's typing-into-another-machine path with "Open that session", because main's composer now owns remote input with durable drafts and delivery answers; keeping both would be two ways to send the same text with different guarantees. Clear to ship.

---

## Evidence pointers

- `tests/unit/console-paste-sheet.test.ts` — every model decision, and the shipped console in jsdom: the sheet from the list, a send with the exact body, a live delivery event, a refused send keeping the text, delete asked once, another machine opened instead, the "⋯" item only for this machine's sessions.
- `tests/integration/console-paste-sheet-routes.test.ts` — the model's own body POSTed to the real `/pastes` routes with a real PasteManager; answers read back through the model's words.

---

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect — not applicable.
