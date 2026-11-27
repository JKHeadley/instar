# App attachment sheet side-effects review

Tier 2 browser slice on the approved App attachment browse spec. The staged implementation covers thirteen browser, signed server, spec and test paths with patch SHA-256 `e0be89a107637808a604079357b8d71ae800a13a234e82ed99e259a6b76483cf`.

## Authority and scope

The authenticated browser status reports an optional availability bit derived from current flags and the local media service. An old or disabled server leaves the dashboard entry hidden. This bit controls UI discovery only. Existing signed owner routes still decide whether to list or release bytes. The sheet renders validated metadata as DOM text and sends both opaque bindings only on an explicit open. It uses its own playback URL and never puts the bytes into the ordinary conversation's hash cache.

## Request and state impact

Each kind choice, Older or Retry can use up to three sequential reads through the existing browser budget. A busy page keeps the declined request's incoming cursor. Confirmed incomplete coverage remains visible through subsequent pages. A hidden tab pauses the walk. Closing, changing chats, replacing a pending file, and observed authentication failure clear the affected requests or playback. A same-origin tab can send a matching denial signal for the same conversation and browser identity, but has no means to grant access. The signal carries no bearer or attachment data.

## Over-block, under-block and rollback

A failed local refresh may close a sheet when access is simply unmeasurable. A matched same-origin failure can close the sheet but cannot authorize a read. On a different replica, the server refuses old tokens before release. Already delivered bytes cannot be withdrawn. The status result and pages remain local to the connected server. No history or browser schema change is introduced. Removing the browse opt-in makes the entry unavailable on refreshed status and makes the existing routes refuse. Reverting this browser slice removes its entry and cross-tab failure event. Production activation still requires the exact tested rollout criteria.

## Evidence

The chat model and dashboard unit suite passed 100 cases. The availability lifecycle ran eight production-path cases. On a throwaway loopback AgentServer and isolated real Chrome profile, the actual dashboard Chats renderer opened a captionless fixture through the Attachments sheet. Merely listing it made no exact-content request. A single signed Open included both tokens and decoded a 16 by 16 image. Closing released the playback URL and preserved the existing composer and draft. Ordinary background chat refresh used its existing routes. Full-suite, sparse-volume latency and wider browser lifecycle acceptance remain pending.

A stable per-incarnation context is scoped to the signed owner device and exact App chat. It is available only on owner-authorized local browse, local history and events while media and browsing are available. It is separate from the encrypted selection tokens and cannot authorize a request. A successful ordinary refresh with a changed or missing context clears the sheet and revokes playback, including scoped follower observations. A media-off error closes the sheet. Generic file Open renders a manual Save link, so ordinary history retains its existing download behavior and the sheet does not synthesize a download click. Focused tests exercise a changed context with a loaded generic file and the enabled and disabled fields on the real route. The disposable Chrome image flow passed again after this change.

The final correction treats a pooled fallback refresh as unverified even when the chat history request succeeds. It clears only sheets that predate the request and gives matching followers a nonauthorizing failure signal. A dashboard test exercises the regular scheduled task with a 200 pool response and verifies old rows disappear.

## 6b. Operator-surface quality

The primary action is the attachment type choice. A listed file offers Open and generic files offer a separate Save. The sheet displays filenames, dates and short status text. Tokens, hashes and route details never appear in the interface. It offers no destructive action. The sheet uses the existing responsive dashboard panel and plain language for loading, retries and incomplete results. Phone-width inspection is part of the activation acceptance work and was not measured by this disposable desktop run.

## Phone-width acceptance

Real Chrome with the dashboard stylesheet at a 390 CSS pixel viewport exposed horizontal overflow on a 244-character unbroken filename. The attachment-specific grid now wraps the filename and keeps Open in view. Controls have a 44-pixel minimum height and the accessible action identifies the full filename. The same Chrome test passed after the change, including explicit signed Open, image decoding, untouched composer draft and released playback URL. This layout change does not affect ordinary history rows or server admission.

## Combined browser and server verification

This merge carries the server test-inventory and default-off registry repair into the phone-width browser branch. The only merge conflict was in the plain-language overview, and both explanations were kept. No runtime route or browser code changed in the merge. The combined checkout passed 190 focused attachment, route-inventory, and browser cases, plus the real Chrome test at 390 CSS pixels.

## Disposable latency measurements

Measured the combined browser and server checkout with real signed loopback HTTP, distinct scored owner devices and the normal read limits. Each fixture used a separate 20-page preflight, five warm-ups per scored device, 20 ordinary reads alone and 20 concurrent browse/history pairs. No scored response returned 429.

| Fixture | Browse p95 | Ordinary alone p95 | Ordinary with browse p95 | Change |
|---|---:|---:|---:|---:|
| 1,040 rows, 26 matching attachments | 10.21 ms | 3.32 ms | 4.34 ms | +1.01 ms |
| 100 matching rows, 240 KiB framed JSON each | 14.23 ms | 10.48 ms | 11.91 ms | +1.43 ms |

The dense fixture uses valid JSON with trailing whitespace to exercise near-limit framed reads. It provides no estimate for more expensive application payloads with the same byte length.

A separate fixture timed 20 ordinary reads alone, 10 starting with four authentic 50 MiB hash verifications underway, and 10 while four published responses waited for drain. It checked real hash-read progress, suppressed automatic drains until release, and waited for descriptor close before the next round. Ordinary read p95 was 3.41 ms alone, 4.90 ms in the hash samples, and 3.60 ms in the stalled samples. The combined loaded p95 was 4.89 ms, a 1.47 ms increase. The uncapped host test admission was in its configured dry-run posture.

These are disposable local measurements. The initial concurrent-open attempts found fixture issues around reference creation, overlapping cleanup and deterministic drain. Only the corrected final run scored. Full verification, development-agent evidence and opt-in remain separate steps.

## Second-pass review

**Reviewer:** independent Claude sub-agent, fresh context, not the author of the merge (Parity session, 2026-11-27 03:55-03:58 PT), after the repair-lane second pass (echo-m5-review-2c-b3) dissented on the earlier head.

Verdict CONCUR WITH CHANGES on the combined 3799 + 3807 change merged with main. Applied: an open sheet makes its own fresh history read instead of sharing main's deduplicated readHistory, so a read started before the sheet opened cannot keep a stale sheet open; a fresh whole-PR trace is the last commit. Confirmed: no symbol the sheet uses was removed by main; cleanup in dispose and closeView runs once each with main's outbox and history-wait cleanup kept; the test helper keeps both page and chatPage callers working; no stale references to the removed draft spec outside old records; feature-ladders.json needs no re-stamp. Still owed before switching the feature on, named by the reviewer: tests for the sheet's remaining failure paths (Open answering 409 with Refresh, attachment-unavailable, 401 or 403, a length mismatch, the hidden-tab pause and Continue, the cross-tab attachment-context-observed message, and the unknown-conversation and attachment-browse-off closes). They need a whole-file run on a machine with disk room and follow as their own change.
