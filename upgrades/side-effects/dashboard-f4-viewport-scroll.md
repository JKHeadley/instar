# Side-Effects Review — Dashboard F4 (no mobile horizontal scroll)

**Change:** Implements floor **F4** of the Dashboard UX Standard (`docs/specs/dashboard-ux-standard.md`): the page body must never scroll horizontally at 1280/768/390px. The audit (2026-07-08) found panels overflowing the viewport's right edge at 390px so the whole page scrolled sideways on a phone.

**Files:**
- `dashboard/index.html` — adds `min-width: 0` to the four grid-child panel containers that lacked it (`files-container`, `jobs-container`, `systems-container`, `features-container`). These are direct `.app` grid children (`grid-column: 1 / -1`); a CSS grid/flex child defaults to `min-width: auto`, so a wide descendant forces the row wider than the viewport and the body scrolls sideways. `min-width: 0` lets the child shrink so wide content wraps/contains instead of blowing out the row. (`.tab-panel` already carried this from #1403.) No JS touched.
- `tests/unit/dashboard-viewport-scroll.test.ts` — the F4 floor, in two halves: (1) a STATIC check that every grid-child container carries `min-width: 0` (always runs); (2) a BROWSER-GATED render check that `document.body.scrollWidth <= clientWidth` at each viewport, which SKIPS HONESTLY when no browser driver is installed (FD-2) and runs in the CI browser job. Never a false green.

**Side effects / blast radius:**
- **Runtime behavior:** NONE. Display-only CSS on static markup. No JS, API, state, or config.
- **Migrations / agent-installed files:** none (dashboard is package-served, not templated per agent).
- **Server/lifeline/mesh/security:** untouched.

**Risk:** Very low. `min-width: 0` on a grid child is the textbook, side-effect-free fix for grid row-blowout; it only *allows* a child to shrink, it never forces a size. Worst case is a wide element inside one of these tabs wrapping instead of overflowing — the desired behavior.

**Verification honesty:** The static half is verified green here. The rendered half is **browser-gated and was SKIPPED in this worktree** — no Playwright/Puppeteer is installed, and installing a browser (a large download) was deliberately avoided on a host that wedged twice on 2026-07-08 under filesystem load. The `min-width: 0` fix targets the known mechanism (grid child blowout) with high confidence from the CSS, but a pixel-level 390px confirmation should run via the CI browser job or a browser-capable pass before treating F4 as fully closed. This is disclosed rather than claimed as visually verified.

**Rollback:** revert — pure CSS + a test, zero residual state.
