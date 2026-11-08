<!-- internal-only -->
# Upgrade Guide — dns-sandbox-test-node-path

## What Changed

The macOS DNS sandbox integration test now runs Node by the full path of the running interpreter instead of `node` on the sandbox's PATH, so it passes on verifiers that start Node by absolute path. Test-only.

## Evidence

On the M5 Pro verifier the old test failed with `node: command not found` and the new one passes; it also passes on the Mac Studio.
