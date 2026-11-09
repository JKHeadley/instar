# ELI16 — the origin store keeps SQLite loaded for its workers

## What was going wrong

Every outbound Telegram message gets a record in the "origin store", a SQLite database. The database work runs on a separate worker thread so a slow disk never freezes the server. SQLite comes as a native library (compiled machine code, not JavaScript). Node loads it into a thread the first time that thread opens a database.

Node also unloads a native library when the last thread that loaded it goes away. A store worker exits whenever its store closes or gets replaced after a stall. On its way out, the worker's final clean-up of memory still has to run some of SQLite's own code. If no other thread was holding SQLite at that moment, the code had already been unloaded, and the clean-up jumped into memory that no longer held anything. The result is a segmentation fault: the whole process dies at once.

That's why `store-retention.test.ts` "failed 16 of 25 tests" in Local Verify on the Studio, the M5 and the Mac Mini. The test process died right after its heaviest store closed, and the 16 tests after that point never ran at all. Local Verify counts a test that never finished as failed, and reports the dead process as an unhandled error ("Worker exited unexpectedly"), which also stops it from rerunning the file alone. The macOS crash report shows the crash inside a worker thread's teardown, in the garbage collector's clean-up callbacks.

## What changes

When an origin store starts its first worker, the parent thread now loads SQLite itself, once, by opening and immediately closing a tiny in-memory database. Because the parent keeps it loaded for the life of the process, a worker exiting can never unload it. No store work moves to the parent thread. If SQLite can't load at all, nothing changes: the worker hits the same problem at startup and reports it through the existing restart path, as it always has.

## Why this is safe

It's a load, not a behaviour change. Production servers usually load SQLite on the main thread already for other stores, so for them this changes nothing. For any process that didn't, it removes a crash. A revert undoes it completely.

## How we know

A test that repeats the heaviest store case in a fresh process crashed with SIGSEGV in 8 of 9 runs before the fix and in 0 of 9 after. The new test file fails both of its behavioural tests without the fix and passes with it.
