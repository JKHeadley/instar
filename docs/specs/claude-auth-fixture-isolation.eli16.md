# Keep sign-in tests independent of the developer’s login

Two unit test files launch a small script that stands in for Claude. The tests start with the Claude sign-in token cleared so a developer can run the signed-out cases even while signed in. The reviewer tests also clear the selected login directory. Vitest restores the original environment after each case.

The script for the configured-key case checks that the expected synthetic key arrived through the child environment and that the command arguments exclude that key. It reports success only when both checks pass. Older versions copied the received token and arguments to disk to make the same assertions. Every temporary directory created by this file belongs to the test and is cleaned up afterward.
