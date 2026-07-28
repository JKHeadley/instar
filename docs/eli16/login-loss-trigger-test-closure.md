# Login-loss recovery: proving the safety posture through the real route

The login-loss recovery trigger already exists on current `main`. When a live
conversation's local account login disappears, Instar can feed that condition
into the same careful account-swap path used for quota pressure. It does not
invent a second detector or a second restart mechanism. It uses the account
identity attached to the conversation's real configuration home, the existing
anti-thrash brakes, the existing fresh-target selection, and the existing
last-moment revalidation before a conversation can restart.

This change closes the missing verification layer. The HTTP integration test
now proves that an account with plenty of quota still becomes a candidate when
its login is explicitly marked as requiring the owner to log in again. It also
proves that the default posture records the intended move but calls no swap
executor. A separate promoted case proves that turning simulation off sends
the same intent through the already-established swap callback.

The end-to-end test boots the real route, subscription pool, anti-thrash
engine, ledger, and monitor together. It first observes the simulation-only
posture over HTTP and verifies no move happens. It then deliberately promotes
the trigger, waits through the normal dwell brake rather than bypassing it, and
proves that the exact login-loss intent is dispatched to the established swap
callback with the fresh healthy account selected.

When the braked login-loss pipeline is wired, the status route also reports
whether recovery is enabled and whether it is still simulation-only. Without
that prerequisite brake pipeline, the trigger does not run and no rollout
posture is advertised. This is observability, not a new control: it does not
change a session, relax a guard, or create another source of authority.
Ordinary machines remain dark, development machines remain simulation-first,
and uncertainty still means no action.
