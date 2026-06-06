# Side-Effects Review — Honest Turn-Receipts

**Version / slug:** `honest-turn-receipts`
**Date:** `2026-06-06`
**Author:** `Echo (instar-dev agent, session-robustness topic — Justin: "finish out item number four" + the "conversation too long is noise" observation)`
**Second-pass reviewer:** `self-adversarial pass over false-positive surface (the one way an honest classifier can become a new liar) + double-messaging`

## Summary of the change

A pure tail-gated `StuckSignatureClassifier` recognizes a live-but-failing
session (rate-limited / policy-wedge / context-wedge / context-too-long) from
its LIVE tmux tail and returns an honest user-facing message. PresenceProxy's
`fireTier3` runs it after the existing quota check and before the process-tree
"working" assessment, surfacing the real reason instead of "working", deferring
to an owning recovery sentinel, and preserving the context-exhaustion recovery
path. The un-tail-gated context-exhaustion block it replaces was the source of
the "conversation too long" noise. Files: `StuckSignatureClassifier.ts` (new),
`PresenceProxy.ts`, `server.ts` wiring, `PostUpdateMigrator.ts` section, tests.

## Decision-point inventory

- Stuck classification — **add (detector)** — signal only; tail-gated.
- fireTier3 placement (after quota, before process-tree) — **modify** — the
  exact seam where a live process forced the "working" lie.
- context-exhaustion block — **replace** — same recovery path, now tail-gated
  (fixes the noise) and folded into the unified honest block.
- `isStuckRecoveryActive` deference — **add (suppression)** — net reduction in
  messaging authority (yields to an owning sentinel).

## 1. Over-block

Nothing is blocked — no authority added. The honest message can only fire at
tier-3 (5 minutes of an unanswered user message), so a session that replied
promptly never reaches it. The deference callback REMOVES a double-message case
(standby + sentinel both speaking).

## 2. Under-block (false-positive surface — the real risk)

The danger of an honest classifier is becoming a NEW liar (saying "stuck" about
a healthy session). Defenses, each tested:
- **Tail-gating:** the signature must be the live tail, not scrollback — kills
  the stale "conversation too long" mention (the reported noise) and a session
  that quoted an error then kept working.
- **Prose-vs-block rate-limit patterns:** "you've hit your limit" / "limit ·
  resets" match; "when you hit your usage limit, the session pauses" does not.
- **AUP repetition gate** (inherited from classifyWedgeTail): a single benign
  policy rejection is not a wedge.
- **Normal-compaction suppression:** the compaction lifecycle banner is not
  treated as context-too-long.
Residual under-block: a stuck session whose signature the provider rewords
escapes — inherent to signature matching; the tier-3 LLM path still runs as the
fallback for the unmatched case (unchanged).

## 3. Level-of-abstraction fit

The classifier is a pure module beside the sentinels whose detectors it reuses
(`classifyWedgeTail`). The wiring lives in `fireTier3` (which owns the
assessment) and reuses the existing `sendProxyMessage` surface and the composed
`wedgeRecoveryActive` checker (same one the SessionReaper veto uses). No new
message path, no new state store.

## 4. Signal vs authority compliance

**Required reference:** `docs/signal-vs-authority.md`

- [x] Pure signal. The classifier decides nothing; it answers a question.
  Recovery is unchanged (the sentinels'). The only behavioral delta is WHICH
  honest string the standby sends, plus a new SUPPRESSION (deference). No new
  decision-maker, and a net reduction in messaging authority.

## 5. Interactions

- **Quota-exhaustion block (runs first):** owns the bare usage-limit form; the
  honest classifier is the backstop for the forms it misses + the wedges +
  tail-gated context-too-long. No double-handling (the first to match returns).
- **RateLimitSentinel:** already suppresses ALL tiers via
  `hasActiveRateLimitRecovery` (unchanged); the honest rate-limit branch is the
  backstop when no sentinel owns it (e.g. the cross-machine EXO case).
- **ContextWedgeSentinel:** when it is mid-recovery, `isStuckRecoveryActive`
  makes the standby defer; otherwise the honest message is the only voice.
- **Existing tests:** all 119 presence-proxy tests pass unmodified; the
  context-exhaustion test's source-grep section was updated to the new wiring.

## 6. External surfaces / 7. Rollback

No API, no route, no config key (default-on behavioral change; the new config
field is an optional injected callback wired in server.ts). One idempotent
CLAUDE.md section (marker 'Honest standby (turn-receipts)'). Rollback = revert;
the standby returns to classifying live-but-failing sessions as "working" and
the context-too-long noise returns.
