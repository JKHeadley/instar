# Separate Telegram detector checks from verified cleanup

## What Changed

The owned configuration canary retains its six-second check deadline and now measures verified cleanup separately, with a 30-second bound. Passing health requires the complete ordered checks, cleanup acknowledgement, normal worker exit, termination and private-fixture removal. Missing or late cleanup latches unavailable health and prevents further attempts while retaining ownership until outstanding teardown settles.

## What to Tell Your User

A Telegram diagnostic can show cleanup running after its checks finish. Slow filesystem watcher shutdown no longer spends the check deadline. A passing diagnostic still does not prove that a message was delivered.

## Summary of New Capabilities

Existing detector health distinguishes active cleanup from completed proof. Startup and retry limits remain in place. Installed agent guidance receives an idempotent update preserving operator additions.

## Evidence

The separate side-effects artifact records measured watcher teardown, independent review, boundary coverage and release validation. This fragment alone is not evidence that a release is active.
