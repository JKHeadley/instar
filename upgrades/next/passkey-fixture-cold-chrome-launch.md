# Slow first Chrome start no longer times out the passkey browser

## What Changed

When the passkey browser starts Chrome, the first command it sends now waits on the launch timeout instead of the shorter per-command timeout. Until Chrome answers that first command it is still starting up, and on a busy machine the first cold start of Chrome can be slow. The passkey browser test also starts Chrome once before its cases run, so the cold start no longer fails whichever test runs first.

## What to Tell Your User

Nothing to do. Saved sign-ins that use a passkey are less likely to fail with a timeout on a busy machine.

## Summary of New Capabilities

- None. This changes one timeout; behaviour, permissions and routes stay the same.
