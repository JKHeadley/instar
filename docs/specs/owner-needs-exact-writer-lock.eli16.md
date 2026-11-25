# Keep one journal writer in charge

A machine must hold an exclusive lock before it can save a Needs You decision. A file timestamp cannot tell us whether an old writer is dead or merely paused. The new write path can use the existing operating-system lock to keep a second writer out while the first process is still in charge. If the operating-system lock is unavailable, the new decision writer stays off.

The strict writer marks its local lock so updated journal processes do not take it away solely because it looks old. A process that lost or never obtained the lock cannot remove the current owner's file. The tests cover two contenders and the case where a live owner has an old timestamp. This checkpoint stays disconnected from the live decision screen. Activation also requires every local journal writer to honor the strict ownership rule.
