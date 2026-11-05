# Side-Effects Review — Slack message ids in TopicMemory

**Version / slug:** `slack-topic-memory-message-id`
**Date:** `2026-11-04`
**Author:** `Dawn (Portal evolution session, PROP-1496)`
**Second-pass reviewer:** `not required (Tier 1)`

## Summary of the change

`TopicMemory` stores `message_id` as an INTEGER under
`UNIQUE(message_id, topic_id)` and writes with `INSERT OR IGNORE`. The Slack
dual-write in `src/commands/server.ts` derived the id as
`typeof entry.messageId === 'number' ? entry.messageId : 0`, but a Slack `ts` is
a string (`"1730000000.123456"`), so every inbound Slack message bound `0`,
collided with the first message in that channel, and was ignored. This change
adds `src/messaging/slack/slackMessageId.ts`, which converts the `ts` to an
exact microsecond integer, and replaces that one expression with a call to it.
Files touched: `src/commands/server.ts` (one expression + one import),
`src/messaging/slack/slackMessageId.ts` (new, pure), and
`tests/unit/slack-topic-memory-message-id.test.ts` (new).

## Decision-point inventory

- `Slack → TopicMemory id derivation` (`src/commands/server.ts`, in
  `_slackAdapter.onMessageLogged`) — **modify** — computes the numeric
  `message_id` for a Slack message. It is not a block/allow gate; it is a data
  mapping whose output happens to decide, via the UNIQUE constraint, whether the
  row survives.

No other decision point is added, modified or removed. The PresenceProxy call in
the same callback is **pass-through** — deliberately untouched.

---

## 1. Over-block

**What legitimate inputs does this change reject that it shouldn't?**

No block/allow surface — over-block not applicable in the gate sense. The
closest analogue is "a legitimate message that still gets dropped", so that is
answered concretely instead:

- A `ts` of `"1730000000.123456"` → `1730000000123456`. Kept.
- Two messages in the same second, `…000100` and `…000200`, get distinct ids.
  Kept (pinned by a test).
- A malformed `messageId` with a readable ISO `timestamp` falls back to the
  timestamp in microseconds, so it is still distinct from its neighbours rather
  than colliding on `0`.
- The only input that still yields `0` is one with both an unparseable
  `messageId` and an unparseable/absent `timestamp`. No real Slack event has
  this shape (`SlackAdapter` sets `messageId: ts` and stamps `timestamp` on
  every entry). If one ever did, it degrades to exactly the old behaviour for
  that single message — it cannot be worse than before.

## 2. Under-block

**What failure modes does this still miss?**

- **Sub-millisecond malformed-ts collisions.** The timestamp fallback has
  millisecond resolution, so two messages with malformed `ts` values inside the
  same millisecond would still collide. Accepted: the fallback is unreachable
  for real Slack traffic, and a coarse distinct id strictly beats a shared one.
- **Messages never offered to the callback at all.** `SlackAdapter` fires
  `onMessageLogged` on two inbound paths only. Agent/outbound messages largely
  never reach `TopicMemory` through this callback; this change does not alter
  that and does not claim to.
- **History already lost.** This stops the bleeding; it does not backfill. See
  §6 and §8.

## 3. Level-of-abstraction fit

**Is this at the right layer?**

Yes, and it moves logic *down* to the right layer rather than adding a new one.
The derivation is a pure, cheap, platform-specific mapping, so it belongs beside
the other small Slack primitives (`threadHistoryLabel.ts`, `sanitize.ts`) and
not inline in a 32k-line `server.ts`. It is a detector-class primitive with no
reasoning and no authority.

No higher-level gate exists that this should feed instead — nothing arbitrates
`message_id`; the store takes it literally. No lower-level primitive already did
this: `grep` found no existing Slack-ts-to-number helper, and the nearest thing
(`parseInt(String(entry.messageId), 10) || 0`, in the PresenceProxy call ten
lines below) is the lossy truncation this module exists to avoid reproducing.
That duplication is now *named* in the new module's doc comment and in §5, which
is the honest state: two consumers, one correct, one coarse.

**Relationship to the governed identity surface (`src/core/conversationIdentity.ts`).**
This is the objection on the record: the PROP-1289 round-2 review deliberately
did NOT fix this defect, reasoning that "inventing an id hash at the call site
would add a rival scheme beside the one that spec exists to consolidate"
(`docs/specs/durable-conversation-identity.md`, whose
`tests/unit/conversation-identity-mint-idiom-ratchet.test.ts` fails CI on a
fourth copy of its negated-absolute-hash mint idiom). That objection is answered
rather than ignored, on three counts:

1. **Different axis.** `conversationIdentity` mints a *conversation* id from a
   routing key (channel + thread), via `sumShiftHash` + `walkDisplacement`.
   This module derives a *message* id from one message's own `ts`. Both land as
   integers in the same table, but they answer different questions and only one
   of them is an identity mint.
2. **No mint, no hash — measured, not asserted.** The module contains no
   absolute-value negation, no hash and no collision walk. Verified by running
   the ratchet itself: `conversation-identity-mint-idiom-ratchet`,
   `conversation-identity` and this change's own suite pass together, 39 tests.
   Worth recording *how* that was learned: an earlier draft of this module's doc
   comment quoted the mint idiom verbatim while explaining why it is not used,
   and the ratchet failed — it greps source text and cannot tell a comment from
   code. The prose was rewritten to name the idiom instead of reproducing it.
   The ratchet was right to fire, and a claim that it passes is only worth
   anything because it was actually run.
3. **The objection is the reason for the design.** A hash was the thing to
   avoid, and §5 gives the independent reason: `message_id` is also an ordering
   key, so a hash would have satisfied UNIQUE and relocated the loss into
   `getMessagesSinceSummary` — a harder bug to see than the one being fixed.
   The review's instinct was right; what this change revisits is the conclusion
   that followed from it ("therefore do not fix"), because deriving from time is
   neither minting nor hashing.

If message ids ever need *minting* rather than deriving, that belongs in the
governed module. `SLACK_THREAD_TS_RE` is deliberately not reused here: it
requires exactly 10 + 6 digits, which is right for a routing key but would push
a short-fraction `ts` onto the coarser fallback path.

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

**Does this change hold blocking authority with brittle logic?**

- [x] No — this change has no block/allow surface.

It computes a value. It does not decide whether anything proceeds, is filtered,
or is sent. The one adjacent concern worth stating: a *wrong* value here causes
silent data loss via the UNIQUE constraint, which is how the original defect
behaved. That is why the derivation is pure and separately tested with a
positive control and a mutation sweep, rather than left inline where it had no
test at all.

## 4b. Judgment-point check (Judgment Within Floors standard)

No new static heuristic at a competing-signals decision point. There are no
competing live signals here: a Slack message has exactly one `ts`, and the
mapping from `ts` to integer is an invariant, not a judgement. The domain is
fully enumerable (a `ts` either matches `^\d+(\.\d+)?$` within the exactness
bound, or it does not), and the fallback order is declared in the module.

## 5. Interactions

- **Shadowing:** The derivation runs inside the existing
  `_slackAdapter.onMessageLogged` callback, before the PresenceProxy call in the
  same callback. It cannot shadow it: the two compute independent values from
  the same entry and neither returns early. `existingSlackCallback` is still
  invoked first, unchanged.
- **Double-fire:** No. Nothing new fires. The same single `insertMessage` call
  happens per entry; only its `messageId` argument changed.
- **Races:** No new shared state. The module is pure with no module-level
  mutable state. `TopicMemory.insertMessage` concurrency is unchanged.
- **Feedback loops:** Indirectly and intentionally — more Slack rows now persist,
  so `needsSummaryUpdate` / `getMessagesSinceSummary` will see real history and
  summarisation will actually run on these topics where before it had ~1 row.
  That is the point of the fix, but it means Slack topics may generate summary
  work that previously never triggered. Flagged rather than hidden: the volume
  is bounded by real message traffic (hundreds, not millions — 568 across two
  machines' full retention windows).
- **`TopicMemory.rebuild()` destroys Slack rows with no restore path — a new
  exposure created by this fix.** Verified by reading the code this session:
  `rebuild()` runs an unconditional `DELETE FROM messages` +
  `DELETE FROM topic_meta`, then calls `importFromJsonl(jsonlPath)` — and that
  importer requires `entry.topicId`, which Slack entries never carry (they have
  `channelId`). So a rebuild deletes every Slack row and restores none of them,
  and on an agent with no `telegram-messages.jsonl` at all the import also
  returns 0 immediately, leaving the store empty. This is the same `topicId`
  gap described in §6, seen from the destructive side.

  Before this change the exposure was ~1 row per channel and therefore
  invisible. This fix makes Slack history actually accumulate, which makes it
  actually destroyable — so the hazard is genuinely *introduced* by this change
  even though the defective code is not in it, and it should not be left for a
  reader to notice. Not fixed here: the honest fix is to teach
  `importFromJsonl` the `topicId ?? channelId` compatibility that
  `TelegramAdapter.scanLogForTopic` already does, which is the same work a
  backfill needs, so the two belong together and in their own change. Recorded
  in the PR, and the release note warns users away from rebuild in the meantime.
  (Independently raised by the concurrent PROP-1289 session; re-derived here
  from the source rather than taken on report.)
- **Ordering dependency (the subtle one):** `getMessagesSinceSummary` selects
  `WHERE message_id > ?`. Slack ids are now ~1.7e15 while the system-notice rows
  arriving via the other path carry small Telegram-style ids (~5e4). Within a
  Slack topic that holds both, a summary whose `lastMessageId` is a Slack id will
  exclude later small-id notice rows from the incremental read. Those rows are
  system notices ("Session respawned.") that `isSystemOrProxyMessage` already
  treats as non-content, and the inbound messages that matter are now the ones
  included rather than excluded — a strict improvement on the prior state, where
  inbound rows had id `0` and were excluded by every non-zero summary. Named
  here as a known residual rather than silently inherited.

## 6. External surfaces

- **Other agents on the same machine:** Yes, in a good direction — every agent
  with Slack configured starts retaining channel history. No API or format
  change.
- **Other users of the install base:** Same. Behaviour change is additive
  (messages that were dropped are now stored).
- **External systems:** None. No Slack API call, no network path, no auth
  surface touched. Nothing is sent anywhere.
- **Persistent state:** Yes — `topic-memory.db` will now accumulate Slack rows
  that previously were discarded. New rows carry large `message_id` values. No
  schema change, no migration. Existing rows are untouched; the pre-existing
  `(0, channel)` row in each channel stays exactly as it is and remains the
  oldest row.
- **Timing / runtime conditions:** None. The derivation is synchronous, pure,
  and O(length of the ts string).
- **Live-API contract evidence — EXEMPT, and why.** The pre-push gate flags any
  change under `src/messaging/slack/` and asks for `npm run test:contract`
  evidence against the real Slack API. It matches on the path, not on
  behaviour, and this module makes no network call and touches no Slack request
  or response shape — it is a pure string-to-number function with no I/O, so
  live-API tests have nothing in it to exercise. The file therefore carries the
  gate's documented in-diff marker, `CONTRACT-EVIDENCE: EXEMPT`, with that
  reason stated next to the code it covers and an instruction to remove it the
  moment anything in the file reads or writes an API payload. Recorded here
  rather than left as a flag a reviewer has to interpret. The genuinely
  Slack-API-shaped assumption this change *does* rest on — that `ts` is unique
  per channel and ordered by send time — is Slack's documented contract and is
  asserted on real ts values in the unit tests, not mocked away.
- **Release visibility:** `upgrades/next/slack-topic-memory-message-id.md` ships
  with the change. Without a fragment, `publish.yml` silently skips the release,
  so the fix would merge and never reach an installed agent — which for a
  data-retention fix means users keep losing Slack history while believing it
  was fixed. The fragment states plainly what is recoverable and what is gone.
- **Operator surface (Mobile-Complete Operator Actions):** No operator-facing
  actions added or touched — this change adds no route, form, approval or
  notice.

## 6b. Operator-surface quality (Operator-Surface Quality standard)

No operator surface — not applicable. No `dashboard/*` file, approval page, or
grant/revoke/secret-drop form is staged in this change.

## 7. Multi-machine posture (Cross-Machine Coherence)

**Posture: machine-local BY DESIGN.**

Reason: `TopicMemory` is a per-machine SQLite store under the agent's state dir,
and it is the record of what *this* machine's sessions saw and said. That is a
pure per-machine observability/context truth, and it was machine-local before
this change; this change does not alter the posture, only what the local store
retains. The ids themselves are derived from Slack's own `ts`, so the same Slack
message yields the **same** id on every machine — the derivation is
deterministic and machine-independent, which means two machines that both see a
channel converge on identical ids rather than inventing conflicting ones. That
property is what would make any future replication or cross-machine merge
possible; it is strictly better than the prior state, where every machine
assigned `0`.

- **User-facing notices:** none emitted. No one-voice gating needed.
- **Durable state:** yes (`topic-memory.db` rows). It does not strand on topic
  transfer: rows are keyed by the synthetic id derived from `channelId`, which
  is stable and machine-independent, so the same channel maps to the same
  `topic_id` everywhere.
- **URLs:** none generated.
- **Status surfaces:** none new or changed. No `/status`, `/health`,
  `/capabilities` or `/channels` answer is added or modified by this change.

## 8. Rollback cost

- **Hot-fix release:** revert the code change, ship as next patch. The revert is
  one expression and one import; the new module and test file become unused and
  can be deleted or left.
- **Data migration:** none required. Rows written while the fix was live remain
  valid and readable — they are ordinary rows with real ids. Reverting stops new
  Slack rows from being retained; it does not corrupt or orphan what was
  written, and nothing needs deleting.
- **Agent state repair:** none. No agent needs notifying or resetting.
- **User visibility:** no regression during a rollback window. Reverting returns
  to the old lossy behaviour, which is the current baseline, so the worst case is
  "back to how it was".

Net: low. Pure code change, no persistent-state cleanup, no downtime.

## Conclusion

The review produced two design decisions and one residual finding. First, the id
is time-derived rather than hashed, because §5 surfaced that `message_id` is
also an *ordering* key (`getMessagesSinceSummary`) and not only an identity key —
a hash would have satisfied the UNIQUE constraint and silently relocated the data
loss into summarisation, which is a harder bug to see than the one being fixed.
Second, the two halves of the `ts` are combined with integer arithmetic rather
than a float multiply, after confirming `parseFloat` rounds on exactly this
input shape. The residual finding is the mixed id-scale interaction documented in
§5, which is an improvement on the prior state but not a clean end state, plus
the un-replayed JSONL history in §6 — 568 recoverable inbound messages on one
machine, which this change deliberately does not backfill. Both are stated in
the commit message and the PR rather than left for a reader to discover. The
change itself is clear to ship.

One self-caught defect worth recording: the first version of the exactness bound
used `floor(MAX_SAFE_INTEGER / 1e6)`, which admits a `ts` whose `.999999` form
overflows into rounding. The boundary test caught it before commit; the fix
subtracts a full second of headroom *and* checks `Number.isSafeInteger` on the
result, so the assertion that matters cannot be off by one.

## Second-pass review (if required)

**Reviewer:** not required (Tier 1)
**Independent read of the artifact: [not applicable]**

Tier 1 ships without an independent reviewer. The compensating controls used
here are the positive-control test (which fails against the replaced
derivation), the 7-mutant sweep over the new module (7/7 killed), and the causal
autopsy recorded in the trace.

## Evidence pointers

- `tests/unit/slack-topic-memory-message-id.test.ts` — 18 assertions, green.
- Related suites re-run green: `topic-memory`, `topic-memory-importer`,
  `topic-memory-privacy`, `topic-memory-forwarded-provenance`,
  `topic-summarizer` + this file — 160 tests passed, including
  `tsc --noEmit`.
- All 51 lint steps passed (`lint:parallel`).
- Pre-fix measurement, two live databases:
  `SELECT from_user, message_id = 0, COUNT(*) FROM messages WHERE topic_id < 0
  GROUP BY 1, 2` → every `from_user = 1` row had `message_id = 0`, one per
  channel (7 inbound rows across 8 channels).
- Recoverability measurement: `slack-messages.jsonl` holds 278 (sagemind) + 290
  (indra-instar) inbound rows with real `ts` values, 0 of which are present in
  `topic-memory.db`. The `channelId → synthetic topic_id` hash was reproduced
  independently and matched the production function exactly on sample inputs,
  confirming a backfill is feasible.

## Class-Closure Declaration (display-only mirror)

**Not applicable.** This change does not fix a defect in an agent-authored
artifact (no LLM prompt, hook, config, skill or standards text is changed — the
defect is in hand-written TypeScript), and it adds no self-triggered controller:
the new module is a pure synchronous function with no loop, monitor, sentinel,
reaper, scheduler or recovery path, and it fires no restart, swap, respawn,
spawn, notify, retry, re-drive or kill.
