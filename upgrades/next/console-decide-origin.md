## What Changed

Promise actions in the console (Approve, Decline, Mark as done, Drop, Resume) always name the machine that holds the promise. Promise ids are numbered per machine, so a bare id could be refused as ambiguous when another machine had a promise with the same number.

## What to Tell Your User

Approve and Decline now work on every promise; before, some failed with an "ambiguous across machines" error.

## Summary of New Capabilities

No new capability; a fix.

## Evidence

Operator screenshot 2026-11-01 23:03: Approve on CMT-1206 answered "ambiguous across machines". The pool view holds CMT-1206 on the Studio (pending), the Mac Mini and the Laptop (expired).
