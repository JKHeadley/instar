# Six more fixes to the locked-screen test, from its first real run

## What this is

Instar can show and control a Mac's screen remotely, even while that Mac is locked. To prove the locked-screen part is safe, a test driver on a real Mac Mini opens the same remote-desktop web page a person would use, types the password into it, breaks things on purpose (kills the server, freezes it, pulls the network) and checks that the Mac always ends up locked again. On 5 November 2026 the driver ran for real for the first time, and several of its own mistakes showed up. None of them was a fault in the product. The first, a wait for a hidden button, is already fixed. These are the other six.

## What went wrong, and what changes

**Its "freeze the server" tests never froze anything.** The test server ran inside tmux, a terminal tool that immediately wakes up anything frozen inside it. So the test believed the server was frozen, saw the Mac stay unlocked, and reported a safety failure that was not real. Those tests now run the server under the Mac's own service manager, where a freeze holds, and the driver checks that the server really is frozen before it judges anything. If it is not, the test stops with a clear error instead of a wrong verdict.

**It did not wait for a restarted server.** After restarting the test server, the driver went straight on. For about a minute a new server does not yet know whether the Mac is locked, so the driver recorded "unknown" as the end state and the next test found the page not ready. The driver now waits for the server to know.

**It asked only one of the two test agents.** Two test agents watch the same Mac. If the first answered "I don't know yet", the driver took that as the answer. It now asks the second.

**It trusted a reading that could be minutes old.** To decide whether the Mac ended up locked, the driver asked the test server. The server answers from memory, and only refreshes that memory while someone has the remote screen open. So after the screen was closed it could keep saying "unlocked" about a Mac that had been locked for two minutes, and the test failed for a problem that did not exist. It could just as easily have passed a test wrongly. The driver now asks the Mac itself, through the operating system's own record of whether the screen is locked, and writes the server's answer next to it so the difference is visible. The stale answer from the server is a real product bug and has been reported separately.

**It left one of the two test agents switched off.** One test kills the terminal tool both test agents run in. The driver restarted only the first agent, so the second stayed off for the rest of the run. Restarting now always starts the first agent and also brings back the second if it is off.

**It treated "already gone" as a failure.** While tidying up after a test, the driver tried to wake a process that had already exited, and counted that as an error. Waking something that is gone is now skipped. Freezing or killing something that is gone is still an error, because then the test did not do what it claims.

## What stays the same

The product is unchanged: the web page, the server and the safety guard all behaved correctly. Once the freeze test was fixed, it passed: the guard noticed the frozen server and relocked the Mac. Nothing here reaches any running agent; it only affects the proof tool run by hand on the test Mac.

## What you need to decide

Nothing. These are fixes to test tooling that a revert fully undoes, each with a unit test so the mistake cannot quietly come back.
