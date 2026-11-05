# Thirteen more fixes to the locked-screen test, from its first real run

## What this is

Instar can show and control a Mac's screen remotely, even while that Mac is locked. To prove the locked-screen part is safe, a test driver on a real Mac Mini opens the same remote-desktop web page a person would use, types the password into it, breaks things on purpose (kills the server, freezes it, pulls the network) and checks that the Mac always ends up locked again. On 5 November 2026 the driver ran for real for the first time, and several of its own mistakes showed up. None of them was a fault in the product. The first, a wait for a hidden button, is already fixed. These are the other thirteen.

## What went wrong, and what changes

**Its "freeze the server" tests never froze anything.** The test server ran inside tmux, a terminal tool that immediately wakes up anything frozen inside it. So the test believed the server was frozen, saw the Mac stay unlocked, and reported a safety failure that was not real. Those tests now run the server under the Mac's own service manager, where a freeze holds, and the driver checks that the server really is frozen before it judges anything. If it is not, the test stops with a clear error instead of a wrong verdict.

**It did not wait for a restarted server.** After restarting the test server, the driver went straight on. For about a minute a new server does not yet know whether the Mac is locked, so the driver recorded "unknown" as the end state and the next test found the page not ready. The driver now waits for the server to know.

**It asked only one of the two test agents.** Two test agents watch the same Mac. If the first answered "I don't know yet", the driver took that as the answer. It now asks the second.

**It trusted a reading that could be minutes old.** To decide whether the Mac ended up locked, the driver asked the test server. The server answers from memory, and only refreshes that memory while someone has the remote screen open. So after the screen was closed it could keep saying "unlocked" about a Mac that had been locked for two minutes, and the test failed for a problem that did not exist. It could just as easily have passed a test wrongly. The driver now asks the Mac itself, through the operating system's own record of whether the screen is locked, and writes the server's answer next to it so the difference is visible. The stale answer from the server is a real product bug and has been reported separately.

**It left one of the two test agents switched off.** One test kills the terminal tool both test agents run in. The driver restarted only the first agent, so the second stayed off for the rest of the run. Restarting now always starts the first agent and also brings back the second if it is off.

**It treated "already gone" as a failure.** While tidying up after a test, the driver tried to wake a process that had already exited, and counted that as an error. Waking something that is gone is now skipped. Freezing or killing something that is gone is still an error, because then the test did not do what it claims.

**Its "in the middle of typing" tests fired too early.** Some tests break something while the password is being typed. The driver decided typing had started as soon as the helper that does the typing was running, but that helper starts the moment the remote screen opens. So the test broke things before any password had been sent, and there was nothing to check. Typing now means the password has actually been handed over and Enter has not been pressed yet.

**One test waited for something that was never due.** The Mac has a small guard program whose only job is to lock it again when a remote session ends. One test kills that guard while a session is open, and expected the Mac to be locked afterwards. But the test never ended the session. The product did what its design says: it started a new guard within a few seconds and left the Mac open for the person still using it. The test now ends the session once the new guard is in place, and then checks that the Mac locks.

**It tried to end a session it did not own.** Some tests end the remote session from outside the page, the way a second device would. The driver did that with a sign-in of its own, and the server refused, correctly: only the sign-in that opened a session may end it. The driver did not notice the refusal and went on to judge a session that was still open. It now ends the session with the page's own sign-in, and treats a refusal as a failed test step.

**It looked for leftovers when there was nothing to leave behind.** After a test, the driver checks that the helper which types the password is gone. One test never sends a password at all and expects the session to stay open, so that helper is rightly still there. The check now only applies when a password was actually sent and its relock duty has finished.

**Three timing mistakes.** One test waits for a ten-minute limit but gave up watching after four and a half minutes. Another is meant to have that limit arrive while the password is being typed, but aimed so late that typing would only have started after the limit, when the password box is already gone. And the check that the owner gets a security alert after a failed relock looked once, immediately, although the alert is sent by a routine that runs every ten seconds; the alert arrived nine seconds later and was missed. All three now use the right times.

**One gap in the notes.** When a typed password got no clear answer, the driver wrote down only that nothing happened. It now also writes down what the page said on screen while it waited, so a later reader can tell why.

**One test checked for tidying-up at the wrong moment.** If typing is interrupted half-way, part of a password can be left in the Mac's password box. The design is that the next session clears the box before anything else can be typed, and until then keeps a note that the box is unclean. The test expected the note to be gone at the end of the interrupted session, which the design never promised. It now opens a next session and checks the box is cleared there.

## What stays the same

The product is unchanged: the web page, the server and the safety guard all behaved correctly. Once the freeze test was fixed, it passed: the guard noticed the frozen server and relocked the Mac. Nothing here reaches any running agent; it only affects the proof tool run by hand on the test Mac.

## What you need to decide

One thing to be aware of rather than decide: the last fix above changes what a test asks for. If you want the Mac to lock straight away whenever its guard dies, even with a session open, that is a change to the product's design, and it is not what the current design or this test says. These are fixes to test tooling that a revert fully undoes, each with a unit test so the mistake cannot quietly come back.
