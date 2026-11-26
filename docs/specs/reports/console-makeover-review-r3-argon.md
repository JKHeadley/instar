# Review round 3 (visual) — Gemini 4 Argon (gemini CLI), 2026-10-25

### 1. Verdict on visual quality
**Close** (with a clear path to production-grade after targeted CSS and view-model polish).

The visual foundation is unmistakably Instar: the `#0a0e17` navy ground, subtle 60 px teal grid, translucent slate surfaces, tight Inter 800 display type, and semantic color discipline (amber for operator attention, teal for healthy/brand, red for urgent/failing) capture the `instar.sh` identity with high fidelity. Both phone and desktop layouts feel calm, structured, and purposeful. However, a handful of visual honesty bugs in the "can't-tell/partial" states, a duplicate header control on desktop, and a few touch-target and alignment defects hold it back from an immediate production-grade stamp.

---

### 2. Ranked visual and interaction defects

1. **Dishonest "unknown / stale / partial" visual affordances in the machine list and partial-pool notes**
   - **Defect:** The design rule states that *Can't tell* / *Unknown* uses a dashed slate outline, and *Partial* / *Stale* states never render silently. In `console.css` (line 262), the `.machine` list override forces `border-style: solid; border-color: var(--hairline)` on `.machine[data-state="unknown"]` and `.machine[data-state="attn"]`, erasing the dashed slate indicator defined earlier on line 183. Meanwhile, in **What I've promised**, *"Includes 3 other machines; some of it is out of date"* renders in `.card-note` (`--text-faint`, 12.5 px)—visually quieter than row timestamps, making partial/stale mesh state easy to miss.
   - **Smallest fix:** In `dashboard/console/console.css`, remove the line-262 border reset and style partial/stale notes with an explicit dashed or amber accent:
     ```css
     .machine[data-state="unknown"] { border: 1px dashed var(--unknown-line); border-radius: var(--r-sm); }
     .machine[data-state="attn"] { border-left: 2px solid var(--attn); padding-left: calc(var(--s-2) - 2px); }
     .card-note { display: flex; align-items: center; gap: 6px; padding: 6px 8px; border-radius: var(--r-sm); border: 1px dashed var(--unknown-line); color: var(--text-muted); }
     ```

2. **Conflicting right-column data in "Where I'm running" (`0.9/core` vs `just now`)**
   - **Defect:** In `r3-home-desktop.jpg` and `r3-home-phone.jpg`, Mac Studio shows `live | 0.9/core` (`1.1/core` on phone), while Mac Mini, Laptop, and Mama PC show `live | just now`. Mixing CPU load ratios and freshness timestamps in the same right-aligned `.m-load` column breaks tabular scanning and violates the spec rule: *"It always shows the evidence age."*
   - **Smallest fix:** In `dashboard/console/home-model.js` (and `console.js`), always render evidence age in the final column and display load in `.m-state` (e.g., `live · 0.9/core` | `just now`), or render both consistently across all rows.

3. **Duplicate "Legacy" links on desktop (`r3-home-desktop.jpg`)**
   - **Defect:** On desktop (`>= 900px`), the top-right header `.chip` ("Legacy") remains visible while the left sidebar also displays `ELSEWHERE -> Legacy dashboard`, and the footer links it a third time. As `console.css` line 235 notes (`/* the legacy link lives in the topbar on phones, in the sidebar on desktop */`), the topbar chip was meant for phone viewports only.
   - **Smallest fix:** In `dashboard/console/console.css` inside `@media (min-width: 900px)`, hide the topbar legacy chip:
     ```css
     @media (min-width: 900px) { .topbar a.chip[href*="legacy"], .topbar .chip-legacy { display: none; } }
     ```

4. **Cramped footer touch targets (`See all N` and `Open`) on phone**
   - **Defect:** In `.card-foot`, the action links (`See all 32`, `See all 50`, `Open`) have no vertical padding (`font-size: 13px`, `line-height: 1.55`), resulting in ~20 px tall tap targets—less than half the 44 px mobile ergonomics minimum. Furthermore, cards with a single action (`What needs you` -> `See all 32` on the left; `Can I reach you` -> `Open` on the right) jump between left and right alignment because `.card-foot` uses `justify-content: space-between`.
   - **Smallest fix:** In `dashboard/console/console.css`, give `.card-foot a` and `.link-btn` a comfortable touch hit-area and keep single primary links consistently positioned:
     ```css
     .card-foot a, .card-foot .link-btn { min-height: 36px; display: inline-flex; align-items: center; padding: 4px 0; }
     .card-foot > :only-child { margin-left: auto; }
     ```

5. **Desktop promises card hides the reason a promise needs the operator (`r3-home-desktop.jpg` vs `r3-home-phone.jpg`)**
   - **Defect:** On phone (`r3-home-phone.jpg`), each row under **What I've promised** clearly shows `.row-sub` (`waiting on your authorization`, `waiting on your input`). On desktop (`r3-home-desktop.jpg`), those subtitles are missing, leaving raw commitment text without explaining *why* it is in the "47 need you" bucket.
   - **Smallest fix:** In `dashboard/console/console.js` / `home-model.js`, ensure `.row-sub` (`blockedOn` / owner reason) is always rendered on promise rows regardless of viewport or line-clamp state.

6. **Red-to-amber hierarchy inversion in "What I'm allowed to do"**
   - **Defect:** In **What I'm allowed to do**, the first row has a red `.dot.bad` (*"8 safety checks off that should be on"*), while the card itself is styled as `data-state="attn"` (amber border, amber `72` in the headline). Having a card contain red (`bad`) items while its container and headline assert lower-severity amber (`attn`) weakens semantic color trust. Additionally, the segmented `.meter` bar has no spacing between segments, making the thin red and striped-unknown segments bleed together at 390 px.
   - **Smallest fix:** In `dashboard/console/home-model.js`, escalate the card state to `bad` (or style the row dot as `.attn` if off-guards are warning-level rather than failing); in `dashboard/console/console.css`, add `gap: 2px` to `.meter`.

7. **Group page tiles lack link affordance and vertical icon centering (`r3-work-phone.jpg`)**
   - **Defect:** On the Work group page, `.tile` uses `align-items: flex-start`, causing the `.t-icon` badge to float awkwardly at the top-left of 3-line descriptions, and there is no trailing chevron (`→` or `↗`) to indicate that tapping a tile leaves the console for the full legacy tab.
   - **Smallest fix:** In `dashboard/console/console.css` (and tile markup in `console.js`), add a subtle trailing arrow or chevron and refine alignment:
     ```css
     .tile { position: relative; padding-right: var(--s-8); }
     .tile::after { content: "→"; position: absolute; right: var(--s-4); top: var(--s-4); color: var(--text-faint); transition: transform var(--dur) var(--ease), color var(--dur) var(--ease); }
     .tile:hover::after { color: var(--accent); transform: translateX(2px); }
     ```

8. **Headline glow and brand mark presence vs `instar.sh`**
   - **Defect:** Compared to `instar-sh-reference.jpg`, the console's `.hero h1` feels slightly flat against the grid, and when the agent is healthy ("All quiet..."), the teal gradient on `.hero h1 .accent` lacks the subtle atmospheric radial glow behind the hero that gives `instar.sh` its signature depth. Also, the theme toggle button (specified in `console-makeover.md` under Aesthetic bar: *"a designed light theme is one toggle away"*) is missing from `.topbar`.
   - **Smallest fix:** In `dashboard/console/console.css`, add a subtle radial hero backdrop and expose the `.icon-btn` theme toggle in `.topbar` (`dashboard/console/index.html` / `console.js`):
     ```css
     .hero { position: relative; }
     .hero::before { content: ""; position: absolute; inset: -20px auto auto -20px; width: 280px; height: 120px; background: radial-gradient(circle, var(--accent-wash), transparent 70%); pointer-events: none; z-index: -1; }
     ```

---

### 3. Open plan-level problems from earlier rounds

All eight architectural findings from Round 1/2 (framing exposure, operator proof isolation, HTTP-200 incomplete data contracts, deep-link cutover adapter, phone row budget, inventory-gated legacy removal, deterministic machine state mapping, and static group directories) are **properly resolved in the spec (`console-makeover.md`)**.

Only two minor **implementation-to-plan drift items** remain visible in the R3 build:
1. **Freshness / age visibility (`Can I reach you` is the only card showing `.card-age`):** The spec notes that cards refresh every 30 s and show age when stale or on machine evidence, yet in the screenshots only `Can I reach you` displays `just now` in `.card-head` while the other five cards omit `.card-age` (and `Where I'm running` omits age on the first row when load is present).
2. **Light-theme toggle missing from the topbar UI:** `console.css` defines the full `:root[data-theme="light"]` token set and `.icon-btn` styling, and the spec requires *"a designed light theme is one toggle away and remembered per browser"*, but neither phone nor desktop screenshots render the toggle button in `.topbar`.
