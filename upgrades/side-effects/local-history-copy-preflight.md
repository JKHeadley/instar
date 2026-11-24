# Side-Effects Review for Local History Copy Preflight

This internal check validates the fields and operation binding of a copy intent, rereads every sealed normalized artifact through the existing reader, and compares the current destination with the original sealed preview. It revalidates owner, expiry and the exact receipt after the worker exits. The returned request identity describes this check only.

## Over-block

A compatible but changed claim, changed message-key set or absent-to-existing store transition returns conflict. An incompatible or corrupt claim may fail as unavailable during the worker read. Current staging permits one immutable preview per operation, so retrying after a destination change requires a new prepared operation. Writer contention remains retryable with the same grant while it is live.

## Under-block

Changes after the reader exits are possible. Actual copy must verify each file and claim again under the mutation writer and issue a durable permit before writing. A result gives no permission to copy. Filesystem identity and storage reservation are separate prerequisites.

## Abstraction fit and interactions

Staging owns the immutable copy-intent fields, current owner and sealed receipt binding. The existing worker owns artifact length, digest, provenance, final EOF and destination inspection. The parent accepts the bounded result only after actual child exit. The existing writer-lock path can create or update private lock metadata. No conversation, source claim, preview row or permit is written by preflight. Existing expiry validation can still mark an operation expired and start disposal.

## Signal versus authority

Under docs/signal-vs-authority.md, the comparison uses exact protocol facts. No heuristic result authorizes a write. A stale result preserves the original receipt and authorizes no future mutation.

## External surfaces and machine scope

There is no HTTP entry point or native UI change. The check uses the existing machine-local grant and private staging artifacts. It introduces no schema, replica, setting or notification.

## Rollback

Reverting the internal method changes no existing durable state. Existing preview replay and intent inspection stay available.

## Class-Closure Declaration

The unbounded-self-action class does not apply. A caller explicitly initiates one read, and the existing reader owns bounded termination. The method does not schedule another attempt.

## Independent Review

The reviewer found no mutation-path blocker. The review clarified the division between intent binding and future signature verification, existing expiry effects and incompatible claim refusal. The method reads each intent field once before validation. The reviewer inspected source and evidence without running tests.
