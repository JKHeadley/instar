# Three tests that failed only on a busy machine — the plain version

## What this is

Before a change is merged, one machine runs every automated test we have, with three groups of tests running at the same time. That machine is very busy while it does this. Three tests kept failing there on changes that had nothing to do with them, and passed when run again alone. A test like that wastes a 20 to 40 minute run each time and teaches people to ignore red results. This change repairs those three tests. It changes test files only. The product is untouched.

## What was wrong

Each test was really measuring how busy the machine was.

- **The "does not freeze" test.** Part of the product walks a large folder tree. It must do this in small pieces so the rest of the program keeps responding. The test checked this by setting a timer and seeing how late the timer rang. On a busy machine a timer rings late even when the work is done in perfectly small pieces, because the processor is off doing something else. The test read 738 thousandths of a second against a limit of 250.
- **The "remember which folder I was in" test.** When a session is restarted, the product reminds it which work folder it was in. The test restarted a session and gave the reminder 20 seconds to show up. The product, on purpose, waits at least 8 seconds before it types anything into a restarted session, and allows itself two minutes on a slow machine. So the test gave up while the product was still doing the right thing. The test also asked the product only once to note the folder, and the product is allowed to miss a single try.
- **The "undo a half-finished copy" test.** The product copies files using a small helper program and gives that helper three seconds each time. On a busy machine just starting the helper can take longer. The test is about undoing a copy when a later step fails. It never got that far, because the helper ran out of time first.

## What changed

- The first test now measures how long the program itself was working without a pause, not how late a timer rang. Work by other programs no longer counts. A new small check proves the measuring tool can tell "working" from "waiting".
- The second test now waits for the product to say "I have typed the message", and checks that the folder really was noted before the restart. A neighbouring test in the same file with the same 20-second mistake got the same repair.
- The third test still uses the real helper program and the real files. Only the three-second limit is lifted, inside this test file alone.

Nothing was removed from what the tests check. The second test checks one more thing than before.

## What was left alone

The three-second limit in the product is a real weakness on a busy machine. It was already reported (fb-fe25893b-2ad) and is not changed here.

## What you need to decide

Nothing. If one of these tests fails again, it now points at the product, not at the machine.

## A fourth test, added before this was sent

One more test failed now and then for a reason that had nothing to do with a busy machine. To check that the server refuses damaged data, the test damaged a piece of scrambled data by writing the letter A over its first character. About one time in 64 that character already was an A, so nothing was damaged, the server rightly accepted it, and the test called that a failure. The test now writes a character that is different from the one that is there, and checks that the data really changed.
