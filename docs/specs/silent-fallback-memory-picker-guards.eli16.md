# Memory-picker guards and the silent-fallback count — plain explanation

## What problem this fixes

Instar has a test that counts places in the code where an error is caught and
quietly replaced with a default value. Those places are risky, because a
failure can hide there without anyone noticing. The test keeps a ceiling
(the "baseline"). New code may not push the count above it, and when the count
goes down the ceiling goes down with it.

When the memory picker feature merged, the count went from 494 to 496, one over
the ceiling of 495. The main branch was failing this test.

## What was actually there

The two new places are in the web route the session-start hook calls to ask
the memory picker which memory lines to load. Each one says "if this job
fails, use nothing". But the job is built so it never fails. It always
produces an answer and logs its own row, even when something goes wrong. The
two guards are only a safety net, and using nothing is exactly what happens
today without the picker. The test flagged them only because the word
"fallback" appeared a few lines further down.

## What this change does

It adds one comment after each guard with the standard exemption marker and
the reason, so the test stops counting them. It then lowers the ceiling to the
new measured count of 494, so the rule is one step stricter than before. No
program behaviour changes.

## How it was checked

The counting test was run on the main branch before and after the memory
picker merged (494, then 496). It was run again after this change (494,
passing), and the whole unit suite ran in four parts with no failures.
