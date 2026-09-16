# Separate Telegram detector checks from verified cleanup

## What Changed

The owned configuration canary retains its six-second check deadline and now measures verified cleanup separately, with a 30-second bound. Its disposable worker removes the private fixture and reports worker-side completion timing; the parent then terminates the watcher thread as one owned resource boundary. Passing health requires complete ordered checks, valid cleanup proof, actual worker exit, and idempotent parent removal. Missing or late cleanup latches unavailable health and prevents further attempts while retaining ownership until outstanding teardown settles.

## What to Tell Your User

A Telegram diagnostic can show cleanup running after its checks finish. Slow per-watcher shutdown no longer turns healthy checks into a false cleanup timeout. A passing diagnostic still does not prove that a message was delivered.

## Summary of New Capabilities

Existing detector health distinguishes active cleanup from completed proof. Startup and retry limits remain in place. Installed agent guidance receives an idempotent update preserving operator additions.

## Evidence

The separate side-effects artifact records the reproduced 15–43 second native watcher-close stall, the worker-boundary repair, boundary coverage and release validation. This fragment alone is not evidence that a release is active.

Aggregate-load validation also separated storage-worker startup from ordinary request timing and made the real-tmux byte-exact control wait until its receiver has entered raw mode. These are bounded reliability fixes; they grant no new delivery authority.

Production configuration and notice-policy readers now avoid parent-process native filesystem watchers too. They poll exact source metadata on a short unrefed cadence, retain fail-closed invalidation and the existing five-second refresh/30-second expiry limits, and close by cancelling a timer. This removes the same macOS watcher-close stall from normal runtime teardown without changing delivery authority.

That observer is registered in the self-action convergence ratchet, which enforces its 250 ms rate floor and deterministic close boundary.
