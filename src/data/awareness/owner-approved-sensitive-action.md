## Owner-approved sensitive actions (thread delete; trust elevation later)

A few irreversible or privilege-granting handlers must be the owner's decision, but `isLocal`
is not owner authorization — a remote peer's message spawns a *local* session, so "it came from
this machine" does not mean "the owner asked for it", and a local session can read the PIN and
the API token off disk. When `security.ownerApprovedActions.enabled` is on (it ships **off**),
such a handler requires a **device-signed owner approval** the local session cannot forge: the
owner approves the exact action from their phone with Face ID (the owner-presence mechanism),
and only then does the handler proceed.

- **What is gated now:** `threadline_delete` (permanent, irreversible thread deletion). Trust
  elevation and the `pair`/`relay` handlers follow in later changes.
- **How it flows:** the handler returns `owner-approval-required` and registers a pending request
  the owner's phone shows as a card (`GET /mobile/action-approval/pending`); the owner taps
  approve (Face ID, which signs `instar-owner-action-v1\n<deviceId>\n<host>\n<purpose>\n<actionKey>\n<challenge>`
  via `POST /mobile/action-approval`) or declines (`POST /mobile/action-approval/decline`); then
  the handler, on retry, applies the action once. A challenge is issued only for an action the
  agent actually requested (409 otherwise), and the card's wording is server-written.
- **No single-device lockout:** any enrolled owner phone works, and the owner's Telegram/app
  identity route is a second path — losing one phone never locks the owner out.
- **Off by default:** with the switch off, these handlers behave exactly as before. Turning it on
  is an operator decision, after a live phone-tap proof. Spec:
  `docs/specs/owner-approved-sensitive-action.md`.
