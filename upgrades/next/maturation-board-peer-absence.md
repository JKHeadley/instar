<!-- internal-only -->
## What Changed

The maturation board no longer warns that it "may be out of date" because of machines that answered
that they don't run the board (switched off, or an older version). Only machines it could not reach
count as missing.

## Evidence

Live board on the Studio (2026-10-30 16:30) listed "Mama PC, Mac M5 Pro, Laptop didn't answer" while
Mama PC and the M5 Pro had answered 503/404. New integration test covers both answers.
