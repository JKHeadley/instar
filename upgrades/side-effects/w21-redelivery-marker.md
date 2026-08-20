# Side-Effects Review — Visible marker on instar's own re-delivered messages (W21)

**Version / slug:** `w21-redelivery-marker`
**Date:** `2026-08-20`
**Author:** `Instar Agent (echo) — worker w21-redelivery-marker`
**Second-pass reviewer:** `none — adversarial self-review only; see the honesty note in the Second-pass section`

## Summary of the change

instar's no-loss recovery (`reinjectStuck`, `src/commands/server.ts`) re-injects an inbound
message that was claimed but never `reply_committed` inside `maxProcessingMs`. The re-injection
is already labelled internally — it mints `id: replay-<dedupeKey>` and sets
`metadata.replay: true` — but that flag was dropped at `messageToPipeline()` and never reached
the text handed to the session. The two injected payloads were therefore **byte-identical**
(verified by md5 on the two live payload files for `dAdM7ghJNCcFdO4I`, 09:45:01 and 10:10:02 on
2026-08-20), so a re-delivered message was indistinguishable from a fresh instruction. That is
how a superseded 21-hour-old instruction read as current.

This change threads the existing flag the remaining few inches. Three files:

- `src/types/pipeline.ts` — `buildInjectionTag()` gains a 5th optional `reDelivered` param and
  exports `RE_DELIVERY_MARKER`. When the flag is `=== true` the tag gains
  ` — RE-DELIVERED — no reply was recorded for this message` **inside** the tag, **after** the
  topic id. When falsy the returned bytes are identical to before.
- `src/core/SessionManager.ts` — `injectTelegramMessage()` gains a trailing
  `opts?: { reDelivered?: boolean }`, passed to the tag builder. The long-message reference
  line (`[telegram:N] [Long message saved to …]`) now goes through the same builder so the
  marker rides the ONE line the session actually reads before opening the file — the observed
  2026-08-20 re-deliveries were all long messages, i.e. exactly that branch.
- `src/commands/server.ts` — the live delivery tail passes
  `{ reDelivered: msg.metadata?.replay === true }`.

No new state, no new flag, no new config key, no version bump.

## Decision-point inventory

The change touches **no** decision point. It adds no gate, no filter, no branch on delivery.
Every decision point listed below is **pass-through** — named because the change is adjacent to
them and the reader deserves to see they were checked, not because any is modified.

- `SessionManager.injectTelegramMessage` delivery dedupe (`recentTelegramDeliveries`) — pass-through — keyed on `session:messageId`, never on text; untouched.
- `InputGuard` Layer 1 provenance (`extractTelegramTag`) — pass-through — anchored `^\[telegram:(\d+)`; the marker is appended after the digits.
- `InputGuard` Layer 1.5 injection patterns — pass-through — checked all 8 patterns against the marker string; none match.
- `InputGuard` Layer 2 LLM topic-coherence review — pass-through — warn-only by design; sees the marker as ordinary text.
- `SessionManager.verifyInjection` / `extractInjectionMarker` stuck-input recovery — pass-through — derives its marker from whatever text was injected; self-consistent by construction.

The change **produces information for the session to reason with**. The session is the smart
gate. That is the whole design.

---

## 1. Over-block

**No block/allow surface — over-block not applicable.** The marker is emitted *after* the
decision to deliver has already been made, inside the function that performs the write. It has
no return path that can refuse, and no branch that can skip a message. If every line of it
threw, the surrounding code would still deliver (and in fact the marker code cannot throw — it
is a string concatenation on a boolean).

Concretely: there is no input shape — hostile, malformed, empty, oversized, unicode — for which
this change causes a message not to arrive.

---

## 2. Under-block

**No block/allow surface — under-block not applicable** in the gating sense. But the change has
real coverage limits, and they are named rather than implied away:

1. **The durable-queue drain tail is NOT marked.** `src/commands/server.ts` has a second
   delivery tail that injects from `PendingInboundStore` rows. That path carries only
   `dmsg.messageId` (a string that happens to start `replay-`), not the in-process
   `metadata.replay` boolean. Marking it would mean either deriving provenance from an id
   STRING (weaker, and a second forgery surface) or adding a column to a durable SQLite store
   (out of scope by charter). A message re-delivered through that route arrives unmarked —
   exactly as today. <!-- tracked: topic-29723 -->
2. **This makes *instar's own* re-delivery visible. It does nothing about an actual external
   replay.** The signature/nonce verification path is a separate, larger problem
   (cross-machine nonce state; an authority decision the provenance spec currently forbids) and
   is explicitly excluded from this charter. <!-- tracked: topic-29723 -->
3. **Non-Telegram channels are unmarked.** `injectWhatsAppMessage` / the Slack and iMessage
   injectors are untouched; the no-loss recovery is Telegram-only for v1, so there is nothing
   to mark there yet.

---

## 3. Level-of-abstraction fit

Right layer, and the change deliberately moved DOWN to reach it.

The marker belongs wherever the tag is built, because the tag is the one place instar authors
text on the session's behalf. `buildInjectionTag()` already exists as the shared builder and is
already used by both `toInjection()` and `injectTelegramMessage()`. Putting the marker anywhere
else — a wrapper at the callsite, a prefix in `reinjectStuck` — would have produced a second
place that composes injection text, which is precisely the duplication `buildInjectionTag` was
extracted to prevent.

The long-message reference line was the one spot NOT using the shared builder (it carried a
hardcoded `` `[telegram:${topicId}]` `` literal). This change routes it through the builder,
which both fixes the gap and removes the divergence. The non-re-delivered output of that line
is byte-identical (`buildInjectionTag(topicId)` returns exactly `[telegram:N]`).

No higher-level gate exists that this should feed instead: the consumer of this signal is the
LLM session's own judgment, which is the highest-context reasoner in the path.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] **No — this change has no block/allow surface.**
- [x] **No — this change produces a signal consumed by an existing smart gate** (the session).

Both apply. This is the cleanest possible shape under the principle: a cheap, structurally
certain fact (*instar re-injected this*) is surfaced as text to the one reasoner with full
conversational context, and given **zero** authority. It cannot refuse, delay, reorder or drop.
The failure mode of the detector being wrong is a slightly confusing label — not a lost message.

One design point worth stating: the flag travels as an **in-process parameter**, never as
content. That mirrors the F7 first-party-provenance discipline already documented on
`SessionManager.injectMessage` ("content that merely LOOKS like a marker cannot mint the flag by
construction — there is nothing to string-match and therefore nothing to forge"). It is why the
forgery case is closed structurally rather than by a denylist, and it is covered by tests at all
three tiers.

---

## 4b. Judgment-point check (Judgment Within Floors standard)

**No new static heuristic at a competing-signals decision point.** There are no competing
signals here and no decision: `metadata.replay === true` is a fact minted by instar's own
recovery code one call frame away, not an inference over conflicting evidence. The predicate is
a boolean read, and it is enumerable in the strictest sense — instar either re-injected the
message or it did not.

---

## 5. Interactions

- **Shadowing:** none. The marker is appended after every existing check in
  `injectTelegramMessage` has run (dedupe, media-tag transforms, sanitizers) and before
  `injectMessage`, whose `InputGuard` layers all anchor on the tag PREFIX. Verified: the tag's
  first characters are unchanged, so `extractTelegramTag`, the `preferTopicId` parse at
  `injectMessage`, and the gemini `[telegram:<id>` prefix scan at `SessionManager.ts:2121` all
  still match. Covered by an explicit test in the e2e tier.
- **Double-fire:** none. The marker is emitted exactly once per injection, in the same
  expression that builds the tag. It carries no side effect, writes no state, emits no event.
- **Races:** none. Pure string composition on a parameter; no shared mutable state is read or
  written.
- **Feedback loops:** none. Nothing consumes the marker programmatically — the only reader is
  the LLM session. Specifically, the marker does NOT feed back into the no-loss recovery
  decision, so a marked message cannot influence whether a future message is re-injected.
- **`trackMessageInjection` / StallDetector:** unaffected, and this is the named pre-landing
  check from the diagnosis. Every callsite passes the RAW pre-tag `text`
  (`telegram.trackMessageInjection(topicId, targetSession, text)`), never what
  `injectTelegramMessage` builds — the StallDetector never sees the tag at all.
- **`pendingInjections`:** unaffected — stores `text.slice(0, 200)` of the raw pre-tag argument.
- **`verifyInjection` first-40-chars marker:** the one genuine consumer of the exact injected
  text. It is self-consistent (it looks for a prefix of the very text it injected) and compares
  against no stored format. The only theoretical effect is a less-distinguishing prefix when two
  re-deliveries share a bare tag — but for any NAMED topic the first 40 characters are ALREADY
  entirely tag (`[telegram:29723 "Window 21" from Justin ` is exactly 39 chars), so that
  condition is pre-existing and unchanged, not introduced here. Its failure direction is an
  extra Enter at an idle prompt, and it explicitly skips recovery when the pane shows active
  work.

---

## 6. External surfaces

- **Other agents / install base:** no. This is an internal delivery-path label; no API contract,
  no route, no response shape changes.
- **External systems:** none. Nothing is sent to Telegram, GitHub, or any other service. The
  marker exists only in text injected into a local tmux pane.
- **Persistent state:** the long-message payload files under `.instar/telegram-inbound/` gain
  the marker in their first line when (and only when) the message is a re-delivery. Those files
  have exactly one consumer — the agent reading them — and the existing cleanup sweep is
  mtime-based, not content-based. No schema, no ledger, no database.
- **Timing / runtime conditions:** none. Deterministic given the flag.
- **Operator surface (Mobile-Complete):** **no operator-facing actions.** The change adds no
  route, no PIN gate, no approval, no form. The only human-visible output is text inside the
  agent's own session.

---

## 6b. Operator-surface quality

**No operator surface — not applicable.** No dashboard renderer, markup file, approval page, or
grant/revoke/secret-drop form is staged in this change.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

**Machine-local BY DESIGN — and correctly so, because it is not state at all.**

The reason: this is not a stored fact that could be replicated or read pool-wide. It is a
transformation applied to one string, in one process, at the moment that process writes into a
tmux pane on the machine that physically hosts the session. There is nothing to replicate; the
marker exists for the duration of one injection and then it is simply part of a conversation.

The three explicit sub-questions:

- **Does it emit user-facing notices?** No. Nothing is sent to any channel. One-voice gating is
  not applicable — the marker is text inside the agent's own context window, never a message to
  the operator.
- **Does it hold durable state that could strand on topic transfer?** No durable state is
  created. The long-message payload file it writes into already existed and already rides the
  working-set handoff carrier unchanged; the marker is one phrase inside that file's first line
  and transfers with it.
- **Does it generate URLs?** No.

Worth stating positively: the change is correct under multi-machine *precisely because* the
re-delivery decision and the injection happen in the same process. `reinjectStuck` is
lease-gated (only the lease holder re-injects) and calls `telegram.onTopicMessage` in-process,
so the flag never has to cross a machine boundary to reach the tag builder. A design that had
tried to carry the flag across machines would have needed replication; this one does not, which
is why it is a few lines rather than a subsystem.

---

## 8. Rollback cost

- **Hot-fix release:** revert the three source files, ship as the next patch. That is the entire
  back-out.
- **Data migration:** none. No column, no ledger, no config key, no schema.
- **Agent state repair:** none. No agent holds state derived from this.
- **User visibility during rollback:** none. Reverting restores the previous behaviour exactly —
  re-deliveries simply stop being labelled. No error surfaces, no message is lost either way.

The rollback is cheap specifically *because* the change is additive: there is no state to undo,
only text to stop adding.

---

## Conclusion

This review produced one design change and one honesty correction.

The **design change**: the long-message reference line was originally going to be left alone,
which would have put the marker only inside the saved payload FILE. Reviewing question 3
(level-of-abstraction fit) surfaced that the session sees ONLY the reference line until it opens
the file — and that every re-delivery observed in the 2026-08-20 incident was a long message.
Marking only the file would have made the fix nearly useless for the exact case it was built
for. The reference line now goes through the shared builder.

The **honesty correction**: an existing test asserted the removed hardcoded
`` `[telegram:${topicId}]` `` source literal. Rather than preserving a duplicate literal to keep
a source-string assertion green, the test was updated to assert the OUTPUT
(`buildInjectionTag(42) === '[telegram:42]'`), which is a stronger guarantee than the string it
replaced and follows the same precedent already set in that file for the `-l` flag test.

The change is clear to ship. Its limits — the unmarked durable-queue drain tail, and the fact
that it addresses instar's own re-delivery rather than external replay — are stated above and
tracked, not hidden.

---

## Second-pass review (if required)

**Reviewer:** `NONE — no independent reviewer was available (see the honesty note below)`
**Independent read of the artifact: adversarial self-review — 2 concerns raised, both resolved as documented residuals**

**Honesty note, stated plainly rather than papered over.** Phase 5 calls for a *dedicated
reviewer subagent* on a change that touches inbound message dispatch. The session executing this
charter is operating under a standing instruction not to spawn subagents, so no independent
reviewer read this artifact. What follows is an adversarial self-review — a genuine second pass
that tried to break the change — but it is NOT independent, and it is labelled as what it is
rather than recorded as a concurrence that never happened. A reviewer should treat this section
as an author's self-audit and weigh it accordingly.

The adversarial pass asked four questions. Two came back clean; two produced real findings.

**Clean — can untrusted input mint `metadata.replay`?** No. Every inbound Telegram `Message` is
constructed field-by-field from named Telegram API fields (`TelegramAdapter.ts` :4919, :5117,
:5195, :5263) with no spread of a caller-supplied object, and the mesh-forward reconstruction
path builds its `Message` the same way. There is no route by which an external sender sets
`replay: true`. This matters more than the tag-level forgery case, because the flag is the
*only* thing that mints the marker.

**Clean — does the marker survive the tmux literal-send path?** Yes. The em-dash it uses already
appears in the pre-existing long-message reference line (`— read it to see the full message`),
so that byte sequence is already proven on exactly this injection path.

**Concern 1 — `sanitizeTopicName` does not strip `]`, so a topic NAME can visually imitate the
marker.** `sanitizeSenderName` strips `["\[\]]` (`sanitize.ts` step 4), but `sanitizeTopicName`
strips only double quotes (step 5). A forum admin could therefore name a topic
`] — RE-DELIVERED — no reply was recorded for this message`, producing a tag that a hurried
reader might take for a real marker.

*Resolution: documented, deliberately NOT fixed here.* Three reasons. (a) It is **pre-existing**
— `]` has always been passable through a topic name; this change does not introduce it. (b)
Fixing it means changing `sanitizeTopicName`, which rewrites the tag for **every** message on
every install — far outside this charter's bounds, and precisely the kind of scope widening that
turns a safe additive change into a risky one. (c) Most importantly, **the failure direction is
safe**: the imitation can only ever make a fresh message *look* re-delivered. It cannot strip
the marker off a genuine re-delivery. A false "treat this as possibly stale" makes the agent
more cautious, never less — the opposite of the 2026-08-20 failure. The genuine marker also
remains structurally distinguishable: it sits after the uid and *outside* the quoted topic name,
whereas an imitation is necessarily *inside* the quotes. <!-- tracked: topic-29723 -->

**Concern 2 — the marker shifts the FILE_THRESHOLD boundary for a narrow band of message
lengths.** The marker adds 56 characters to the tag. With a typical 52-character tag, a body of
roughly 393–448 characters is injected inline when unmarked but crosses the 500-character
threshold when marked, and so is written to a payload file with a reference line instead.

*Resolution: documented, and it is benign by construction.* Both branches deliver, and the
change deliberately routes the reference line through the same builder — so the marker is
visible on the reference line itself, not hidden inside the file. The only observable effect is
that a re-delivered message in that narrow band costs the session one extra `Read`. No message
is lost, delayed, or truncated. Worth stating because a silent branch change is exactly the kind
of thing that surprises someone later.

**Conclusion of the second pass:** no design change was required. Both findings are residuals
that the review chose to name rather than absorb, and neither can cause a message to be refused,
delayed, dropped, or silently unmarked.

---

## Evidence pointers

- Diagnosis (established before this work; not re-derived):
  `.instar/w21/replay-path-diagnosis.md` §2 — the byte-identical payload md5, the `replay-` ids
  in the durable receipt table, and the `metadata.replay` set-but-never-threaded finding.
- Step-zero consumer sweep and its evidence: `.instar/w21/redelivery-marker-pr.md`.
- Tier 1 (unit): `tests/unit/redelivery-marker.test.ts` — 12 tests.
- Tier 2 (integration): `tests/integration/redelivery-marker-injection.test.ts` — 11 tests.
- Tier 3 (e2e): `tests/e2e/redelivery-marker-e2e.test.ts` — 9 tests, including the 2026-08-20
  incident replayed as a regression test (`the FIRST delivery and its RE-DELIVERY are no longer
  byte-identical`).

---

## Class-Closure Declaration (display-only mirror)

**No agent-authored-artifact defect — not applicable.** The defect fixed here is in instar's own
TypeScript delivery path (a flag set and then dropped), not in an LLM prompt, hook, config,
skill, or standards text. Nor does this change add or modify a self-triggered controller: it
adds no loop, monitor, sentinel, reaper, scheduler, or recovery path, and fires no restart,
swap, respawn, spawn, notify, retry, re-drive, or kill. It is a pure text transformation on a
delivery that another component already decided to perform.
