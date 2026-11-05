# Three more fixes to the locked-screen test, from its first real run

## What this is

Instar can show and control a Mac's screen remotely, even while that Mac is locked. To prove the locked-screen part is safe, a test driver on a real Mac Mini opens the same remote-desktop web page a person would use, types the password into it, breaks things on purpose (kills the server, freezes it, pulls the network) and checks that the Mac always ends up locked again. On 5 November 2026 the driver ran for real for the first time, and several of its own mistakes showed up. None of them was a fault in the product. The first, a wait for a hidden button, is already fixed. These are the other three.

## What went wrong, and what changes

**Its "freeze the server" tests never froze anything.** The test server ran inside tmux, a terminal tool that immediately wakes up anything frozen inside it. So the test believed the server was frozen, saw the Mac stay unlocked, and reported a safety failure that was not real. Those tests now run the server under the Mac's own service manager, where a freeze holds, and the driver checks that the server really is frozen before it judges anything. If it is not, the test stops with a clear error instead of a wrong verdict.

**It did not wait for a restarted server.** After restarting the test server, the driver went straight on. For about a minute a new server does not yet know whether the Mac is locked, so the driver recorded "unknown" as the end state and the next test found the page not ready. The driver now waits for the server to know.

**It asked only one of the two test agents.** Two test agents watch the same Mac. If the first answered "I don't know yet", the driver took that as the answer. It now asks the second.

## What stays the same

The product is unchanged: the web page, the server and the safety guard all behaved correctly. Once the freeze test was fixed, it passed: the guard noticed the frozen server and relocked the Mac. Nothing here reaches any running agent; it only affects the proof tool run by hand on the test Mac.

## What you need to decide

Nothing. These are fixes to test tooling that a revert fully undoes, each with a unit test so the mistake cannot quietly come back.
