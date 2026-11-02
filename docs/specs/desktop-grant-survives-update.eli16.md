# Keeping the Mac's remote desktop permission through updates

**What went wrong.** To see the screen and move the mouse, Instar uses a small Mac program called the desktop helper. A person has to allow that program once in System Settings. macOS remembers that yes for the exact program. Our helper is not signed with a real Apple developer certificate, so "the exact program" means its precise bytes. Change one byte and the yes is gone.

On November 1 two Macs lost that yes when they updated to 1.3.1580. We checked every release from 1.3.1575 to 1.3.1580. The helper was byte-for-byte the same in the first five, and changed in the last one, because the code of the helper itself was edited that day. So the story was not "every build loses it". It was "this release really did change the helper".

**What already existed.** Each agent on a Mac had its own copy of the helper, inside its own install. That meant a separate entry in System Settings per agent, and a new set of bytes whenever a build came out different. Our release builds happen to give identical bytes today, but a new compiler would quietly change them.

**What is new.** Each Mac now keeps one permanent copy of the helper in a fixed folder that updates do not touch. Every agent on that Mac uses it. It is replaced only when the helper's actual source code changes. A new compiler, or any update that does not touch the helper, can no longer cost the permission.

**What this does not fix.** When the helper's code really changes, macOS still drops the permission. Only a real Apple certificate fixes that, and only the Apple Account Holder can create one. Until then, a helper change means someone must allow it again at that Mac. So the machine now says exactly that, in plain words, in the place people see it and as one Attention item, instead of just reading "not ready".

**Safeguards.** If the installed copy still has a working permission, it keeps being used until the kept copy has its own, so this change cannot take away access. If the kept copy will not run, the Mac goes back to the installed copy. An older agent cannot swap the helper back and undo a newer one's permission. A developer's test build can never replace it. `remoteDesktop.retainedHelper: false` turns it all off.

**What you need to decide.** Nothing for this change. Separately, whether to create the Developer ID certificate, which is what actually ends the re-approvals.
