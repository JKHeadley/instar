# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

Codex quota readings went blank the moment an account's session ended, and stayed blank until something ran on that account again. On a machine with five enrolled Codex accounts, three showed "No quota reading yet" for days while every one of them was logged in and working.

The cause is a second kind of record. Codex has no usage API, so the account's weekly allowance is read out of the session log the Codex CLI writes locally: each turn appends a `token_count` event whose `rate_limits` payload carries the account's usage windows under `limit_id: "codex"`. But at session close Codex appends one more `token_count` event for a *different* limit family — `limit_id: "premium"`, an entitlement/credits record with `primary: null` and `secondary: null`. The reader took the newest `rate_limits` record unconditionally, so that single closing line erased the whole session's real quota. One captured rollout holds 600 `codex` records followed by exactly 1 `premium` record, as its final line, and the `premium` one won.

The reader now keeps the newest record that belongs to the `codex` family AND carries a usage window, ignoring window-less entitlement records. Rollouts written before `limit_id` existed are unaffected — a record with no `limit_id` is still treated as the codex family. A record from some other limit family that *does* carry windows is ignored rather than shown, so another product's allowance can never be presented as this account's quota.

Two honesty fixes ride along. An account that genuinely reports no usage window at all — a credits-only account, where no future poll can ever produce a number — now reads "This account reports no usage window." instead of "No quota reading yet.", which implied a pending read. And because a reading is only as fresh as the account's last completed turn, a reading older than six hours is now labelled with its age, so an idle account's days-old bar cannot pass as current.

This is a reader and presentation fix. No routing, placement, load-shedding or proactive-swap threshold changed. Their input improves — two exhausted accounts now present a real number where they previously presented nothing — which makes them more likely to route work away from a full account, not less.

## What to Tell Your User

Your Codex accounts should stop showing "No quota reading yet" when they're actually fine. That message was a bug in how the usage number was read, not a sign-in problem — Codex writes a final, empty bookkeeping record when a session closes, and that empty record was overwriting the real number. Now the real number survives.

Two things will look a little different. An account that genuinely has no weekly usage window to report now says so plainly, instead of implying a reading is on the way. And a reading that's more than six hours old now shows its age underneath, because Codex only updates the number when something actually runs on that account — so an idle account can be sitting on a number from days ago, and you should be able to see that rather than assume it's current.

Nothing about how your work is spread across accounts changed.

## Summary of New Capabilities

- The Codex rollout reader keeps the newest `limit_id: "codex"` record that carries a usage window, instead of whatever `rate_limits` record happened to be last.
- A window-less entitlement record (`limit_id: "premium"`) at session close no longer erases the session's real quota.
- A record from a non-codex limit family is ignored even when it carries windows — another product's allowance is never shown as this account's.
- A genuinely window-less account is reported as its own state (`windowsUnavailable` on the snapshot, `noQuotaWindow` on the stored quota) and rendered as "This account reports no usage window."
- Quota readings older than six hours are labelled with their age on the Subscriptions card.
- Back-compatible: rollouts with no `limit_id` are still read as codex-family; the new snapshot field is optional and absent on existing stored state.

## Evidence

- Live, against the BUILT reader and the five real Codex config homes on the operator's machine. Before: 2 of 5 accounts reported a number. After: 4 of 5 report a number (`justin@sagemindai.io` 100% weekly captured 2026-09-14, `headley.justin@gmail.com` 94% weekly captured 2026-09-15, plus the 86% and 96% that already worked), and the fifth (`dawn@sagemindai.io`) reports `windowsUnavailable: true`.
- The fifth account's blank card was verified as an honest state, not a parse failure: no `limit_id: "codex"` record appears in any sizeable rollout it wrote across 2026-09-16..20.
- Unit (`tests/unit/codexRateLimitReader.test.ts`, 15 passing): the entitlement record closing a session, several codex records with an entitlement record interleaved, an entitlement-only tail, a foreign limit family carrying windows, and the reader falling through an entitlement-only rollout to an older one with real windows.
- Mutation-checked: reverting only the record-selection branch to the previous unconditional assignment fails 5 of the new cases, so the assertions are load-bearing rather than decorative.
- Unit (`tests/unit/quota-poller.test.ts`, 26 passing): both sides of the boundary — a windowless reading sets `noQuotaWindow`, a windowed one does not.
- Unit (`tests/unit/subscriptions-render.test.ts`, 97 passing): the three distinct card states (a bar, "reports no usage window", "No quota reading yet") and the age label appearing above the six-hour threshold and not below it.
