# Side-Effects Review — Visible automated mentor delivery

**Version / slug:** `mentor-drive-visible-echo`
**Date:** `2026-07-10`
**Author:** `instar-codey`
**Second-pass reviewer:** `framework_guard_review`

## Summary of the change

`AgentServer.deliverA2aMessage` accepts an optional observability-only visible echo. On confirmed `a2a-inbox-local` success, mentor delivery mirrors the original body through the existing mentor bot/topic. `MentorVisibleEcho` provides bounded line-aware chunking and one-shot failure reporting. `mentor.visibleEcho` defaults on inside the already-dark mentor system and can be disabled.

CI repair: adding that fleet-on child shifted later line numbers in the dark-gate lint's hand-authored golden attribution map by one. The map was updated by hand; its 25 dotted paths remain unchanged.

## Decision-point inventory

- Canonical a2a delivery — pass-through — remains authoritative and byte-identical.
- Visible echo eligibility — add — structural: only confirmed local-inbox success, configured bot/topic, and enabled config.
- Chunk cap — add — hard Telegram/flood invariant, maximum three messages.

## 1. Over-block

No canonical delivery is blocked. An opted-out or unconfigured echo is skipped after delivery. A visible sequence stops after its first failed chunk rather than retrying, preventing a retry storm or reordered duplicates.

## 2. Under-block

The mentee-reply direction lacks sender-bot plumbing at this chokepoint and is not mirrored here. It remains tracked by framework issue `mentor-guardian-drive-channel-gap`. <!-- tracked: framework-issue mentor-guardian-drive-channel-gap --> A process crash after inbox success but before the mirror can still leave that one exchange invisible; the canonical delivery remains durable/audited.

## 3. Level-of-abstraction fit

The single `deliverA2aMessage` chokepoint knows the actual transport outcome, so it is the only layer that can avoid double-posting Telegram fallback while mirroring local inbox success. Chunk planning is extracted as a pure core primitive. The mentor call site retains bot/topic/config ownership.

## 4. Signal vs authority compliance

Required reference: [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — the echo is an observability signal after authoritative delivery.

The echo has no blocking power over delivery, the ledger, outstanding state, or anti-ping-pong. Structural Telegram size/flood limits constrain only the mirror transport.

## 5. Interactions

- **Shadowing:** echo runs only after inbox acceptance and ledger append; it cannot shadow delivery.
- **Double-fire:** fallback delivery never calls the echo; the existing visible Telegram fallback remains singular.
- **Races:** the fully-contained echo sequence is detached after canonical success so a hung Telegram call cannot delay delivery bookkeeping. Within that sequence, chunks are awaited sequentially; no parallel reorder. Failure stops once.
- **Feedback loops:** the visible post is ordinary chat output, not a new a2a marker, so it cannot spawn a mentor loop.

## 6. External surfaces

Operators now see mentor prompts in the configured mentor topic. Up to three Telegram posts may result from one successful local delivery. A failed/partial mirror adds one DegradationReporter row and honest log. No ledger schema, topic creation, credential storage, or new endpoint is introduced.

## 6b. Operator-surface quality

No dashboard or form renderer changes; not applicable. The Telegram content leads with a plain role label and ordered part marker, contains no raw transport identifiers, and fits phone width through normal Telegram wrapping.

## 7. Multi-machine posture

**Machine-local by design:** the visible echo attaches only to same-machine `a2a-inbox-local` delivery. Cross-machine Telegram fallback is already visible and therefore must not echo. The bot posts once from the mentor's existing one-voice delivery process. No new durable state or URLs are introduced; the configured topic remains the routing owner.

## 8. Rollback cost

Revert and ship a patch. The additive config key can remain harmlessly unread. No migration, ledger repair, topic cleanup, or agent reset is required.

## Conclusion

The design makes the invisible transport observable without giving the mirror any authority. Independent review caused one material correction: the mirror was detached from the canonical return so a hung Telegram send cannot delay ledger/outstanding bookkeeping. Failure is bounded, loud, and non-retrying; fallback cannot double-post; volume cannot exceed three messages. Clear after reviewer re-check.

## Class-Closure Declaration

- **Defect class:** `unbounded-self-action`
- **Closure:** guard
- **Enforcement:** ratchet
- **Citation:** `tests/unit/MentorVisibleEcho.test.ts`
- **How caught:** each successful mentor delivery starts at most one echo sequence; the pure planner caps it at three ordered sends, and the first failure terminates without retry. Tests prove the three-message steady-state bound and one-shot failure settling.

## Second-pass review

**Reviewer:** `framework_guard_review`
**Independent read of the artifact:** concur

Concur with the revised review. The echo launches only after confirmed inbox-local acceptance and the local sent-ledger attempt, but is detached behind a terminal catch, so slow or hung Telegram cannot delay the `true` return that drives mentor sent-ledger/outstanding bookkeeping. The executable test proves a never-resolving visible send starts once while canonical delivery returns within the bound, local transport is ledgered, and the Telegram fallback is never invoked. Helper tests prove ordered messages within 4096 characters, exact reassembly, max-three honest shortening, and one report/no retry on mid-sequence rejection. Default-on remains nested inside the dark mentor configuration; mentee-reply scope remains honestly excluded and tracked.

## Evidence pointers

- `tests/unit/MentorVisibleEcho.test.ts`
- `tests/unit/AgentServer-mentor-visible-echo-wiring.test.ts`
- `tests/e2e/mentor-reply-via-inbox.test.ts`
