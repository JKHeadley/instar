# Side effects: History items keep their height

CSS only. Found in the live check of the History view on 1.3.1586: the History box is a
column flex container with a fixed height, so it squeezed its children to fit; tool lines
(which clip their overflow) shrank to 0 px and the box looked empty while 1,050 entries were
loaded. `.sess-history > * { flex-shrink: 0 }` keeps each item's height and lets the box
scroll. On desktop with a session open, the History box now fills the same space as the
live terminal instead of a fixed 52% of the window.

1. Over-block: none. 2. Under-block: none known. 3. Level: stylesheet. 4. Not a decision point.
5. Interactions: none; the Live terminal rules are unchanged. 6. Appearance only.
7. Multi-machine: static asset, identical everywhere. 8. Rollback: revert.

## 6b. Operator-surface quality
1. Primary action unchanged. 2. No internals added. 3. Nothing destructive. 4. Phone width
unchanged (the fill rule applies at 900 px and wider).
