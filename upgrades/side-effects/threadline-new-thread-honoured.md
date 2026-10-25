# Side-effects review: a requested new Threadline thread actually goes out as one

Tier 1: 7 source/test files plus docs, about 90 lines of source. Effort: no spec rounds; one commit.

Changes: (1) `POST /threadline/relay-send` hoists `forkRequested` (`fork: true` or `newThread: true`), refuses it together with a `threadId` (400 `fork-conflicts-with-threadId`, nothing sent), and records the thread it decided for the wire (`routeDecidedWireThreadId`: the minted id for a fork, or the canonical id when the conversation-discipline resolver ENFORCES a join). The relay leg and the cross-machine forward leg now pass that id when the caller named none; before, they passed the caller's own `threadId` (undefined), so the relay client fell back to its per-peer thread affinity and the fork was lost while the response reported success. (2) After the relay send, if a fork was requested and the client reports a different wire thread, the route still writes every record (delivery ledger, canonical thread log, origin capture, outbox) because the message is already out, and only the final answer changes: 502 `fork-not-honoured`, naming the thread it went on and saying not to resend. (3) `threadline_send` gets `newThread` (default false), passed through `sendMessageViaHttp`. (4) CLAUDE.md template + `migrateClaudeMd` section "A2A new thread with a peer", listed in the cross-framework shared sections.

Principle check: the 400 is a deterministic input-contract refusal (two contradictory caller instructions), not a content judgement; the 502 is an honest delivery outcome, not a gate. No detector gains blocking authority (docs/signal-vs-authority.md).

1. **Over-block** — a caller that sent `fork: true` with a `threadId` used to be silently sent on that thread; it now gets a 400. That combination has no consistent meaning, and the error says to send one or the other. No other input changes.
2. **Under-block** — the 502 runs after the message is already on the wire (a client that ignored the explicit thread cannot be detected earlier); the response names the thread it actually went on and says not to resend, so the caller is neither misled nor pushed into a duplicate, and the records are still written so the message stays in history and peer-health tracking. The real `ThreadlineClient` honours an explicit thread first (`sendEncryptedKnown`, `sendToPinned`), so this path is a guard, not an expected outcome. The local same-machine delivery path already used the route's `effectiveThreadId` and is unchanged.
3. **Level of abstraction** — fixed in the route, which owns the thread decision; the relay client's precedence (explicit > affinity > mint) is correct and untouched.
4. **Signal vs authority** — no new authority. See principle check.
5. **Interactions** — default sends (no thread, no fork) are byte-identical: `routeDecidedWireThreadId` stays undefined unless a fork is requested or the resolver is enabled AND not dry-run AND joined an existing binding (dry-run is the shipped default, where the decided id is a throwaway mint and is deliberately not put on the wire). In enforce mode, putting the canonical join id on the wire is the resolver's stated intent, which the affinity fallback used to override. The backup-routes fall-through (`postIssued`) still wins over everything, as before. The negotiator gate already keyed on `effectiveThreadId`.
6. **External surfaces** — the peer sees a new thread id when one was requested (the intended fix). New 400/502 reasons on relay-send; new optional MCP tool argument.
7. **Multi-machine posture** — proxied: a standby forwards the decided thread id as an explicit `threadId` to the relay holder, which honours it as explicit. No new state.
8. **Rollback cost** — revert the commit. No data or state migration; the CLAUDE.md section is additive text.

## Class-Closure Declaration

- defectClass: `decided-value-dropped-downstream`
- closure: `closed-at-chokepoint`
- reason: both outbound legs that reach the relay (direct relay send and cross-machine forward) now take the same route-decided id; the local leg already did.

## Second-pass review

Reviewer (independent subagent, 2026-10-25): "Concur with the review." Checked: default sends unchanged (dry-run resolver returns `would-join`, never `joined`); no remaining path loses the fork (credential-pinned and both relay sends use `relayLegThreadId`; the forward leg carries the decided id as an explicit `threadId`; local send, negotiator gate and `waitForReply` already used the decided id; the body `threadId` reads that remain are the caller's own thread by design); the enforce-mode join change carries out the resolver's stated intent; the new 400 precedes `tryClaimReply`, and the 502 is released by the existing `finish` handler. Concern applied: the 502 originally returned before `recordSent` / the canonical log, dropping an already-sent message from history and inviting a resend; it now writes every record and only rewrites the final answer (test asserts `recordSent` ran on the 502 path).
