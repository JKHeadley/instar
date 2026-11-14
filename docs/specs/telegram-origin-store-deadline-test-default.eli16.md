# Tests get a longer wait for the message recorder's helper, too

## What this is about

Before the agent sends a Telegram message it writes down who is sending it and why. The writing is done by a small helper program, and the agent waits for the helper to answer each request. In real use it waits at most two seconds. If the helper has not answered by then, the agent treats the recorder as unavailable and holds the message. That is right for the real agent: two seconds is a long time for one small write, and a helper that is really stuck should not hold everything up.

## What was wrong

Tests use the real helper. When the whole set of tests runs on a busy machine, the helper sometimes does not get a turn on the processor for more than two seconds. It is not stuck and nothing is wrong with the disk (measured on 13 November: a write that must reach the disk takes about five thousandths of a second on the busy machine, the same as on the quiet one). It is simply waiting its turn. The test then sees "recorder unavailable" and fails, although it was checking something else.

Earlier repairs gave every test a longer allowance for the steps above this helper. They could not reach this limit, because it sits one layer lower. On 13 November it failed three changes that had nothing to do with it, including the fix for an unrelated emergency.

## What changes

The two-second limit gets the same treatment as the limits above it. There is now one switch that says "in this program, wait this long for the helper unless told otherwise", and the setup file that every test loads sets it to twenty seconds.

## What stays the same

- The real agent never touches the switch and still waits two seconds. A test reads the source code and fails if anything outside the tests uses it.
- A test that sets its own wait keeps it. The tests that deliberately freeze the helper to check recovery all set their own (between a fifth of a second and two seconds), so they behave exactly as before. An independent check went through every test that touches the recorder and found none that relies on the two-second default.
- A helper that has crashed or been shut down still fails at once. Only a slow but working helper is waited for longer.

## What could go wrong

A test whose helper is truly hung, and which did not set its own wait, now fails after twenty seconds instead of two. That costs time in a failing test, not correctness.

## What you need to decide

Nothing. This is a change to how tests run.
