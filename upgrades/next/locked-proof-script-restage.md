<!-- internal-only -->
# Locked-Mac proof scripts: build and re-stage fixes

## What Changed

The locked-Mac test build script no longer fails at packaging. npm ran the repo's husky `prepare` step even with scripts turned off, so the build now drops `prepare` from its scratch copy. The proof setup script can now install a newer test build over the existing test agents. It only creates an agent that doesn't exist yet. These are developer test scripts only, with no change to agent behavior.

## Evidence

Hit live on 2026-11-20 while building and staging 1.3.1942-lockedproof.6 for the Mac Mini proof run. Unit tests in tests/unit/locked-proof-build.test.ts and tests/unit/locked-proof-driver.test.ts cover both fixes (91 passing).
