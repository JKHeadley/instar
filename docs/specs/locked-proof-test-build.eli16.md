# A test build for proving the locked-Mac feature (ELI16)

## What this is

Instar has a feature that lets you open a locked Mac remotely and makes sure the Mac locks itself again afterwards. It ships switched off. The code will only let anyone turn it on for a macOS version that is listed in a table inside the source code, and a version only goes in that table after two safety tests have passed on a real Mac: the crash tests (does the Mac always end up locked, whatever crashes) and the Stop tests (does the Mac always end up locked, whenever you press Stop). Today that table is empty, so nobody can turn the feature on.

That creates a chicken-and-egg problem: to run the tests on a real Mac, the feature has to be turned on, and it cannot be turned on until the tests have passed. The design answer is a special test build that lists one macOS version as "proof run in progress", installed only inside a throwaway test account. This change adds the script that makes that build.

## What it does

The script takes the code exactly as committed, copies it into a scratch folder outside the project, adds that one "in progress" line to the copy's table, gives the build a clearly different version name (for example `1.3.1607-lockedproof.1`), builds it and packages it. It also writes down which commit it came from and a fingerprint of the Mac helper program, so the test results are tied to the exact helper that real users will run. The real table in the project is never edited, and the test build is never published.

## Safeguards

- A new automatic test fails if the real table ever gets a row that does not point to a recorded proof file, or that carries the "in progress" marker. So the test build's line can never sneak into a real release.
- The script refuses to write its output inside the project folder, and checks afterwards that the real table did not change.
- It only uses committed code, so half-finished local edits cannot end up in the test build.
- It builds with the release signing key removed, so a test build can never carry the signature real releases have.

## What you need to decide

Nothing. This is a tool for the planned test sitting; it changes nothing for any running agent.
