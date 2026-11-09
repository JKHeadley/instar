# The DNS sandbox test names its own Node

## What this is

One integration test checks that the feedback executor's macOS sandbox lets a Node process load its DNS settings. It does that by starting a shell inside the sandbox and running a small Node command there. The command said `node`, so the shell had to find Node on its PATH.

## Why it broke

Local Verify on the shared Mac M5 Pro runs Node by its full path, and the shell inside the sandbox there has no `node` on its PATH. So the shell answered "node: command not found" and the test failed. It failed for every pull request that machine verified: three in one day, including the one that added the test. The same test passed on the Mac Studio, where Node is on the PATH. So whether a pull request passed depended on which machine picked it up.

## What changes

The test now runs the exact Node binary that is running the test, by its full path. Nothing else changes. The sandbox settings it checks are the same, and the timeout and assertions are the same. No product code changes. A real DNS hang still fails the test, as before.

## How it was checked

On the M5 Pro, the old test failed with "node: command not found" and the new one passes. It also passes on the Mac Studio.
