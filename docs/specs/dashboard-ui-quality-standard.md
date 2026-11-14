# Dashboard UI quality standard

The short bar every Instar dashboard screen meets before it ships: the console, `/dashboard/pair`,
the legacy dashboard tabs, and any sheet or result box they open.

It came from feedback fb-8c4c5d83-759 (Justin, 2026-11-11, with screenshots). The "Turn on automatic
sign-in repair" result ran every machine's answer together in one paragraph. The Pair page listed
browsers under "Paired phones", said "Paired · Browser" on every row, and wrapped its "Remove this
browser" link over three lines. Each rule below closes one of those defects as a class.

## The rules

1. **One thing per line.** A result that covers several machines, accounts or devices shows one
   line per item: what it is, then what happened to it. Never join several items into one
   sentence or paragraph. A style that only works inside one container (for example `.row-sub`,
   which is a block only inside `.row`) is not reused somewhere else without checking it there.
2. **Group by kind, and say the kind once.** Items of different kinds go under separate headings
   ("Paired phones", "Paired browsers"). A heading never lists items of another kind. The kind
   goes in the heading, not repeated in every row.
3. **A row is a name and a short detail.** The name is on the first line. One short detail line
   follows: a state or a date, without seconds. Text that only repeats the heading or the status
   everyone shares is left out.
4. **Buttons never wrap.** A row's button is short ("Remove") and `white-space: nowrap`. Its
   accessible label names the item ("Remove Justin's iPhone"). The text column shrinks and wraps
   (`minmax(0, 1fr)` with `overflow-wrap: anywhere`), never the button. Tap targets are at least
   44px tall.
5. **No sideways scroll.** At 390px wide the page has no horizontal scroll, and long names wrap
   inside their column.
6. **Both themes.** Colors come from the page's own tokens, so light and dark both work.

## Check before calling it done

Load the changed screen with realistic data (long names, several items, a mix of outcomes) and
look at it at **390px** and **1280px** wide, in dark mode as well. Run a short in-page check:
`document.documentElement.scrollWidth === innerWidth`, and every row button is one line tall.
A unit test asserts the structure: separate groups, one element per result line, and no
repeated kind tag. The PR says which screens were loaded and at which widths.
