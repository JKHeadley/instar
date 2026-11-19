# An oversized upload is cut off at its limit, and a device id alone opens less

<!-- bump: patch -->

## What Changed

SEC-118. Two gaps in the pre-auth body budget (SEC-103):
- **Chunked uploads were read in full before refusal.** body-parser reports an over-limit body only after the whole request has arrived, so a chunked upload with no declared length was read to the end before its 413. A new guard, `boundedBody`, counts bytes as they arrive and refuses at the limit: it answers 413, pauses the stream and closes the socket. It wraps the budget parser's small and peer tiers and every fixed-size pre-auth parser. It only counts bodies of the parser's own content type, so other bodies pass through untouched.
- **A device id unlocked the large budget anywhere.** A paired device's narrowed admission now opens the large budget only on device-allowlist routes that take a body.

## What to Tell Your User

- **Harder to overload before sign-in**: "Before anyone signs in, my server now stops reading an oversized upload the moment it passes the limit, instead of reading to the end first."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Oversized bodies cut at the limit before sign-in | Automatic |

## Evidence

- `tests/unit/body-budget-before-auth.test.ts`:
  - an endless chunked upload to a fixed parser and to the budget parser is answered 413 and closed while the client is still sending;
  - an oversized body gets 413 with `Connection: close`;
  - a device id opens the large budget only on a device body route, and is refused when no route check is wired;
  - `deviceRouteTakesBody` agrees with the real allowlist;
  - a form-encoded body passes the JSON guard whole.
- A standalone reproduction showed plain `express.json` with a 1 KB limit still reading at about 1.2 MB, with no answer after 1.5 s.
