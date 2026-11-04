<!-- bump: patch -->

## What Changed

The console's 30-second refresh no longer moves the page. The shared repaint step in `dashboard/console/ui.js` now keeps the scroll position, any section the operator opened or closed, inner scroll positions and focus, restoring them before the browser draws. A link to a section scrolls once per arrival. A loading placeholder only shows before a page's first real content, so Promises and any page showing an error no longer blank themselves on refresh. The refresh also waits while a field is focused or holds typed text, or text is selected, and two refreshes can no longer overlap. In the legacy dashboard, a missed Integrated-Being read no longer blanks the table.

## What to Tell Your User

The dashboard no longer jumps back up the page or closes what you opened when it refreshes. Your place stays put and only the numbers change.

## Summary of New Capabilities

- Dashboard UX floor F12: a refresh keeps the operator's place, enforced by a test over every console page.

## Evidence

Measured in a real browser at 1280x728 against this agent's live data, before and after, on all 23 console routes and all 30 legacy tabs. Before: Permission slips 1795 to 169, Passwords and keys 698 to 165, Under the hood 4640 to 1785, Maturation 2930 to 483, Plans (in the way) 4451 to 1559, Costs 1161 to 959, Allowed 2937 to 2827, Machines 98 to 0, Promises 60 to 0 with a blank. After: all of them hold position with every fold still open. On the real 30-second timer, Development with a section link moved 339 to 419 before and held at 491 after. Legacy tabs showed no scroll movement; only Integrated-Being lost content on a poll, and that is fixed. `tests/unit/dashboard-refresh-keeps-place.test.ts` fails when a page is reverted to a placeholder or a raw scroll (checked by mutation).
