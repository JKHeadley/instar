# Convergence Report — Sending email from an agent

## Cross-model review: codex-cli:gpt-6-astra

Ran in every round (seven of seven). Gemini and Grok were not available on this machine. The Anthropic clean-door read ran in round 1 only, degraded.

**Exit state: round 7 still carried design findings; all were folded into version 8 and checked by one verification read, not by a further review round. The Tier-2 cap is six rounds; this convergence used seven. The operator reads that before approving.**

## ELI10 Overview

An agent cannot send email today, so the "email" row on the recommended-services list has been the one marked unavailable. This plan gives an agent one narrow ability: to email its owner, and nobody else, the reports of scheduled jobs the owner has chosen to receive that way, plus the odd "email me that". It does not read mail.

The owner picks whose account does the sending: a free sending service (Resend) opened in their name, their own Gmail or iCloud mailbox through an app password, or a spare mailbox they hand the agent. In every case the owner types the destination address on their own PIN page, and where the mailbox is not provably theirs the first email carries a code they enter back, so the agent can never mail a stranger by mistake.

The other half of the plan is that no report is ever lost: each one is written down before the job is marked finished, the agent checks whether the mail actually arrived where it can, and anything it cannot confirm is delivered to the chat instead with one line saying why. The trade-off accepted is an occasional duplicate (an email and a chat copy of the same report) in exchange for never zero copies.

## Original vs Converged

- **Who gets the mail.** Originally the recipient was read from the credential and typed only for a spare mailbox. After review every shape has the owner type the address on the PIN page; Resend and spare-mailbox setups require a code from the first email; an own-mailbox credential is refused unless it belongs to that address. A session can never set or change the destination.
- **What counts as delivered.** Originally a mail server's "accepted" was treated as delivery. Now only Resend's status says delivered; mailbox sends are named "accepted, unproven" and are terminal only because the inbox was proven at setup.
- **Nothing lost.** Originally a note of each report with a hash. Now a replicated outbox with a complete state table, the report written before completion is acknowledged, a marker on the job's execution so a sweep never re-sends, a non-terminal "queued for the chat" state, hourly checkpoints so housekeeping never drops a live row, and a bound on how many live rows can pile up.
- **Who sends.** Originally "the lease holder", relying on a role guard that turns out to be dark on ordinary agents. Now the email hook itself refuses to enqueue on a standby and forwards the report to the holder over the authenticated mesh with its own idempotency id; the holder re-checks the lease before every send.
- **Budgets.** Originally a hard local count claimed never to exceed the provider cap. Now an honest reservation (best-effort across a machine handoff), one time zone for the whole agent, and the provider's own refusal as the real cap.
- **Retention.** Originally "keep every record forever", which the code treats as a defect for content-bearing stores. Now three 16 MB archives, live rows checkpointed hourly, a 24-hour tombstone, and a plain statement that the outbox is a transit copy, never the only copy.
- **Honest limits.** Stated on the page: a part of the agent that holds the sending credential could read the opt-in code (through Resend's status call or a spare mailbox's Sent folder); the PIN page stops mistakes, not a hostile agent, until owner authentication ships.
- **Account security.** The agent never changes the person's account security (two-step sign-in) without their explicit yes, and only with a factor the person holds.

## Iteration Summary

Reviewers: the Standards-Conformance Gate every round; Codex (gpt-6-astra) every round; three internal subagents (security + adversarial; scalability + integration/multi-machine; decision-point classification + decision-completeness + verify-the-state + lessons-aware) in rounds 1 and 5 to 7, fewer in rounds 2 to 4. The internal reviewers' verbatim texts for rounds 1 to 4 were not retained after a context compaction; their folds are recorded in the spec's decision rows and in "Original vs Converged".

| Round | Gate flags | Codex design / precision | Internal lenses: design findings | Spec version written | Main changes |
|---|---|---|---|---|---|
| 1 | 5 | ran (clean-door degraded) | about 25 across three lenses | v2 | Delivery vs send result; owner-only by construction; outbox; budgets; multi-machine posture |
| 2 | 9 | 4 / 0 | several | v3 | Durable fallback text; sending identity bound; proof keyed by credential version; two fallback deadlines |
| 3 | 8 | 5 / 0 | several | v4 | Ownership-gated sends; drain on stop; recipient hash; opt-in code |
| 4 | 9 | 4 / 0 | several | v5 | Three account shapes; Resend idempotency key; reservation budget; per-shape proof |
| 5 | 15 | 3 / 0 | 2 + 2 + 2 | v6 | Shape A needs the code; budget honesty + one time zone; full transition table; rotateKeep 3; mesh forward named as new work; shape A recipient change refused |
| 6 | 4 | 3 / 1 | 3 + 0 + 0 (two lenses converged) | v7 | Shape B typed recipient; role guard named dev-gated + enqueue refusal; shape A code limit; checkpoint rule; row before completion; relay idempotency; unknown transition; retry backoff |
| 7 | 7 | 2 / 1 | 1 + 2 + 0 (one lens converged) | v8 | Execution marker; cadence checkpoint with paced, checked emits; relay-queued state, terminal on acknowledgment; standby forwards scheduled reports; 24-hour breaker; 16 MB archives |
| verification read | n/a | n/a | one subagent re-read v8 against the code | v8 | see "Verification of the round-7 folds" |

## Proportion

Tier 2 (money, identity, credentials, a published interface). ⚠ 7 rounds against the Tier-2 cap of 6, on a spec that grew from about 9 KB to about 58 KB. Round 5's premise shift (one proof shape to three account shapes) reopened design in rounds 5 to 7; each of those rounds found real design defects, not wording, so the extra round bought correctness rather than polish. Build time should split the spec: the recipe and transports first, the mesh forward and journal kind as their own changes.

## Verification of the round-7 folds

One subagent re-read version 8 against the code after the round-7 folds. Result: all five design fixes present, consistent and feasible (the execution marker sits on the single completion write; the journal's emit outcome exposes rate-limited and deduped results so the paced, checked checkpoint is buildable; the relay store's enqueue is insert-or-ignore on the delivery id; the mesh command table takes a new type as described). Four gaps, all stale wording from version 7, fixed in place: three "4 MB" / "before rotation" remnants, one "terminal on relay acceptance" in Testing, and the Telegram reconnect event, which does not exist yet and is now named as an addition this change makes (an emit when the adapter's consecutive poll errors fall back to zero). No design-class defect remained after those edits. This was a verification read, not a review round: no new lenses, no new findings sought.

## Left behind

See  in the spec (nine items, each with its reason). Precision items from the last rounds not iterated on:

- Gate: the fixed proof, size, rate and window limits are classified with floors in the decision table; the gate still asks for derivations of the exact numbers. Each row states its evidence; where the number is a default inside a floor, the floor is the standard's requirement.
- Gate: the credential-exposure guard's authority. The spec adds no authority and no matcher; it routes one more surface through the guard that already holds Wall 1 over Telegram sends. If that grant is wrong, it is wrong for Telegram first.
- Gate: per-machine grants. Inherited from the parent spec's converged and approved design; not this spec's decision.
- Integration (round 7): the journal's bucket is per kind with shared parameters; the spec's wording "shared bucket" is loose but the bound is right.

## Full Findings Catalog

The gate and Codex findings below are copied from the saved round outputs. Internal reviewer texts for rounds 5 to 7 are summarised in the Iteration Summary and folded as described; rounds 1 to 4 were not retained verbatim.

### Round 1
- Standards-Conformance Gate: ran (5 flags)
  - Verify the State, Not Its Symbol: SMTP verification treats the server's final 250 response as confirmed delivery, although it proves acceptance by that server rather than arrival in the owner's inbox.
  - Judgment Within Floors: The one-test-per-hour and 20-sends-per-hour limits lack evidence supporting those exact boundaries and reject legitimate immediate retesting after credential repair or an authorized burst of reports, which contextual jud
  - An Instar Agent Is Always a Multi-Machine Entity: The design makes portable email credentials and the owner address machine-local with optional synchronization, but its physical-credential-locality label identifies no actual hardware or keychain constraint justifying th
  - Migration Parity: The spec adds agent-installed CLAUDE.md and CapabilityIndex entries without a migration path that delivers those capabilities to existing agents.
  - Maturation Path — Test Agent → Development Agent → Fleet: The rollout uses a recipe proving list followed by catalog availability after live proof, bypassing the required role-based test-agent, development-agent and fleet ladder with reviewed graduation decisions.

### Round 2
- Standards-Conformance Gate: ran (9 flags)
  - Judgment Within Floors: The one-proof-per-day prohibition does not follow from a 100-send provider limit and rejects a legitimate second proof after credential replacement, which contextual judgment could authorize within the remaining provider
  - Judgment Within Floors: The enforced 80/20 allocation and minimum half reserved for reports lack evidence for those boundaries and reject legitimate one-off sends when report capacity is unused, while an intelligent allocator could preserve act
  - Judgment Within Floors: Enumerating three fallback causes does not justify suppressing each cause's explanation for an entire day, since a later independently requested report may need its own explanation, which contextual judgment could permit
  - Judgment Within Floors: Stopping all sends after three refusals treats unrelated refusals as evidence of a credential failure and can reject a legitimate clean report after three credential-exposure refusals, whereas contextual recovery could d
  - Signal vs. Authority: The deterministic credential-exposure matcher directly refuses outbound messages without a full-context intelligent gate, granting blocking authority outside the enumerated emergency-stop exception.
  - The Person Decides; the Agent Does the Rest: Recommending an agent-owned mailbox over the person's own mailbox ranks against one account-ownership choice despite the standard requiring the agent to explain concessions without recommending against either.
  - Attributed Statements Trace to Their Source: The spec labels the provider default an operator decision using the agent's announcement and subsequent silence as evidence, rather than a logged statement containing the operator's own decision.
  - Ownership-Gated Side Effects: A standby refuses a one-off send and tells the session to ask again on the holder instead of forwarding, queuing, or deliberately claiming ownership as required.
  - Canonical Pipeline Operational Completeness — Accepted Intake Must Drain: Rollback explicitly ignores pending delivery rows, abandoning accepted work without a consumer, terminal disposition, or governed waiting state.
- Cross-model (codex-cli:gpt-6-astra, ok): verdict SERIOUS ISSUES
  - DESIGN: The spec promises resumed fallback, but delivery rows contain only `textHash`, with no report body or durable reference. One-off requests also supply no fallback destination. Writing a row “before a report is considered handled” does not establish persistence 
  - DESIGN: Recipient identity is carefully specified, but sending identity is not. The credential schema lists `transport`, credential and preset, while explicitly excluding an address; the agent-owned mailbox’s login identity can differ from the bound recipient. Neither
  - DESIGN: Proof runs after credential changes, but a second call within a day returns “the last result.” Nothing binds that result to the credential or owner-address version. A previous pass could therefore mark replacement credentials working without testing them; an a
  - DESIGN: Unknown delivery triggers fallback after a 30-minute status window, while fallback notification has a maximum latency of 120 seconds from the first failed report. These requirements conflict when a report remains unresolved. **Resolution:** define separate dea

### Round 3
- Standards-Conformance Gate: ran (8 flags)
  - Judgment Within Floors: One proof per credential version permanently prevents retrying a transiently failed proof with unchanged valid credentials; credential identity justifies binding evidence, not this attempt limit, and bounded retries info
  - Judgment Within Floors: Enumerating three authentication error codes does not justify stopping after three refusals per day, which can reject a legitimate subsequent send after a transient outage; the threshold needs substantive safety evidence
  - Judgment Within Floors: The 80/20 allocation and 20:00 headroom restriction can reject an urgent authorized one-off despite available provider capacity, while configuration alone supplies no contextual judgment to allocate capacity within the g
  - Judgment Within Floors: The 16 KB text ceiling lacks a demonstrated transport or resource basis and excludes legitimate longer reports that judgment could admit within an evidenced size floor.
  - Judgment Within Floors: The fixed 15-second transport timeout and maximum 30-minute delivery window lack evidence for those exact boundaries, potentially abandoning a legitimate slower send or forcing an avoidable duplicate where contextual jud
  - Judgment Within Floors: The hourly fallback-explanation ceiling can suppress notice of a materially different failure sharing the same cause label, without establishing why contextual judgment within a structural notification budget cannot hand
  - Know Your Principal — An Unverified Identity Is a Guess: Shape C treats inbox access as proof of the owner's identity even though the spec explicitly allows a hostile session to submit the recipient, so that session could confirm an inbox it controls and defeat the owner-only 
  - An Instar Agent Is Always a Multi-Machine Entity: The design makes grants per machine and credential replication optional without a concrete machine-bound necessity, so another installed machine can lose the ability to provide the configured email capability when the or
- Cross-model (codex-cli:gpt-6-astra, ok): verdict SERIOUS ISSUES
  - DESIGN: The spec says a hostile session can enter an address but cannot read that inbox. That is false when the session supplies an inbox it controls. The code proves control of the submitted inbox, not that it belongs to the owner. Bind the recipient through an indep
  - DESIGN: SMTP permanently yields `accepted-unproven`, while fallback covers `failed`/`unknown`/`refused`. No terminal outbox transition is defined for ordinary successful SMTP sends. This also conflicts with rollout’s requirement that every report be delivered or falle
  - DESIGN: Counting only `sent`/`delivered`/`fallen-back` rows omits the explicitly described crash case: the provider may accept a message while its row remains `pending`. A subsequent send can therefore pass an understated budget. Delivery failures can also remove cons
  - DESIGN: Only the lease holder may send, but grants are per machine and credential replication is unresolved. A standby’s valid setup therefore does not establish that the holder can drain its reports. Define a bounded fallback when the holder lacks authorization or cr
  - DESIGN: Compaction deletes rows older than seven days regardless of status. An outage or delayed replication can therefore erase accepted, unfinished reports, contradicting “nothing is dropped.” Restrict age-based deletion to terminal rows, and require recorded fallba

### Round 4
- Standards-Conformance Gate: ran (9 flags)
  - Judgment Within Floors: The six-digit code space does not establish why five attempts or a 30-minute expiry is necessary: a legitimate owner making another correction or returning later is rejected, whereas judgment within an evidenced guessing
  - Judgment Within Floors: Irreversible proof-mail delivery establishes a need for abuse protection but not exactly three messages daily, three retries ten minutes apart, or a permanent prohibition on repeating a successful proof; legitimate setup
  - Judgment Within Floors: Reserving capacity for every remaining scheduled report blocks a legitimate urgent one-off in favor of lower-priority scheduled mail, although intelligent prioritization could preserve the provider cap without treating t
  - Judgment Within Floors: The fixed 120-second refusal fallback, 60-minute maximum status window, and hourly ceiling on repeated fallback explanations lack evidence establishing those exact boundaries, rejecting legitimate preferences for longer 
  - Judgment Within Floors: The 5–60-second transport range and concurrency-one queue are justified by unsupported universal claims about handshake duration and starvation, excluding legitimate fast-failing connections, slower successful connection
  - Judgment Within Floors: The browser profile's hard 20-minute lifetime can terminate legitimate setup involving delayed authentication, without evidence deriving that duration from an external constraint or irreversible consequence rather than a
  - Never Silently Cut the Data a Decision Depends On: The 16 KB report truncation is justified by a 24 KB journal limit introduced by this same design rather than a derivation from actual producer and consumer capacities, so disclosure and delivery of the full report elsewh
  - An Instar Agent Is Always a Multi-Machine Entity: The design makes grants and recipient configuration machine-local and requires setup again after lease movement without identifying a hardware-bound constraint or operator-ratified exception that prevents unified authori
  - The Person Decides; the Agent Does the Rest: The categorical refusal to enable two-step verification makes an account-management operation the person's work even when they could authorize the agent to perform it through a complete approval request.
- Cross-model (codex-cli:gpt-6-astra, ok): verdict SERIOUS ISSUES
  - DESIGN: **“A durable outbox, drained”; parent “Multi-machine posture.”** The email spec promises one attempt per row and that accepted intake drains. The parent explicitly states that replication has no handoff fence. The described design therefore permits a holder to

### Round 5
- Standards-Conformance Gate: ran (15 flags)
  - Framework-Agnostic — and Framework-Optimizing: Claude Code jobs receive their report text by email while Codex, Gemini and Grok jobs receive only a status line, making core reporting functionality depend on the execution engine.
  - Signal vs. Authority: The deterministic credential-exposure matcher independently refuses outbound messages, granting a brittle detector blocking authority outside the constitution's sole enumerated emergency-stop exception.
  - An Instar Agent Is Always a Multi-Machine Entity: Grants and credentials deliberately remain machine-local and require setup again after failover, without identifying a hardware constraint or operator-ratified exception that prevents their unification.
  - Verify the State, Not Its Symbol: Although shapes A and C require owner-entered proof codes, the prove hook marks shape A working on delivery alone, substituting provider delivery evidence for the required confirmation by the owner.
  - Ownership-Gated Side Effects: Ownership is checked when a job runs or a request reaches the holder, but queued transport attempts have no specified fire-time ownership check, allowing an earlier authorization to survive a lease handoff.
  - Judgment Within Floors: The five-entry proof limit and 30-minute nonce expiry lack an evidenced acceptable guessing risk or exposure window: the arithmetic explains five guesses but not why five is necessary, while a legitimate sixth correction
  - Judgment Within Floors: The three-proof-mails-per-day and twenty-total limits identify irreversible mail delivery but do not justify those exact boundaries, rejecting legitimate recovery after repeated delivery failures where judgment could aut
  - Judgment Within Floors: Returning a cached passing proof forever for an unchanged credential version prevents a legitimate fresh delivery test after mailbox routing changes, although judgment could authorize revalidation within the provider and
  - Judgment Within Floors: The absolute 60-minute browser-profile lifetime has no evidenced session or security constraint establishing that boundary and would terminate legitimate delayed authentication, where judgment could extend the session wi
  - Judgment Within Floors: The hard 60-minute delivery-status ceiling and 5–60-second transport-timeout range lack external constraints supporting their exact values, excluding legitimate longer provider delays or faster failure requirements that 
  - Judgment Within Floors: Concurrency one and twenty outbox records per second are unexplained behavioral ceilings that reject legitimate independent sends or bursts, where judgment could choose throughput within a resource ceiling derived from m
  - Judgment Within Floors: The 24 KB record, 16 KB report, 8 KB fallback-text and 200-character subject ceilings are not derived from the stated 80 KB journal constraint or transport capacities, rejecting legitimate larger reports and subjects tha
  - Judgment Within Floors: Reserving capacity for every remaining scheduled email without allowing judgment rejects a legitimate urgent one-off even when a later report could use Telegram, although an arbiter could prioritize both within the provi
  - Judgment Within Floors: The hard one-fallback-line-per-cause-and-reason-per-hour ceiling has no evidence establishing that exact boundary and could suppress a distinct consequential failure, where contextual judgment could distinguish necessary
  - Attributed Statements Trace to Their Source: The spec credits inclusion of the email capability to an operator decision dated 2026-11-03 without providing the required pointer to the logged message and the operator's own words.
- Cross-model (codex-cli:gpt-6-astra, ok): verdict SERIOUS ISSUES
  - DESIGN: “Owner-only, by construction” requires both A and C to remain `unproven` until the owner enters the emailed code. But “The setup recipe → Two checks” includes the code only for C and makes A `working` on provider-reported `delivered`. The spec itself distingui
  - DESIGN: “Budgets” promises reservations never exceed the provider cap using a replicated aggregate keyed by the holder’s local date. The parent’s “Multi-machine posture” explicitly permits handoff before replication completes. Consequently, a successor can reserve aga
  - DESIGN: “A durable outbox, drained” defines recovery for `pending` rows, but also introduces nonterminal `sent` rows without stating how polling resumes after restart. “Accepted intake must drain” marks rows fallen back before stopping, without defining what happens w

### Round 6
- Standards-Conformance Gate: ran (4 flags)
  - Signal vs. Authority: The credential-exposure matcher receives blocking authority through a claimed constitutional exception, but the supplied constitution grants that exception only to the enumerated exact-match emergency-stop floor.
  - Judgment Within Floors: The exact five-attempt, three-daily/twenty-total proof, 24-hour code, 60-minute browser, 20-records/second, 24-KB record, 16-KB text, 8-KB excerpt and 200-character subject boundaries lack evidence establishing those par
  - An Instar Agent Is Always a Multi-Machine Entity: Grants remain machine-specific and a lease transfer can require setup again despite replicated credentials, without identifying a hardware-bound constraint or operator-ratified exception that prevents unified authorizati
  - No Unbounded Loops — Every Repeating Behavior Carries Its Own Brakes: When Telegram or its relay queue remains unavailable, falling-back rows retry every minute indefinitely, explicitly prescribing a repeating failure path without increasing backoff or a breaker.
- Cross-model (codex-cli:gpt-6-astra, ok): verdict SERIOUS ISSUES
  - DESIGN: The spec deletes older journal files with `rotateKeep: 3`, while allowing `falling-back` rows to remain pending indefinitely. Tolerating a tombstone whose original put disappeared does not establish that unresolved rows survive rotation. No durable snapshot or
  - DESIGN: The spec places report extraction and sending after completion bookkeeping through a serial queue; it does not require durable delivery intent before that bookkeeping completes. A crash in this interval could leave a completed job with neither email nor fallba
  - DESIGN: The table marks a row `fallen-back` after durable relay acceptance and records `relayId`. It does not specify deduplication if the process crashes between those operations. Recovery can enqueue the same fallback again; repeated crashes can repeat this beyond t
  - PRECISION: The transport explicitly returns `unknown`, and timeouts produce it, but the supposedly complete table has no transition for a live `pending` attempt returning `unknown`. Later prose says to fall back. **Resolution:** add that transition and its deadline expli

### Round 7
- Standards-Conformance Gate: ran (7 flags)
  - Judgment Within Floors: The five-attempt, three-per-day, twenty-total and 24-hour proof limits lack evidence establishing those exact boundaries: legitimate owners can exhaust them through mistakes or delayed setup, and contextual judgment with
  - Judgment Within Floors: The fixed payload, subject, journal-growth, emission-rate, polling-rate, status-window and browser-lifetime ceilings lack derivations establishing their exact boundaries, reject legitimate larger reports, bursts or slowe
  - Signal vs. Authority: The deterministic credential-exposure matcher independently refuses outbound messages, although inherited 'Wall 1 authority' is not the standard's sole enumerated exception for exact-match emergency stops.
  - Archiving May Never Mean Deleting: The design deletes content-bearing journal archives and terminal report text without ensuring that their memory-bearing content survives in a memory-governed store, while incorrectly treating indefinite preservation of a
  - An Instar Agent Is Always a Multi-Machine Entity: Setup grants remain machine-specific and a replacement holder loses email capability until separately provisioned, despite synchronized vault values and no concrete hardware, credential-location or operator-ratified just
  - No Unbounded Loops — Every Repeating Behavior Carries Its Own Brakes: Fallback retries explicitly omit a breaker and continue every fifteen minutes indefinitely, although the requirement to drain accepted intake does not exempt retries from the mandatory breaker.
  - Capacity Safety — No Unbounded Self-Action: During a sustained relay outage the fallback worker keeps retrying indefinitely, so its cumulative self-triggered action count never settles to the required small bound.
- Cross-model (codex-cli:gpt-6-astra, ok): verdict SERIOUS ISSUES
  - DESIGN: In “A durable outbox, drained,” terminal rows receive tombstones after 24 hours and disappear from the folded store. The hourly reconciliation sweep creates a fallback for any completed emailed execution without an outbox row. These rules together make a succe
  - DESIGN: The same section says live rows are re-emitted *before* rotation, then claims they are present in the current file *after* rotation. That ordering does not establish the claimed invariant. More fundamentally, an extended relay outage can accumulate an unrestri
  - PRECISION: “Who sends” explicitly refuses standby enqueue, but “Testing → Integration” requires “a standby-run job appends and the holder sends.” Forwarding is specified for one-offs, not scheduled jobs. **Resolution:** change the test to assert standby refusal and ident


## Convergence verdict

Stopped at round 7, one past the Tier-2 cap of six. Round 7 found four design defects (a sweep that could re-deliver a tombstoned report, a checkpoint rule the journal could not honour, a terminal state reached before the chat copy was really delivered, a standby-fired report with no path); all four were fixed in version 8 and confirmed by a verification read against the code, which found only stale wording. No design finding is left behind unfixed; no finding went to the operator as a safety exit. The tag is written with the round count and this report, so the operator approves knowing the cap was exceeded by one round and that the last round's fixes were verified by a read rather than a further round.
