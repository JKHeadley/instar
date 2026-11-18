---
title: Locked screen on a testing machine
---
A machine that runs Local Verify, or one set up to look after itself, reports once when its screen stays locked for 10 minutes, because tests there can fail while it is locked. One report goes out per lock per machine, even with several agents on it; a desk machine only reports while testing work is waiting. Read the current reading and the watch with `curl -H "Authorization: Bearer $AUTH" http://localhost:{{port}}/machine-maintenance/lock-state` (it answers even where machine maintenance is off). When a test run fails on a machine for no clear reason, check this first: a locked screen is a common cause, and only a person at its console can unlock it.
