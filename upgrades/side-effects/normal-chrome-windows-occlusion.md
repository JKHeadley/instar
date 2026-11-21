# Side-Effects Review — Windows normal-Chrome occlusion fix and ERR page-not-rendering

**Version / slug:** `normal-chrome-windows-occlusion`
**Date:** `2026-11-19`
**Author:** `echo`
**Second-pass reviewer:** `not required (no messaging, session-lifecycle, gate or sentinel surface; internal + cross-model spec review ran)`

## Summary of the change

Tier 1 (small, reversible): 7 source/test/config files plus a fixture, spec, ELI16, report and release note; roughly 250 changed lines of code and test. Three spec review rounds (the Tier-1 cap), each with an internal reviewer, a cross-model (codex) pass and the code-backed conformance gate. ⚠ Three rounds is at the top of the Tier-1 range: round 1 and 2 each found a real migration or wording defect (note placement; the launch-row edit that kept the replace-whole branch from ever firing), so the rounds were earned, not ceremonial. `native-drive.ps1` (Windows normal-Chrome driver) always launches Chrome with `--disable-features=CalculateNativeWinOcclusion`; page reads that find no page Document while the title names a site recheck once after a second, then answer `ERR page-not-rendering` (exit 2) instead of Chrome UI strings; `text` on a blank or new tab adds a stderr note that only Chrome's own UI was read; `attach` warns when the bound Chrome lacks the flag. The `/normal-chrome-browser` skill text gains a Windows blank-page note, a Recovery quick list row and a flag sentence in the `launch` row, delivered to installed skills by `migrateNormalChromeWindowsBlankPageNote` (three anchored, guarded edits; an untouched previous copy ends byte-identical to a fresh install, tested against a fixture of the real previous text). Hash pins move in the unit test and the blocking-decision baseline.

## Decision-point inventory

- `native-drive.ps1 Assert-NotBlankSite` — add — a read that would return wrong data (toolbar strings as page text) now fails with a named token. Signal to the calling agent; gates no message, session or other agent.
- `native-drive.ps1 attach` — modify — adds a stderr warning; exit code and binding unchanged.
- `ND_CHROME_FLAGS` allowlist — pass-through (unchanged).

---

## 1. Over-block

`text` on a site whose Document element is absent for more than the one-second recheck (a very slow page) now exits 2 instead of returning UI strings with 0. The neutral message says to wait and retry; callers already poll on exit 2 for `editfields`. A real page whose title is literally "New Tab" or "about:blank" and which also has no Document keeps the old behaviour (no over-block, a narrow under-report instead). Previously find/editfields already returned 2 in all these cases, so their exit codes do not change; only the message is more specific.

## 2. Under-block

- A Chrome started before this update keeps the occlusion behaviour until restarted; covered by the `attach` warning and the named error, not fixed automatically (the driver never kills a browser it did not start).
- A page that renders but publishes a Document with no text is not detected (out of scope; unchanged).
- The "flag present, still not drawn" branch was not reproduced live; it is covered by static tests only.

## 3. Level-of-abstraction fit

Right layer: the launch arguments and the UIA read live in the driver; the wrapper passes stderr through unchanged. The skill carries the explanation. No higher gate exists for "is the page readable"; this is the driver reporting its own read truthfully.

## 4. Signal vs authority compliance

- [x] No — this change has no block/allow surface over agent behaviour. It changes what a read returns (a named failure instead of wrong data) and adds a warning. The blocking-decision baseline keeps the file as content-pinned non-blocking, with its reason text updated to name the new read failure.

## 4b. Judgment-point check

No new static heuristic at a competing-signals decision point. The read-result classification is enumerable (Document present or not; title names a site or not; flag on the command line or not), listed in the spec's Decision points section.

## 5. Interactions

- **Shadowing:** `Assert-NotBlankSite` runs before the existing `page document not found` failure in Find-ByName/Get-PageEdits and returns early when the title is blank, so the old message still fires for blank tabs.
- **Double-fire:** none. The wrapper's unknown-outcome latch treats any successful read as clearing; a `page-not-rendering` exit 2 does not clear it, same as the old exit 2.
- **Races:** the title and Document are read moments apart; a page finishing its paint in between yields the old success path. Harmless.
- **Migrations:** the new skill-note migration runs after `migrateNormalChromeBrowserSkill` and `migrateAccountActionSafetySkill`; a v1/v2 copy replaced whole already carries the note (tested in the real order).

## 6. External surfaces

- Other agents on the machine: none (per-agent binding unchanged).
- Install base: Windows agents get the new driver on update (always-overwrite installer) and the skill note appended once. macOS/Linux unaffected (the driver refuses off Windows via the wrapper).
- Chrome: one extra launch switch; it changes rendering of covered windows only. Not a debugging or automation switch.
- Operator surface: none.

## 6b. Operator-surface quality

No operator surface — not applicable.

## 7. Multi-machine posture

Machine-local by design: the driver acts on the local Windows desktop's Chrome; no durable state, no notices, no URLs.

## 8. Rollback cost

Revert the commit and ship a patch: the next update overwrites the driver with the old bytes. The appended skill note would remain in installed copies (harmless text describing a token the old driver never emits). No data migration.

## Conclusion

Clear to ship. Review changes: removed the "Untitled" title carve-out, softened the cause attribution to "likely" (conformance gate), and the round-1 design findings listed in the convergence report were folded into the spec and driver before commit.

## Second-pass review (if required)

Not required.

## Evidence pointers

Spec Evidence section (live Mama PC runs 2026-11-19); `tests/unit/normal-chrome-browser-skill.test.ts`; `tests/unit/PostUpdateMigrator-normalChromeBrowser.test.ts`.

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect — not applicable. The defect is a runtime behaviour of Chrome on Windows (occlusion tracking) that a shipped helper script did not account for; no LLM prompt, hook, config, skill or standards text was wrong. The skill text gains a note but was not incorrect. No self-triggered controller is added or modified.
