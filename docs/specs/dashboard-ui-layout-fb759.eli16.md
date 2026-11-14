# Two cramped dashboard screens, cleaned up — Plain-English Overview

> The one-line version: the sign-in repair result now shows one line per machine, and the Pair page shows phones and browsers in their own sections with short rows and a Remove button that stays on one line. A short written standard says how every dashboard screen should be laid out and checked.

## The problem in one breath

Justin sent screenshots on 2026-11-11 (feedback fb-8c4c5d83-759). After he tapped "Turn on automatic sign-in repair", the box that says what happened ran every machine's answer together into one long paragraph, so you could not tell which machine said what. On the Pair page, browsers he had paired were listed under the heading "Paired phones". Every row repeated "Paired · Browser". The "Remove this browser" link was squeezed so hard it wrapped over three lines.

## Why it happened

- **The result box.** Each machine's answer was put in a small text piece whose "start on a new line" style only works inside a list row. In the result box it was not inside a row, so all the pieces flowed together like words in a sentence.
- **The Pair page.** It had one list for every paired device, with a heading written back when only phones could pair. Browsers were added to that list later. They got a tag inside each row instead of their own heading, and the remove link sat beside long text with nothing stopping it from being squeezed.

## What changes

- **Result box:** a short summary at the top ("Done.", "Done on some machines." or "Not done."). Below it, one line per machine: a tick or a cross, the machine's name, and what happened there.
- **Pair page (and the older Phones tab):** "Paired phones" lists only phones, and "Paired browsers" lists only browsers. Each row is the device's name with one short line under it, such as "Paired since Sep 30, 2026" or "Last used on this machine Nov 11, 2026, 2:00 AM". The button just says "Remove" and never wraps. For screen readers it says which device it removes. Nothing changes about what Remove does.
- **A UI standard:** `docs/specs/dashboard-ui-quality-standard.md` sets six short rules (one item per line, group by kind, name plus short detail, buttons never wrap, no sideways scroll at phone width, both themes). It also requires loading every changed screen at 390px and 1280px wide before calling it done.

## Safeguards

Only how the pages look changes. The same server calls are made, with the same confirmation before removing a device, and no data, setting or permission moves. Undoing the change is a plain revert.

## What you need to decide

Nothing. This is a layout fix.
