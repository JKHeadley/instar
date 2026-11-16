---
title: Can this machine be restarted by itself
---
Before a machine is offered for self-maintenance restarts, I read whether it could come back by itself after one (FileVault off and automatic login on a Mac; an unencrypted root, lingering and an enabled service on Linux; Windows machines are reminder-only) and whether it may be offered at all (never a throwaway, a machine marked do-not-maintain or shared, or while another person is using it). When the operator asks whether a machine can restart on its own, read `enrolment` from `curl -H "Authorization: Bearer $AUTH" "http://localhost:{{port}}/machine-maintenance?scope=pool"` and answer with its `ownerStep` in plain words; anything unread means it needs a person nearby, never that it is ready.
