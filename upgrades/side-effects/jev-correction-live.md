# Side-Effects Review — Jev correction detector as live sentinel input

**Version / slug:** `jev-correction-live`
**Date:** `2026-10-15`
**Author:** `echo`
**Second-pass reviewer:** `independent review subagent`

## Summary of the change

Graduates the Jev correction shadow (`docs/specs/jev-correction-shadow.md`)
from log-only to a live input of the Correction & Preference Learning Sentinel
(spec `docs/specs/jev-correction-live.md`). When Jev flags a user message as a
correction or standing preference (existing 0.5 line) and Layer 0 missed it,
the shadow hands it to a sink the sentinel installs; the sink runs the
sentinel's existing `captureAndDistill` on the window as it stood at that
message, with the minimum Layer-0 provenance weight (3). Desk notes opening
"From <agent name>" and agent-signed messages are excluded. Dev-gated
(`intelligence.jevCorrectionShadow.feedSentinel`, omitted ⇒ dev gate, `false`
kills it live).

Files: `src/core/JevCorrectionShadow.ts` (feed, exclusions, `fed` row field,
summary counts, factory gate), `src/monitoring/CorrectionCaptureLoop.ts`
(optional pre-captured `window`, `windowEndingAt`), `src/commands/server.ts`
(agent name to the shadow; sink installed in the sentinel block; `trigger`
on the audit row), `src/core/types.ts`, `src/core/devGatedFeatures.ts`,
`src/scaffold/templates.ts` (card rewritten), `src/core/PostUpdateMigrator.ts`
(replace the stale log-only card once), tests in all three tiers.

## Decision-point inventory

- **Distill trigger (new input):** a Jev-only flag now triggers a distill, in
  addition to a Layer-0 signal. It is a signal into the sentinel, which keeps
  every consequential decision: the distill may return `noise`; the unchanged
  recurrence gate (4 occurrences / 2 days / 2 sessions) decides promotion; a
  promoted preference is an advisory session-start hint.
- **Feed exclusion (new, deterministic):** `feedExclusion` decides only whether
  a message is handed on; it blocks nothing the user sees.

---

## 1. Over-block

Excluded messages are never fed: a genuine operator correction that happens to
open "From <agent name>" (e.g. "From Echo's last report I can see you were
wrong") would be skipped. The word-boundary match keeps "From Echoes…" and
mid-sentence mentions in. Cost of an over-exclusion: one missed learning
occurrence, which is today's behaviour for every such message. Acceptable.

---

## 2. Under-block

- Another agent's text pasted by the operator without the prefix or a
  signature is fed as the operator's. The distill and the recurrence gate are
  the remaining filters; named in the spec's known gaps.
- Jev false positives (~7 of 40 in the evidence were desk notes, now excluded;
  the other 33 all read as genuine on one rater's read). A weak flag
  (a bare "yes" to a proposed rule) can enter the ledger as one occurrence; it
  promotes only if it recurs across days and sessions.

---

## 3. Level-of-abstraction fit

Right layer. The feed reuses the sentinel's own capture function with the same
deps (ring, ledger, LlmQueue cap, rate ceiling, shedding, backlog) instead of
a parallel write path, so every existing bound applies. The window helper lives
next to the ring it reads. The shadow never touches the ledger itself.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — this change produces a signal consumed by an existing smart gate.
- [ ] No — this change has no block/allow surface.
- [ ] Yes — but the logic is a smart gate with full conversational context.
- [ ] ⚠️ Yes, with brittle logic — STOP.

Jev's flag is a signal; the sentinel's distill LLM (full window) and the
code-determined recurrence gate are the authorities. The exclusion check is
brittle but holds no blocking authority over anything user-facing: it can only
withhold a signal, never block a message.

---

## 4b. Judgment-point check (Judgment Within Floors standard)

The one judgment call is the provenance weight: a Jev-fed occurrence counts at
`LEARNING_DETERMINISTIC_THRESHOLD` (3), the weakest Layer-0 hit. Argued in the
spec: weight 0 would make the feed inert (never counted), the weight's purpose
is to keep the distill LLM's self-reported confidence out of promotion (Jev is
a separate classifier on the authenticated user's own text, with agent text
excluded), and Layer 0 reads the same text. The gate thresholds are unchanged.
Deliberate asymmetry: a Jev-fed occurrence counts at 3, so it is stronger than a
weight-2 Layer-0 signal (which is distilled but never counted). Unsigned
automated text posted through the operator's account without the "From <agent>"
prefix now reaches the gate more easily; the 4 / 2-day / 2-session gate bounds
it, and it is named in the spec's known gaps.

---

## 5. Interactions

- **Double-distill:** prevented. The feed fires only when Layer 0 did not
  signal, so a message is distilled at most once. The ring is not pushed twice
  (supplied window), so the prompt shows the turn once (tested).
- **Ordering:** the shadow is constructed before the sentinel; the sink is
  installed late via `getJevCorrectionShadow()`. Messages checked before the
  sentinel is up record `no-sentinel`.
- **Late arrival:** the Jev answer can arrive after the agent replied;
  `windowEndingAt` cuts the window at the flagged turn so the reply is not
  presented as preceding it. If the ring evicted the topic, the single turn is
  used.
- **Rate ceiling and backlog** are shared with Layer-0 signals (same
  `rateState`, same backlog), so a burst of Jev flags cannot exceed the
  per-topic ceiling or the sentinel's daily LlmQueue cap.
- **Card migration:** replaces the stale card only when its log-only sentence is
  present; idempotent; framework-shadow marker unchanged.

---

## 6. External surfaces

- **Other agents:** fleet agents get the code and the card; the feed is dark
  there (dev gate) and inert without a TypeSafe key and an enabled sentinel.
- **External systems:** no new egress. The Jev call already exists; the
  sentinel's distill goes through its existing intelligence provider and cap.
- **Persistent state:** new ledger records (ordinary correction records) and
  audit rows with `trigger: 'jev'`; one optional `fed` field on shadow rows.
- **Operator surface:** the Preferences tab / `/corrections` will start showing
  records the keyword check missed. That is the intended effect.

---

## 6b. Operator-surface quality (Operator-Surface Quality standard)

No new operator surface; existing read routes gain counts.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

Machine-local BY DESIGN, as the shadow and the sentinel: each machine feeds its
own sentinel from messages its own adapter logs. No notices, no topic-bound
state that must follow a transfer, no URLs.

---

## 8. Rollback cost

`intelligence.jevCorrectionShadow.feedSentinel: false` (live, no restart) stops
the feed and keeps measuring. Records already written are ordinary open records
handled by the ledger lifecycle. Full back-out: revert and ship a patch.

---

## Conclusion

Clear to ship behind the dev gate. Evidence: 40 Jev-only flags over ten days,
about 33 genuine and learned from by nothing; the 7 desk notes are excluded by
construction.

---

## Second-pass review (if required)

**Reviewer:** independent review subagent (2026-10-15)
**Verdict: Concur with the review.** No correctness bugs found. Confirmed:
the shadow is constructed before the sentinel block, so the late-installed sink
finds it (a construction failure makes the feed a no-op); the sink closure has
the ring, rate state, backlog, ledger and distill in scope; the turn is on the
ring before the deferred feed fires; no double distill (same pure Layer-0
classifier and signal definition on both sides; supplied window avoids a second
push); exclusion regex both sides; migration replaces exactly the one-paragraph
card and is idempotent; gate and kill switch resolved live.

Notes taken: (1) an unused wiring marker global was removed; (2) the weight
asymmetry is now stated in 4b. Notes accepted as known edges: the same short
text sent twice while a check is pending cuts the window at the later copy (safe
fallback); on an agent whose `projectName` differs from the name its desk notes
are signed with, the prefix exclusion does not apply; a trailing card at end of
file loses its final newline on replacement.

---

## Evidence pointers

- `logs/jev-correction-shadow.jsonl` (agent home), joined by `messageId` to
  `.instar/telegram-messages.jsonl` on 2026-10-15: 40 Jev-only flags, 7 opening
  "From Echo (…), not from Justin:".
- `tests/unit/jev-correction-shadow.test.ts`, `tests/unit/CorrectionCaptureLoop.test.ts`,
  `tests/integration/jev-correction-shadow-routes.test.ts`,
  `tests/e2e/jev-correction-shadow-lifecycle.test.ts`.

---

## Class-Closure Declaration (display-only mirror)

Not a self-triggered controller: it never restarts, respawns, spawns, notifies
or kills. Its only new action is one bounded distill per Jev-only flag, under
the sentinel's existing daily cap and per-topic rate ceiling.
