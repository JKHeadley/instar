# Convergence Report — Real-channel collectMessages (absence proof over a live channel)

## Cross-model review: codex-cli:gpt-5.5

A real GPT-tier external pass ran through the agent's codex CLI on every round (rounds 1–3), each returning MINOR ISSUES only (no material findings). Gemini ran on rounds 1–2 (MINOR). The external reviewers' substantive note across rounds — "polling can't see deleted/ephemeral messages; pin the ordering/clock semantics" — was folded into the spec's **Known limits** section (history-poll proof = observable durable messages; platform-order-after-marker, not wall-clock).

## ELI10 Overview

Echo has a safety check that proves it does NOT send the user a surprise background message (like the buggy "the throttle should have cleared, please continue" nudge the earlier fix stopped). That check could already run, but only against a *fake* chat driver. This change lets it run against a REAL Telegram or Slack conversation by adding a `collectMessages` step that watches the channel's history over a window and gathers every message the agent posted, so the harness can prove none of them is the forbidden one.

The hard part is that "watch a real chat and confirm nothing bad showed up" has a sneaky failure mode: accidentally saying "all clear" when you simply didn't look hard enough. That's the worst direction for a safety check. The multi-angle review found five such holes and all are closed: a paginated/truncated read now BLOCKS (says "can't verify") instead of passing; an edited message can't launder itself out (every version is kept); a Slack background message posted under a `bot_id` is now matched; a failed read BLOCKS; and a reused long-lived test channel no longer trips a false "too busy" alarm. The unifying rule: every way the read could be incomplete fails toward BLOCKED, never a false PASS.

## Original vs Converged

The original spec added `collectMessages` as a straightforward "poll history, return agent messages" method, with one harness change (a typed `DriverCapabilityError → BLOCKED` mapping for an unsupported surface). Review showed that simple version could silently *false-PASS* an absence proof five ways, so the converged design is materially more defensive:

- **Truncation:** original returned whatever a single 100-entry read gave; converged BLOCKS when the read may be incomplete (Slack: full page or `next_cursor`; Telegram: full page whose oldest entry is still after the marker — a marker-bounded check so a reused demo topic isn't wrongly blocked).
- **Edits:** original kept the last text per message id (an edit could erase the offending text); converged keeps every text version per id.
- **Slack identity:** original matched the agent's user id only (a `bot_id`-only background post was skipped); converged matches user id OR an injected `bot_id`.
- **Failed read:** original treated an empty/failed read as "nothing there" (a vacuous pass); converged throws on Slack `ok:false`.
- **Live-channel safety:** original let a `safe`-tagged absence scenario poll any channel; converged forces every absence scenario onto a demo channel (§5.3), since it reads the whole channel history.

Plus a `windowMs` clamp (caps real-API poll volume) and a second typed error (`AbsenceUnverifiableError`, raised by senders for an incomplete read; `DriverCapabilityError` stays the capability-layer/missing-method signal). All additive, test-harness-only, no production runtime path.

## Iteration Summary

| Iteration | Reviewers who flagged | Material findings | Spec changes | Standards-Conformance Gate |
|-----------|-----------------------|-------------------|--------------|----------------------------|
| 1 | adversarial, lessons-aware, security; codex+gemini (minor) | 5 (truncation, edit-laundering, Slack bot_id, Slack ok:false, §5.3 safe-bypass) | Added Absence-proof soundness section + D4-D8; code fixes in both senders + harness | ran (0 flags) |
| 2 | adversarial (1 new medium); codex+gemini (minor) | 1 (Telegram full-page guard mis-fires on a reused demo topic) | Marker-bounded the Telegram truncation guard; D4 prose + Known-limits added | ran (0 flags) |
| 3 | (verification) adversarial RESOLVED+CONVERGED; codex (minor) | 0 | none | ran (0 flags) |

## Full Findings Catalog

**Round 1 — material (all resolved in round 2):**
- *Truncation false-PASS* (adversarial #1/#2, codex, gemini): limit-100 read, no cursor → a nudge on an unread page → false PASS. → `AbsenceUnverifiableError` on full page / `next_cursor` → BLOCKED.
- *Edit-laundering false-PASS* (adversarial #4, lessons #1): last-write-wins overwrote offending text. → keep all versions per id.
- *Slack `bot_id` false-PASS* (lessons #3, codex #3): background nudge via `bot_id` (no `user`) skipped. → match user OR injected `agentBotId` (collect + awaitReply).
- *Slack `ok:false` vacuous PASS* (security #6): failed read looked like "nothing there". → throw `AbsenceUnverifiableError`.
- *§5.3 safe-bypass* (security #2): a `safe` absence scenario could poll a live channel. → absence scenarios are demo-only regardless of `safe`.

**Round 1 — minor/non-material (noted):** windowMs clamp (scalability #2 → added 300s clamp), missing-id guard (adversarial #7 → `Number.isFinite` skip), DriverCapabilityError contract narrowing (adversarial #6 → two-error model documented), polling-vs-streaming justification (gemini #1 → added), tail-depth/deleted/ephemeral (codex #2 → Known-limits), multi-machine posture (integration #1 → machine-local-by-design, stated), route-level integration coverage (integration #4 → noted; harness-level BLOCKED path is unit-covered).

**Round 2 — material (resolved in round 3):**
- *Telegram truncation guard mis-fire* (adversarial, medium): `getTopicHistory` returns a whole-lifetime tail, so a bare `length >= 100` wrongly BLOCKED any reused demo topic — the surface the spec exists to make runnable (safe direction, but defeats the purpose). → marker-bounded: BLOCK only when the full page's oldest entry is still after the marker. New test for both the in-page (no block) and scrolled-off (block) cases.

**Round 3 — verification:** adversarial confirmed the Telegram fix resolves the mis-fire, the safe direction holds, and the edge cases (`afterId === -Infinity`, all-non-finite ids) are non-material. Zero new material findings.

## Convergence verdict

Converged at iteration 3. Zero material findings in the final round; `## Open questions` is `*(none)*`. Every round-1 and round-2 material finding is resolved with matching test coverage (22 unit tests across the collect path, including both sides of every guard boundary). The Standards-Conformance Gate ran clean (0 flags) all three rounds. Spec is ready for approval.
