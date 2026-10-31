# Side-effects review: pairing invites require owner info

**Summary.** Tier 1. Requested by Justin, topic 9210, 2026-10-30. An agent with no owner name cannot make or approve an invite; inbound invites and accepts with a blank owner are refused. The owner name now also resolves from the registered users file and the one verified Telegram operator. A revert fully undoes it.

**Second pass.** The first review raised a blocker (operator store read from the wrong folder) and side effects from building a UserManager per call. Both fixed: `readPairingOwnerName` reads the real paths and writes nothing, with a test on the real file layout. Also fixed from that review: invisible-character names count as blank, the setting is read live, and the Telegram `promptGate.ownerId` is honored.

**Decision point?** Yes: pairing admission. The check is an exact blank test on a declared field, not a heuristic, and it only refuses; the operator's Approve/Finish remain the authority.

1. **Over-block.** Older agents that send a blank owner are refused until they update. This is what was asked for. An agent with no registered user and no verified operator cannot pair until it has one or sets `threadline.ownerName`; the refusal says so.
2. **Under-block.** The name is a claim: any non-blank text passes, including a false name. threadline-mcp defaults to the OS username, so a standalone agent may state an unhelpful name; it is not blank. threadline-mcp calls the engine directly, so a standalone agent still prompts on a blank invite from an older Instar agent; it ships separately and is filed to the feedback queue. Core's `inviteMessage` still has the "unknown owner" fallback text, unreachable from Instar because a blank invite can no longer be made.
3. **Level of abstraction.** The rule sits in the handshake wrapper, ahead of the engine, because the engine posts the Approve and Finish prompts itself and the pinned core 0.1.0 cannot change without a publish. The handshake copy and core's module stay byte-identical below the header.
4. **Signal vs authority.** Blocking on a deterministic validity check of a required field, the same class as the existing malformed-invite refusals. No judgment is made by brittle logic.
5. **Interactions.** Accept refusal uses the existing refusal path with a one-notice-per-invite limit. The blank check runs before the engine verifies the accept's signature, so someone holding the invite id could provoke the one notice with a forged blank accept; the id is secret to invite holders and the invite stays open. Second-accept alarms are unaffected because a blank accept never reaches the engine.
6. **External surfaces.** New wire refusal reason `owner-required`. Older peers discard it as malformed and show a no-answer timeout. MCP and HTTP callers of invite creation get the plain reason.
7. **Multi-machine posture.** Machine-local read at each use. The relay holder makes invites, so the holder's users, operator bindings and config decide. A standby holds no relay and makes none.
8. **Rollback cost.** Code revert. No stored state or data migration; one added CLAUDE.md line on existing agents, harmless if left behind after a revert.

**Second-pass result.** Concur with the review (after the fixes above).
