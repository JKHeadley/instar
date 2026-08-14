## What Changed

The check added earlier today to stop a required argument being forgotten was itself blind to renaming — and two places it could not see had forgotten it.

- **The check matched the class by the literal text of its name.** Two places import that class and rename it locally, which is ordinary, and construct it under the new name. It never saw them, and reported that every construction was correct while two were not.
- **It now resolves every local name the class is bound to** before scanning, so renaming on import no longer hides a construction site.
- **Both hidden places are wired.** One matters immediately: it feeds a read named "active conversations on this machine" into the component that decides where work runs, so that component could never see an active conversation. The other reads only a conversation's focus today, and is wired anyway so a future reader cannot silently inherit a wrong answer.
- **Failure stays safe.** Both lookups fall back to "not running" if they throw — the same value the missing argument produced.

## What to Tell Your User

A safeguard was added this morning to make sure a particular setting is never left out. It passed, and it was wrong: it looked for the thing by name, and two places refer to it by a different name locally. Both had left the setting out.

One of them feeds the part that decides which machine should pick up work, through a reading described as "which conversations are active here" — which was always empty. That is now correct.

The lesson is the one the safeguard existed to teach, turned on the safeguard itself: something that checks by matching a name can be defeated by renaming, and looks entirely healthy while it happens.

## Summary of New Capabilities

None. This corrects a test's target resolution and supplies an existing setting at two further places. No new command, route, setting, or behaviour, and nothing gates on the corrected values.

## Evidence

Demonstrated rather than argued: on the tree before this change, the existing check passes every one of its assertions while two unsupplied sites exist. Made name-aware, it fails and names the file twice; with both sites supplied, it passes again. A new test constructs the class under a renamed import and asserts the check finds it — that test fails against the previous version. Typecheck clean and ten of ten tests passing across the check and the project's silent-failure ratchet, whose allowance was not raised: both new fallbacks carry an explicit marker and a written reason.

This was found by a second agent running an independent audit, which resolved the class through the type system instead of matching its name. It found four construction sites where the original check found two.
