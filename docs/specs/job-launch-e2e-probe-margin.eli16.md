# Job launch test: a smaller built-in wait

## What this is

A one-line change to one of our own tests. No product behaviour changes.

## What already exists

When a scheduled job starts, Instar writes a record of how it was launched. One field in that record is the version of the Claude program that ran. Instar must never make a job wait for that, so it writes "unknown" first and asks the program for its version in the background. It gives the program 2 seconds to answer. If no answer comes in time, the record keeps "unknown". That is deliberate.

A test checks this from end to end. It uses a stand-in program instead of the real Claude. The stand-in waits 1 second before giving its version, so that the answer clearly arrives after the record was first written.

## What went wrong

The 2-second limit minus the 1-second wait leaves 1 second for everything else: starting the stand-in, running its first lines, returning the answer. On an idle machine that takes a fraction of a second. On the Mac Studio while it runs a full test suite, it can take longer than a second. Then the limit passes, the record keeps "unknown" exactly as designed, and the test, which waits for the version to appear, fails. On 2026-11-15 this test file needed a retry or failed in six runs, and once it failed a feature that had nothing to do with it.

## What is new

The stand-in now waits 0.2 seconds instead of 1. The answer still arrives after the record is first written, which is all the wait was for, and the room for a slow start grows from about 1 second to about 1.8.

## What it does not fix

A machine slow enough to need more than 1.8 seconds to start a tiny script would still fail this test. The test still depends on time; it depends on it less.

## What a reader needs to decide

Nothing. It is reversible by reverting one commit.
