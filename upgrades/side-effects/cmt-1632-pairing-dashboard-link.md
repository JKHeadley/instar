# Side-Effects Review — pairing dashboard lines carry a direct link

**Version / slug:** `cmt-1632-pairing-dashboard-link`
**Date:** `2026-11-11`
**Author:** `Echo`
**Second-pass reviewer:** `not required (message wording only; no gate, sentinel or decision changed)`

## Summary of the change

Tier 1. 3 source files (about 70 changed lines), 1 new unit test file, 2 test files updated. One build pass, no spec rounds (Tier 1, the PR is the review surface).

Feedback fb-300d9f7d-6d3 / CMT-1632: Cora replied to Justin's pasted invite with "Open the Threadline tab on the dashboard to do this with your PIN. Paste the invite there." and no link. The fixed string bypasses the outbound tone gate (B22_SURFACE_REFERRAL), so the link rule was never applied.

- `src/threadline/PairingInviteTelegram.ts`: `DASHBOARD_HINT` replaced by `agentsPageUrl(origin)` (origin only, http(s), no credentials; `consolePageUrl(origin, '#/people/agents')`), `dashboardHint(url)` and `pasteInviteHint(url)`. New optional dep `dashboardOrigin()`. The four call sites (forwarded-invite refusal, refused tap, expired tap, finish prompt with buttons off) use them. Tap answers go through `tapAnswer()`, which keeps the answer within Telegram's 200-character limit (full line, then a short line with the link, then plain words). The link is withheld when the person is known not to be the owner.
- `src/server/routes.ts`: passes `dashboardOrigin: () => originOrNull(pairingLinkOrigin())`, built with the existing `createOperatorLinkOriginResolver` (public tunnel origin; localhost only when no tunnel is configured; null while a configured tunnel is starting).
- `src/messaging/TelegramAdapter.ts`: the adapter's own fallback line (no pairing handler, or the handler threw) and its no-handler tap answer use the same helpers with the adapter's existing public-address provider (`setConversationsUrlProvider`, the tunnel URL).

## Decision-point inventory

None changed. Who may approve, which taps count, and when buttons are offered are untouched. Only the text of messages that were already sent changes.

## 1. Over-block
No issue identified: nothing is blocked or filtered.

## 2. Under-block
Not applicable. Remaining gap: a button-tap answer is a Telegram alert, where a URL shows as text and cannot be tapped. The forwarded-invite reply and the finish prompt (ordinary messages) are tappable.

## 3. Level-of-abstraction fit
Right layer. The fixed strings live in the pairing helper, which never passes the LLM tone gate, so the link has to be added where the string is built. The address comes from the existing operator-link resolver rather than a new one.

## 4. Signal vs authority compliance
- [x] No — this change has no block/allow surface.

## 5. Interactions
The resolver instance is separate from the other `createOperatorLinkOriginResolver` callers in routes.ts; its only state is when the tunnel was first seen down. While a configured tunnel is starting it returns pending, which here means plain words (these replies are immediate and cannot be deferred). The invite secret is still consumed before any session or log sees it; the link never carries it.

## 6. External surfaces
Operator-visible Telegram text changes in five places. The dashboard address (tunnel URL) now appears in these messages, only for the owner or when no owner is named. The dashboard itself is still PIN-gated.

## 7. Multi-machine posture (Cross-Machine Coherence)
Machine-local by design: each machine's reply uses that machine's own dashboard address, which is the machine holding the pairing state the owner must act on (pairing runs where the invite was received). No durable state added.

## 8. Rollback cost
Revert and ship a patch. No state, config or migration involved.

## Class-Closure Declaration (display-only mirror)

- `unbounded-self-action`: closure `n/a`. One-shot user-driven action, not a self-triggered loop: only the wording of existing replies to an operator paste or tap changes; no new send, retry or spawn.

## Tier note

Declared Tier 1 below the signaled risk floor 2 (TelegramAdapter.ts is a safety-invariant file). The TelegramAdapter change only replaces two fixed reply strings with the same helper text plus a link; no ingress, authorization or routing logic is touched.

## Conclusion
Clear to ship.
