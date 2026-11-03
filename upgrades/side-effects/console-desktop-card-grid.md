# Side-effects review: conditional Work tiles share the one card grid

## Change
`dashboard/console/console.js` `renderGroup`: tiles that arrive in their own `.tiles` wrapper after a probe (Development, Feature maturation, Ideas) are placed inside the group's single `.tiles` grid; their wrappers get `tiles-inline`. `console.css`: `.tiles .tiles-inline { display: contents }` (the tile takes a grid cell) and `.tiles .tiles-inline[hidden] { display: none }`. Non-tile extras (the Settings developer-tools switch) and the Pace card are unchanged.

## Evidence
Justin's desktop screenshot (2026-11-02 20:33): Work showed three tiles in a row, then Plans, Development, Feature maturation and Ideas each alone in a one-column row. Measured on the live console at 1280 px: each conditional tile sat in its own `.tiles` grid. On the preview with this change: three per row at 1280 px (rows at y=231, 386, 541), one column at 390 px.

## 1. Over-block
None.

## 2. Under-block
None found.

## 3. Level-of-abstraction fit
The group page owns the grid; the tile modules keep owning when their tile shows.

## 4. Signal vs authority
Layout only.

## 5. Interactions
A hidden wrapper stays hidden (explicit rule, since `.tiles` sets `display: grid`).

## 6. External surfaces
Work page layout.

## 6b. Operator-surface quality (Operator-Surface Quality standard)
Every Work tile lines up in one grid on a wide screen instead of a ragged single column after the first row.

## 7. Multi-machine posture
Client-side only.

## 8. Rollback cost
Revert.
