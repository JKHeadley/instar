# Side-Effects Review — TIME_CLAIM outbound advisory (accurate time reporting)

**Version / slug:** `time-claim-advisory`
**Date:** `2026-06-12`
**Author:** `Instar Agent (echo)`
**Second-pass reviewer:** `independent reviewer subagent (verdict appended below)`

## Summary of the change

Adds a `TIME_CLAIM` advisory code to the inform-only outbound preflight: when the
sending topic has an ACTIVE time-boxed (autonomous) session, anchored
elapsed/remaining/percent claims in the candidate text are verified against the
live session clock; a gross contradiction returns an advisory and the relay
script's existing NOT-SENT loop holds the message until the sender fixes the
number or acks. Files: `src/core/time-claim.ts` (new pure detector),
`src/messaging/OutboundAdvisory.ts` (code + guidance + `composeTimeClaimAdvisories`),
`src/server/routes.ts` (preflight route resolves active clocks; reply-kind sends get
the clock check ONLY), `src/templates/scripts/telegram-reply.sh` (preflight gate
widened from automated+llm-session to every non-script sender),
`src/core/devGatedFeatures.ts` (dev-gate registry), `src/core/PostUpdateMigrator.ts`
(prior-shipped template SHA + CLAUDE.md bullet migration), `src/scaffold/templates.ts`
(Agent Awareness). Operator mandate: Justin, 2026-06-12 17:55 PDT, topic 13481.

## Decision-point inventory

- `POST /messaging/preflight` advisory composition — **modify** — adds the TIME_CLAIM
  detector for automated kinds and makes it the ONLY detector for non-automated kinds.
  Inform-only: the route returns advisories; it never blocks a send.
- `telegram-reply.sh` preflight gate — **modify** — widens which senders consult the
  preflight (every non-script sender). The script's existing NOT-SENT/ack loop is
  unchanged; sender keeps final authority.
- `recordPreflight` audit keying — **modify (pass-through shape)** — reply-kind rows
  with no job slug are keyed `interactive-session` instead of empty string.

---

## 1. Over-block

**What legitimate inputs does this reject that it shouldn't?**

The advisory never rejects — worst case is a held message the sender must re-send or
ack. The realistic false-hold shapes, and their mitigations:

- A message quoting a WRONG time to correct it ("my '~7h elapsed' line was wrong"):
  quoted-claim skip (chars `"'""''` + backtick immediately before the claim) — unit-tested.
- Honest rounding ("about 2h" at 1h54m): tolerance is max(15 min, 20%) — unit-tested
  on both sides.
- Talk about OTHER durations ("the regression took 3h", "in 2 hours I'll check"):
  extraction requires an explicit elapsed/remaining/percent anchor; future-tense
  "in X hours" and "Xh in CI" shapes are excluded by the boundary lookahead — unit-tested.
- A topic with NO active timed run: detector is a structural no-op (no clocks → no
  advisory) — conversational sends remain effectively friction-free.

Residual: a sender quoting a wrong time WITHOUT quote marks in a correction message
could be held once; the advisory text tells it the real numbers, and `--ack-advisory`
delivers unchanged. Accepted — this is the exact message class the mandate targets.

## 2. Under-block

**What failure modes does this still miss?**

- Prose-only claims with no anchored number ("we're most of the way through") — out
  of scope for a deterministic detector; accepted.
- Wrong ABSOLUTE times ("started at 4pm", "ends at 16:07 tomorrow") — not parsed in
  v1; the elapsed/remaining/percent family covers the founding incident class.
  Tracked for a follow-up detector revision if dogfooding shows absolute-time
  guesses recur. <!-- tracked: 13481 -->
- Slack/WhatsApp/iMessage relay scripts have no preflight at all today (pre-existing);
  the Telegram template is where autonomous reports go. Same tracking item.
  <!-- tracked: 13481 -->
- Time claims in CONVERSATIONAL sessions on topics with no active run are unchecked
  by design (no clock = no truth to compare against).

## 3. Level-of-abstraction fit

Right layer. The deterministic detector lives beside the other text detectors
(`JargonDetector`, `raw-file-path`, `localhost-link`) in `src/core/`; the clock READ
stays in the route (the module remains pure); the hold-and-fix loop reuses the
existing advisory mechanism rather than inventing a parallel one. The smarter
outbound authority (MessagingToneGate) is not the right owner: this is an objective
numeric contradiction, not a tone/judgment call, and the mandate asks for a
deterministic guarantee.

## 4. Signal vs authority compliance

Compliant (docs/signal-vs-authority.md). The detector is a brittle/cheap
signal-producer feeding the existing inform-only advisory surface. It holds NO
blocking authority: the server route only returns advisories; the script-side loop
gives the sender the fix-or-ack decision; every error path (clock read failure,
detector throw, server down, timeout, malformed JSON) fails OPEN to delivery.

## 5. Interactions

- The localhost-link server guard, tone gate, dedup, and delivery pipeline are
  untouched — the TIME_CLAIM advisory composes alongside the other codes for
  automated sends and rides the same audit/escalation machinery (signature includes
  the code set, so per-signature escalation just works).
- Double-fire: for automated sends the detector runs once inside
  `composeAdvisories`; the reply path calls `composeTimeClaimAdvisories` directly —
  one detector run per preflight, never two.
- The reply-kind preflight writes audit rows that previously only automated sends
  wrote; rows are keyed `interactive-session`, so per-slug aggregate escalation for
  real jobs is not polluted.
- Race with a run finishing between preflight and send: harmless — worst case a
  passing claim was checked against a clock that then expired; the advisory is
  point-in-time by design.

## 6. External surfaces

- `POST /messaging/preflight` response may now include a `TIME_CLAIM` advisory; for
  non-automated kinds the response can be non-empty for the first time. OLD scripts
  never call the preflight for those kinds → no deployed-behavior change until the
  script template migrates (SHA-gated, stock copies only; customized copies get a
  `.new` candidate + degradation event — the established mechanism).
- NEW script + OLD server: server returns `[]` for non-automated kinds → no-op.
  Version-skew safe both directions (tested at the route level for the kinds matrix).
- Timing dependence: yes, inherently — the detector compares against the live clock
  at preflight time; tolerances absorb request latency (seconds vs a 15-minute floor).

## 7. Multi-machine posture (Cross-Machine Coherence)

**machine-local BY DESIGN.** The session clock reads `<stateDir>/autonomous/*.local.md`
— per-machine state for runs executing ON this machine — and the preflight runs on
the same machine as the sending session, so the clock consulted is the right one by
construction. A topic transferred mid-run carries its autonomous state file via the
working-set carrier (WS1.4, PR #1092); after a transfer the new machine's preflight
reads the carried file once the run resumes there. No replication needed; no URL or
notice surface is generated; one-voice gating is unaffected (this layer holds a
message BEFORE send, it never speaks).

## 8. Rollback cost

Cheap, three independent levers, no data migration:
- Live-config: `messaging.outboundAdvisory.timeClaim.enabled: false` (or the master
  `messaging.outboundAdvisory.enabled: false`) — read live, no restart.
- The feature ships DARK on the fleet (dev-agent gate); never enabling it is the
  default state.
- Full revert: the detector is additive; reverting the PR restores the prior
  template SHA path (the SHA set keeps old entries valid as migration sources).
State written: only advisory audit JSONL rows (observe-only).

---

## Second-pass review

**Round 1 (independent reviewer): CONCERN RAISED — two genuine defects; all safety
claims (fail-open at every layer, dev-gate resolution, version-skew no-op both
directions, ReDoS-bounded regexes ≤1.3ms on adversarial 64KB inputs, migration
idempotency, template-SHA correctness) verified clean.**

- **Concern 1 — percent anchors captured TASK progress.** `done`/`complete`/bare-`in`
  ("the migration is 90% done", "passes 100% in CI") parsed as TIME claims; task
  progress diverges from wall-clock percent in the NORMAL state, so honest reports
  would be held routinely — and the guidance would have made them WRONG.
  **Fixed:** percent anchors now require an explicit time noun
  (`elapsed | (through|of|into) the (run|session|clock)`); 5 new negative tests on
  the reviewer's exact counterexamples.
- **Concern 2 — a non-automated `--ack-advisory` never recorded `acked`.** The
  script's ack annotation was gated to automated+llm-session, and the route's ack
  writer used the raw (empty) jobSlug — so an interactive session's advised
  episodes could never resolve, and the ignore-escalation would false-page on
  messages that actually DELIVERED (compounded by every interactive session
  sharing the `interactive-session` signature). **Fixed:** the script annotates
  the ack for every non-script sender, and the route's ack writer applies the same
  `interactive-session` slug fallback as the preflight writer; covered by a new
  script test (unstamped ack carries advisoryAck + codes) and a new route test
  (kindless ack lands `acked` under the SAME signature key).

**Round 2: CONCUR.** The reviewer executed the literal percent regex against all
round-1 counterexamples (zero matches) and the three time-noun shapes (all match);
traced the script's ack-first METADATA_JSON assembly for the all-env-empty case
(valid JSON, no leading-comma defect, confirmed empirically by the unstamped-ack
test JSON-parsing the delivered body); and verified the preflight writer and the
ack writer resolve to the IDENTICAL signature key for every kind, so a reply-kind
advised episode is genuinely resolved by its acked row (recordAck clears
`unresolved` + `escalatedIgnore` on the `slug|topic|codes` signature). 55/55 tests
green in the three touched files.
