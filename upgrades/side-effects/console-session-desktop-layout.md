# Side effects: desktop session view fills the window

CSS only (dashboard/console/console.css). At 900 px and wider, with a session open, the
page widens to 1680 px, the list column narrows to 280-340 px, and the session view is
exactly the window height below the top bar, so the terminal takes the free space and the
composer is always on screen. The preview banner now spans the full grid width instead of
wrapping inside the 248 px nav column (it was ~125 px tall, now ~37 px).

1. Over-block: none (no logic).
2. Under-block: very short windows (< ~450 px) still squeeze the terminal; acceptable.
3. Level fit: layout belongs in the stylesheet.
4. Signal vs authority: not a decision point.
5. Interactions: xterm refits through the existing ResizeObserver. Phone layout untouched (media query).
6. External surfaces: dashboard appearance only.
7. Multi-machine: machine-local static asset; identical on every machine.
8. Rollback: revert the commit.
