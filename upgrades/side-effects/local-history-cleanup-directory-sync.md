# Side-Effects Review for Local History Cleanup Directory Sync

Temporary-run cleanup now pins the verified parent directory, removes the registered run directory, syncs the pinned parent and verifies physical absence before marking the row disposed. It uses the existing cleanup entry points and typed rows.

## Over-block

If directory sync fails or the parent identity changes, cleanup stays pending. A failed sync after removal leaves the original charge held even when the old path is absent. A later takeover cannot infer successful removal from absence alone under the current schema.

## Under-block

Ordinary directory sync establishes an operating-system ordering boundary where supported. It does not prove a hardware cache flush or cover every filesystem. Future recovery needs durable evidence for a crash after removal but before the row is settled. No automated recovery path or row retirement is introduced here.

## Abstraction fit and interactions

The registry already owns verified temporary names and actual child-close or old-generation takeover proof. It persists cleanup-pending before unlinking private names. It syncs the opened parent directory after removal and checks the original store and parent identities before persisting disposed. Staging retains its physical-absence guard. Final published attachments and conversations are outside this namespace.

## Signal versus authority

Under docs/signal-vs-authority.md, directory identity, exact removal and successful sync are protocol evidence. They do not grant any new cleanup scope or copy permission.

## External surfaces and machine scope

The change is internal and machine-local. It adds no route, setting, schema, release hook, app control or new cleanup invocation.

## Rollback

The row format stays the same. Reverting loses the extra sync guarantee, so any already unresolved charge must stay with the existing recovery custody.

## Evidence

The focused test injects a sync failure on the real pinned parent after successful removal. The row remains cleanup-pending and a real next-generation recovery retains it.

## Independent Review

The reviewer concurred with the pinned-parent sync ordering and retained-state boundary. The regression also verifies physical absence outside the injected callback. The reviewer inspected the source and tests without running them.
