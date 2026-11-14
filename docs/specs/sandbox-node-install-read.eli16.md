# The feedback executor can find Node when Node is installed in the home folder

## What this is, in plain words

The feedback executor runs each attempt's commands inside a macOS sandbox, so a fix in progress cannot read secrets or other agents' files. To do that, the sandbox blocks reading anything in the user's home folder, then re-opens only the folders that attempt needs: its own workspace, its temp folder and the shared dependency cache.

That works when Node is installed in a system place such as /usr/local/bin, as on the Mac Studio. It breaks when Node is installed inside the home folder, which is what nvm, fnm and volta do. The M5 verifier has Node at ~/.nvm/versions/node/v24.15.0. Inside the sandbox, the shell looks up `node` on PATH by checking the file exists, that check is refused because the file is in the blocked home folder, and the shell says "node: command not found". Running Node by its full path still works, which is why the problem hid.

It showed up as one test, tests/integration/feedback-execute-dns-sandbox.test.ts, failing on the M5 every time and passing on the Studio. Three PRs (#2912, #2933, #2927) failed Local Verify on it for code they never touched, and the M5 was taken out of the verifier pool. The same block would also stop the real executor running `node` or `npm` on any machine that installs Node with nvm.

## What changes

When the sandbox settings are built, the folder Node is installed in (the folder above Node's `bin`) is re-opened for reading, but only when it is inside the home folder. It is not re-opened when that would re-open something that must stay closed: if the folder is the home folder itself, contains the agent home, the publish clone or a credential folder such as ~/.ssh or ~/.config, or sits inside the agent home or the publish clone. Reading only: nothing new becomes writable. A system install outside home changes nothing, so the Studio and Linux behave exactly as before.

## What already exists and stays the same

The home folder stays blocked. Credential folders stay blocked. Writes stay limited to the attempt's own workspace and temp folder. The network allowlist is unchanged. The worker session's sandbox uses the same filesystem block, so it gets the same fix and nothing else.

## Safeguards

A Node install folder holds Node, npm and globally installed command-line packages, and no credentials. The guards refuse any install location that would widen access to home, the agent home, the publish clone or a credential folder. Tests check both sides: the nvm case is re-opened and found on PATH inside a real sandbox, and a system path, ~/bin, a folder holding the agent home or ~/Library, and folders inside the agent home or publish clone are all refused.

## What to decide

Nothing needs a decision. This is a small reversible fix; a revert restores the old behaviour.
