# Review round 4 (visual) — Gemini 4 Argon (gemini CLI), 2026-10-25

## 1. Verdict on visual quality

**Production-grade.** 

Nothing left in the visual presentation or interaction design should stop Justin from calling this MVP. The console now unmistakably looks like `instar.sh`—the `#0a0e17` navy ground with the 60px teal grid, the tight Inter 800 display typography, the radial hero aura, and the translucent slate surfaces with hairline borders cohere into a sharp, disciplined operator interface. All Round 3 blockers have been resolved: amber is restrained to the primary feature card wash and semantic figures, partial coverage ("partial view", dashed notes) and struggling machine states are visually honest without drowning the screen in alarm, rows expand cleanly inline with chevrons and preserved state, touch targets meet the 44px bar, and the 390px phone viewport shows zero horizontal overflow or layout cramping.

---

## 2. Ranked visual and interaction polish items (non-blocking)

Everything below is minor polish that can be applied in minutes or deferred post-MVP; none of these block acceptance:

1. **Red/amber semantic mismatch in the "What I'm allowed to do" meter bar**
   - **Defect:** In `r4-home-phone.jpg` and `r4-home-desktop.jpg`, the segmented `.meter` bar renders an amber segment followed by a red segment (`m-bad`, for critical-path guards off), while both row dots below it ("8 safety checks off that should be on", "2 critical paths without its guard") and the card border/number (`72`) are amber (`attn`). Either the red meter segment looks orphaned without a matching red row dot, or the critical-path row should carry `.dot.bad` to match the meter.
   - **Smallest fix:** In `dashboard/console/home-model.js` (or `console.js` where the guard rows are built), assign `.dot.bad` to the "critical paths without its guard" row when its count > 0, or if the whole card is intentionally capped at `attn`, use `.m-attn` for both off-guard segments in `console.js`.

2. **Expanded `.row-detail` lacks a left guide rail to group it with its parent row**
   - **Defect:** In `r4-home-phone.jpg` ("What I've promised", first row expanded), `.row-detail` (`You asked: CMT-965 follow-through...`) sits below "waiting on your authorization" at `margin-left: 30px`. Because both `.row-sub` and `.row-detail` use `--text-muted` (`#94a3b8`) at `13px`, the expanded payload blends into the subtitle rather than reading as an opened inspection drawer.
   - **Smallest fix:** In `dashboard/console/console.css`, add a subtle left border and padding to `.row-detail`:
     ```css
     .row-detail { margin: 2px var(--s-2) var(--s-3) 20px; padding: 6px 0 6px 12px; border-left: 2px solid var(--hairline-strong); font-size: 13px; color: var(--text); }
     ```

3. **Identical wrench icons across all 9 "Under the hood" tiles**
   - **Defect:** In `r4-work-phone.jpg`, the top three Settings tiles (`Features`, `Preferences`, `Files`) have distinct icons, but all nine tiles under `UNDER THE HOOD` stamp the exact same wrench SVG inside `.t-icon`. In a vertical stack of nine cards on phone, the repeated teal wrench box becomes visual noise rather than a scannable cue.
   - **Smallest fix:** In `dashboard/console/nav-model.js`, either assign distinct stroke icons from the set (e.g., activity/pulse for `LLM activity`, git-branch/merge for `PR pipeline`, shield/check for `Process health`, sliders/route for `Routing map`) or hide `.t-icon` on secondary "Under the hood" tiles via `.tiles-hood .t-icon { display: none; }` in `dashboard/console/console.css`.

4. **Dashed `.card-note` icon alignment on multi-line wrap (phone)**
   - **Defect:** In `r4-home-phone.jpg` ("What I've promised"), `.card-note` ("Includes 3 other machines; some of it is out of date.") wraps onto two lines at 390px. Because `.card-note` uses `align-items: center`, the `::before` dashed circle floats mid-height between lines 1 and 2 instead of anchoring to the first line like `.row > .dot` does.
   - **Smallest fix:** In `dashboard/console/console.css`, update `.card-note` and `.card-note::before`:
     ```css
     .card-note { align-items: flex-start; }
     .card-note::before { margin-top: 5px; }
     ```

5. **Empty left slot in `.card-foot` when only "Open" is present**
   - **Defect:** Cards with both a left summary/toggle (`See all 50`, `and 15 more`) and a right link (`Open`) feel balanced, and `.card-foot > :only-child { margin-left: auto; }` fixes single-action cards when only one child node is rendered. However, verify in `console.js` that cards without a left action ("Can I reach you", "Where I'm running") do not render an empty `<span></span>` placeholder beside `Open`—and visually, `Open` alone in the bottom-right of tall desktop cards leaves a lot of dead air.
   - **Smallest fix:** In `dashboard/console/console.css`, add a subtle trailing arrow to `.card-foot a` (`Open →`) or give `.card-foot` a hairline divider (`border-top: 1px solid var(--hairline); padding-top: var(--s-2);`) so the footer action anchors the bottom of every card consistently.

6. **Machine row metadata density on narrow phones (360px edge case)**
   - **Defect:** In `r4-home-phone.jpg` ("Where I'm running"), the struggling row (`Mac Studio` | `struggling · 2.5/core · just now`) fits comfortably at 390px, but at the 360px MVP minimum with a longer machine nickname, the 3-column `.machine` grid (`auto 1fr auto`) can squeeze `.m-name` against the right-aligned state cluster.
   - **Smallest fix:** In `dashboard/console/console.css`, allow `.machine .m-name` to truncate cleanly if needed:
     ```css
     .machine .m-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
     ```

---

## 3. Plan-level problems still open from earlier rounds

**None.** Every architectural, security, data-honesty, and navigation finding raised across Rounds 1–3 in `docs/specs/console-makeover.md` has been cleanly resolved and closed:
- **Security & framing:** `X-Frame-Options: DENY` is preserved; no iframe embedding; console is strictly read-only and validates against protected `/sessions` rather than public `/health`; operator proof stays in-memory in legacy.
- **Honest state & mesh coverage:** Per-card data contracts, `observedAt` null checks, unfiltered `scope=mesh` commitment reads with client-side active filtering and staleness/coverage labels, deterministic machine-state precedence, and 8s pool deadlines with 5s "Still checking…" feedback are all specified and reflected in the UI.
- **Navigation & cutover:** Two-tap reachability to all 29 legacy tabs (with "Under the hood" inline on Settings rather than behind a disclosure tap) and the URL query/hash adapter (`tab`, `session`, `path`) for post-MVP cutover are complete.

The spec and implementation are ready for Justin's live phone acceptance pass.
