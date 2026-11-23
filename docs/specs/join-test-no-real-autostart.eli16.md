# ELI16 overview: a join test stops leaving broken startup services on our machines

When a new machine joins an Instar agent's group, the join step sets up a startup service so the agent runs again after a reboot. On a Mac that is a launch agent; on Linux it is a systemd user service. That is the right behavior for a real join.

One of our automated tests checks that joining works when the target folder does not exist yet. It ran the real join code, including that startup-service step, against a throwaway folder. When the test finished it deleted the folder but left the startup service registered. The machine then tried to start a server from a folder that no longer existed, again and again: every ten seconds on the Mama PC, and on the Laptop since 16 November. It did no damage, but it was constant background noise, it cluttered logs, and the generic name "home" could one day clash with a real agent of that name.

The change: in that one test, the startup-service step is swapped for a stand-in that does nothing. Everything else in the join still runs for real, so the test still proves what it was written to prove. The test also checks that the join reached the startup-service step and used the stand-in, so a future change cannot quietly bring the leak back.

What already exists: the real join behavior is unchanged, and the two leftover services found on the Laptop and the Mama PC have been switched off, with their files kept in backup folders. What is new: only the stand-in in the test and the one extra check.

There is nothing to decide here. This is a test-only fix that a revert fully undoes. A broader guard, stopping any test from touching the real startup-service folders, is tracked separately in feedback fb-2ecf9c2b-055.
