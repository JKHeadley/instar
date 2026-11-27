# Convergence Report — Native conversation as the base for every chat platform

## Cross-model review: codex-cli:gpt-6-astra

RAN. GPT 6 Astra reviewed the spec through the codex CLI in all six rounds (status `ok` each round, no truncated prompt). Gemini is not installed on this machine, so there was one external family, not two. The constitution gate also ran every round, never degraded.

**Spec:** [docs/specs/native-conversation-base.md](../native-conversation-base.md) (slices 3a, 3b, 3c)
**Slug:** `native-conversation-base`
**Sibling:** [native-conversation-any-machine-access](native-conversation-any-machine-access-convergence.md) (slices 3d, 3e, 3f)
**Report written:** 2026-11-11T21:44Z
**Iterations:** 6 of 6 (the cap for Tier 2+)
**Final-round design findings:** 4 (1 internal, 3 cross-model), plus 1 gate flag. **Not zero.** Three were fixed after the cap, two were accepted. See the verdict.

POSTCAP-CHECK: **BLOCKING, 1 item (B1), parent only.** Source: `.instar/efforts/ncb/postcap-check.md`. Four of the five post-cap areas are resolved and clean. The fifth (uncertainty kept across a lease change, §3a item 7 fourth bullet) is right as a rule but cites a carrier that does the opposite: the existing receipt ask folds the old owner's `suppressed` state into `not-accepted` (`src/commands/server.ts:32648`), and the existing branch then clears the uncertainty and sends locally (`OriginForwardToHolder.ts:409-412`). A builder reusing it as written rebuilds the double send. The fix is one sentence and no new part. **B1 was then applied to the spec (file changed 13:45 PST):** §3a item 7 now says the path must not reuse that mapping, reads the raw `state` with `outcome` and `failure`, counts `suppressed` with no `outcome` as "no reason", and names the test stub. The report author read that sentence against the fix the check asked for and it matches. **No reviewer has re-checked it, and the code lines were not re-read after the edit.** **Resolved 2026-11-11 13:47 PST by Echo:** the sentence now forbids reusing the receipt mapper's suppressed→not-accepted collapse and reads the raw state with outcome and failure. Echo verified the cited code (src/commands/server.ts:32649, OriginForwardToHolder.ts:409) and all four checks pass. Final post-cap state: CLEAN. This one sentence was checked only by that targeted pass and the code read, not re-reviewed by a full round.

---

## ELI10 Overview

Today each chat platform keeps its own notes on whichever of the agent's machines happens to talk to it. On 2026-11-11 that went wrong five ways for Justin in one day. This spec is the first stage of making Instar's own conversation record the home of every chat, with Telegram, Slack and the app as doors into it. It fixes the first three failures: a reply that was quietly thrown away, a delivery check that said "I don't know" when another machine knew, and a photo that stayed on a different computer from the session that needed it.

What changes if it ships: a newer message no longer cancels a waiting reply. A reply is dropped only when the user already has the same text; otherwise it is delivered (with a first line saying it is late, if it was held more than five minutes) or handed back to the session that wrote it, with the reason. The "did it arrive?" check asks the machine that did the sending and says "safe to send again" only when that machine says it did not go and no other machine still holds it. A message with a photo reaches the session at once and the photo follows on the session's own machine; text typed into a chat can no longer make the agent open a file.

The main tradeoffs. Replies can again arrive after the conversation has moved on; that reverses a fix that is one week old (PR #2779, 2026-11-04), and the spec says so. When the system is not sure whether a reply arrived, it does not send a second copy and does not say it failed, so some replies end as "not sure" and go back to their author. A definite failure is handed back, not re-sent automatically. The shared record itself (every Telegram message stored natively) is a later stage with its own design; nothing here is built yet.

## Original vs Converged

- **Originally:** the old "a newer message cancels a waiting reply" rule stayed as the fleet default, with the new rule opt-in, and later as an opt-out. **After review:** the timestamp rule is gone on every agent with no setting to bring it back (FD-2, FD-3). Why: reviewers and the gate showed that any clock comparison lets the agent's own "got it" note cancel the real answer, which is the failure being fixed; a fix that ships dark leaves the bug on the fleet.
- **Originally:** when a reply was withheld, the user got a notice asking them to ask again. **After review:** no new message goes to the user. A late reply carries its own first line, and the session that wrote the reply is told (FD-4). Why: asking the user to chase a lost reply puts the agent's work on the person, and one notice per reply could flood a topic after an outage.
- **Originally:** the delivery check turned "the owner has no record" or "the reply was suppressed" into "not delivered, safe to resend". **After review:** an absence is always "not sure"; "safe to resend" needs the sending machine's own verdict plus the authoring machine's statement that it no longer holds or has replaced the reply (FD-5, FD-13). Why: every reviewer in round 1 found a way that table would send a reply twice.
- **Originally:** a photo reference was a file path in the message text, kept whenever the path existed locally, and the session was told to wait or poll. **After review:** a structured attachment id set by server code; typed path tags are inert on every entry point; the message is injected at once and the file follows in one line (FD-7, FD-8). Why: anyone who could type in the chat could point the session at any readable file, and a wait before injection can reorder a topic.
- **Originally:** an ending with no stated reason (from a machine on an older version) finished the reply silently. **After review:** it is never final; the reply stays unresolved and the author is told or one dashboard item per topic is raised (FD-14). Why: that is the rolling-update state of the pool where the original failure happened.
- **Structure:** the spec was one document through round 2 (41 KB at the draft, 69 KB after round 2). It was split into this spec and its sibling with no design change. Frontloaded Decisions, a Multi-machine posture section and a Maturation plan were added because reviewers found them missing.

## Iteration Summary

Design counts are raw per-reviewer counts and include overlaps (the same hole found by two reviewers counts twice). Rounds 1 and 2 ran on the single spec, so those rows cover both documents. "Gate flags" are possible violations from the constitution gate, each engaged by a reviewer or the author.

| Iteration | Reviewers who flagged design issues | Design findings | Precision / left behind | Gate flags | Spec changes |
|-----------|-------------------------------------|-----------------|-------------------------|------------|--------------|
| 1 (single spec, 41 KB) | all three Fable agents, Astra | 41 (12 security+adversarial, 12 scale+integration, 14 decisions+lessons, 3 Astra) | 24 | 7 | Rewrite: outcome table, notices, media design, FD and posture sections added (r1, 55 KB) |
| 2 (single spec, 55 KB) | all three Fable agents, Astra | 26 (7, 9, 7, 3) | 33 | 5 | Rewrite with decisions A to L (r2, 69 KB), then split in two |
| 3 (parent, 56 KB) | security+adversarial, scale+integration, decisions+lessons, Astra | 10 (3, 2, 2, 3) | 28 | 3 | Timestamp rule and its opt-out retired entirely; Maturation plan added (r3, 75 KB) |
| 4 (parent, 75 KB) | security+adversarial, scale+integration, Astra (decisions+lessons: none) | 8 (3, 2, 0, 3) | 25 | 1 | "Fixes and simplification only" (r4, 88 KB) |
| 5 (parent, 88 KB), calibrated | security+adversarial, scale+integration, Astra (decisions+lessons: none) | 4 (1, 1, 0, 2) | 16 | 1 | Sentence-level fixes (r5, 91 KB) |
| 6 (parent, 91 KB), cap | one Fable agent on the delta, Astra | 4 (1 internal, 3 Astra) | 3 | 1 | Post-cap sentence-level fixes, no mechanism added (final, 98 KB) |

Reviewer setup: rounds 1 to 5 used three Fable 5.2 agents, each covering two lenses (security + adversarial, scalability + integration, decision-completeness + lessons-aware). Round 6 used one Fable agent covering all six lenses on the round-5 diff. External: GPT 6 Astra every round.

Round-5 calibration: because the spec had grown from 55 KB to 88 KB over three rewrites, the author told round-5 and round-6 reviewers to class a finding as DESIGN only if it would cause a double send, a silent loss, a privacy or security exposure, data loss, or a false statement about the code that a builder would act on. That narrows what counts as a design finding from round 5 on. Astra was not given a different bar and its findings are counted as it classed them.

## Proportion

⚠ Tier 2+, a 411-line, ~98 KB spec (about 55 KB of sibling beside it), 6 of 6 rounds, and it still did not reach a quiet round. The spec grew in every rewrite (41 → 55 → 69 KB, split, then 56 → 75 → 88 → 91 → 98 KB), and from round 2 on most design findings were in mechanisms the previous rewrite had added. This is out of line for a first-phase design and is recorded for the retrospective: a growth warning and a "no new mechanisms after round 3" rule are candidates for /spec-converge (meta-review log).

## Left behind

The spec's own `## Left behind` section is the authority; it has 30 numbered items. Summary:

**Accepted at the cap (design-class, not fixed):**
- Media follow-up after a session move (round 6, Astra): the new machine has no pending row for a file still being copied, so the "file now available" line does not arrive by itself there. The session holds the attachment id and can fetch the file, so there is no dead path. Queue: CMT-049 (Mama PC registry), in the CMT-048 spec, 2026-11-25. Item 29.
- The existing content check may suppress an identical legitimate answer (round 6 gate flag, *Signal vs. Authority*): text Telegram already accepted for the same destination inside the look-back ends a reply, so the same answer to a new request can be dropped. Existing behaviour for every send, not introduced here; the suppression carries the reason `duplicate-content`, so it is not silent. No queue. Item 30.
- Against a machine still on the older version, the duplicate check looks back 15 minutes, not over the reply's whole wait, so a reply held longer could arrive twice until that machine updates (stated in §3a after the round-6 fix).
- Against an older owner that never states an outcome, a reply whose lease moves is never delivered by this design and ends as an uncertain hand-back (item 19, what is left after the post-cap fix).
- Native media off: a photo stays on the polling machine and the session is told so (round-5 gate flag, accepted deferral with owner and date, CMT-048, 2026-11-25).
- F1's incident cause is still a hypothesis. The Studio log read (CMT-057) is a gate before the build, not done in review (item 28).

**Precision, not iterated on (one line each in the spec, items 1 to 16, 18, 20 to 27):** line references re-checked at build; attention items stay one per operation; late replies after a long outage are not collapsed per topic; the late line appears on age alone; server-typed session lines need a marked form (covers a person typing `[file now available: …]`); the uncertain session line has no pointer to the reply text; an old lifeline reads a typed tag until it restarts; name the serializer for per-session order; commitments live in the Mama PC registry and CMT-047 names the wrong spec; the Slack posture marker cites the wrong commit; no pool view of origin status; the old `queued-reply-coherence` ELI16 is superseded, not edited; `definiteNoSession` does not separate "none anywhere" from "one on another machine"; CMT-056 text is stale; resend after an exhausted 429 is less sure than stated; the content check skips text under 40 characters; state that no late-mark replacement is made while the last attempt is uncertain; a forwarded reply sent locally after the lease returns is not counted late; a queue row from the previous release loses its local path once; where a `ready` media row ends with no session; name the purge horizon; name "a session with its binding"; how the owner's scan revisits an uninjected line; the owner-read switch has no re-arm line.

**Acted on after the cap (items 17 and 19):** see round 6 below.

**Told to the operator:** FD-3 (the reversal of the 2026-11-04 fix) was sent to Justin as message 142005 in the effort topic, about 13:04 PST. The round-5 reviewer read it as a row in the standby's topic log, which proves the send was made, not that Telegram accepted it. Delivery was not verified for this report.

## Full Findings Catalog

Severity is the reviewer's. "Fixed" means the next revision changed the text and a later round's resolution check read it as resolved, unless noted.

### Round 1 (single spec)

Security + adversarial (12 DESIGN, 8 PRECISION):
- SA-1 major: the suppression notice is itself retired silently on a non-holder. Fixed by removing the user notice (FD-4).
- SA-2 major: the outcome table maps raw state while the owner answers from its classifier; they disagree where a reply may have arrived. Fixed: the owner's classified verdict is used.
- SA-3 major: a reply suppressed because the user has it was reported "safe to resend". Fixed (reasons on suppression, §3b table).
- SA-4 major: `reader: true` skipped more checks than the author check, and the route asked the lease holder, not the execution owner. Fixed (roles, checks kept).
- SA-5 major (sibling slice 3e): "Not confirmed" invites a second send.
- SA-6 major: path tags trusted from message text. Fixed (FD-7).
- SA-7 major: one user notice per retired reply, unbounded. Fixed by removal.
- SA-8 major: the authoring session was never told. Fixed (session line).
- SA-9 minor: 3d would change 3a's behaviour on the fleet. Dissolved when the timestamp rule was retired.
- SA-10 minor: where `causal` reads its evidence was unspecified. Fixed.
- SA-11 minor: a second notifier on mixed versions. Fixed.
- SA-12 minor: the outcome route was an unthrottled trigger for mesh calls. Fixed (coalescing, cache).

Scalability + integration (12 DESIGN, 7 PRECISION):
- SI-1 critical: `superseded` and "user already has it" mapped to safe-to-resend. Fixed.
- SI-2 major: owner `no-record` read as proof of non-delivery. Fixed (FD-13).
- SI-3, SI-4, SI-5 major: the media event is usually not on the serving machine at injection; reuse the existing follow-up line; a wait before injection reorders a topic. Fixed (FD-8).
- SI-6, SI-7 major: a permanent HIGH attention item per reply; no Standard B declaration. Fixed.
- SI-8 major: `causal` evidence across machines. Fixed.
- SI-9 major, SI-11 minor: sibling slices.
- SI-10 major: no Multi-machine posture section. Added.
- SI-12 minor: the review metric could not be read. Fixed.

Decision-completeness + lessons (14 DESIGN, 9 PRECISION): D1 no Frontloaded Decisions section (added); D2 three open questions were author-answerable (answered, Open questions now empty); D3 to D5 the outcome table read absence, `superseded` and suppression as non-delivery (fixed); D6 retained waits no longer guarded anything (fixed); D7, D8 notices per operation, recovery handed to the user (fixed); D9 five reasonless suppression sites, not two (fixed, sites named); D10 an unreplicated photo reported as permanently elsewhere (fixed); D11 the fix stayed dark on the fleet (fixed, FD-2); D12 no cross-machine posture (added); D13 deferrals with no owner or date (commitments and dates added); D14 fixed waits with no basis (contested, see decision points).

Cross-model, GPT 6 Astra (3 DESIGN): a third machine with no local row got safe-to-resend; a local path was kept on existence alone, with no identity check; replacement admission was treated as delivery. All fixed.

Gate (7 flags): Multi-Machine Entity, Verify the State, Judgment Within Floors, Bounded Notification Surface, The Agent Carries the Loop, User-Facing Fixes Ship Live, Attributed Statements. Each engaged; the last was fixed by quoting the logged messages with their ids (§1.1).

### Round 2 (single spec)

Security + adversarial (7 DESIGN, 12 PRECISION): N1 major, four other producers put path tags in text and three consumers read them; N2 major, a new poller with an older serving machine drops the photo; N3 major, `held/author-review` had no way out; N4 major, the reworded notice asserted non-delivery for an unknown outcome; N5 minor, a second reasonless suppression ended the reply silently; N6 minor, a `superseded` author answered `holding: false`; N7 minor, the `awaiting-event` row could not be written as specified. All fixed in r2 or by the removal of the opt-out rule in r3.

Scalability + integration (9 DESIGN, 8 PRECISION): N1 critical, the "existing earlier-answer marking" is not sent by anything (fixed: the late first line is new work, FD-4); N2 major, with the holder on the old version the reply is still dropped twice (fixed, FD-14); N3 major, `media[]` has more carriers than stated; N4 major, `awaiting-event` rows wait 7 days; N5 major, the hot path asks the holder for an answer the local row has; N6 major (sibling 3e); N7 major, posture markers did not fit; N8 minor, both answers sent at the ceiling; N9 minor, the review rule read a symbol nothing produces. All fixed.

Decision-completeness + lessons (7 DESIGN, 12 PRECISION): N1 the F1 diagnosis named a field nothing writes (now the CMT-057 log read, a pre-build gate); N2 high, "deliver late" had no arbiter (fixed: the session is told when its reply goes late); N3 a progress note retired the real answer on the opt-out path (dissolved with FD-3); N4, N5 transcripts posture (sibling); N6 four untrue statements in the ELI16, including "a spec you approved" (fixed); N7 "send again when it didn't go through" had no carrier for a failure with no session (FD-17, with a count and a 2026-11-25 decision).

Cross-model (3 DESIGN, 1 PRECISION): mixed-version recovery still dropped replies silently; an uncertain delivery triggered a "did not reach you" instruction; legacy dashboard retry had no dedupe (sibling). Fixed.

Gate (5 flags): A Refusal Stays a Refusal, Verify the State, Multi-Machine Entity, Judgment Within Floors, Never Silently Cut. Engaged.

### Round 3 (parent)

- Security + adversarial (3 DESIGN, 8 PRECISION): R3-1 major, on the authoring non-holder the session line had no carrier and a state-keyed table would say "not delivered" for a reply that may have arrived; R3-2 minor, the late line stated an age frozen at sealing; R3-3 minor, the outcome route said `unknown` forever while the session line said to send again. Fixed.
- Scalability + integration (2 DESIGN, 10 PRECISION): D1 major, no Maturation plan, so the tag writer would refuse the stamp (added); D2 major, the late mark had no carrier when the author is the execution owner, which is every single-machine agent (fixed).
- Decision-completeness + lessons (2 DESIGN, 9 PRECISION): R3-1 minor, at 300 s the session was told the file "could not be copied", a definite statement on an absence (fixed: uncertain wording, a late event still produces the line); R3-2 minor, "`known-failed` is the platform refusing this content" is false, the state also covers replies that never left (fixed, FD-17).
- Cross-model (3 DESIGN, 1 PRECISION): a race between the media availability check and the waiter insert; a stale local "safe to resend" could survive an unavailable owner; the `known-failed` claim (same as R3-2). Fixed.
- Gate (3 flags): Signal vs. Authority (the temporal opt-out; retired in r3), Judgment Within Floors (six-hour ceiling), Verify the State (the late-marked claim; fixed).

### Round 4 (parent)

- Security + adversarial (3 DESIGN, 8 PRECISION): N4-1 minor, after the owner's definite verdict the author's row stayed `held`, so the route said "pending" while the session was told "send it again"; N4-3 minor, row 9 needed facts the author's answer did not carry; N4-4 minor, the sweep healed a missed conversion but not a missed "now available" line. Fixed.
- Scalability + integration (2 DESIGN, 7 PRECISION): D1 major, a replacement prepared in a recovery pass was sealed as server automation, so a late-marked reply stopped being a session reply and its failure would be silent; D2 minor, "until the row leaves retention" never happens for these rows. Fixed.
- Decision-completeness + lessons: no DESIGN finding (10 PRECISION). Converged in these lenses.
- Cross-model (3 DESIGN): mixed-version forwarding left the typed-path hole open against an older receiver; a failed forwarded reply could be handed back and reported pending at once (same as N4-1); the author receipt lacked evidence row 9 required (same as N4-3). Fixed.
- Gate (1 flag): Judgment Within Floors, the 300-second late threshold. Kept as an inherited starting value, measured and reset 2026-11-25.

### Round 5 (parent, calibrated)

- Security + adversarial (1 DESIGN, 4 PRECISION): N5-1 minor, a row with the owner's verdict was still sent by the forward ladder when the lease moved, after its session was told to resend: a double send. Fixed in one sentence; resolved per round 6.
- Scalability + integration (1 DESIGN, 4 PRECISION): D1 minor, a replacement resets the duplicate check's look-back, so a late reply whose text was accepted more than 15 minutes earlier is delivered twice. The r5 fix was wrong; see round 6.
- Decision-completeness + lessons: no DESIGN finding (7 PRECISION). Advice: tag as is and settle the rest in the build.
- Cross-model (2 DESIGN, 1 PRECISION): the execution-owner shortcut skipped the author check before "safe to resend"; retained hand-back rows could starve active delivery. Fixed; resolved per round 6. Precision: rename "Cause, read from code" (left behind 28).
- Gate (1 flag): Multi-Machine Entity, a photo stays on the poller where native media is off. Accepted deferral (CMT-048).

### Round 6 (parent, cap)

- Internal, all six lenses on the delta (1 DESIGN, 3 PRECISION): **P-D1**, the round-5 fix for D1 split the envelope's `createdAt` from `admission.preparedAt`, which `validOriginAdmission` forbids on every machine deployed since September, and cited a precedent that proves the opposite. A builder would meet a thrown admit. **Post-cap fix:** both times stay equal and the look-back anchor travels as its own sealed field, `firstPreparedAt`; the 15-minute bound against an older owner is stated. P1 (a verdict row stays due on every tick): **post-cap fix**, the verdict merge nulls `ladder.nextAt`. P2 (the health summary reads the same 500-row listing) and P3 (the round-5 gate flag): left behind.
- Cross-model (3 DESIGN): (1) duplicate prevention did not survive an ownership change. **Post-cap fix:** uncertainty is kept across a lease change; nothing is sent without the old owner's receipt record. **The post-cap check found this fix blocking as written (B1, below).** (2) The new reply-text route had no complete authorization contract. **Post-cap fix:** it refuses device tokens and applies the conversation check of topic history. (3) Media follow-up loses its destination when a session moves. **Accepted**, CMT-049.
- Gate (1 flag): Signal vs. Authority, the content check. **Accepted** as existing behaviour, item 30.
- Decision-completeness counts (round-6 reviewer): 15 frontloaded decisions (FD-1 to 9, 12 to 17), 2 cheap-to-change tags surviving (FD-12; FD-17, policy only), 7 contested then cleared, 0 open user decisions.

The post-cap fixes are listed with the code lines checked in the spec's `revision:` frontmatter. They were verified by one targeted check, not by a full review round.

### Post-cap targeted check (not a round)

One Fable pass over the post-cap diff only, source read at `d54f26884`, nothing built or run.

| Post-cap area | Resolves its finding | Blocking |
|---|---|---|
| `firstPreparedAt` as its own sealed envelope field (P-D1) | Yes; every cited carrier holds, an unknown envelope field is tolerated on the submit path as read | None |
| Verdict merge nulls `ladder.nextAt` (P1) | Yes | None |
| Uncertainty kept across a lease change (Astra #1) | Yes in rule, no in carrier | **B1** |
| Reply-text route authorization (Astra #2) | Yes | None |
| Left behind 29 and 30, the two acceptances | Yes, as stated acceptances | None |

- **B1 (blocking at the check; fix applied to the spec afterwards, not re-checked).** The text says an `ownerUnstated` row is handled "exactly as" an `outcome-unknown` row with the existing receipt ask. That ask's mapper collapses `suppressed`, `known-failed`, `expired`, `superseded` and `not-admitted` into `not-accepted`, which the existing branch reads as "definitely not accepted, clear the uncertainty". The old owner of an `ownerUnstated` row holds exactly a `suppressed` record, so the cited carrier sends the reply a second time. Fix: say the mapper collapses `suppressed` and that this path must not use that class; it reads the raw `state` plus the new `outcome` and `failure` fields, and `suppressed` with no `outcome` is "no reason". Make the test stub explicit: the old holder answers `state: 'suppressed'` with no `outcome`.
- Non-blocking notes from the check: the 3a graduation criterion "no reply delivered twice" can fail on the stated 15-minute bound while any owner runs the previous release; the order of the conversation check and the principal refusal on the text route is not stated; `telegram:<topicId>` is undefined for an operation with a null topic (nothing leaks either way).

## Convergence Verdict

**Converged at the cap with post-cap fixes; not a clean quiet round.**

Round 6 was the sixth and last allowed round and it still found four design-class findings and one gate flag in this spec. Three findings were fixed after the cap with sentence-level changes that add no mechanism, and one finding and the gate flag were accepted with their reasons (Left behind 29 and 30). Those fixes have had one targeted check and no full review round.

**That check came back BLOCKING on one sentence (B1).** The fix it asked for was then written into the spec, and reads as asked, but that last edit has had no review of any kind beyond a read of the sentence for this report. So the honest state is: six rounds, four post-cap fixes checked once and clean, one post-cap fix corrected after the check and unchecked since. This is the second time in a row that a fix sentence cited a carrier that does the opposite (round 5's D1 fix was the first), so the build should read each named carrier, `server.ts:32648` and `OriginForwardToHolder.ts:409-412` first, before relying on it.

Open questions: none. Counts for the tag: 15 frontloaded decisions, 2 cheap-to-change tags, 7 contested then cleared. No decision here changes the constitution, so under FD-16 Echo approves the spec under the standing grant and Justin receives this report, including the Slack finding (CMT-053). One gate stands before the build: the F1 incident cause is read from the Studio's log (CMT-057).
