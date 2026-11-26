# Convergence Report — Any-machine access to conversations and the sessions behind them

## Cross-model review: codex-cli:gpt-6-astra

RAN. GPT 6 Astra reviewed the spec through the codex CLI in all six rounds (status `ok` each round, no truncated prompt). Gemini is not installed on this machine, so there was one external family, not two. The constitution gate also ran every round, never degraded.

**Spec:** [docs/specs/native-conversation-any-machine-access.md](../native-conversation-any-machine-access.md) (slices 3d, 3e, 3f)
**Slug:** `native-conversation-any-machine-access`
**Parent:** [native-conversation-base](native-conversation-base-convergence.md) (shared framing; slices 3a, 3b, 3c)
**Report written:** 2026-11-11T21:44Z
**Iterations:** 6 of 6 (the cap for Tier 2+). Rounds 1 and 2 ran on the single spec this one was split from.
**Final-round design findings:** 3 (1 internal, 2 cross-model), plus 1 gate flag. **Not zero.** Three were fixed after the cap (one by withdrawing a round-5 answer), the gate flag was accepted. See the verdict.

POSTCAP-CHECK: **CLEAN for this spec.** Source: `.instar/efforts/ncb/postcap-check.md`. All four post-cap areas resolve their findings with no blocking problem. The same check was BLOCKING on one sentence in the parent spec (B1), since corrected there and not re-checked; that does not touch this document, but the two specs ship as one phase.

---

## ELI10 Overview

On 2026-11-11 Justin wrote that the agent should always have full insight into any conversation and the session behind it, whichever machine it is on. That day it did not: one machine refused another's address, a second refused its password, and a reply Justin typed into the dashboard never arrived. This spec is the part of the native-conversation first stage that fixes those two failures.

What changes if it ships. The agent's machines read each other's session transcripts and conversation history by asking directly, each proving who it is, with no shared password. A machine that is asleep is named, with when it was last seen, instead of an error. The dashboard reply box keeps the typed text until the receiving machine confirms that exact send, by an id the page attaches to it; nothing else clears it, and a "send again" is offered only where the receiving machine can recognise a repeat. In a second step (its own short design, due 2026-11-18, live by 2026-12-02), transcripts are copied to every machine a little at a time, so a sleeping machine can still be read, and the answer says how far the copy reaches.

The main tradeoffs. Transcripts are for the owner and the agent only; team members and guests are not shown them in this spec. Copies on every machine cannot be called back, and passwords are removed line by line before any piece leaves a machine. The privacy rule is a rule on what the server hands out: a session running for the owner on a machine can still open the transcript files on that machine's disk, and no server rule stops that. Typing into a session on another machine stays off by default; this work makes the box honest about that. A dashboard reply is still raw typing into a terminal, not a conversation message; that is a later stage. None of this is built yet.

## Original vs Converged

- **Originally:** transcripts stayed on the machine that ran the session and were read on demand from awake machines; whether to copy them was left to a later phase. **After review:** copying is decided here (FD-11, slice 3f). Why: the operator's message 141905 asks for the session behind a conversation "regardless of what machine you are on", and a read that fails when the machine sleeps does not meet it.
- **Originally:** the transcript read had no audience rule. **After review:** each transcript follows the audience of the conversations its session served, the strictest one deciding, checked at read time against the signed team record; a machine refuses while its team record has a gap or an awake peer has not answered. Why: the gate flagged that an owner-wide read bypasses the team's sharing grants.
- **Originally (round 5):** members and guests were shown the transcript of a session that served a conversation granted to them. **After review (post-cap):** withdrawn; owner and agent only. Why: a transcript is the session's working record, not just the messages, and a session that ran before a grant ran with the owner's full reach, so a later grantee would see what the per-message rule withholds.
- **Originally:** the dashboard showed "Not confirmed, your text is still here" after 8 seconds and let the operator send again. **After review:** each send carries an id, the server refuses a repeat it has already typed, a second send is offered only where the serving machine advertises that it can recognise a repeat, and an older server's id-less acknowledgement no longer clears a draft. Why: against an older machine every successful send looked unconfirmed, and sending again typed the text twice.
- **Originally (round 3):** a draft was also cleared when the same text appeared in the session's record. **After review:** removed. Why: two clients each sending "yes" would both clear on one row; equal text does not prove this send arrived. The session can be asked whether a dashboard message reached it, and its answer can only confirm arrival, never declare a loss.
- **Originally:** the old shared-token read was to be removed after seven days with no use. **After review:** it is retired per machine and per kind of read, only once that machine has itself answered the new way (FD-18). Why: a machine that slept for eight days would have been locked out.

## Iteration Summary

Design counts are raw per-reviewer counts and include overlaps. Rounds 1 and 2 ran on the single spec, so those rows are the whole-spec totals, with the findings in this spec's slices named in the catalog. "Gate flags" are possible violations from the constitution gate.

| Iteration | Reviewers who flagged design issues | Design findings | Precision / left behind | Gate flags | Spec changes |
|-----------|-------------------------------------|-----------------|-------------------------|------------|--------------|
| 1 (single spec, 41 KB) | all three Fable agents, Astra | 41 whole spec; 4 in slices 3d to 3f, plus the missing posture and decisions sections | 24 whole spec | 7 | Rewrite (r1, 55 KB) |
| 2 (single spec, 55 KB) | all three Fable agents, Astra | 26 whole spec; 4 in these slices or the transcript posture | 33 whole spec | 5 | Rewrite (r2, 69 KB), then split; this spec starts at 20 KB |
| 3 (sibling, 20 KB) | scale+integration, Astra (security+adversarial and decisions+lessons: none) | 4 (0, 1, 0, 3) | 8 | 4 | Oversized-row rule, redaction boundary rule, Maturation plan, audience rule (r3, 33 KB) |
| 4 (sibling, 33 KB) | security+adversarial, scale+integration, Astra (decisions+lessons: none) | 6 (1, 1, 0, 4) | 12 | 3 | Text match removed, per-kind capability, dedupe key changed (r4, 46 KB) |
| 5 (sibling, 46 KB), calibrated | Astra only; all three Fable agents found none | 3 (0, 0, 0, 3) | 14 | 2 | Sentence-level fixes; member answering added (r5, 50 KB) |
| 6 (sibling, 50 KB), cap | one Fable agent on the delta, Astra | 3 (1 internal, 2 Astra) | 7 | 1 | Post-cap sentence-level fixes; member answering withdrawn (final, 55 KB) |

Reviewer setup: rounds 1 to 5 used three Fable 5.2 agents, each covering two lenses (security + adversarial, scalability + integration, decision-completeness + lessons-aware). Round 6 used one Fable agent covering all six lenses on the round-5 diff. External: GPT 6 Astra every round.

Round-5 calibration: because the parent had grown from 55 KB to 88 KB over three rewrites, the author told round-5 and round-6 reviewers to class a finding as DESIGN only if it would cause a double send, a silent loss, a privacy or security exposure, data loss, or a false statement about the code that a builder would act on. Under it, all three internal agents found no design issue in this spec in round 5. Astra was not given a different bar and still returned three.

## Proportion

⚠ Tier 2+, a 238-line, ~55 KB spec (beside a ~98 KB parent), 6 of 6 rounds, and no quiet round. This spec nearly tripled after the split (20 → 33 → 46 → 50 → 55 KB). Three of its slices is a lot to carry in one review, and 3f is itself only a set of constraints on a spec not yet written. Out of line for the size of the change; recorded for the retrospective.

## Left behind

The spec's own `## Left behind` section is the authority; it has 20 numbered items. Summary:

**Accepted at the cap (design-class, not fixed):**
- Direct disk reads by an owner-reach process (round 6 gate flag, *An Instar Agent Always Serves a Team*): the audience rule is enforced at the server's routes. A session running for the owner on a machine can read the transcript files on that machine's disk, 3f copies included. `team-roles-and-access.md` §5 states the same limit for the conversation log. Stated in §3d item 2 and §5 Risks. No queue.
- A machine cut off with no awake peer to ask still shows the owner a transcript on its last known team record; a revocation it has not seen does not apply there. Same rule conversations already follow; disclosed.
- 256-id retention for input dedupe (gate flag, rounds 4 and 5, *Judgment Within Floors*): a memory bound until the 2026-11-25 counters. Item 20.
- Member and guest transcript access: withdrawn, not built. Queue: CMT-059 (Mama PC registry), for sessions launched confined with the reader's grant only. Item 10.
- Dashboard replies as real conversation messages: Phase 2, no commitment of its own yet. Item 8.

**Precision, not iterated on (items 1 to 7, 9, 11, 13 to 19):** line references re-checked at build; the remembered "peer cannot serve this kind" entry has no expiry beyond a version change; no bound on transcript pulls per peer until 3f; measure transcript bytes per day before fixing the chunk size; a first try that never arrived and one the machine has forgotten both end as `input-retry-unknown`; CMT-051's registered text still states the retired seven-day rule; the live terminal view is not covered by the audience rule; the session line should use the marked form for system lines; name where "every conversation that session served" is read from (fails closed today); the 200-character cut of a tool input has no in-band mark; bound-check the continuation's row and byte offset; the reader does synchronous reads of up to 32 MB per call, now reachable by peers; state when the seen-id set and the relay's pending map are dropped; name the control that resends kept text after a lost peer link; "it will answer in the conversation" promises more than an acknowledgement can guarantee (Astra, round 6); keep the 3f checkpoint store out of git sync, backups and support bundles.

**Acted on after the cap (item 12):** ordinary paging uses the offset-plus-index entry identity.

**Told to the operator:** FD-11 (transcripts copied to every machine) says Justin was told in the effort topic. The round-5 reviewer read messages 141981 and 142005 as rows in the standby's topic log, which proves the sends were made, not that Telegram accepted them. Delivery was not verified for this report.

## Full Findings Catalog

Severity is the reviewer's. "Fixed" means the next revision changed the text and a later round's resolution check read it as resolved, unless noted. Findings on slices 3a to 3c are in the parent's report.

### Round 1 (single spec; findings in these slices)

- SA-5 major (security + adversarial, 3e): "Not confirmed. Your text is still here" invites a second send, and on a mixed-version pool it fires after every successful send. Fixed (FD-10).
- SA-9 minor (3d): signed reads change which peers the old timestamp rule could read. Dissolved when the parent retired that rule.
- SI-9 major (scale + integration, 3e): an older serving machine makes every remote send read unconfirmed. Fixed (capability frame).
- SI-11 minor (3d): `shape: 'pool'` inherits caps that silently change pool history. Fixed (cursors, `truncated`).
- SI-10, D12 major: no Multi-machine posture; two surfaces proxied-on-read against the operator's stated requirement. Section added.
- D1, D13 (decisions + lessons): no Frontloaded Decisions; deferrals with no owner or date. Added.
- Astra's three round-1 findings were all in the parent's slices.
- Gate (7 flags, whole spec): see the parent's report.

### Round 2 (single spec; findings in these slices)

- SI-N6 major (3e): `inputAck: 2` had no carrier for a remote session and the old-peer path still typed twice. Fixed.
- Astra #3 DESIGN (3e): legacy dashboard retry lacks dedupe. Fixed: retry only where the serving machine advertises dedupe.
- N4 medium (decisions + lessons): FD-11 was not a decision; transcripts left proxied-on-read. Fixed: decided, "Reversible: no".
- N5, SI-N7: posture markers did not fit and the Standard A lint failed. Fixed; lint clean from round 3.
- Gate: *Multi-Machine Entity* on transcripts available only from awake peers. Answered by FD-11 and 3f.

### Round 3 (sibling)

- Security + adversarial: no DESIGN (2 PRECISION).
- Scalability + integration (1 DESIGN, 1 PRECISION): D1 major, no Maturation plan, so the tag writer would refuse the stamp. Added.
- Decision-completeness + lessons: no DESIGN (5 PRECISION). Converged in these lenses.
- Cross-model (3 DESIGN): an unrelated id-less acknowledgement from another tab could erase a draft; byte-capped paging had no rule for one row larger than the cap; byte checkpoints and secret removal had no shared boundary, so a token split across two chunks could leak. All fixed (drafts kept as unresolved; `rowTruncated` and a byte-range continuation; whole-line checkpoints with carry-over).
- Gate (4 flags): Never Silently Cut (row caps; fixed by the oversized-row rule), Verify the State (the id-less acknowledgement; fixed), Judgment Within Floors (seven-day retirement; replaced by FD-18), No Manual Work (the operator told to check the session; fixed, the page asks the session).

### Round 4 (sibling)

- Security + adversarial (1 DESIGN, 4 PRECISION): N4-2 minor, keying seen input ids by client connection made every retry after a reconnect an unknown id, refusing "Send again" in the one case it exists for. Fixed: keyed by session and id, random id required.
- Scalability + integration (1 DESIGN, 3 PRECISION): D3 minor, the transcript read is a clipped digest (4,000 characters per entry), so "every row can be read in full" was false and the oversized-row test could not be built on the named reader. Fixed: the clip is stated, with a full read on request.
- Decision-completeness + lessons: no DESIGN (5 PRECISION).
- Cross-model (4 DESIGN): text equality cannot confirm this send (fixed by removing the text match); the transcript baseline had no required ordering (moot after the removal); restart recovery omitted buffered redaction state (fixed in the 3f constraints); one signed read marked a machine capable for every verb (fixed, FD-18 per kind).
- Gate (3 flags): Verify the State (the text match; removed), Judgment Within Floors (256 ids; left behind 20), Always Serves a Team (the owner granted every transcript; fixed by the audience rule).

### Round 5 (sibling, calibrated)

- Security + adversarial: no DESIGN (5 PRECISION). Scalability + integration: no DESIGN (3 PRECISION). Decision-completeness + lessons: no DESIGN (6 PRECISION).
- Cross-model (3 DESIGN): (1) audience freshness contradicts the offline guarantee: a cut-off copy can lack a revocation, and a signature proves authenticity, not currency. r5 answered in direction; the predicate was defined only after the cap. (2) Transcript paging lacks an entry-level boundary when several entries share one record offset. Left as wording in r5; fixed after the cap. (3) The session's recollection cannot establish that a message was lost. Fixed: the line says only "cannot confirm".
- Gate (2 flags): Judgment Within Floors (256 ids, again), Always Serves a Team (members denied even their own transcripts with no reason given). The r5 answer to the second opened transcripts to members and guests, which became round 6's S-D1.

### Round 6 (sibling, cap)

- Internal, all six lenses on the delta (1 DESIGN, 6 PRECISION): **S-D1**, the round-5 member rule shows a later grantee the transcript of sessions that ran with owner reach before the grant, and of sessions that did not know of the grant, which the per-message rule withholds. No route reaches it today, but the spec's own test and live proof could pass only if a builder opened one. **Post-cap fix:** member answering withdrawn; owner and agent only; "no device or team route reads the store" restored; member access deferred to CMT-059 for confined sessions. S-P1 to S-P3 (the currency predicate could not be evaluated by the machine it describes, and a strict reading refused every copy): **post-cap fix**, one evaluable test (the team log has a gap, or the team puller is refusing). S-P4 to S-P6: left behind or folded into S-D1.
- Cross-model (2 DESIGN, 1 PRECISION): (1) freshness is required but nothing establishes it. **Post-cap fix** as above, with the cut-off-machine limit stated. (2) Ordinary paging can skip or repeat entries. **Post-cap fix:** offset-plus-index is mandatory for ordinary paging, with a test that every entry is returned exactly once. Precision: the "it will answer in the conversation" wording (left behind 18).
- Gate (1 flag): Always Serves a Team, direct disk reads by owner-reach sessions bypass the route rule. **Accepted** as a stated limit.
- Decision-completeness counts (round-6 reviewer): 6 frontloaded decisions (FD-9, 10, 11, 15, 16, 18), 0 cheap-to-change tags surviving, 3 contested then cleared, 0 open user decisions. The reviewer also counted 1 contested and not cleared (who besides the owner is answered) and 1 undecided (the currency predicate) at round 6; both were settled by the post-cap fixes and the check below reads them as resolved. No reviewer re-counted after the cap.

### Post-cap targeted check (not a round)

One Fable pass over the post-cap diff only, source read at `d54f26884`, nothing built or run. Verdict for this spec: **CLEAN.**

| Post-cap area | Resolves its finding | Blocking |
|---|---|---|
| Owner and agent only (S-D1) | Yes; no sentence still answers a member or guest, and the tests, live proof and kill criteria now say "refused" | None |
| Currency predicate (S-P1 to S-P3, Astra #1) | Yes; one test the machine can run. A machine whose other machines are all off does not refuse for good, so 3f copies stay readable | None |
| Offset-plus-index cursor (Astra #2) | Yes; the reader's entry shape was re-read in the check and matches | None |
| Accepted risk of direct file reads (gate flag) | Yes, as a stated acceptance; wording only | None |

## Convergence Verdict

**Converged at the cap with post-cap fixes; not a clean quiet round.**

Round 6 was the sixth and last allowed round and it still found three design-class findings and one gate flag in this spec. All three findings were fixed after the cap with sentence-level changes that add no mechanism (one of them by taking back a round-5 answer), and the gate flag was accepted as a stated limit. Those fixes had one targeted check, which came back clean for this spec, and no full review round. The round-6 internal finding was introduced by a round-5 fix sentence, so the build should read each named carrier before relying on it.

Open questions: none. Counts for the tag: 6 frontloaded decisions, 0 cheap-to-change tags, 3 contested then cleared. No decision here changes the constitution, so under FD-16 Echo approves the spec under the standing grant and Justin receives this report. The parent spec had one blocking sentence from the same check (B1); it has been corrected there and not re-checked. Nothing in this spec waits on it except that the two are one phase.
