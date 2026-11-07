# The locked-screen test now waits for something you can actually see

## What this is

Instar can show and control a Mac's screen remotely, even while that Mac is locked. To prove the locked-screen part is safe, a test driver on a real Mac Mini opens the same remote-desktop web page a person would use, types into it, and checks what the Mac does. Before each test the driver waits for the page to be ready.

## What went wrong

The page has two ways of being ready. If several machines are listed, it shows an "Open selected machine" button. If exactly one machine is ready, it skips that step and opens the screen by itself, hiding the button. The hidden button was still switched on, though. The driver's wait asked for "an enabled button, or the open screen panel", and the browser automation tool always follows the first thing that matches. That was the hidden button. It never became visible, so the driver gave up after 20 seconds, and on 5 November 2026 the locked-screen proof could not even start its calibration step.

## What changes

Both halves of the wait now also say "and visible". The hidden button no longer counts, so the open screen panel is what the driver finds. With this change the calibration ran on the Mac Mini straight away, and the 30 automatic test cases started.

## What stays the same

The web page itself is unchanged. It behaves correctly for people; only the test's way of looking at it was wrong. Nothing here reaches any running agent; it only affects the proof tool that is run by hand on the test Mac.

## What you need to decide

Nothing. It is a small fix to test tooling that a revert fully undoes. A new unit test makes sure both parts of the wait keep asking for something visible, so this mistake cannot quietly come back.
