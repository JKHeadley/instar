# Moving the test helper to a clean spot (plain version)

We are proving that Remote Desktop can open a locked Mac. The test on the Mac Mini is stuck for a boring reason. macOS remembers permissions by the program's location, and the memory at the current location describes an older copy of the helper. Nobody can see that record in System Settings, and the usual tool for clearing records refuses programs like ours.

What is new: the script that makes the test build can now put the helper in a different folder, for that one test build only. A folder macOS has never seen has no old record to trip over. The helper program itself does not change, so what we prove still applies to the helper we ship.

Two small repairs ride along. The test build now always makes the kind of helper that can be kept, which used to need a manual step. And the test driver now writes down whether each "please do this at the Mac" message was really delivered, because a refused message used to disappear silently while the test waited.

Nothing here changes what ships to any agent. The real product problem, that a changed helper can leave a hidden record behind, is still open and tracked in the feedback queue. This is the way past it for the proof, and it is also the way we find out whether a clean location really works.

There is nothing for anyone to decide here. If it turns out wrong, reverting the commit puts everything back.
