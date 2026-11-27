---
title: "A tone verdict on a forwarded reply reaches its author, and the reply waits for the author (slice 3g)"
slug: "native-conversation-forwarded-advisory"
author: "echo"
parent-principle: "The User Experience Is the Product — Reachability, Responsiveness, and Coherence Are Sacred"
eli16-overview: "native-conversation-forwarded-advisory.eli16.md"
status: "draft"
approved: true
approved-by: "echo, under the standing operator rule that only constitution changes need Justin; this slice changes no constitution text. Justin was told the cause and the plan in Telegram topic 141876 on 2026-11-12."
approved-at: "2026-11-12T17:52:00Z"
sibling-of: "native-conversation-base (shared framing; this spec extends its slice 3a carriers)"
depends-on: "native-conversation-base §3a and §3b (PR #3102, branch echo/ncb-3a-held-replies), tone-gate advisory migration"
lessons-engaged: "The Agent Carries the Loop, User-Facing Fixes Ship Live, Judgment Within Floors, A Refusal Stays a Refusal, Bounded Notification Surface"
effort: ".instar/efforts/native-conversation-base.md (topic 141876)"
evidence: "docs/specs/reports/ncb-f1-cause.md (branch echo/ncb-f1-cause-4)"
review-convergence: "2026-11-12T17:48:49.495Z"
review-iterations: 4
review-completed-at: "2026-11-12T17:48:49.495Z"
review-report: "docs/specs/reports/native-conversation-forwarded-advisory-convergence.md"
cross-model-review: "codex-cli:gpt-6-astra"
single-run-completable: true
frontloaded-decisions: 7
cheap-to-change-tags: 0
contested-then-cleared: 4
---

# A tone verdict on a forwarded reply reaches its author, and the reply waits for the author

Line references are to the slice 3a branch at `a7e4937b8`. No constitution text changes. Round 1 removed the timed release: a delay is accepted, a duplicate is not.

## 1. Problem

On 2026-11-11 a reply written on the M5 Pro for topic 141868 was forwarded to the Studio, the lease holder. The Studio's tone gate gave it `B11_STYLE_MISMATCH` with `advisory: true` three times in ten minutes, 15 to 20 s per review. Then the timestamp rule ended it and Justin never saw it (`ncb-f1-cause.md`). Slice 3a removes that rule; the same reply would now sit unanswered to its deadline (up to 6 h).

The verdict is the tone gate's refusal body (`routes.ts:5166-5205`), thrown as `OriginSendPolicyRefusal` from the one review call, which runs before any claim (`TelegramOriginService.ts:724`). It is mishandled in three places:

1. **The holder's recovery** logs it and continues (`TelegramOriginRuntime.ts:846-852`); the next tick reviews again.
2. **The author's recovery submit** stores a `policyRefusal` answer as an ordinary `refused` attempt and submits again (`OriginForwardToHolder.ts:706-716`).
3. **The synchronous answer.** The holder answers `policyRefusal` and leaves its row `admitted` (`OriginMesh.ts:187-190`). The script says "not sent", the session revises, and the holder's recovery can still deliver the original (`OriginStoreBackend.ts:599`): a double send today, on every author version.

## Frontloaded Decisions

| # | Decision | Choice and reason | Reversible |
|---|---|---|---|
| G-1 | What a verdict on a reply in custody does. | Exactly what it does at the script: the reply is not sent and the decision goes back to the author. | no |
| G-2 | Timed release. | None. Only the author's answer sends an advisory-held reply; otherwise it ends at its existing deadline through 3a's carrier. "Revised" cannot be proven for a reply sent without the reference, so silence never releases. | revisited on evidence (2026-11-25) |
| G-3 | Where the reply lives while it waits. | One `held` row on the author's machine. The holder ends its own copy of a forwarded reply in the same step that records the verdict. The answer supersedes locally, so there is no holder-side supersede. | no |
| G-4 | Verdict classes. | Three, by allow-list (item 1). A review that produced no verdict is never an ending. | no |
| G-5 | How the author answers. | The existing reply script and the four reaction fields (`OriginSendPolicy.ts:10-15`). No new flag or route. | no |
| G-6 | Fleet default. | Live on every agent from release, no configuration key. Rollback is by version. Where the advisory migration is dark, one judgment-rule verdict in custody now ends the reply (3a reviewed it again), as at the script. | no |
| G-7 | Approval. | Echo, under the standing grant, after convergence. | n/a |

## 2. Design

**Item 1. One classifier, three classes.** `policyVerdictClass(decision)` reads the refusal body:

| Class | Matches | Effect |
|---|---|---|
| `advisory` | `error: 'tone-gate-advisory'` | handed back, answerable (items 2 to 5) |
| `refused` | `blockedBy: 'credential-exposure-guard'` (`routes.ts:4556-4575`); `blockedBy: 'localhost-link-guard'` (`:4541-4551`); `error: 'tone-gate-blocked'` whose `rule` is a key of `RULE_DISPOSITIONS` (`MessagingToneGate.ts:627`) and either no `failedClosed` or `degradedToDeterministic` (the deterministic floor caught a real rule, `:352-394`); `error: 'tone-gate-advisory-reason-required'` (`:5129`) | handed back as a definite failure (item 6) |
| `retain` | everything else: `content-reservation-pending`, `duplicate-content` (already ended by its own writer, `TelegramOriginService.ts:304-319`), `content-dedup-unavailable`, `authorizeDispatch` refusals (`:259-263`), any `tone-gate-blocked` with another rule value (`CAPACITY_UNAVAILABLE`, the spawn-cap shed, `MessagingToneGate.ts:1350-1360`; `GATE_UNAVAILABLE`; `GATE_TIMEOUT`; an unknown rule), and any other fail-closed review | unchanged: the row stays queued and is reviewed again, as in 3a |

Both blocked bodies, the demoted advisory (`routes.ts:5097-5113`) and the ordinary block (`:5193-5203`), gain the result's `failedClosed` and `degradedToDeterministic` (neither body has them today), and the rule must be a real one, so neither an outage nor a capacity shed is read as a verdict, and a floor catch is. `refused` covers the self-stop family (`MessagingToneGate.ts:705-709`), a judgment rule where the advisory migration is dark, and an advisory demoted by `advisoryUnavailable` (`routes.ts:5086-5114`). Each is a 422 at the script today; custody now gives the same answer instead of a 6 h wait.

**Item 2. The holder records the verdict and gives up its copy, in one transaction.** A new nullable column `policy_verdict_json` on the operation row holds `{ class, rule, suggestion, decisionRef, at, machineId }` (`suggestion` cut to 500 characters, newlines and backticks removed; `issue` never stored; a `refused` row stores class and rule only). No state transition clears it, so it survives re-holds, retries and restart. `recordOperationState` (`OriginStoreBackend.ts:869-908`) takes it as an optional argument, and refuses `admitted` for a row whose column has class `advisory` (a re-hold replaces `hold_reason`, `:890`). `SUPPRESSION_REASONS` (`OriginOperationOutcome.ts:39`) gains `tone-advisory` and `policy-refused`; both classify as `not-delivered`, `safeToResend: false`, and `policy-refused` carries `failure: 'refused'`.

Two sites call the classifier. Review precedes the claim, but a concurrent submit or recovery can claim the row meanwhile, so the verdict-and-end write is a conditional transition: it succeeds only if the row has no claim, no unresolved dispatch and no accepted part (the existing fence in `recordOperationState`, `OriginStoreBackend.ts:869-908`, already refuses a claimed child and an `accepted`, `expired`, `outcome-unknown` or `partial` row; :887 is the unresolved-dispatch test), the first recorded verdict wins (a later verdict never overwrites it), and in the same transaction it prevents any later claim. A writer that loses returns the custody answer (operation id, `outcome-unknown`), never a definite non-delivery.

- **Submit** (`OriginMesh.ts:187-190`): for `advisory` or `refused` the holder writes `suppressed` with the matching reason, then answers `policyRefusal` with `copyEnded: true`. It answers `policyRefusal` only after ending its copy: for `retain`, or if the write is refused, it gives the ordinary custody answer (operation id, `outcome-unknown`), so the author holds its row and no session is told "not sent" about a live row.
- **The holder's outbox recovery** (`TelegramOriginRuntime.ts:846-852`): a row authored on another machine is written `suppressed` the same way. A row authored here is written `held` with reason `tone-advisory` (class `advisory`) or `suppressed` (class `refused`). The recovery query leaves out a row whose column has class `advisory`: it is never reviewed again and never fills the batch.

**Item 3. The verdict reaches the author's row.** The `receipt` answer gains `policyVerdict`, copied from the column, only for the machine that wrote the reply, never on a `reader` answer. `classifyHolderReceipt` (`OriginForwardToHolder.ts:312-316`) reads `suppressed` + `tone-advisory` + a valid `policyVerdict` as a new `owner-advisory`, and `policy-refused` (or `tone-advisory` with no valid verdict) as `owner-verdict` with `failure: 'refused'`. The recovery submit reads a `policyRefusal` answer carrying `copyEnded: true` the same way, without waiting for a poll; on every path an author treats a `policyRefusal` without `copyEnded` (an older holder, which keeps its row) as custody, not as ended. On `owner-advisory` the author's forward row keeps its text, gets the same column, and is marked `lastAttempt: 'outcome-unknown'` at that holder. `recoverForwardedHold` then returns at once for it, as for `ownerVerdict` (`:494`): no submit, no local send after a lease change, no holder-change or late-mark replacement. The row also leaves both delivery selections: its `ladder.nextAt` is set to null, and the 500-row forward lookup leaves it out as it does an ended row (`TelegramOriginRuntime.ts:403-407`). A separate scan of rows with class `advisory` carries their line (item 4) and deadline. The other readers of `outcome-unknown` (`authorStatement`, the outcome route, the awareness block's uncertain count, `refreshHeldForward`'s held count) read the column first and report the reply as not sent. `forwardExpiryArm` (`:273-278`) reads a row with an advisory as `definite`, cause `deadline`, before its uncertain test.

The first synchronous attempt is unchanged for the session: the script prints the 422 (`:382`), no author row exists, and item 2 has ended the holder's copy.

**Item 4. One session line, through 3a's carrier.** `sessionLine` (`TelegramOriginRuntime.ts:484-494`) with a new key `advisory-line`: once per operation, retried each pass until recorded. A forward row gets it from item 3's scan; a row authored on the holder from the session-exception scan, whose `WHERE` already returns it, through a new `scanSessionLine` arm. Text:

> Your reply `<id>` was not sent. The outbound check has a suggestion (`<rule>`): <suggestion> It stays held until you answer and ends undelivered at <deadline, HH:MM UTC>. To send a revised version, send it with `--tone-complied <rule> --tone-decision-ref <ref>`. To send it as written, resend its text with `--tone-ack <rule> --tone-reason "<why>" --tone-decision-ref <ref>`. A reply sent without that reference is a separate message and leaves this one held. Its text is at `GET /telegram/origins/operations/<id>/text`.

`<id>` is the id the session was given (`originalOperationId`, `:545`). Each advisory-bearing operation has its own answer reference, distinct from the displayed lineage id: `<ref>` is the gate's `decisionRef`, or `op:` with that row's own operation id when the gate recorded none; an `op:` reference is resolved on the author's machine and removed before the policy input is sealed. With no live session (`isSessionLive`, as in 3a) nothing is injected and the row waits; a row with no session author gets no line. At the deadline 3a's definite line gains one sentence: "If you already sent a revised version, do nothing."

**Item 5. The answer withdraws the original before anything is sent.** One lookup, `advisoryRow(session, destination, ref)`, reads this machine's rows that carry the column: outbox rows and forward rows alike, in any state.

- **No row matches** (the synchronous case): an ordinary reply, as today.
- **A `held` row matches:** the reply is prepared as its replacement (3a's `replacement`, keeping `firstPreparedAt` and `deadlineAt`, with the new text and reaction as policy input) and `supersedeWithAdmission` retires the old row and admits the new one in one transaction (`OriginStoreBackend.ts:694-714`). A local replacement is reviewed by the route first and superseded only on a pass; a refusal leaves the held row as it was. A forwarded replacement is superseded, marked `outcome-unknown`, then submitted as a new operation (`forwardSuccessor`'s order, `OriginForwardToHolder.ts:572-579`); the holder needs nothing new. A verdict on the replacement is handled by items 2 and 3, under the original's deadline.
- **A matching row is no longer `held`, or the supersede is refused** (expired, or already replaced, as when a stale answer names an older advisory's reference): the new reply is admitted nowhere and nothing is sent. The script prints the old row's recorded outcome from `classifyOperationOutcome`: pending (with the successor's id), delivered, not delivered with its cause, or unknown.

The only ways out of `held`/`tone-advisory` are `superseded` and `expired`. No timer, tick, lease change or older machine sends it.

**Item 6. A refused reply.** `owner-verdict` with `refused` already has its carrier: `recordVerdict` merges `ownerVerdict` and `handOwnerVerdict` sends the definite line in the same pass (`OriginForwardToHolder.ts:502-508`, `TelegramOriginRuntime.ts:496`). The verdict gains `refusedBy: 'policy'` and the rule. A reply authored on the holder needs three edits: the session-exception scan's `WHERE` (`OriginStoreBackend.ts:959-963`) also returns `suppressed` rows with reason `policy-refused`; `scanSessionLine` (`TelegramOriginRuntime.ts:~926`) builds the definite `refused` line for them, as for `known-failed`; and the failure mapping (`:982`) reads them as `refused`. `failureCausePhrase` says "the outbound check refused it (`<rule>`)" for this case and the line ends "Rewrite it before sending again." The closed cause set does not grow. No credential value is stored or shown.

**Item 7. Counters and awareness.** The federated `metrics` verb and `/telegram/origins/status` gain `advisoryHandedBack`, `advisoryLineSent` (injection, not reading), `advisoryNoSession`, `advisoryComplied`, `advisoryAcked`, `advisoryAnswerRefused`, `advisoryExpiredUnanswered`, `advisoryUnmatchedReply` (a session reply to the topic, without the reference, while one of its rows is held), `policyRefusedHandedBack`, and the count and sum of answer delay. The held-reply block in `OriginAwareness.ts` gains two sentences on the line and its two answers, carried by `migrateClaudeMd`. The parent spec gets a 3g entry.

### Tests

- **Unit:** the classifier over every body in item 1, the capacity-shed body included; the column across re-hold and restart; `admitted` refused for a `tone-advisory` row; receipt classification, and `policyVerdict` withheld from a `reader`; `forwardExpiryArm`; the line for both reference forms.
- **Integration (two origin runtimes), each asserting the dispatch count:** advisory in custody then comply, ack, silence to the deadline, and an unflagged reply; a synchronous advisory then a recovery tick; answer racing expiry in both orders; a second answer with one reference; two successive reference-less advisories, then a stale answer (its recorded outcome, nothing sent) and a current answer; a refused supersede for each recorded outcome; a lease change while held; restart between supersede and submit; refused in custody; a submit and a recovery of one operation running concurrently with divergent review results (the loser answers custody); a capacity shed in custody (retained, delivered on the next pass); a fail-closed review with no rule (custody answer, retained) and one where the floor catches a rule (ended, one definite line); a reply authored on the holder and refused on recovery (one definite line, zero dispatches); more advisory holds than each selection limit (10 due, 500 looked up) with a deliverable reply behind them (delivered next pass); an older author; an older holder.
- **E2E (production boot path):** the counters answer 200 and move; `advisory-line` is wired to a real injector; the migration adds the column.

### Live proof

A throwaway two-machine agent and a demo Telegram group, before release. The author runs on the non-holder; the harness drops the first submit answer (custody) and shortens the deadline for run 1. Six runs: silence (line, nothing delivered, deadline line); comply (only the revised text); ack (the original, once); an unflagged reply (it arrives once, the original never); a self-stop message (definite line, nothing delivered); a synchronous advisory then comply (one message). Then one comply run on Echo's pool, M5 Pro to Studio.

Slack has no such path: `handleSlackReply` (`routes.ts:22918`) reviews and posts on the machine that holds the Slack connection and answers the script directly, so a verdict cannot be stranded on another machine. One Slack run on a demo workspace (advisory, comply, one message) confirms that is unchanged.

## Maturation plan

Ships live under *User-Facing Fixes Ship Live*. Owner throughout: Echo.

- **test-agent-live:** the six Telegram runs and the Slack run above, before the release is published.
- **dev-agent-live:** Echo's pool from the release, with the M5 Pro to Studio run that day. Window ends at the 2026-11-25 review (CMT-056).
- **fleet:** the same release, no gate.
- **graduation criterion:** read on 2026-11-25 through the `metrics` verb from every machine of Echo's pool, naming any that did not answer. All must hold: no duplicate; no `tone-advisory` row reviewed twice; every handed-back row has its line or a counted no-session; at least one advisory answered and one refusal observed (a zero is `unmeasured`, not a pass). The review reads `advisoryExpiredUnanswered`, `advisoryNoSession` and the answer delay, and decides G-2 again.
- **dark-window:** none.
- **ladder:** not applicable: no flag, rolls back by version

| State at release | Rollback | Review | Kill criteria |
|---|---|---|---|
| live, every agent | by version. Old code never sends a handed-back reply: an ended row stays ended, a held local row cannot be claimed, and a forward row marked `outcome-unknown` is asked about at the holder and settles unresolved (`OriginForwardToHolder.ts:643-647`). Cost: repeated reviews, a vaguer line | Echo, 2026-11-25 | any duplicate; a refused reply delivered; a handed-back reply sent without its author's answer. Any one: roll back and file it the same day |

## Multi-machine posture

Default: unified. One line per surface.

- The verdict (`policy_verdict_json`): proxied-on-read, operational state. The holder's row is the source; the author's copy arrives over the signed `receipt` verb.
- The live copy of a handed-back reply: one row, on the machine that wrote it. Supersede and expiry are transactions in that one store, so two machines cannot both act on it.
- The session line: injected on the machine that runs the authoring session, from its own row.
- Counters: unified through the federated `metrics` verb.
- Mixed versions: an older author is told "not sent" synchronously as today, and in custody reads the new reason as an ending with no stated reason: one unresolved line, never a resend. An older holder sends no verdict on the receipt and no `copyEnded` on its submit answer, so its refusal is read as custody and it behaves as 3a.

## Decision points touched

| Decision point | Class | Basis and evidence, or floor and arbiter |
|---|---|---|
| Which refusals hand a reply back | invariant | basis: enumerable-domain; evidence: the refusal body's `error` and `blockedBy` values are a closed set in `routes.ts`, and item 1's `advisory` and `refused` rows list every one that is a verdict on the text, the two deterministic ones (link guard, floor catch) included; `tone-gate-blocked` counts only with a rule in `RULE_DISPOSITIONS`; all else, a capacity shed included, is retained. |
| Nothing sends a handed-back reply but its replacement | invariant | basis: irreversible-consequence; evidence: a second Telegram message cannot be removed, and an unreferenced revision cannot be told from a new message. |
| A refused reply is ended, not retried | invariant | basis: irreversible-consequence; evidence: a sent credential or self-stop message cannot be unsent, and one changed LLM verdict on a later tick would send it. |
| An unanswered advisory waits rather than releases | judgment-candidate | floor: never held past the reply's existing deadline; never sent without the author's answer. Arbiter: the authoring session, at any time before the deadline; the 2026-11-25 review, from the item 7 counters, decides whether silence should ever release. |
| A recorded verdict is not reviewed again | judgment-candidate | floor: a reply with no verdict is always reviewed; changed text or a reasoned override always gets a fresh review. Arbiter: the author, by answering. |

## Left behind

Round-2 precision items not applied (`g2-all-lenses.md`, `g2-codex.json`): P3, P6 to P10, P12, P14 to P20, P22 to P24; Astra's note that a line can be injected twice.

Round-3 precision items not applied (`g3-delta.md`):

- P-a: an ended row is dropped from the held count, not left out of the 500-row lookup.
- P-b: name one carrier for the advisory forward row's deadline.
- P-c: if excluded in SQL, the scan also calls `markHoldExpiryReported` and `raiseHandBackOnce`.
- P-d: the separate scan's limit, order and pass.
- P-e: limit item 6's widened `WHERE` to rows authored here.
- P-f: `scanSessionLine` shows `originalOperationId` for `suppressed` too.
- P-g: `retain` at submit with a lasting cause waits to the deadline (3a re-forwarded).
- P-h: the script answers "held", not a 422, for a `retain` refusal.
- P-i: the due-ladder query is `OriginStoreBackend.ts:634-641`.

## Open questions

*(none)*
