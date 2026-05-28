# Side-Effects Review — mentor-cycle reply leg over /a2a/inbox

**Spec:** `docs/specs/MENTOR-LIVE-READINESS-SPEC.md` §Recipient side (§281:
"Codey's reply goes back via sendAgentMessage role=mentor-reply"; §250:
finding-emission-only capability handle). Fourth + final fast-follow closing
the round-trip. Same approved spec — implementing the reply half with the
HTTP-transport substitution established in #466 (Telegram blocks bot-to-bot).

**Change:** `src/server/AgentServer.ts` only (+ 1 new test file).
- `installMentorMessageHook` generalized: builds a combined a2a hook on the
  primary adapter covering BOTH `mentor` (mentee side, from `config.mentee`)
  and `mentor-reply` (mentor side, from `config.mentor.menteeBotId`).
- New `deliverA2aMessage` private helper: unified same-machine `/a2a/inbox`
  (HTTP) + Telegram-fallback transport for both directions.
- `deliverToMentee` refactored to call `deliverA2aMessage` (removes the inline
  #466 logic, fixes the `\n\n` marker bug).
- Mentee reply capture: last-non-empty-while-alive (reap-race fix).
- `tests/e2e/mentor-reply-via-inbox.test.ts` (new, 1).

## The seven questions

1. **Over-block.** N/A — additive. Non-a2a traffic falls through unchanged;
   the consolidated hook only adds role-handlers.
2. **Under-block.** Spoof defense unchanged (decideRoute's bot-id allowlist,
   covered by the primitive's own unit tests). The mentor-reply handler stays
   finding-emission-only (persist to jsonl + clear OutstandingPromptTracker —
   no spawn/deliver/schedule), preserving the spec §250 capability-handle
   invariant.
3. **Level-of-abstraction fit.** Consolidates two previously-separate hook
   installs (mentor-bot adapter + primary adapter) onto one primary-adapter
   hook. `deliverA2aMessage` unifies what was duplicated transport logic.
   Net reduction in surface.
4. **Signal vs authority.** The hook decides route/drop (spec routing matrix);
   handlers are capture-only / finding-emission-only; `deliverA2aMessage`
   audits every send to the ledger. No new authority.
5. **Interactions.** Reuses AgentRegistry + AgentTokenManager + the existing
   `/a2a/inbox` route (#466) + `getOrCreateMentorOutstanding` + the a2a ledger.
   `installMentorReceiverHook` (mentor-BOT adapter, Telegram path) is left in
   place for cross-machine; the primary-adapter hook is the same-machine path.
   Both write to the same `mentor-replies.jsonl` (append-only, safe).
6. **External surfaces.** No new routes, no new config keys. `mentor-replies.jsonl`
   rows gain a `transport` field (additive).
7. **Rollback cost.** Trivial — revert restores the per-side installs +
   inline deliverToMentee logic. No migration, no config change.

## Testing

1 new E2E (`mentor-reply-via-inbox`): a `mentor-reply` marker POSTed to
`/a2a/inbox` on a mentor-configured server routes through the consolidated
hook + persists to `mentor-replies.jsonl` with the right corr/from/message/
transport. All 22 prior mentor/mentee/inbox tests still green (no regression).
`tsc --noEmit` clean.

Live round-trip verification (test-as-self) is performed post-release against
the live Echo↔Codey pair — the autonomous run's completion criterion.

## Migration parity

No new config keys; the consolidated hook reads the existing `config.mentee`
+ `config.mentor` blocks. Purely additive — agents with neither configured
get no hook (same as before). No PostUpdateMigrator change required.
