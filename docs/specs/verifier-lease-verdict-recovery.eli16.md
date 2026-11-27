# Recovering a completed test result after a restart

A proposed change can pass its entire test run just as the computer in charge of publishing results gives up that responsibility. The test result is saved on disk, but GitHub can still show the change as waiting. A developer looking at the pull request cannot tell whether anyone tested it.

When a computer takes responsibility again, it checks what GitHub currently shows and evaluates the saved result using the same rules it normally uses. If the result still qualifies, the computer can post it without making everyone wait for another test run. If the target branch changed in a way that requires another run, the coordinator needs a way to put the change near the front of the queue. Today a request for priority can return the earlier result instead.

A replacement run must test the version of the change that is still open against the current target branch. An existing test, an operator's pause, or a newer version of the change can affect whether that run is appropriate. Restarting the computer or asking for priority twice should never create two copies of the same test. The published check must continue to reflect the normal review, test and repository protection rules.
