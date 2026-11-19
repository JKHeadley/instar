# Marking one intended error check

The repository has a test that counts places where the code catches an error and quietly carries on, and that count must never go up. The new file-deletion safety check added one place the test counted, so the count rose from 494 to 495.

That place does not actually hide the error. It asks the disk whether a file exists. If the answer is "no such file", it reports that the file is absent. If the disk gives any other error, it hands the error back to the caller, and the caller records it as unknown evidence, which counts toward refusing rather than allowing.

This change adds the standard comment telling the test that the place is intended, with the reason. It changes no behaviour, and the count returns to 494.

What needs deciding: nothing. It is a comment-only change made before the pull request is opened, so the merge line's check passes.
