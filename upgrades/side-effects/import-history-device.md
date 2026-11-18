# Side effects: the Instar app reaches imported history (import slice 2)

Spec: `docs/specs/import-from-claude-chatgpt.md` §B.3 (the Imported section in the app) and §D (Import from the app's settings). This builds on #3349.

## Change
- `src/server/importedHistoryRoutes.ts`: every route is also served at `/mobile/imported-history/...`. A new `deviceOwnerOk` dep makes the owner's signed app device an owner caller, which reads raw, like the dashboard owner session.
- `src/server/mobilePairingRoutes.ts` `DEVICE_ALLOWLIST`:
  - GET conversations, projects, one conversation (an `imported:` reference only) and search;
  - POST preview and apply;
  - all `ownerOnly`, with their own rate buckets;
  - none in `BROWSER_ROUTES`, so a browser device is refused.
- `src/server/routes.ts`: `deviceOwnerOk` accepts a device principal whose person is the owner and whose client isn't a browser.

## Who is affected
Nobody until the Instar app's Imported section ships (echo-instar-desktop-app). The bearer and operator-session behaviour is unchanged.

## Rollback
Revert. The app's Imported section then gets 403 and shows nothing.

## Review
An independent security review concurred. It verified that the device authenticator runs first and sets these fields, and that team devices, browser devices, notify tokens and devices with no known person are refused before the route. Its test gaps are added: the owner-device check as a tested function, and the bearer on a /mobile path still getting quoted text.
