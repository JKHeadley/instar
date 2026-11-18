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

## Confirmed facts (spec §B.9)
`POST /imported-history/facts` and `/mobile/imported-history/facts` take `{from, facts:[string]}`. They are for the owner only, from the operator session or the app device; the agent's bearer gets 403, because the person ticks the facts in the app. Each fact is scrubbed of secrets again and stored through `SemanticMemory.remember` as a `fact`, with `source import:<from>` and private to the owner (`privacyScope: private`, ownerId being the memory owner). It answers 503 when long-term memory is off. Tests: the integration case covers the agent being refused, secrets removed, bad input and memory off; the allowlist test covers `facts`.

## Device-route inventory verification

The shared mobile route test now exercises all seven owner-only history operations, including selecting one imported conversation and saving confirmed facts. The mobile terminal and imported-history device-rule tests passed together (24 tests).

## Merge with main after #3349 landed (2026-11-18)

#3349 was squash-merged (ced37add9), so this branch's copy of it conflicted with main. Resolution: the merged tree is exactly main plus this PR's own commits (20d5acd1d..4bc9b40c1) replayed on main; the only hand resolution kept both main's machine-care entries and this PR's imported-history entries in the device allowlist test, each once. No behaviour change. Unit: imported-history device rules + mobile-session-terminal + two imported-history files, 24/24; typecheck clean.
