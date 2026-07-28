# Round-3 convergence findings — slack-outbound-robustness

**Spec reviewed:** `docs/specs/slack-outbound-robustness.md` @ commit `14c724bad`
(round-3 revision; eli16 revised in the same commit).
**Report commit:** this file.
**Round-3 status: NOT CONVERGED.** 2 CRITICAL + 2 MAJOR + 5 MINOR + 3 LOW.

Round 3 ran the same protocol as round 2: every round-2 fold's walk re-executed
against the round-3 text and the deployed v1.3.728 source, then fresh lenses on
the NEW material (the HOLD-as-durable-disposition architecture). The headline:
**all twelve round-2 folds LANDED and HELD their walks** — the purge, stampede,
teamId, validator, ambiguous-mapping, and provenance walks all close cleanly.
What blocks is one genuinely NEW catch in the Layer-1 script contract (the
delivery-id is minted too late to protect the initial send — a latent deployed
Telegram gap that the new held-lane architecture AMPLIFIES into an open
double-post walk) and one under-specification in the new architecture itself
(the partition's re-hold rule has no per-reason RELEASE predicate, so its
natural reading self-deadlocks every verdict-hold — found independently by the
internal panel and the GPT-tier external).

---

## Fold verification (round-2 findings, walks re-executed)

| Round-2 finding | Fold | Walk re-executed | Verdict |
|---|---|---|---|
| R2-C1 (stampede consumes held rows) | §2.2a disposition partition BEFORE `groupByTopic` | 6+ fresh rows, dark lane, first tick → partition holds all pre-grouping → zero stampede consumption, zero digest; dry lane same; live lane keeps Telegram-parity stampede | **HELD** (the partition's own release rule is the new R3-C2 — see below) |
| R2-C2 (boot purge vs hold-lapse) | purge scope = LIVE-enabled channels AND `hold_reason IS NULL` | dry row + overnight downtime → exempt on BOTH axes (dry lane not live-enabled; hold_reason set); verdict-hold row in a live lane → exempt by disposition; fresh live-lane row >60min → purged loud (deployed Telegram parity, deliberate) | **HELD** |
| R2-M1 (no ambiguous terminal) | pinned additive typed results; ambiguous → `finalize-ambiguous`; residual named; table TOTAL w/ canary default | ambiguous funnel outcome → terminal, never re-posted; 422 → tone-gated; unmapped → transient + attention | **HELD** (gemini found a THIRD unnamed residual on property 1 — R3-M2) |
| R2-M2 (teamId waved through) | tail + teamId-compatibility compare | `slack:T1:C123` vs resolve→`slack:T2:C123` → refuses; `_`↔concrete benign | **HELD** |
| R2-M3 (delivery-failed validator) | validator relaxation pinned + both-direction tests | negative minted id + channel enum accepted; `topic_id:0` refused | **HELD** |
| R2-m1 (false TTL bound) | `heldRetentionMs` 7d loud long-stop | held rows exit loudly, never silently | **HELD as intent** — the mechanism is unimplementable as pinned (no hold-start anchor, no stated enforcement point) → R3-M1 |
| R2-m2 (ref provenance) | pinned to the script's OWN argument | forged context pair → ref records the real target → drain refuses | **HELD** |
| R2-m3 (route modification) | explicit handler-change sentence | — | **HELD** |
| R2-m4 (budget row) | HOLD `funnel-budget`, never terminal | — | **HELD** (its RELEASE is part of R3-C2) |
| R2-L1..L3 | opts=3; full paths; eli16 phrasing | — | **HELD** |

**eli16 check:** consistent with the round-3 spec (hold marker story, week-long
loud surfacing, ambiguous parity, honest crash-window fine print).

**Code grounding:** the new round-3 claims were re-grounded; the round's
CRITICAL-1 came directly out of grounding the §2.6 script contract against the
deployed `telegram-reply.sh` (the ported tail's id-minting point).

---

## Reviewers who ran this round

**Internal pass** (six lenses + fold re-walks + line-level grounding):
contributed R3-C2 (the verdict-hold release-predicate gap — found before and
independently of the externals), the `hold_started_at` anchor gap (merged into
R3-M1), and R3-L1..L3.

**External cross-model passes (one bounded pass each, neutral grounding pack,
no internal conclusions shared):**
- **pi / openai-codex provider, `--model openai-codex/gpt-5.5`,
  `--no-session --no-tools -p`, spec inlined** — RAN (exit 0). Verdict:
  `3 CRITICAL + 2 MAJOR + 1 MINOR + 0 LOW`. Its #1 (delivery-id minted too
  late) is the round's best catch — adopted as R3-C1 after verifying the
  premise against the deployed script (`telegram-reply.sh:437` mints inside
  the recoverable branch; the initial POST carries no `X-Instar-DeliveryId`).
  Its #2 confirms R3-C2 (independent overlap with the internal pass). Its #3
  (24h-TTL-at-flip "defeats the architecture") is DOWNGRADED to R3-m1: the
  spec states that behavior explicitly and it is a defensible deliberate
  choice (delivering days-stale conversational messages is worse than a loud
  escalation) — what is missing is the stated rationale, not a different
  design. Its #4 merges into R3-M1; its #5 is downgraded to R3-m2 (an
  ordering ambiguity between two loud terminals — no loss either way); its
  #6 is adopted as R3-m3.
- **gemini-cli, `-o json -m gemini-2.5-pro` (serving model confirmed from the
  stats block), prompt on stdin** — RAN (exit 0). Verdict:
  `0 CRITICAL + 2 MAJOR + 2 MINOR + 0 LOW`. Its #1 merges into R3-M1 (the
  long-stop enforcement point); its #2 is adopted as R3-M2 (the third unnamed
  property-1 residual — the M5 "property table must describe reality"
  precedent); its #3 (NULL `conversation_ref`) and #4 (unreachable bypasses
  the escalation machinery) are adopted as R3-m4/R3-m5.
- **codex-cli** — NOT RUN: not installed on this machine (consistent with all
  prior rounds).

Strongest overlap: R3-C2 (internal + pi, independent) and R3-M1 (internal +
pi + gemini, three-way).

---

## CRITICAL findings (blocking)

1. **The script mints its `delivery_id` at ENQUEUE time, so the INITIAL send
   is never covered by the id-ledger — and the held-lane architecture
   amplifies that into an open double-post walk with no net** `[pi-ext #1;
   premise verified against deployed code]`. §2.6: "On a RECOVERABLE outcome
   … generate a `delivery_id` (UUIDv4), enqueue" — the id is born AFTER the
   first POST failed, so the first POST carries no `X-Instar-DeliveryId`
   (deployed parity: `telegram-reply.sh:437` mints inside the recoverable
   branch; the initial curl at `:346-358` sends no id header). Walk: the
   initial `/slack/reply` POST is ACCEPTED server-side (message posts) but
   the response is lost to the script (curl `000` — recoverable class) → the
   script enqueues under a FRESH id → the row is HELD (fleet-dark or dry — the
   DEFAULT postures) → the lane flips live within the 24h TTL → the redrive
   POSTs with an id the durable ledger has NEVER seen, the 15-min content
   dedup long lapsed → **the user gets the same message twice, days apart.**
   Every net misses by construction: the id-ledger (round-2 M4) only protects
   ids the route has SEEN, and the round-3 hold architecture is exactly what
   keeps such rows alive long past the dedup window. (The same latent shape
   exists on the LIVE lane whenever early redrives fail past 15 min, and on
   Telegram TODAY — historically masked by the old channel-blind purge eating
   >60-min rows, i.e. the round-1 C2 bug was accidentally suppressing this
   one.) **Fix:** the script mints the `delivery_id` BEFORE the first POST
   and sends it as `X-Instar-DeliveryId` on the INITIAL send; on a
   recoverable failure it enqueues the SAME id — so if the initial send
   actually landed, the route recorded that id durably and the redrive is
   answered `idempotent:true`. Pin it for `slack-reply.sh` AND port the same
   change to `telegram-reply.sh` in the same template refresh (additive
   header, strictly safer, closes the deployed latent gap; Migration Parity —
   both scripts already refresh via the same machinery). §7 gains the walk as
   a test (initial-send-landed + lost response + held + flip → exactly one
   post).

2. **The §2.2a partition re-holds "rows whose prior verdict left a live hold"
   with NO per-reason release predicate — the natural reading self-deadlocks
   every verdict-hold, including a LIVE-lane budget hold** `[internal + pi-ext
   #2, independent]`. As committed, held rows "NEVER enter `groupByTopic`" and
   the partition re-holds anything with a live `hold_reason` — but the only
   way a `non-owning`/`unresolvable`/`no-adapter` row can discover its
   condition healed is to be re-evaluated, and the only pinned release is the
   dry-lane config flip (§5). Three stated guarantees break: "heals when
   ownership arrives" (§2.3 ×2, §3 fail-direction row) is mechanically
   impossible; and a `funnel-budget` hold — taken in a LIVE lane on a
   transient P17 window — permanently parks a deliverable user message until
   the 7-day `held-retention-exceeded` terminal escalation (loss-with-notice
   of a message that should have delivered 10 minutes later). **Fix (pin the
   release taxonomy in §2.2a):** holds split into CONFIG-holds
   (`disabled-channel`, `dry-run` — released when the partition's config
   check says the lane is live: already pinned for dry, extend to disabled)
   and VERDICT-holds (`non-owning`, `unresolvable`, `binding-incoherent`,
   `no-adapter`, `funnel-budget` — RE-EVALUATED at partition time, when the
   hold's `next_attempt_at` lapses, by their CHEAP LOCAL predicate: the
   keystone §5.0 `ownsConversation(id)` is a local adapter + local-origin
   registry read; the §2.1 coherence compare is local; adapter presence is
   local; the budget window is local). Condition cleared → CLEAR
   `hold_reason` → the row enters the NORMAL flow this tick (grouping
   included — it is now genuinely deliverable, so live-lane stampede
   semantics legitimately apply); condition persists → re-hold. The long-stop
   check (R3-M1) runs BEFORE re-holding. §7 pins the heal shape (a non-owning
   hold delivers within one recheck cadence of ownership arriving; a budget
   hold delivers after the window) and the deadlock regression (no
   verdict-hold row can be re-held indefinitely while its predicate is
   clear).

## MAJOR findings (blocking)

1. **`heldRetentionMs` is unimplementable as pinned: no column carries "held
   since", and the enforcement point is unstated** `[pi-ext #4 + gemini-ext
   #1 + internal — three-way]`. "A row held CONTINUOUSLY for
   `heldRetentionMs`" has no measurable anchor: `attempted_at` mismeasures a
   row that spent 20h live-retrying before being held; `next_attempt_at` is
   the pushed liveness knob; `hold_reason` carries no timestamp. And no
   section says WHERE the long-stop check runs. **Fix:** a fourth additive
   column `hold_started_at TEXT` — set when `hold_reason` transitions
   NULL→non-NULL, PRESERVED across reason relabels (a row bouncing
   `non-owning`→`funnel-budget` is still continuously held), cleared only on
   release-to-deliverable; the long-stop check runs in the §2.2a partition
   BEFORE any re-hold (`now - hold_started_at ≥ heldRetentionMs` →
   `escalated: held-retention-exceeded` + the out-of-band item). Schema/§5/§7
   updated accordingly.
2. **§0 property 1 omits the THIRD designed residual: the id-ledger's
   fail-open degradation re-enables the round-2 M4 double-post while
   degraded** `[gemini-ext #2]`. §2.4 (correctly) degrades a ledger
   open-failure to in-memory-only rather than blocking delivery — but during
   that degradation the ack-lost + restart + ≥15-min-backoff walk is live
   again, and the operator-visible property table doesn't say so. The M5
   precedent governs: the property table must describe reality, including
   designed degradations. **Fix:** name residual (c) on property 1 (ledger
   degraded → restart-window double-post exposure returns until the ledger
   heals; the degradation is already loudly reported).

## MINOR findings (batch)

1. **Held-past-TTL rows escalate at flip instead of delivering — deliberate,
   but currently unstated as a decision** `[pi-ext #3, downgraded]`. pi rated
   this CRITICAL ("defeats the architecture"); the panel disagrees: §5
   states the behavior explicitly, and delivering a days-stale conversational
   message at a lane flip is worse than one loud "this never delivered"
   escalation — the same judgment the deployed 60-min restore-purge encodes.
   What is missing is the RATIONALE sentence (so round N+1 doesn't re-litigate
   it) and the note that a flip-burst of such escalations is bounded (P17
   budgets + the out-of-band aggregation).
2. **Unknown-channel vs disabled-channel ordering is contradictory** `[pi-ext
   #5, downgraded]`. A corrupt `channel:'slakc'` matches BOTH §2.3-6
   (`escalated: unsupported-channel`, immediate) and §5 (a) (not in
   `channels` → held to the 7-day long-stop). Both are loud terminals so
   nothing is lost either way, but pin the order: the partition validates
   against the KNOWN channel enum FIRST (unknown → immediate
   `unsupported-channel` terminal, P19), enabled-membership second.
3. **HOLD mutations need bounded P18 audit rows** `[pi-ext #6]`. §4.2 ledgers
   "every row state transition", but hold set / release / long-stop are field
   mutations on a `queued` row. Pin: one ledger row on hold SET (with
   reason), one on RELEASE, one on long-stop escalation — NOT on every 15-min
   re-push (that would flood the ledger for a week-held row).
4. **NULL `conversation_ref` on a Slack row is undefined at the coherence
   check** `[gemini-ext #3]`. No legacy Slack rows can exist (the column
   ships with the lane and the script always writes it), so NULL on a
   `channel:'slack'` row is anomalous by construction. Pin: fail CLOSED —
   the typed `conversation-binding-incoherent` HOLD + attention item
   (keystone corruption posture; Telegram rows exempt — the check is
   Slack-scoped).
5. **Pin that `conversation-unreachable` bypasses the escalation MACHINERY
   entirely** `[gemini-ext #4]`. The mapping row terminalizes with an
   out-of-band notice, but the deployed `escalate()` (2-attempt in-topic post
   + `recordEscalationFailure`) must not be the code path that does it — an
   implementer reusing `escalate()` with a swapped target would arm the
   per-channel breaker on attention-surface hiccups. One sentence: the
   unreachable terminalization writes the transition + raises the attention
   item directly; `recordEscalationFailure` is never invoked on this path.

## LOW findings (batch)

1. **"Zero transitions" imprecision** `[internal]`: the §2.2a/§7
   burst-in-held-posture assertion says "zero transitions, zero posts" — the
   re-hold itself is a `transition()` bookkeeping write. Say "zero TERMINAL
   (`delivered-*`/`escalated`) transitions, zero posts".
2. **Rollback honesty** `[internal]`: §2.2's "a ROLLED-BACK binary ignores the
   three unknown columns and keeps working" is true for Telegram rows; a
   rolled-back sentinel would redrive queued SLACK rows via
   `/telegram/reply/<negative id>` → 400 (the keystone's pinned guard) →
   `escalate` terminal per the deployed policy (400 → escalate). Loud, never
   a misdelivery — add the sentence so the rollback story covers Slack rows.
3. **Lane-flip stampede semantics unstated** `[internal]`: when a flip
   releases a >5-rows-per-conversation backlog, the rows are genuinely
   deliverable and land in deployed stampede semantics (digest +
   all-but-newest dropped as `delivered-ambiguous`) — deliberate Telegram
   parity for a stale backlog, but name it in §5 so the flip behavior is a
   stated decision, not a surprise.

---

## Convergence recommendation

**NOT CONVERGED.** 2 CRITICAL + 2 MAJOR block.

The round-2 folds all held — the HOLD-disposition architecture survives its
own walks (purge, stampede, teamId, validator). The two CRITICALs are
different in kind from round 2's: R3-C1 is a genuinely new Layer-1 contract
catch (the id-ledger can only protect ids the route has SEEN — minting at
enqueue leaves the first send permanently outside the guarantee, and the hold
architecture is precisely what keeps those rows alive long enough to
double-post; the fix also closes the same latent gap on deployed Telegram),
and R3-C2 is the new architecture's own missing half (a durable hold needs a
durable RELEASE rule — set-and-hold was pinned, re-evaluate-and-release was
not). Both fixes are small and structural. R3-M1 completes the disposition
schema (`hold_started_at`); R3-M2 is property-table honesty per the M5
precedent.

**Verdict: NOT CONVERGED** (2 CRITICAL + 2 MAJOR + 5 MINOR + 3 LOW).
