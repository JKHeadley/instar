# Round-2 convergence findings — slack-outbound-robustness

**Spec reviewed:** `docs/specs/slack-outbound-robustness.md` @ commit `185c39e4b`
(round-2 revision; eli16 revised in the same commit).
**Report commit:** this file.
**Round-2 status: NOT CONVERGED.** 2 CRITICAL + 3 MAJOR + 4 MINOR + 3 LOW.

Round 2 ran as a FOLD-VERIFICATION round first: every round-1 fold was checked by
re-executing its failure walk against the round-2 text and the deployed v1.3.728
source (not by trusting the fold's prose), then fresh lenses hunted new seams in
the revision. The headline: **all fifteen round-1 folds LANDED as designed and
HELD their original walks** — but two of the folds (C2's channel-scoped purge and
C3's HOLD-shaped dryRun) protect their rows through mechanisms that two OTHER
pieces of retained deployed machinery bypass: the shared stampede path consumes
held rows before any per-row dispatch runs, and the boot restore-purge's
timestamp-arithmetic exemption evaporates across a long downtime. The 2026-06-05
silent-deletion lesson recurs a THIRD level up — this time inside the folds that
were built to close it. (This is the machine-coherence round-3 pattern: the
folds' walks pass; the folds' compositions don't.)

---

## Fold verification (round-1 findings, walks re-executed)

| Round-1 finding | Fold | Walk re-executed | Verdict |
|---|---|---|---|
| C1 (topic_id=0 lane: misdelivery + black hole) | tuple-validated enqueue; lane DELETED | never-minted target → resolve-by-key yields nothing (read route mints NOTHING, keystone §8 verified) → loud exit-1, NO row, no black hole; forged/stale context pair → drain-time `conversation_ref` tail coherence refuses (given R2-m2's provenance pin) | **HELD** (see R2-M2/R2-m2 for two seams in the coherence check itself) |
| C2 (channel-blind restore-purge eats dark-lane rows) | purge + drain CHANNEL-SCOPED; held/purge-exempt/surfaced | boot with sentinel on + `channels:['telegram']` + a queued Slack row aged >60min → purge is scoped to enabled channels → row SURVIVES; §7 dark-rollout e2e pins it | **HELD as scoped** — but the protected class is re-opened by two other paths (R2-C1, R2-C2) |
| C3 (success-shaped dryRun = message loss) | HOLD-shaped dryRun | dry tick over a queued slack row → would-redrive ledger row, NO `delivered-*`, no attempt, no post, `next_attempt_at` held | **HELD per-row** — violated by the shared stampede path (R2-C1) and the boot purge (R2-C2) |
| M1 (funnel bypass) | redrive + notices ride `deliverToConversation`; pinned typed-result table | ownership stand-down / incoherent / unresolvable → HOLD, no attempt burn, no breaker arm — verified against keystone §5.0/§3.5.2/§5.1 (CONVERGED r11 text read directly) | **HELD** — the mapping table is not TOTAL over the funnel's result vocabulary (R2-M1, R2-m4) |
| M2 (archived-channel escalation into the archived channel; shared breaker) | §5.1 permanent classification; out-of-band escalation; PER-CHANNEL breaker | archived channel → `is_archived` via `SlackApiError.slackError` → `conversation-unreachable` terminal, NO 24h burn, notice → attention queue (never the dead channel), no escalation-failure recorded, no breaker arm; Slack storm suspends slack lane only | **HELD** |
| M3 (stale E1 description) | restated to converged two-lane §5.0(a) | §2.1's restatement checked clause-by-clause against the converged keystone text (retirement lane / 15-min content-hash lane / send-intent journaling / lane-scoped boot conversion / funnel mints no delivery-id) | **HELD** — accurate |
| M4 (restart double-post; OQ-4 falsified) | DURABLE delivery-id ledger on both routes | ack-lost redrive → row stays claimed → restart → next redrive at ≥15-min backoff (content-dedup lapsed) → durable ledger answers `idempotent:true` → exactly one post | **HELD** — one residual crash-window shape remains unnamed (folded into R2-M1) |
| M5 (tone-gate fail-direction misstated) | layered reality stated | verified against deployed `src/messaging/local-tone-check.ts` (gate error → `passed:true, failedOpen:true`) + `MessagingToneGate.ts:608-621` `failClosedMode` tri-state (default `'always'`) | **HELD** — matches deployed code exactly |
| M6 (slack-forward gate-only) | typed 409 misdirected-route refusal | grounded: route echoes inbound-shaped text outbound ungated (`routes.ts:12233-12251`); sole caller `SlackLifeline.forwardToServer` (`SlackLifeline.ts:183`); SlackLifeline never instantiated (grep: zero constructors outside its own file) | **HELD** |
| MINOR 1-7 / LOW 1-3 | all folded | keystone metadata now CONVERGED r11 `aa5086eb8` `approved:true` (verified in the conversation-identity worktree git log + frontmatter); read-route mints-nothing ✓; pre-mint dedup SKIP ✓; metadata-forwarded-whole ✓ (and `telegram-reply.sh` genuinely captures it — `METADATA_JSON` :287-312 → `Q_METADATA` :487 → INSERT :572); Guards-Degrade re-anchor exists in the registry (STANDARDS-REGISTRY.md:490) ✓; near-silent decision stated ✓; template-bypass pins ✓; 5s script dedup ✓; fairness bound stated ✓ | **HELD** (two path nits remain — R2-L2) |

**eli16 check:** consistent with the revised spec on every load-bearing claim
(channel column, tuple validation + loud refusal, funnel routing, per-channel
breaker, durable id memory, hold-shaped dry-run, channel-scoped boot cleanup,
typed slack-forward refusal). One phrasing nit (R2-L3).

**Code grounding:** every new/changed file:line citation in the round-2 text was
verified against the worktree source (v1.3.728) and the CONVERGED keystone spec
(`.worktrees/conversation-identity`, `aa5086eb8`). All verified accurate except
the two bare-name path nits in R2-L2. The grounding sweep itself produced R2-M3
(the delivery-failed validator) — a deployed constraint the spec cites around
but never addresses.

---

## Reviewers who ran this round

**Internal pass** (one consolidated multi-lens review — security, scalability,
adversarial, integration/multi-machine, decision-completeness, lessons-aware —
with line-level re-verification of every citation and re-execution of every
round-1 fold walk): contributed the stampede-consumes-held-rows walk (R2-C1, the
round's most severe catch), the boot-purge-vs-HOLD-arithmetic walk (R2-C2,
independently), the delivery-failed negative-id grounding (R2-M3,
independently), the disabled-lane retention falsification (R2-m1), the
`conversation_ref` provenance pin (R2-m2), the budget-overflow mapping gap
(R2-m4), and the opts-count nit (R2-L1).

**External cross-model passes (one bounded pass each), both EXECUTED against the
committed round-2 spec + a NEUTRAL verified code-grounding pack (deployed facts
only — no internal conclusions were shared, so overlaps below are independent):**
- **pi / openai-codex provider, `--model openai-codex/gpt-5.5`,
  `--no-session --no-tools -p`, spec inlined** — RAN (exit 0). Verdict line:
  `VERDICT: 3 CRITICAL + 1 MAJOR + 0 MINOR + 0 LOW`. Its boot-purge-vs-holds
  CRITICAL confirms R2-C2 (independent overlap with the internal pass); its
  teamId-coherence CRITICAL is the round's best external catch (consolidated
  R2-M2); its ambiguous-mapping CRITICAL is consolidated R2-M1 (MAJOR — see
  severity note there); its delivery-failed MAJOR confirms R2-M3.
- **gemini-cli, `-o json -m gemini-2.5-pro` (serving model confirmed from the
  run's stats block), prompt on stdin** — RAN (exit 0). Verdict line:
  `VERDICT: 1 CRITICAL + 1 MAJOR + 1 MINOR + 1 LOW`. Its negative-topic_id
  CRITICAL confirms R2-M3 (three-way overlap: both externals + internal); its
  stampede MAJOR lands adjacent to R2-C1 (right seam, wrong knife — see R2-C1);
  its `/slack/reply` resolution-pin MINOR is adopted as R2-m3; its
  metadata-null LOW is REJECTED on grounding (`telegram-reply.sh` does capture
  `message_metadata`; §2.6 ports that tail — verified :287-312/:487/:572).
- **codex-cli** — NOT RUN: not installed on this machine (consistent with all
  prior rounds of both ceremonies).

Strongest overlap this round: R2-M3 was found independently by BOTH externals
AND the internal grounding sweep; R2-C2 by pi + internal independently.

---

## CRITICAL findings (blocking)

1. **The retained shared stampede path consumes HELD-disposition rows and posts
   digests in withheld postures — the C2/C3 guarantees are bypassed one layer
   above the folds** `[internal; gemini-ext #2 adjacent]`. §2.3 keeps "stampede
   grouping" in the "Unchanged and shared" list, and the deployed pipeline order
   is: `tick()` → `selectClaimable` → `groupByTopic` → **`handleStampede` runs
   BEFORE any per-row channel dispatch** — and `handleStampede` posts a digest
   and transitions ALL BUT THE NEWEST row to terminal `delivered-ambiguous`
   (`delivery-failure-sentinel.ts:329-348, 648-668`). Walk 1 (fleet-dark, the
   C2 posture): sentinel enabled + `channels:['telegram']`; a Slack outage
   enqueues 6+ rows on one conversation (Layers 1-2 ship unconditionally, §5);
   the FIRST tick sees them all (fresh rows have `next_attempt_at NULL` — the
   per-row skip-and-HOLD has not run yet) → stampede consumes 5 rows as
   `delivered-ambiguous` (terminal; never delivered, never drained when the
   lane later enables) + attempts a digest send. C2's "a lane that was never
   allowed to drain can never have its rows purged" is defeated by a different
   consumption path. Walk 2 (dry soak, the C3 posture): same burst with
   `slackDryRun:true` → 5 rows consumed AND the digest send is a REAL post
   attempt through the live funnel — violating C3's "rows survive the whole
   soak intact" and "posts NOTHING". The spec also self-contradicts: §2.3
   point 4 routes the stampede digest through the funnel while the "Unchanged
   and shared" line keeps stampede semantics unchanged, and §2.2/§5 disagree on
   WHERE the disabled-channel skip lives ("the SENTINEL dispatches per-row"
   §2.2 vs "(a) NOT claimable by the drain" §5) — the placement is load-bearing
   for exactly this walk. **Fix for round 3:** pin that rows in a
   NOT-DELIVERABLE disposition (disabled channel, dry lane, and §2.3 HOLD
   verdicts) are excluded from stampede grouping/accounting BEFORE
   `groupByTopic` (the skip-and-hold runs pre-grouping); stampede
   consumption/digests apply only to rows the drain may actually deliver;
   digest delivery is per-channel via the funnel for Slack rows (already
   §2.3-4); §7 gains the burst-in-held-posture test (6+ held rows on one
   conversation → zero transitions, zero posts).

2. **The boot restore-purge deletes HOLD-shaped rows in ENABLED channels across
   a downtime — the hold-exemption is timestamp arithmetic, and it expires
   exactly when the design needs it** `[pi-ext #3 + internal, independent]`.
   The C2 fold scopes the purge to enabled channels; the C3/M1 folds protect
   dry rows and stand-down HOLD rows (non-owning / unresolvable / incoherent)
   by "pushing `next_attempt_at` forward, riding the purge's existing
   hold-exemption". But the deployed purge runs ONE-SHOT at `start()` **before
   the first drain tick** (`delivery-failure-sentinel.ts:229-236` vs `:267-271`)
   and exempts a row ONLY while `next_attempt_at` is ahead of the 60-min cutoff
   (`pending-relay-store.ts:489-495, 531-541`). Walk: dev agent in the MANDATED
   dry soak (`channels:['telegram','slack']`, `slackDryRun:true` — slack IS
   purge-enabled); a dry-held Slack row's last hold-push lands at t; the
   machine sleeps overnight (> hold distance + 60min); on boot the purge runs
   before any dry tick can re-push → the row is 60+ min old with a lapsed
   `next_attempt_at` → DELETED (loud-per-row, but systematic — every held row
   crossing a long restart dies). Identical walk for a stand-down HOLD row on a
   non-owning machine — directly contradicting §2.3's "heals when ownership
   arrives … or ages out LOUDLY at TTL", §3's "rows stay queued (never
   deleted)", and §5's "rows survive the whole soak intact". The hold-push
   distance is also nowhere pinned, so the exemption's real strength is
   unspecifiable. **Fix for round 3:** purge exemption for held rows must key
   on a DURABLE HOLD DISPOSITION (e.g. an additive `hold_reason` column set on
   every §2.3 HOLD / dry hold / disabled-channel hold, cleared on release),
   not on `next_attempt_at` arithmetic; the purge predicate skips rows with a
   live hold_reason in ADDITION to the channel scope; pin the hold-push
   cadence; §7 gains the boot-after-long-downtime test (held row aged 3× the
   purge cutoff with a lapsed hold survives the boot purge and drains/holds on
   the next tick).

## MAJOR findings (blocking)

1. **The funnel lane has no AMBIGUOUS terminal — §0 property 1's
   "delivered-ambiguous, NEVER blindly re-posted" is not implementable from the
   pinned mapping table, and one derivable double-post residual is unnamed**
   `[pi-ext #1 (rated CRITICAL there) + internal]`. The converged funnel folds
   an ambiguous transport outcome (posted-but-ack-lost) into a transient
   `not-delivered` return (recording an E1 likely-posted entry); a route-level
   408 through the funnel hop surfaces the same way. §2.3's table maps
   transient `not-delivered` → retry — so for Slack rows an ambiguous outcome
   is RETRIED, not finalized `delivered-ambiguous` (the Telegram lane's
   deployed posture and §0 property 1's literal text). The retry is safe in the
   dominant shape ONLY because the redrive re-sends the SAME `row.delivery_id`
   and the M4 durable ledger answers `idempotent:true` — and there remain
   derivable double-post shapes where the ledger record never landed: Slack
   accepts the post but the route 408s/crashes BEFORE recording the id → row
   still claimed → next redrive at a ≥15-min backoff step (E1's content-hash
   window and the content-dedup window both lapsed) → posts again. (This is
   the keystone's own accepted-residual class — R8-M1's "at most ONE duplicate
   per crash-during-send" — but the spec neither names the residual nor keeps
   property 1's absolute wording honest.) Severity consolidated to MAJOR (pi
   rated CRITICAL): the durable id-ledger + E1 close the dominant walk; what is
   missing is typed surfacing + honesty, not the net itself — the same class
   and severity as round-1 M4. **Fix:** pin (as ADDITIVE funnel typed-result
   requirements, exactly how §2.3 pins the additive opts) that the funnel
   surfaces (a) an ambiguous/likely-posted outcome distinctly → mapped to
   `finalize-ambiguous` (Telegram parity; property 1 restored), and (b) the
   route's tone-gate 422 distinctly (the current table row "route 422 surfaced
   typed" consumes a result the keystone never defined — without it a
   tone-gated Slack row is indistinguishable from transient and would burn the
   24h TTL before escalating); and name the crash-window residual on property 1
   ("AT MOST once per id at the server" holds except the named
   crash-between-accept-and-record window, where content dedup is the
   second net and the residual is one duplicate, bounded, visible).

2. **The drain-time coherence compare excludes `teamId` — a concrete-teamId
   mismatch (a provably-corrupt pair) passes the tail check and delivers
   cross-workspace** `[pi-ext #2]`. §2.1 pins the comparator as the
   `(channelId[,threadTs])` TAIL and declares key-prefix differences benign
   ("a `_`→teamId upgrade rewrote the prefix"). The benign case is real, but
   the rule as written also waves through `slack:T1:C123` (ref) vs an id
   resolving to `slack:T2:C123` — same channelId under a DIFFERENT concrete
   teamId. No legal registry transition produces that pair (the only teamId
   rewrite is the `_`→concrete upgrade), so per the keystone's own R6-M4 logic
   — a legitimately-bound pair can never BECOME incoherent, therefore
   incoherence affirmatively proves corruption and the converged posture is
   REFUSAL — this exact shape must refuse, not deliver. **Fix:** the compare is
   tail-match AND teamId-compatibility: `_` on either side ⇄ concrete is
   benign; concrete-vs-concrete mismatch is the typed
   `conversation-binding-incoherent` HOLD. One sentence + one §7 case.

3. **The deployed `/events/delivery-failed` validator rejects every Slack
   event-kick — negative `topic_id` is 400'd and `channel` is an unexpected
   field — and the spec never declares the route change** `[pi-ext #4 +
   gemini-ext #1 + internal — the round's strongest three-way overlap]`.
   Verified deployed: `allowedFields = {delivery_id, topic_id, text_hash,
   http_code, error_body, attempted_port, attempts}` with 400 on any other
   field, and `topic_id` must be a NON-NEGATIVE integer (`routes.ts:496-504,
   583-585`). Every Slack row's minted id is negative, so the §2.6 best-effort
   POST 400s on BOTH counts: the "<1s reaction" property silently degrades to
   the 5-min watchdog for the entire Slack lane, and the §7 integration test
   ("enqueue slack row via `POST /events/delivery-failed` (channel:'slack')")
   is unimplementable against the deployed handler. No message is lost (the
   SQLite enqueue is the durable record; the event only accelerates) — hence
   MAJOR, not CRITICAL (gemini rated CRITICAL). **Fix:** pin the validator
   change explicitly in §2.6: `topic_id` accepts keystone minted ids (negative
   integers), `channel` joins `allowedFields` (optional, enum-validated,
   default `'telegram'`), with a Tier-2 test for both directions (valid slack
   event kicks the tick; garbage channel / positive-id-with-slack-channel still
   400s).

## MINOR findings (batch)

1. **Disabled-lane retention is unbounded and §5's stated bound is false**
   `[internal]`. "the 24h TTL bounds it" — the TTL is evaluated by
   `evaluatePolicy` at DRAIN time, and a disabled channel's rows are never
   drained, so nothing ever TTLs them: on the fleet posture (sentinel on,
   telegram-only) held Slack rows accumulate for as long as the lane stays
   dark (purge-exempt BY DESIGN per the C2 fold). Decide and state a LOUD
   long-stop retention for held/disabled rows (e.g. the 7-day far-future-clamp
   scale, escalated as P18 rows — never a silent delete), and correct the
   claim.
2. **`conversation_ref` provenance is unpinned — the drain-time coherence check
   is only as good as the ref's source** `[internal]`. §2.6 sets
   `conversation_ref = the canonical key` without pinning WHOSE key: if an
   implementer builds it from the session-context pair rather than from the
   script's OWN `CHANNEL_ID[:THREAD_TS]` argument, a forged/stale context pair
   validates against itself at drain and the C1 fold's backstop evaporates.
   Pin: the ref is constructed from the script's own target argument, never
   from context.
3. **The §2.5 minted-id resolution inside `/slack/reply` is an implied route
   modification, never pinned** `[gemini-ext #3]`. The deployed route has no
   registry access and no topicId concept; §2.5 requires it to resolve
   `(channelId, thread_ts)` → minted id for content dedup + the gate signal.
   State the handler change explicitly (registry read at route-time; pre-mint
   → skip dedup + omit topicId, already decided) so the route work is scoped.
4. **The typed-result mapping table is not total: the funnel's §5.2
   budget-overflow/coalesced outcome has no row** `[internal]`. A redrive that
   lands on the per-conversation or global P17 ceiling gets a
   budget-typed/coalesced result — unmapped. In practice drain throughput
   (maxConcurrent 4, 30s per-topic cap) sits far below the ceilings, but the
   table claims to replace raw-HTTP classification wholesale; an unmapped
   result is an undefined branch. Pin the disposition: HOLD without attempt
   burn (a budget refusal is a by-design refusal, not a delivery failure —
   stand-down parity), never a terminal.

## LOW findings (batch)

1. **"Two ADDITIVE funnel opts" — the §2.3 call passes three** `[internal]`:
   `deliveryId`, `systemTemplate`, AND `metadata` (the row blob forwarded
   whole). The keystone pins `allowDuplicate`/`messageKind` as individual
   opts, not a blob. Count and pin all three additive opts (or map the row
   metadata onto the existing pinned opts) so the funnel-side change is scoped
   honestly.
2. **Path nits** `[internal]`: `SlackAdapter.ts:565-579` →
   `src/messaging/slack/SlackAdapter.ts` (lines verified correct);
   `local-tone-check.ts` → `src/messaging/local-tone-check.ts` (it does NOT
   live under `delivery-failure-sentinel/`).
3. **eli16 phrasing** `[internal]`: "spots permanently-dead channels … so we
   don't retry them for 24 hours" reads as a 24-hour retry pause; the design
   never retries them at all (it avoids BURNING the 24h TTL). One clause.

---

## Convergence recommendation

**NOT CONVERGED.** 2 CRITICAL + 3 MAJOR block.

The fold-verification arm confirms the round-1 resolution was architecturally
right — every fold landed and held its own walk, and the funnel-as-delivery-hop
move survives adversarial re-walking cleanly (ownership, coherence,
permanent-error, out-of-band escalation, per-channel breaker all check out
against the CONVERGED keystone text). What blocks is the round-2 pattern the
ceremony was warned about: folds compose with RETAINED machinery the folds
didn't touch. Both CRITICALs are the 2026-06-05 deletion lesson recurring
INSIDE the round-1 fixes — the stampede path and the boot purge each consume
rows that the new held/dry/disabled dispositions promise to protect, because
the protections key on timing accidents (selector visibility, `next_attempt_at`
arithmetic) instead of on a durable disposition marker. The single architectural
move for round 3 mirrors round 2's: make HOLD a first-class durable disposition
(visible to the purge predicate, the stampede grouper, and the selector), not
an emergent property of a pushed timestamp. R2-M3 is the round's best
grounding catch (three independent finders): the spec's fast-path claim dies on
a deployed validator two lines long.

**Verdict: NOT CONVERGED** (2 CRITICAL + 3 MAJOR + 4 MINOR + 3 LOW).
