# Side-Effects Review — permission-prompt resolver: an unanswered menu is announced even under blank padding and a status line

**Version / slug:** `permission-prompt-abstention-silent`
**Date:** `2026-10-19`
**Author:** `Echo`
**Second-pass reviewer:** `required (a sentinel/floor detector is modified) — see below`

## Summary of the change

Silent-gate instance #7 (feedback-pipeline silent-gate sweep, G8). Two blocking menus on an autonomous session went unannounced for minutes while the PermissionPromptAutoResolver was on and ticking. Reproduced live (session `echo-canary-perm-prompt`, pane saved verbatim as `tests/fixtures/claude-code-model-switch-menu-pane.txt`): Claude Code's model-switch menu, 17 blank rows, one "✻ Waiting for API response · will retry in 2m 40s" line at the pane bottom. Three links failed, each measured against the deployed dist before the change (every detector returned null; the 5-row pre-gate was false):

1. `SessionManager` monitor loop: the resolver pre-gate read `captureMeaningfulTail(…, 5)` and the evaluate capture `…(…, 16)`, both of which count RAW rows (blank-inclusive). New `meaningfulNonBlankTail` (`src/core/paneText.ts`) + `captureMeaningfulNonBlankTailMaybeAsync`; the pre-gate regex is exported as `RESOLVER_PREGATE_RE` so the tested shape is the shape the loop uses. `captureMeaningfulTail` and its other callers are untouched.
2. `detectPersistingMenu` (Layer 3, observability only): `stripTransientTrailer` drops trailing lines matching `TRANSIENT_TRAILER_RE` (retry-wait line; Claude Code's permission-mode status bar) before the genuine-bottom test; its bottom window is `LAYER3_MENU_BOTTOM_WINDOW = 12` (was the shared 6). `detectApprovalPrompt` (Layer 2, the key-pressing layer) keeps its 6-line window, its ≥2-named-phrase requirement and its raw tail: byte-for-byte the same decisions.
3. Audit: Layer 3 now writes `menu-observed` on an episode's first tick and `menu-unanswered-terminal` on the raise (static names + structure digest only; never pane bytes). Before, an abstention left no row anywhere.

## Decision-point inventory

- `detectPersistingMenu` — **modify** — a wider observe-only detector; its only consumer raises one deduped attention item after 4 ticks.
- `detectApprovalPrompt` / `handleLayer2` — **pass-through** — unchanged (tests pin: the captured model-switch menu never matches Layer 2).
- Monitor-loop pre-gate — **modify** — same regex over non-blank rows.

## 1. Over-block

Nothing blocks. The widened Layer 3 can raise an attention item for a menu it previously missed; a false positive costs one deduped item after 4 consecutive ticks (≥20 s) and resets the moment the menu clears. A bare status bar under an idle prompt is tested not to match (no option lines). The second-pass review found a real false-positive shape (probe A: a numbered list inside a tool result, `⎿  1. …`, above the retry-wait line; probe B: a `│ 1.` quoted list above the status bar): closed by making the `≥2 numbered lines` fallback count only on an UNSTRIPPED tail — a real menu under a trailer always carries an affordance line. Both probes are now tests.

## 2. Under-block

- Only two trailer shapes are known (retry-wait, permission status bar). A host status line of another shape under a menu still declines silently; the new `menu-observed` row makes that visible the next time it happens.
- A real spinner ("✽ … (esc to interrupt)") under a menu still declines, by design: `isGenerating` is true and the session is working.
- The hook-"ask" dialog shape (the `rm` case) was not re-captured: the model used for the canary declined to run the unguarded command. Its known shape (`tests/unit/permission-prompt-auto-resolver.test.ts` fixtures) is covered by links 1 and 2; link 3's trailer rule covers the status bar Claude Code now draws under every screen.
- A menu that is more than 80 raw rows above the pane bottom is still out of the capture window.

## 3. Level-of-abstraction fit

Row counting belongs in `paneText` (shared pure helper, new function rather than a changed one); the pre-gate shape in the resolver module beside the detectors; trailer tolerance only in the layer that cannot press a key.

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — signal only. The key-pressing path is unchanged; the change widens what is observed and recorded.

## 4b. Judgment-point check

No new heuristic at a competing-signals decision point; the window and trailer list are static and tested against a captured pane.

## 5. Interactions

- Layer 2 owns a tick it matches, so Layer 3's wider view cannot double-raise a Layer-2 wedge (unchanged ordering).
- Dedup: the attention id is `perm-prompt:<session>|<menu digest>`; the TelegramAdapter attention store ignores an id it already holds, so one item per session per menu shape — the same bound as before.
- Cost: ONE 80-row raw capture per monitor tick (was one 50-row capture) feeds the 5-row tail, the pre-gate and the evaluate tail; no second capture per tick (the first cut captured twice; corrected on second-pass review).
- A decline shape the review found (probe D): two `❯ 1. Yes` rows inside the 80-row window — Layer 2's cursor scan stops on the first from the top, which fails its window, so a genuine live prompt below a scrolled-back copy is declined (no key); Layer 3 raises after 4 ticks. Fail-closed, noted.

## 6. External surfaces

Operator: possibly one more attention item ("Session wedged on an approval prompt I could not auto-clear") per genuinely parked session. Agents: nothing. Persistent: `logs/permission-prompt-resolver.jsonl` now receives Layer-3 rows (size-rotated at 8 MB by the existing wiring).

## 7. Multi-machine posture

Per machine, per session; nothing crosses the mesh.

## 8. Rollback cost

Revert. No state format changes.

---

## Conclusion

Closes a silent wedge the floor's own documentation promised to announce, with the failing shape pinned as a fixture and the key-pressing layer provably unchanged. Clear to ship pending the second-pass review.

---

## Second-pass review (if required)

**Reviewer:** independent reviewer subagent (general-purpose, read-only)
**Independent read of the artifact: concern raised, applied** — Layer 3 false positive (probe A: `⎿  1. …` tool-result list above a retry-wait line; probe B: a quoted `│ 1.` list above the status bar) → the `≥2 numbered lines` affordance fallback now counts only on an unstripped tail, with both probes as tests. Advisory applied: the double capture per tick is folded into one 80-row capture (artifact §5 corrected). Advisory noted: probe D (two `❯ 1. Yes` rows in the window) is a fail-closed decline. Confirmed without change: Layer 2 receives the raw tail, keeps its 6-line window, its ≥2-named-pattern gate and its re-capture guard (`server.ts` re-capture still `captureMeaningfulTail(s, 16)`); the fixture cannot match Layer 2; audit rows carry no pane bytes and are bounded per (session, digest) episode. 70 tests across five files pass.

---

## Evidence pointers

Live canary 2026-10-19 11:21–11:27 PDT (Mac Studio): pane saved as the fixture; `detect.mjs` against the deployed dist: pregate false, Layer 2 null, Layer 3 null (as-is, not-generating, and with the trailer dropped). Tests: `tests/unit/permission-prompt-resolver-abstention-silent.test.ts` (10), plus the existing resolver suites (53) and wiring integration (4).

---

## Class-Closure Declaration (display-only mirror)

No self-triggered restart/swap/respawn/kill controller is added or modified; the only actuation reachable from the changed code is one deduped notify.
