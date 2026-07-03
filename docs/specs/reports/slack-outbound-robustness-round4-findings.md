# Round-4 convergence findings — slack-outbound-robustness

**Spec reviewed:** `docs/specs/slack-outbound-robustness.md` @ commit `f8c951bda`
(round-4 revision; eli16 revised in the same commit).
**Report commit:** this file.
**Round-4 status: NOT CONVERGED.** 0 CRITICAL + 1 MAJOR + 4 MINOR + 3 LOW.

Round 4 re-executed every round-3 fold walk plus the R2 spot-regressions, then
put highest scrutiny on the round-4 additions themselves. **All round-3 folds
LANDED and HELD**, and — for the first time in the ceremony — the round
produced ZERO CRITICALs. The one blocking MAJOR is a fold-introduced seam
(the third such in the ceremony's pattern): the round-3 m5 escalate()-bypass
for `conversation-unreachable` removed even the deployed 2-attempt notice
retry without pinning any notice durability, so a transient attention-surface
hiccup permanently loses the operator notice on a terminal row. Narrowly
scoped; the fix is a bounded-retry + durable re-raise rule.

---

## Fold verification (round-3 findings, walks re-executed)

| Round-3 finding | Fold | Walk re-executed | Verdict |
|---|---|---|---|
| R3-C1 (id minted too late) | pre-POST mint + header on the initial send; SAME id enqueued; telegram parity in one refresh; mint-failure degrades headerless | lane-flip double-post end-to-end: initial POST carries the id → server accepts + records the id DURABLY (§2.4 record-after-success) → response lost (000) → script enqueues the SAME id → row held (dark lane) → flip within TTL → redrive answered `idempotent:true` → exactly once. Ledger window vs row TTL: attempts exhaust at ~7.9h cumulative; only released-held rows approach 24h, and escalate-at-release covers >24h — the boundary race is sub-minute-scale (R4-L2 pins it away) | **HELD** |
| R3-C2 (no release predicate) | pinned partition order: enum → long-stop → per-reason release → hold | all seven `hold_reason`s traced: `disabled-channel`/`dry-run` release on config; `non-owning` releases when `ownsConversation(id)` (local read) turns true → delivers within one cadence; `unresolvable` on registry heal; `no-adapter` on adapter-up; `funnel-budget` after its window (the LIVE-lane deadlock is gone); `binding-incoherent` never clears (corruption-proven) → bounded by the 7-day loud long-stop, correct. Day-7-heal ordering (long-stop before release-eval) is harmless: any long-stop row is past the 24h TTL and would escalate on release anyway | **HELD** |
| R3-M1 (`hold_started_at`) | fourth additive column + partition enforcement point | implementable; preserved across relabels; purge needs only `hold_reason` | **HELD** (atomicity + NULL-anchor repair remain to pin — R4-m2) |
| R3-M2 (third residual) | property 1 (c) named | — | **HELD** (count word says "TWO" — R4-L3) |
| R3-m1..m5, L1..L3 | all folded | enum-first ordering consistent with §2.3-6 (same terminal, one mechanism); NULL-ref fail-closed pinned; `escalate()` bypass pinned (`:571-580` citation verified); bounded hold audit; rollback honesty; flip-stampede decision | **HELD** (the m5 bypass itself opens R4-M1) |

**R2 spot-regressions:** stampede partition (held rows never reach
`groupByTopic`) — HELD; boot-purge exemptions (live-enabled + `hold_reason IS
NULL`) — HELD; teamId concrete-vs-concrete compare — HELD; delivery-failed
validator relaxation — HELD.

**Code grounding:** `telegram-reply.sh:436-442` (id minted inside the
recoverable branch; initial POST headerless — R3-C1's premise re-verified);
`delivery-failure-sentinel.ts:571-580` (the 2-attempt escalation loop the m5
bypass steps around — load-bearing for R4-M1); backoff cumulative arithmetic
recomputed from `recovery-policy.ts:60-70`.

**eli16 check:** consistent (id-from-first-attempt story, release-rule story,
week-long loud surfacing).

---

## Reviewers who ran this round

**Internal pass** (six lenses + fold re-walks + grounding): contributed the
ledger-TTL boundary pin (R4-L2), the residual-count nit (R4-L3), and
independently flagged the NULL-`hold_started_at` shape (merged into R4-m2).

**External cross-model passes (one bounded pass each, neutral grounding pack,
scrutiny directed at the round-4 additions):**
- **pi / openai-codex provider, `--model openai-codex/gpt-5.5`,
  `--no-session --no-tools -p`, spec inlined** — RAN (exit 0). Verdict:
  `3 CRITICAL + 1 MAJOR + 0 MINOR + 0 LOW`. Its #3 (unreachable-notice
  durability) is the round's real catch — adopted as R4-M1 (consolidated
  MAJOR: the message itself was already undeliverable; the P18 ledger + §4.1
  status still record it; the loss is the NOTICE, and deployed Telegram's own
  escalation notice is best-effort-2-tries — the regression is dropping even
  that without a replacement). Its #1 (boot purge vs never-classified rows)
  is DOWNGRADED to R4-m1: the walk is real but is byte-for-byte the deployed
  Telegram staleness judgment (`restorePurgeAgeMs` = 60 min, documented
  deliberate, loud) that every prior round accepted as baseline — the actual
  defect is that §2.3's "cannot outrun" sentence OVERCLAIMS for unclassified
  rows. Its #4 (NULL `hold_started_at` invariant) is adopted as R4-m2
  (downgraded: with an atomic-set pin + a repair rule the shape self-heals;
  it requires a corruption path to arise). Its #2 (offline tuple validation
  ignores teamId) is **REJECTED on keystone grounds**: the CONVERGED
  keystone's identity TUPLE is `(slack, channelId, threadTs?)` — teamId
  deliberately lives only in the canonical KEY under the single-workspace
  `workspacePin` posture (keystone §3.1); a cross-workspace channelId
  collision is out of the converged identity model's scope, and the R2-M2
  concrete-vs-concrete refusal already covers the corruption variant.
  Re-litigating the tuple definition is re-litigating the approved keystone,
  not this spec.
- **gemini-cli, `-o json -m gemini-2.5-pro` (serving model confirmed from the
  stats block), prompt on stdin** — RAN (exit 0). Verdict:
  `0 CRITICAL + 0 MAJOR + 2 MINOR + 1 LOW`. All three adopted as-is:
  R4-m3 (explicit NULL-ref §7 test), R4-m4 (§7 asserts `hold_started_at`
  cleared on release), R4-L1 (pin ISO-8601 UTC for `hold_started_at`).
- **codex-cli** — NOT RUN: not installed on this machine (consistent with all
  prior rounds).

---

## MAJOR findings (blocking)

1. **The `conversation-unreachable` out-of-band notice has NO durability — a
   transient attention-surface failure permanently loses the operator notice
   on a terminal row (a round-3 m5 fold-introduced seam)** `[pi-ext #3]`.
   The m5 bypass (correctly) keeps `recordEscalationFailure` and the
   2-attempt in-conversation `escalate()` machinery out of this path — but it
   replaced them with a single unguarded attention raise. Walk: channel
   archived → funnel returns `conversation-unreachable` → row transitions
   terminal `escalated` → the attention enqueue hiccups transiently → no
   retry, no re-raise, notice gone; the operator learns of the undeliverable
   message only from the P18 ledger / the §4.1 status surface. §0 property 3
   ("the operator hears about it ONCE") degrades on a single hiccup — and
   deployed Telegram at least tries twice (`delivery-failure-sentinel.ts:
   571-580`). **Fix:** (a) the terminalization writes the durable ledger row
   FIRST (already the case) and stamps the row `notice_pending`; (b) the
   attention raise gets deployed-parity bounded retry (2 attempts) in-line;
   (c) a terminal unreachable row still carrying `notice_pending` is
   re-raised IDEMPOTENTLY by a later partition tick (dedup key = the
   conversation, riding the keystone's 60s coalescing window) until the raise
   is accepted, then the marker clears — one transient hiccup can delay the
   notice, never delete it. §7 pins the transient-attention-failure shape
   (raise fails once → the notice lands on a later tick → exactly ONE item).

## MINOR findings (batch)

1. **§2.3's "a durable disposition the boot purge cannot outrun" OVERCLAIMS
   for never-classified rows** `[pi-ext #1, downgraded]`. A live-lane Slack
   backlog enqueued while the server is down >60 min is purged LOUDLY at boot
   before its first classification — byte-for-byte the deployed Telegram
   staleness judgment (`restorePurgeAgeMs` 60 min: "prevents redelivering
   genuinely ancient messages after a long outage"), deliberate and accepted
   as this spec's baseline in every prior round. But the multi-machine
   stand-down sentence implies protection an unclassified row does not have
   (pi's ownership-moved-while-down variant would have HELD had it been
   classified first). Fix: scope the sentence ("once CLASSIFIED, the boot
   purge cannot outrun the hold") + state the never-classified staleness
   purge as the deployed deliberate decision with its rationale (mirroring
   the §5 held-past-TTL decision bullet), naming the rare
   ownership-moved-while-down residual honestly.
2. **`hold_reason`/`hold_started_at` need an atomicity pin + a NULL-anchor
   repair rule** `[pi-ext #4 + internal]`. Both fields are set in the SAME
   `transition()` write (single transaction — pin it); defensively, a held
   row observed with `hold_started_at NULL` (corruption, partial migration)
   gets the anchor set AT OBSERVATION + one ledger row — so no corrupt-held
   row can sit purge-exempt outside the long-stop forever.
3. **§7 lacks the explicit NULL-`conversation_ref` test** `[gemini-ext #1]`:
   a `channel:'slack'` row with NULL ref → `binding-incoherent` HOLD
   (Telegram rows exempt), asserted as its own unit case.
4. **§7 lacks the release-clears-anchor assertion** `[gemini-ext #2]`: a row
   released from any hold has `hold_reason` AND `hold_started_at` NULL
   (a later re-hold starts a fresh retention clock).

## LOW findings (batch)

1. **Pin the `hold_started_at` format** `[gemini-ext #3]`: ISO-8601 UTC
   (`YYYY-MM-DDTHH:mm:ss.sssZ`) — the store's existing timestamp convention;
   the long-stop arithmetic depends on it.
2. **Ledger-TTL boundary** `[internal]`: the durable id-ledger TTL (24h)
   equals the row TTL (24h), both anchored at the initial send — a redrive in
   the final minutes before the row TTL could race a just-pruned ledger
   entry. Pin the ledger TTL to 25h (row TTL + slack) and the race is gone by
   construction.
3. **Residual count word** `[internal]`: §0 property 1 says "TWO
   honestly-named residuals" and lists three — (a)(b)(c).

---

## Convergence recommendation

**NOT CONVERGED.** 1 MAJOR blocks (0 CRITICAL — the ceremony's first
zero-CRITICAL round).

Trajectory: 3C+6M → 2C+3M → 2C+2M → **0C+1M**. The funnel-hop and
HOLD-disposition cores have now survived THREE adversarial re-walk rounds
unchanged; round 4's own additions (pre-POST mint, partition order,
`hold_started_at`) survived first-contact review with only pinning-level
findings. The single blocker is narrowly scoped — notice durability on one
terminal path — and its fix is mechanical (bounded retry + an idempotent
`notice_pending` re-raise). The externals' disagreement pattern is itself
informative: gemini returned zero blocking findings; pi's three CRITICALs
reduced under grounding to one MAJOR + one deployed-parity scoping MINOR +
one keystone-settled rejection.

**Verdict: NOT CONVERGED** (0 CRITICAL + 1 MAJOR + 4 MINOR + 3 LOW).
