# The feedback executor finds Node when Node is installed in the home folder

## What Changed
The feedback executor's sandbox blocks reading the home folder and re-opens only the attempt's own folders. On a machine where Node is installed inside the home folder (nvm, fnm, volta), commands inside the sandbox could not find `node` or `npm`: the shell said "command not found", although Node itself could run. The folder Node is installed in is now re-opened for reading when it is inside home, unless that would re-open the home folder, the agent home, the publish clone or a credential folder. The global npm config inside that folder stays unreadable, since it can hold a registry token. Machines with Node installed elsewhere are unchanged.

## What to Tell Your User
Nothing changes in how you use your agent. On machines where Node was installed with a version manager, the agent's automatic fix runs could fail to start their tests; they now work.

## Summary of New Capabilities
- Automatic fix runs work on machines that install Node in the home folder.

## Evidence
Found on the M5 verifier (fb-c238c6c9-f0d): tests/integration/feedback-execute-dns-sandbox.test.ts failed there every run with "node: command not found" and failed three PRs' verifies; it passed on the Studio, whose Node is in /usr/local/bin. A new integration test builds a home with an nvm-style Node and runs the real sandbox: Node is found when its install is re-opened and not found when it is not. Unit tests cover each guard on both sides.
