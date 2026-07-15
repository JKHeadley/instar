# Side-Effects Review — Agent-Health Lane raw-tag formatting fix

**Version / slug:** `agent-health-lane-fixes`
**Date:** `2026-07-15`
**Author:** `Echo (instar-dev agent)`
**Second-pass reviewer:** `not required for this scope (formatting/transport only, no decision surface) — see note`

## Summary of the change

One call-site fix in the "🩺 Agent Health" calm-lane path (user report 2026-07-14, CMT-854): `TelegramAdapter.routeToAgentHealthLane` builds a `<b>title</b>` line but sent it via `sendToTopic(topicId, line)` with no format mode → the markdown converter re-escaped the tags to literal `<b>`/`</b>` text. Fixed by passing `{ formatMode: 'html' }`, identical to the lane intro post and the attention-hub post (the 2026-07-11 fix for the same class). Files: `src/messaging/TelegramAdapter.ts` + a regression test in `tests/unit/attention-single-topic-routing.test.ts`.

**Scope note:** the sibling *flood* fix (making the stranded notice's dedup key stable per-owner) was built and then REMOVED from this PR after the Phase-5 second-pass review (recorded below) found the naive version introduces a silent under-signal. That fix is being redirected to a spec. This PR is the formatting fix only.

## Decision-point inventory

- `TelegramAdapter.routeToAgentHealthLane` (lane send) — **modify** — send now carries `formatMode: 'html'`; no change to routing, dedup, or block/allow decisions, only to how the already-authored HTML is transmitted.

---

## 1. Over-block

**No block/allow surface — over-block not applicable.** The change only sets a transmission format flag on an already-decided send.

## 2. Under-block

**No block/allow surface — under-block not applicable.** No dedup or suppression logic is touched by this PR (the dedup change was removed — see scope note). The notice still posts exactly when it did before; only its rendering changes.

## 3. Level-of-abstraction fit

Correct layer. The fix uses the existing `sendToTopic({ formatMode: 'html' })` primitive rather than hand-rolling a direct `apiCall`, matching how the lane intro and attention hub already transmit caller-authored HTML.

## 4. Signal vs authority compliance

Compliant — no decision surface. This is a pure transport/formatting correction with no gating authority. Ref: `docs/signal-vs-authority.md`.

## 5. Interactions

- **`sendToTopic` formatMode branch (`TelegramAdapter.ts:1358-1366`)** — the `formatMode:'html'` branch sends with `parse_mode:'HTML'` + `_formatMode:'html'` and carries a built-in fallback: on a malformed-entity 400 it retries with plain params so the message still delivers (tags visible — never worse than the current bug). No new failure mode.
- **Lane intro post** — already used the correct HTML path; unaffected. No double-send or shadowing.
- **Dedup / flood path** — untouched by this PR.

## 6. External surfaces

- **User-visible:** yes, positively — the Agent Health topic now renders bold titles instead of raw `<b>` tags. This is the intended fix.
- **Other agents / systems:** none. The lane is a per-agent Telegram topic.
- **Timing/runtime dependence:** none — formatting is deterministic per send.

## 7. Multi-machine posture (Cross-Machine Coherence)

**Machine-local BY DESIGN.** The agent-health lane topic + its send path are per-machine adapter state; this formatting fix applies wherever the lane posts and needs no replication. (The separate duplicate-topic issue — Mini and Laptop each creating their own "🩺 Agent Health" topic — and the flood fix are OUT of this PR, tracked as follow-ups <!-- tracked: CMT-854 -->.)

## 8. Rollback cost

Trivial. Single call-site edit; revert the PR to restore the prior behavior (raw tags return, no data effect). No migration, no persisted-schema or cross-version contract touched.

## Class-Closure Declaration

- **`unbounded-self-action` → closure `n/a` (negative declaration).** This change is NOT a self-triggered action. The diff only adds `{ formatMode: 'html' }` to an EXISTING `sendToTopic` call in `routeToAgentHealthLane` — a formatting flag on an already-decided, externally-driven attention-item post. No controller, loop, restart, swap, respawn, or retry is introduced or modified; the send already existed and fires once per attention-raise from an external caller, not a self-perpetuating loop. (The gate's heuristic matched self-action vocabulary present elsewhere in `TelegramAdapter.ts`, not in this diff.)

## Second-pass review

**Concern raised (on the ORIGINAL two-fix scope) — and acted on.** The Phase-5 reviewer independently confirmed the formatting fix is correct (it reaches the `parse_mode:'HTML'` + `_formatMode:'html'` send branch at `TelegramAdapter.ts:1358-1366`) and that signal-vs-authority is preserved. It then found the (now-removed) dedup fix's causal model was inverted: `createAttentionItem` short-circuits on `attentionItems.has(item.id)` (`TelegramAdapter.ts:3865-3867`) BEFORE the lane routing, and `updateAttentionStatus` never deletes from the map (no prune/TTL, no heal→resolve wiring). So a permanently-stable id would post once and then suppress that owner's strand notice indefinitely — a silent under-signal on a load-bearing reachability guard, and the "(N topics)" count would freeze.

**Resolution:** the dedup/flood fix was REMOVED from this PR. It requires a proper signal-lifecycle design (clear-the-stranded-alert when the machine recovers, restart-robust so it neither re-floods on frequent restarts nor orphans on heal-during-restart) and is being taken through `spec-converge` as a separate change. This formatting-only PR carries no decision surface and needs no further second-pass review. Follow-up tracked <!-- tracked: CMT-854 -->.
