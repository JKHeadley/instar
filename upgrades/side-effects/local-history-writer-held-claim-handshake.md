# Side-Effects Review for Writer-Held Local History Claim Handshake

The existing fixed reader can announce the first verified claim plan while its actual destination writer lock is held. A synchronous trusted parent observer sees bounded sizing and the plan digest. The only accepted reply discards that exact digest. No witness is a write token.

## Over-block

Wrong message order, unexpected shape, changed digest, parent policy refusal, lost authorization or disconnect ends the attempt. A held writer can briefly delay other history writers while the parent observes. Existing per-file deadline and cancellation supervision bound the extra wait.

## Under-block

This is a discard-only exchange. It does not write a claim, reserve space, persist a permit, authenticate an apply acknowledgement or provide production headroom policy. A future mutation path must preserve exact writer custody and commit its permit before delivery.

## Abstraction fit and interactions

The child completes full artifact and EOF validation first, calculates the real plan inside the existing writer, and waits on its private IPC channel. The parent checks the exact mode, phase, bounded response and authority, calls the trusted synchronous observer, and sends only the digest-bound discard. Completion must carry the same plan digest. Actual worker exit releases custody. Normal preview and ordinary estimate calls do not use the handshake.

## Signal versus authority

Under docs/signal-vs-authority.md, the real writer hold and message identity establish evidence. A successful observation gives neither consent nor authority to write.

## External surfaces and machine scope

Only the internal fixed reader can use this optional mode. There is no route, new worker executable, setting, schema, external service or user control. All operation data stays on the selected machine.

## Rollback

Revert both private ends together. No persisted format or operation state changes.

## Class-Closure Declaration

The unbounded-self-action class does not apply. The existing one-shot child emits one plan and accepts at most one discard. The parent waits for actual close and starts no retry.

## Independent review

The reviewer concurred after checking that asynchronous observer results are refused and their rejections are handled. The reviewer also confirmed that the stop guard is set before signaling the child, preventing repeat escalation if signaling emits an error synchronously.
