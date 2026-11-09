# Side effects: browser setup asks no PIN when the owner approves on the phone or in Telegram

Spec: docs/specs/browser-setup-no-second-pin.md (one independent security review, verdict SAFE WITH CHANGES, every required change included).

## What changed
- Setup route: the Bearer-principal check runs first on every path (`403 bearer-required`). The approval path is read once at step 5. On `telegram` no operator session is required and any header is ignored; the one-setup key is `enroll:`+sha256(enrollmentId); `session-used` there answers `409 setup-ended`. At most one browser setup pending (`409 browser-setup-waiting`); an owner Decline of a browser pauses browser setups for an hour (`429 browser-setups-paused`, in memory). On `dashboard` the PIN session stays required and step 9 refuses to activate without it.
- `activate()`: refuses `dashboard-pin` unless the request's own record, and `owner-agent` always, for browsers.
- Device name: `\p{Cf}` stripped at creation; "(the browser chose this name)" on both approval-message versions.
- `TelegramAdapter.sendOwnerDMWithButton` sends HTML-escaped text with `parse_mode: HTML` and `_formatMode: html` (the owner's pairing and browser approval messages only), so no caller text becomes markup.
- Dashboard: no PIN sheet on the `telegram` path; a 403 asking for the PIN shows it once; wording drops "You will be asked for your dashboard PIN" there.

## Review
1. Over-block: one pending browser at a time and the decline pause can make the owner wait (bounded: Decline then an hour, or the 30-minute pending life); accepted in the spec.
2. Under-block: no activation without the owner's approval (review finding 1-3); the PIN path unchanged without a Telegram owner.
3. Level: setup route and activation funnel, where the rules already live.
4. Signal vs authority: the owner's approval stays the only authority; the PIN is no longer asked on the path where it never approved anything.
5. Interactions: the one-waiting rule (`another-phone-waiting`) and the wrong-code budget, analysed in the spec's costs; phone-pairing approval messages now go out as escaped HTML too (same text, plain characters).
6. External surfaces: new error codes `bearer-required`, `setup-ended`, `browser-setup-waiting`, `browser-setups-paused`, all with plain detail text and dashboard wording.
7. Multi-machine: unchanged; setup runs on the Telegram-serving machine (physical-credential-locality); the decline pause is per machine and in memory.
8. Rollback: revert; no state or migration.

## 6b. Operator-surface quality
- (1) Leads with the action: "You will approve this browser on your iPhone with Face ID".
- (2) No internals in the wording.
- (3) No destructive action added.
- (4) Plain at phone width: one line fewer than before.

## Second pass
Independent security review (read-only agent) before the build; its required changes are all in. Concur, given those changes.
