# Side-Effects Review — Dashboard Devices

## Summary

Tier 1. Two dashboard entry points use Devices as the public label. Paired device rows keep their prior status and removal IDs. The standalone page starts the existing Conversations browser setup by explicit click after PIN unlock.

## Decision-point Inventory

The list projects the current visible device records. Known native computer and browser records take the computer label. Legacy untyped responses without a browser discriminator take the neutral Device label. The API's existing storage convention identifies non-computer app enrollments as phones. Document-scoped links get a separate status so the Conversations browser switch cannot make them look disabled.

The link button uses the existing browser adapter and bound registration proof. A session check applies before loading it and before each request. The browser adapter owns its existing retry window, local key storage, and approval policy. A refused enrollment displays a retry or disabled message. Removing a row still asks for confirmation and calls the existing exact-device revoke route.

## Existing behavior and access

The legacy tab ID, standalone path, pairing hash, PIN challenge, token lifetime, and CSP are preserved. The device response adds a kind and a document-link marker to already-visible records. It does not add a route, key material, identity fields, eligibility, or authorization. Existing operator and device scoping still apply. No config migration.

## 6b. Operator-surface Quality

The Devices title matches navigation. One list identifies phones, computers, and document browsers. The browser setup button and Remove controls have 44 CSS-pixel minimum targets. The first screen on both fixture widths shows Link this computer, with enough room for device names and status text. Remove identifies the selected device and asks for confirmation. PIN and any existing out-of-band approval remain in the flow.

The wording works for any agent with the dashboard. No agent, account, hostname, or person is assumed by the renderer.

## Multi-machine posture

The dashboard uses the same local device query. Document browsers already represented on this agent appear alongside other devices. No cross-machine inventory read or action is added. Browser enrollment stays host-bound and uses the existing approval path and settings.

## Rollback

Reverting the change rolls back the label, screen and additive response metadata. Devices enrolled through the existing flow remain linked until removed normally.

## Verification

Focused renderer and HTTP tests cover the list projection and pairing. A disposable browser fixture exercises layout and existing browser enrollment at 1280 and 390 pixels. Coordinator verification and release follow the normal publication process.

## Class-Closure Declaration

No agent-authored-artifact defect. No new controller, scheduled work, or change to an existing trigger.
