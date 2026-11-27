# A remote-desktop speed test stops tripping on busy test machines — Plain-English Overview

## The problem in one breath

One automated test checks that a remote-desktop session asking for faster video really gets pictures more often than the default 15 a second. It does this by opening one stream at the normal pace, closing it, then opening a faster one and watching the timers each schedules. On busy GitHub test machines, the first stream did not always stop in time: closing it took longer than the test's fixed 150 millisecond pause, so the old stream's slow timers were counted as if the fast stream had made them. The test then failed even though the product was fine. That blocked an unrelated fix (a secret-store change, PR 3255) from merging three times.

## What already exists

An earlier change (#3223) added the fixed pause after closing the first stream. It helped, but a fixed pause is a guess about how slow the machine is.

## What this adds

Instead of guessing, the test now waits until the first stream has actually gone quiet: no new frame timer for a quarter second, with a five second upper limit so it can never hang. Then it measures the faster stream.

## The safeguards

Only the test changes. The product code, the pace values, and what the test asserts are all the same. A slower machine now waits a little longer instead of failing.

## What ships when

Ships on merge. A revert undoes it.

## What you actually need to decide

Nothing.
