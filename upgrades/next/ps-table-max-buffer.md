<!-- bump: patch -->

## What Changed

On a busy machine, the checks that decide whether a session is idle could fail because the list of running processes was larger than the space set aside to read it (1 MB). When that read failed, the check assumed the session was still working, so idle sessions were never cleaned up or handed over. The read now has 32 MB, the same limit another process check already uses, and a test keeps every process-list read in the code on that limit.

A flaky test of the hook event queue now checks that the queue stays under its limit and that every accepted event is kept, instead of expecting an exact count that varied under load. Test-only.

Rollback: revert. No state to repair.

## What to Tell Your User

Nothing to do. On a busy machine, idle sessions are now cleaned up as intended instead of lingering.

## Summary of New Capabilities

None. A bug fix.
