# Convergence Report — A send held for a lapsed lease renewal is retried within seconds, named, logged and counted

## Cross-model review: codex-cli:gpt-6.2-astra

A real GPT-tier external pass ran through the agent's codex CLI on every round (rounds 1 to 3, `status: ok` each
time). The Anthropic clean-door reader (`claude-code:claude-fable-5`) also returned a review in every round; it is
disclosed separately (`clean-door-anthropic-review`) and never counted as a cross-model pass. Gemini was not authed
on this machine (`gemini-not-authed`), so the GPT family was the only external family. The spec's reviewable body
changed between every round (hashes `…` round 1 → `4dbb1557…` round 2 → `faf92b40…` round 3), so no external pass
was delta-skipped.

## ELI10 Overview

Echo runs on several computers and only the one holding the lead may talk to Telegram. The lead keeps that right by
renewing a 60-second pass every 30 seconds. If the lead's own server freezes long enough to miss a renewal, it stops
trusting its own pass and refuses its own sends, even though no other computer took the lead. On 2026-11-21 eight
sends were refused with a name that means "sending too fast", nothing was logged, and the replies went out minutes
later.

This change does three small things on the computer that refused itself. It names the refusal by what was actually
seen (the lease code itself says whether its renewal fence answered, or the lead was lost some other way), and logs
one line per refusal with the measured gap. It retries within seconds once the lead is held again, through the
existing recovery pass, with a small bounded timer that never sends anything itself. And it counts each held reply
in the never-silent record, closed when the reply goes out. The fence that stops a computer without the lead from
sending is untouched: every retry re-runs the same checks.

The trade-off: a two-second blip no longer produces a "reply delayed" warning in the conversation (that warning was
itself held by the same blip and landed stale), so a lead that is really lost is reported through the existing
five-minute delivery check and the 30-minute hand-back instead of at once.

## Original vs Converged

- **Naming moved from inferred cause to observed state.** The first draft wrote `lease-freshness-lapsed` for every
  "lease not held" refusal. Review showed that bucket also covers a real loss of the lead (another computer took it,
  or the coordinator suspended itself). Now the lease coordinator reports which of its own checks answered, and
  `lease-freshness-lapsed` is written only when it says its renewal fence did; every other case is
  `lease-not-held-at-send`.
- **The cause is captured in the refusing decision.** The draft explained a refusal with a second read after the
  fact, which a lease flip between the two reads could mislabel. Now `reserveExplained()` evaluates once and the
  thrown refusal carries that evaluation's cause; where a freshness reader exists, permission and reason come from
  the same coordinator snapshot.
- **The retry timer learned to wait and to stop.** The draft disarmed after one call, which a pass already running
  would turn into a no-op (the reply waited for the slow path), and had no budget. Now the timer waits for a running
  pass, keeps stepping while lease-held replies remain, always ends at the fourth step, and is budgeted to four
  wakes per lease lifetime.
- **A replay refused for the lease is paced like a first send.** Review found the review-schedule row written before
  a replay would hold a re-refused reply for its 30 s rung; the local-refusal write now moves that row to 2 s too.
- **The "reply delayed" warning no longer fires on first detection**, and the exhaustion signal was first added as a
  new attention item, then removed again when review showed the existing five-minute scan already raises the same
  item for a persisting hold and a per-reply burst would be noise about one fact.
- **Send holds are a list, not incidents.** The draft opened never-silent incidents with a new silence class and an
  in-memory map to match deliveries. Review showed the incidents array would be adopted by the watcher on a revert
  and truncate the route, and the map could mislabel a delivered reply as undelivered. Now the never-silent file
  carries a separate `sendHolds[]` list, delivery is matched by durable operation id from a receipt-bound callback,
  and what the store never observed is closed as unobserved, never as undelivered.
- **The lease reasons join the sticky lease-held set**, so the existing 30-minute hand-back covers a reply refused
  at the boundary as it covers one refused earlier.
- **The problem statement became a hypothesis.** A delayed renewal of a few seconds does not cross the fence; it
  takes a stall past the headroom or an unconfirmed renewal followed by a late one. The records cannot say which
  cause refused the eight sends; the change is what makes the next one measurable. The headroom itself (one missed
  renewal) was filed to the feedback queue (fb-5422a875-8e4) rather than changed here.

## Iteration Summary

| Iteration | Reviewers who flagged | Design findings | Left behind | Spec changes |
|-----------|-----------------------|-----------------|-------------|--------------|
| 1 | codex (5), clean-door (1), security/adversarial (4), scalability/integration (5), decision-completeness (2), lessons-aware (3), conformance gate (9 signals) | 20 | 24 | observed-state reasons; atomic cause capture; timer waits for a running pass and steps while holds remain; episode brake; live notice excluded; no delivery map; unobserved close; Lifeline topology stated; late wiring; hypothesis wording; retry-after decision filed |
| 2 | codex (3), security/adversarial (2), scalability/integration (1), decision-completeness (1), lessons-aware (2, one later withdrawn), conformance gate (7 signals) | 9 | 21 | coordinator `holdVerdict()` decides the name; refusal survives the egress catch; post-grant causes named under the old reason; rolling budget with 60 s fallback; lease reasons join `#leaseHeldIds`; send holds become `sendHolds[]`; exhaustion item added |
| 3 (cap) | codex (3), security/adversarial (1), scalability/integration (1), decision-completeness (1), conformance gate (5 signals); clean-door and lessons-aware: none | 6 | 16 | final edit, not re-reviewed: review-schedule row moved to 2 s on a replay refusal; fourth step always ends the episode; age check before the lease skip; exhaustion item removed (existing scan and hand-back carry it); one-snapshot wording; budget counts wakes |

Standards-Conformance Gate: ran in every round (9, 7 and 5 flags), advisory, folded into the rounds. Internal
reviewers ran on the authoring session's model (claude-fable-5-1) in every round.

Cross-model per round: round 1 `ok` (SERIOUS ISSUES, 5 findings), round 2 `ok` (SERIOUS ISSUES, 4), round 3 `ok`
(SERIOUS ISSUES, 4: three design, one precision). Clean-door per round: MINOR ISSUES each time (1 design in round 1,
precision only after).

## Proportion

Tier 1 (a narrow fix in the Telegram origin send path, fully undone by a revert); about 250 LOC in src plus six test
files; spec about 330 lines. Three rounds, the Tier-1 cap. ⚠ Three rounds on a Tier-1 change: each round found a
genuine design defect in the retry and reporting mechanics (a lost wake, a mislabeled cause, a stale notice, a
ladder-gated replay), and the design shrank in round 3 (an added item removed) rather than grew. The round-3
design findings were small enough to resolve in the final edit; they are recorded below as resolved without a
further round rather than as accepted risks, so a reader can judge that call.

## Left behind

Resolved in the final edit, not re-reviewed (round 3 at the cap):
- A lease refusal during a replay was gated by the review-schedule row (30 s rung): the local-refusal write now moves
  that row to the same 2 s (security/adversarial, codex).
- The fourth timer step is now always terminal, with residual rows left to the sentinel (codex).
- The §2(b) age check runs before the lease skip, as in the `lease-not-held` branch (codex).
- The per-reply exhaustion attention item was removed: the existing five-minute scan raises the same record-only item
  id for a persisting hold, and a burst of items for one fact fails the Needs-you relevance rule (scalability,
  decision-completeness).
- Wording: one-snapshot lease read; `#live()` order aligned across sections; `#leaseHeldIds` fallback past the cap;
  `load()` defaults `sendHolds` to empty; 30-minute bound named; 5 s realistic first delivery; restart loses the
  bound for young holds; count is distinct replies, the log is per refusal.

Accepted and not changed:
- Why a renewal was late (the stall) and the one-missed-renewal headroom: other post-mortem items and
  fb-5422a875-8e4.
- The Lifeline-owner deployment keeps unexplained refusals (its capacity reads a flag, so the lapse does not arise).
- A renewal confirmed just after a timer step waits for the next step (polling, not push).
- The expired-permit hold site keeps its reason and writes no outcome row; it now logs.
- A crash between the recorded receipt and the `onDelivered` callback leaves a send hold to close as unobserved at
  its deadline; the two stores are not reconciled by a recurring check (conformance gate, cross-store coherence).
- The 200-row cap for closed send holds mirrors the judged-incident cap rather than a measured storage budget
  (conformance gate).
- The Live-User-Channel Proof and Bug-Fix Evidence standards are not met by this PR's unit tests alone; the live proof
  belongs to the post-mortem run lead's verification of N71 once this ships.
- The clean-door reviewer could not verify the §2(b) bound from the non-inlined parent spec; the internal reviewers
  verified it in code (`staleAtSendSite`, `STALE_HELD_RELEASE_MS` = 30 min).

## Full Findings Catalog

### Round 1

- codex, DESIGN: problem statement over-claims the cause (a 5 s delay does not cross the fence) → rewritten as a
  hypothesis with both timelines.
- codex, DESIGN: `explainRefusal()` is a second read; neutral name wanted → `reserveExplained()`, observed-state
  reasons.
- codex, DESIGN: staggered holds and a wake during an active pass lose the retry → timer waits for `#passDone`,
  steps while holds remain.
- codex, DESIGN: restart/eviction closes a delivered reply as undelivered → durable id matching, unobserved close.
- codex, DESIGN: rollback left open incidents under old code → later resolved by `sendHolds[]` (round 2).
- clean-door, DESIGN: prevention (cadence) unexamined → Frontloaded Decision 8, feedback filed.
- clean-door, PRECISION ×3: name mislabels a real loss; atomicity unstated; 47 s arithmetic → all fixed.
- security, DESIGN: timer disarms on a guarded no-op → waits for the pass.
- security, DESIGN: refusal and explanation are two reads → atomic capture.
- security, DESIGN: no floor on timer passes under a flapping lease → budget.
- security, DESIGN: lapse hold still raises the user-visible "reply held" notice → excluded from first detection.
- security, PRECISION ×2: second capacity hold site unnamed; prune is write-triggered → both stated.
- scalability, DESIGN: Lifeline topology inverted → stated; feature applies to the server-owner path.
- scalability, DESIGN: timer disarms on no-op → as above.
- scalability, DESIGN: wiring mechanism unstated → late assignment named.
- scalability, DESIGN: prune write-triggered → `snapshot()` applies the check.
- scalability, DESIGN: shared closed-incident cap → own cap, later own list.
- scalability, PRECISION ×6: read-site detail, skip placement, age bound, cadence wording, other matchers, test
  realism → all folded in.
- decision-completeness, DESIGN: name-as-claim → observed-state reasons.
- decision-completeness, DESIGN: unmeasurable case asserted undelivered → unobserved close.
- decision-completeness, PRECISION ×7: counter not receipt-bound; precedence and sixth cause; two open incidents per
  key; row-2 basis; row-4 arithmetic and arbiter wording; lower bound; Lifeline contradiction → all folded in.
- lessons-aware, DESIGN: first-detection notice violates P22 → excluded.
- lessons-aware, DESIGN: expired-permit cause invisible → log line.
- lessons-aware, DESIGN (foundation): one-missed-renewal headroom → filed fb-5422a875-8e4.
- lessons-aware, PRECISION ×3: causal arithmetic; un-suspend path; awareness text → fixed.
- conformance gate (signals): P20 name-as-claim; dispatch answer; schedule basis; 1000-map; cross-store; counting
  excluded chats; flapping bound; evidence bar; live proof → addressed above or accepted.

### Round 2

- codex, DESIGN: gap > ttl can coexist with supersession → coordinator `holdVerdict()`.
- codex, DESIGN: the scan does not cover queued local refusals → (round 3) exclusion kept, existing scan's
  aged-admitted branch verified to cover the rows; hand-back bound added.
- codex, DESIGN: one episode per lifetime starves a second short lapse → rolling budget.
- codex, PRECISION: ELI16 attribution and "wake does nothing" → fixed.
- security, DESIGN: egress catch drops the refusal; post-grant causes unlisted → preserved; named.
- security, DESIGN: brake needs `ttlMs` → 60 s fallback.
- security, PRECISION ×4 → folded in.
- scalability, DESIGN: send holds inside `incidents[]` → `sendHolds[]`.
- scalability, PRECISION ×5 → folded in.
- decision-completeness, DESIGN: new reasons outside the §2(b) bound → `#leaseHeldIds`.
- decision-completeness, PRECISION ×5 → folded in.
- lessons-aware, DESIGN: the scan is record-only, no conversational backstop; bound not covered → bound covered;
  exhaustion signal designed (later simplified to the existing channels).
- lessons-aware, DESIGN: `onDelivered` anchor never reached by replays → refuted against code
  (`telegramFetch` → `OriginBotEgress` → `executePreparedBot`), withdrawn by the reviewer in round 3.
- lessons-aware, PRECISION ×3 → folded in.
- clean-door, PRECISION ×5 → folded in or accepted (polling vs push).
- conformance gate (signals): verdict vs gap; schedule basis; 200 cap; flapping; scan timing; counting; cross-store.

### Round 3

- codex, DESIGN: hand-back path after the skip unspecified → age check before the skip (final edit).
- codex, DESIGN: two clock samples in `reserveExplained` → one coordinator snapshot (final edit wording; the
  implementation already derives permission from the verdict).
- codex, DESIGN: fourth wake with holds remaining undefined → terminal step (final edit).
- codex, PRECISION: counting label; "likely cause" wording → fixed.
- security, DESIGN: replay refusal gated by the review-schedule row → row moved to 2 s (final edit).
- security, PRECISION ×2: 30-minute bound; `load()` default → fixed.
- scalability, DESIGN: per-reply HIGH item burst at exhaustion → item removed (final edit).
- scalability, PRECISION ×3: verdict read cost; one-snapshot statement; destination for the item → first two
  stated, third moot.
- decision-completeness, DESIGN: 47 s item is a competing-signals point mislabeled invariant → item removed.
- decision-completeness, PRECISION ×2: `#leaseHeldIds` cap fallback; prune deletes map entries → fixed.
- lessons-aware: no design findings; round-2 D2 withdrawn; PRECISION ×2 (5 s realistic first delivery; restart loses
  the bound) → fixed.
- clean-door: no design findings; PRECISION ×4 (precedence consistency; non-inlined parent; due-time race;
  vocabulary) → first and third fixed, second noted, fourth accepted.
- conformance gate (signals): schedule basis; 200 cap; wake budget; idempotent count; cross-store → stated or
  accepted above.

## Experience fit

The operator's stated outcome (N71): held replies go out within seconds once the lead is fresh, the real cause is
named, and nothing is sent from a machine that really lost the lead. The ordinary journey after convergence: a reply
is refused at the boundary, named from the coordinator's own verdict, logged with the gap, counted; the coordinator
re-acquires on its 5 s pull tick; the timer's 5 s step runs the pass; the reply is sent once; the count closes with
the delivery time; no warning reaches the conversation. A lead that is really lost is reported through the existing
five-minute delivery check (dashboard item) and the 30-minute hand-back. The lessons-aware reviewer judged this
meets the outcome with no needless ask and no unsupported coverage; the trust/approval portion does not apply.

## Convergence verdict

Converged at round 3, the Tier-1 cap. The final round's six design findings were each small, none concerned safety,
security or data loss, and all were resolved in the final edit (listed above as resolved without re-review); the two
reviewers with the lenses closest to the fence (lessons-aware, clean-door) found nothing that changes what gets
built. Sixteen items left behind. Spec is ready to approve and build.
