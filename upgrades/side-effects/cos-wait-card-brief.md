# Side-Effects Review — Chief of Staff wait cards: a structured brief and a clean need

**Version / slug:** `cos-wait-card-brief`
**Date:** `2026-11-18`
**Author:** `Echo`
**Second-pass reviewer:** `not required`

## Summary of the change

Justin called the Work Board card detail for a Chief of Staff wait card "pretty terrible" (topic 134088, 2026-11-18 20:05 PST): one prose `need` blob with Markdown backslash escapes ("\(Claude Code, Codex, ...\)"), an internal "(wait c5c23e80)" id, a raw "2026-11-17 22:15:31 UTC" time and statuses glued as "item.: not known". This change:

1. Adds an optional, **non-material**, server-writer-only card field `brief` = `{ask, goal?, checks?: [{text, status: passes|needs-you|unknown|fails}], chiefSaid?, waitingSince?}` (`src/core/WorkCardStore.ts`: type, schema validator `vBrief`, known field, fold; `src/core/WorkBoardService.ts`: create/edit field lists, `brief-not-allowed` for any non-server writer, credential scan of its strings; `src/core/workBoardViews.ts`: `cardJson` serves it when present — this covers `GET /work-board`, `GET /mobile/work-board` and the single-card reads).
2. `composeWaitCard` (`src/core/ChiefOfStaffWaitCards.ts`) returns the brief and writes a clean `need`: plain text with no backslash escapes (link/image/tag syntax is broken with a space or a look-alike bracket instead), "- item (state)" checklist lines, "Waiting on you since Nov 17, 2026, 10:15 PM UTC." with no wait id. `ask` comes from the check note when it names a decision for the owner, else "Confirm this project is done." / "Answer what the project needs next."
3. Sync carries the brief to existing cards: an open card picks up the new text + brief on the first sync after a newer Chief of Staff record (the existing fence); a finished card gets a brief-only, non-material write.
4. The wait id used to make two waits' material always differ. Without it, when a new wait on a finished card would read word for word like the old one, the line reads "Waiting on you again since …" (alternating), so the reopen still changes the material and voids the old finish.

Tier 1 (display-only fields, no new authority; a revert undoes it). Size: 7 source/test/doc files, ~275 insertions. Effort: no spec review rounds (spec amended in place), first commit attempt.

## Decision-point inventory

- Wait-card reopen (a new wait voids the old finish via a material change) — modify — the material discriminator moves from the visible wait id to the wait time plus the "again" alternation.
- `WorkBoardService.ownershipRefusal` — modify — adds `brief-not-allowed` for non-server writers, mirroring the existing `mirror-not-allowed`.
- No other decision point; the brief itself is display only.

---

## 1. Over-block

A route caller (agent or person) that sends `brief` on a card is refused with 400 `brief-not-allowed`. No caller sends it today; it is the same rule `mirror` has. No other over-block surface.

## 2. Under-block

`waitAsk` reads the note with two plain patterns ("the owner/you (to) choose|decide|pick|select|approve|confirm …", "your/the owner's decision|choice|answer on|about|whether …"). A note that names a decision in other words gets the generic "Answer what the project needs next." — a weaker ask, never a wrong one, and `chiefSaid` still carries the note verbatim. The pattern stops at the first `.`, `?` or `!`, so a note like "choose v1.3 or v2" shortens to "Choose v1."; a cosmetic risk only, nothing decides on it.

The inert-text change no longer escapes emphasis, code or heading characters. A client that renders `need` as Markdown may now show `*x*` as emphasis; links, images and HTML tags stay broken. Bare URLs auto-link in GFM as they did before.

## 3. Level-of-abstraction fit

The brief is composed where the card text is already composed (one pure function of the wait) and stored as a card field like `whyYou`/`covers`/`mirror`, served by the one card serializer every read uses. Clients format `waitingSince` in the reader's zone. No new layer.

## 4. Signal vs authority compliance

No blocking authority added. The brief is display only and outside the material hash; only a person's tap approves anything on the board. The one refusal added (`brief-not-allowed`) is a schema-ownership rule identical to `mirror-not-allowed`, not a judgment. Reference: `docs/signal-vs-authority.md`.

## 4b. Judgment-point check (Judgment Within Floors standard)

No new static heuristic at a competing-signals decision point. `waitAsk` is a deterministic text summary for display; it gates nothing and its fallback is a safe generic sentence.

## 5. Interactions

- **Material hash / approvals:** `brief` is not in `MATERIAL_FIELDS`, so writing it never moves `lastMaterialIdx`, never voids evidence, a claim, a finish or an approval. Verified by a unit test (hash unchanged after a brief edit).
- **One-time text rewrite of open cards:** an open wait card written by the old build gets its new `need` on the first sync after a newer Chief of Staff record. `need` is material, so this is one material edit per open card — the same kind the sync already makes whenever a done item's state changes. Open wait cards are carried by the owner and not outward, so they need no Approve (`approvalRequired: false`, verified on the live Engine Feature Optimization card) and hold no counted evidence until they close; nothing is reset that matters. It happens once per card: the text is a pure function of the wait, so later syncs compare equal and write nothing (unit test).
- **Finished cards:** not rewritten (unchanged rule); only a brief-only non-material write, once.
- **Close path:** the close evidence wording (`clearingText`) is deliberately unchanged, so a retried close under the same deterministic record key writes the same text across builds.
- **Needs-you linking (`covers`)**, the fence (`mirror`), the soft cap and the daily ceiling are untouched.
- PR #3475 (needs files) is not touched.

## 6. External surfaces

`cardJson` gains an optional `brief` key (absent when a card has none). App builders are coding against this exact shape in parallel. Older clients ignore unknown keys and keep reading `need`, which is now plain. No new messages, no notifications.

## 6b. Operator-surface quality (Operator-Surface Quality standard)

No dashboard renderer/markup file is changed. The card text an operator reads improves on each criterion: the ask leads (`brief.ask`), no raw ids or raw UTC in the text, nothing destructive added, plain language ("not checked yet", "needs your judgment").

## 7. Multi-machine posture (Cross-Machine Coherence)

Replicated: `brief` rides the card's existing replicated `created`/`edited` records (the work-card record store), written only by the Chief of Staff lease holder. The text is machine-independent: the human time is always written in UTC and says so, so two lease holders never rewrite each other's text by zone. An older machine's envelope validator drops the unknown `brief` field (counted) and keeps the record, so it shows the card exactly as today; its own sync composes the old text, and a mixed pool can flip `need` between the two wordings only when the lease moves between versions during the upgrade window — bounded by the fence (writes only on a newer Chief of Staff record) and ending when every machine has updated.

## 8. Rollback cost

Revert the PR. Cards that got a `brief` keep the field in their records; an older build drops it on read. Their `need` keeps the clean wording until the next newer check, when the reverted build rewrites it in the old wording (one material edit, as today). No data migration, no state repair.

## Conclusion

Safe to ship as Tier 1: display-only, additive, non-material, server-writer-only, forward and backward compatible across machines. The only behaviour change with a cost is one material rewrite per open wait card, which carries no approval or evidence.

## Second-pass review (if required)

Not required: no messaging block/allow, session lifecycle, compaction, gate, sentinel or watchdog surface.

## Evidence pointers

- `tests/unit/chief-of-staff-wait-cards.test.ts` — "the brief and a clean need" block: the screenshot card's exact brief and clean `need`; ask derivation; status mapping; store + `cardJson` carry the brief and the material hash is unchanged by a brief edit; only the server writer may set it; an old-format card gets the brief once on the next newer check, a finished one without reopening; a word-for-word repeat wait on a finished card still changes the material.
- Also run: `tests/unit/WorkBoardService.test.ts`, `tests/unit/work-board-cards-appear.test.ts`, `tests/unit/work-board-my-board.test.ts`, `tests/unit/work-board-wiring.test.ts`, `tests/unit/work-card-closeout.test.ts` — all green.

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect and no self-triggered controller added or changed — not applicable. (The sync is the existing Chief of Staff tick; this change adds one idempotent brief-only write inside it, bounded by the existing fence.)
