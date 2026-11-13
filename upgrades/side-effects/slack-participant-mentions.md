# Side-Effects Review — Slack mentions tag people in the conversation

**Version / slug:** `slack-participant-mentions`
**Date:** `2026-11-12`
**Author:** `Echo`
**Tier:** 1 — narrow, reversible formatting change on one outbound path plus agent awareness; 2 source files for behavior (SlackAdapter, SlackMrkdwnFormatter), 3 for awareness (PostUpdateMigrator, templates, server context lines), 4 test files. One build pass, one test round.
**Second-pass reviewer:** independent /instar-dev reviewer subagent (outbound messaging decision)

## Summary of the change

PR 2748 (2026-11-04) made every Slack `<@U…>` mention literal unless the bound agent passed `--native-reference ID` for it. No agent-facing guidance outside one spawn-context line taught the flag, and non-bound send paths could not pass it at all, so agent mentions arrived as raw text (operator reports 2026-11-04 and 2026-11-12, agent Indra: `<@U0C62ABNDK8> Justin passed on your note…`).

Now the SlackAdapter's single outbound funnel (`formattedApiCall`) resolves the person IDs written in a send-method message against the target conversation: an ID that is a member of the channel or DM (`conversations.members`, cached 5 min per conversation), or that posted in the target thread (adapter ring buffer), AND that `users.info` reports as an active non-bot account, is passed to the formatter as a participant. The formatter keeps those `<@U…>`/`<@W…>` mentions active. Everything else is unchanged: non-participants, bots, the agent itself, Slackbot, deactivated accounts, broadcasts, channel references, links, and anything in code stay literal unless explicitly listed with `--native-reference`. Lookup failure, missing scope or a 2.5 s timeout returns no participants (fail closed, literal), logs at debug level, and never blocks or fails the send. A failed member read is not retried for 60 s per conversation.

Awareness: a `### Slack person mentions` CLAUDE.md section for new agents (generateClaudeMd) and existing agents (migrateClaudeMd, marker-guarded, idempotent), and the Slack spawn and recovery context lines now describe the default instead of the flag-only rule.

## Decision-point inventory

- Formatter native-reference parser (`extractNativeReferences`) — modified — a user mention is active when explicitly listed OR in the participant set; channel references and links still need the explicit list; broadcasts are never matched.
- Adapter participant resolution (`participantMentionIds`) — added — produces the participant set; a signal into the formatter, never blocks.

## 1. Over-block

A real person not in the conversation stays literal (by design; the explicit flag covers it). A person who posted in a thread more than 50 messages ago in a busy channel and has since left the channel stays literal. If the bot lacks `channels:read`/`groups:read`/`im:read`/`mpim:read`, every mention stays literal, as before this change. A bot the agent genuinely wants to tag needs the explicit flag. A `@Name` written as plain words is not converted (see Under-block). Bounds: only the first 16 distinct ids in one message are resolved (later ones stay literal); member lists are read to at most 10 pages (10,000 members), and anyone beyond that stays literal.

## 2. Under-block

A copied excerpt that names a person who is already in the conversation now becomes an active tag where before it stayed literal. The reach is bounded: that person is already in the conversation and can read the message, so this adds a notification but no new audience; broadcasts and outsiders remain inert. Inbound Slack text is still encoded in the agent's context, so a straight copy remains literal; only a deliberate decode re-activates it. Server paths that forward text from elsewhere into Slack through the same funnel (app mirror posts, bridge) also get participant mentions; the same bound applies. A thread poster found in the adapter's 50-message ring buffer is tagged without a fresh membership check, so a person who posted recently in the thread and then left the channel can still be tagged (one person who was already in that thread, not a new audience). Plain `@Name` conversion is not done: it needs a name directory for every member and a tie rule for duplicate names, which is neither cheap nor unambiguous.

## 3. Level-of-abstraction fit

The adapter funnel is the one place every Slack send passes and the one component that holds the Slack client and caches; the formatter stays a pure function that receives the resolved set. Reuses the existing `conversations.members` pagination shape (`authorizedMembersOf`), the user cache and `users.info` lookup added before 2748, and the ring buffer.

## 4. Signal vs authority compliance

[Signal vs authority](../../docs/signal-vs-authority.md): no new blocking authority. The participant lookup is a signal consumed by the formatter, and its only failure mode is the previous behavior (literal). Nothing is ever refused or delayed beyond the bounded 2.5 s lookup.

## 4b. Judgment-point check

No static heuristic at a competing-signals judgment point. "Is this ID a non-bot member of this conversation" is a factual Slack lookup, not a judgment.

## 5. Interactions

Code extraction still precedes reference extraction, so code never activates. The explicit `nativeReferences` path is unchanged and unions with the participant set. The legacy-passthrough mode, `mrkdwn:false` and Block Kit sends skip the lookup entirely. The oversized-input fallback still escapes everything. The origin ledger and footer are untouched (the lookup runs before the ledger intent). The `getUserInfo` cache now also records `is_bot`/`deleted`; existing name readers are unaffected, and `getUserInfo` gained an optional `refresh` flag only used here. The 2.5 s lookup runs inside the route's 30 s adapter-send timeout. `slack-reply.sh` is unchanged (no relay SHA migration needed).

## 6. External surfaces

Slack recipients who are in the conversation now get a real tag (and a notification) when an agent writes their ID. Slack API usage: at most one `conversations.members` read per conversation per 5 minutes and one `users.info` per mentioned person per 5 minutes, only for messages that contain a person mention. Concurrent sends to an uncached conversation share one member read (added after the second-pass review). A timeout does not start the 60 s retry pause, so in a conversation where Slack is chronically slow each mention-bearing send can wait up to 2.5 s until a read completes. Agents see a new CLAUDE.md section and a changed one-line instruction in Slack session context.

## 6b. Operator-surface quality

No dashboard, approval form, or operator page changes. Not applicable.

## 7. Multi-machine posture

Machine-local by design: the member and user caches are per-adapter, per-machine read-through caches of Slack's own state, and Slack is the source of truth on every machine. No durable state, no notices, no generated URLs, nothing to strand on topic transfer. Each machine runs the same shipped code. No status surface is added or changed.

## 8. Rollback cost

Pure code change: revert and ship a patch. No persistent state. The added CLAUDE.md section would remain on updated agents after a revert and would then over-promise; a revert should also remove the migration step and the section (a small follow-up edit, no data). Do NOT use `formatMode: legacy-passthrough` as a rollback: it sends text verbatim and would re-open what PR 2748 closed (broadcasts and every `<@U…>` live). The real rollback is a revert plus a patch that removes the migration step and the CLAUDE.md section.

## Conclusion

The change restores the operator's expectation (mentions of people in the conversation tag them) while keeping 2748's guard against broadcasts and against pinging people outside the conversation. Live proof in the isolated test workspace shows the participant tagged and the outsider, bot, broadcast and code example literal.

## Second-pass review

**Reviewer:** independent /instar-dev reviewer subagent
**Independent read of the artifact: concern** (minor, non-blocking; the code change itself is sound)

- Code verified: broadcasts (`<!here>`/`<!channel>`/`<!everyone>`), `<@U…|label>` forms, channel refs and links never match the participant branch; code is extracted before references; bots, the agent itself (also when `botUserId` is null, via `is_bot`), `USLACKBOT`, deactivated accounts and `users.info` answers without `is_bot` stay literal; old name-only cache entries are refreshed; every lookup failure/timeout returns no ids and the send proceeds; `_participantUserIds` and `_nativeReferences` are stripped in `applySlackFormatter` before any Slack call (asserted in the wireup test, 21/21 passing on this read). Migration is marker-guarded and idempotent in the existing pattern; `### Slack person mentions` routes to `messaging.md` (first keyword hit is `slack`).
- Section 8 is inaccurate: `formatMode: legacy-passthrough` is not a neutral per-agent rollback. It sends text verbatim, so it also re-opens what PR 2748 closed (broadcast tokens and any `<@U…>` become live). State that, and name the real rollback (revert plus a patch that removes the migration step and section).
- Undocumented bounds worth one line in Sections 1/6: only the first 16 distinct mentioned ids are resolved (later ones stay literal); member lists are read to at most 10 pages (10,000 members), and anyone beyond stays literal; a timeout does not set the 60 s backoff, so in a chronically slow conversation each mention-bearing send waits up to 2.5 s until a background read lands; concurrent sends to an uncached conversation each start their own `conversations.members` read (no in-flight dedupe).
- Section 2 should say explicitly that a thread poster found in the 50-message ring buffer is tagged without a membership check, so someone who posted recently and then left the channel is still tagged (a person-level, not audience-level, widening).
- Test gaps (recommended, not blocking): a `users.info` answer with no `is_bot` field stays literal; a pre-existing name-only cache entry is refreshed before activation; `USLACKBOT` and a `W…` id round-trip through the adapter.

**Re-review after fixes: concur** — Section 8 now warns against legacy-passthrough as a rollback, the bounds are stated in Sections 1, 2 and 6, concurrent member reads share one in-flight promise (failures still reject every waiter into the fail-closed path), and the four added tests pass (25/25 on this read).

## Evidence pointers

- Unit: `tests/unit/slack-mrkdwn-formatter.test.ts` (72 passed), `tests/unit/slack-mrkdwn-wireup.test.ts` (25 passed after the review follow-ups), `tests/unit/slack-mentions-awareness.test.ts` (3 passed).
- Integration: `tests/integration/slack-session-reply-route.test.ts` — bound reply route with a real SlackAdapter.
- Live: test workspace T0CEF50NAR1, channel `#dcproof-test` C0CG1C62HUL, bot U0CFSCA24JZ, message `1794535933.184259`. Readback blocks: a `user` element for member U0CFA03N5QF (Echo's test person Gear Test); outsider U0CFJ95JMFS, the bot itself, `<!here>` and a code example came back as text.

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect — not applicable. The defect is formatter policy in source code (opt-in only) plus a missing awareness line; the awareness gap is closed by the template section, its migration, and `tests/unit/slack-mentions-awareness.test.ts`.

### Response to the second-pass review

All points taken: Section 8 corrected (legacy-passthrough is not a safe rollback); the 16-id, 10,000-member, timeout-without-backoff and thread-poster bounds are now stated in Sections 1, 2 and 6; concurrent member reads are now shared in flight; the four recommended tests were added (no is_bot field stays literal, name-only cache refreshed, Slackbot literal and W id tagged, concurrent reads deduped), 25/25 passing.
