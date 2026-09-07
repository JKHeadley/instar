# Telegram origin release certification

The explicit release issuer consumes an approved review manifest and signs the
final packaged bytes with the existing Instar release authority:

```bash
npm run release:certify-telegram-origin -- --package-root /release/final-package --review /release/reviews/approved-origin-review.json
```

Normal `build` and `prepublishOnly` do not invoke this command. Missing review,
missing trials, missing keys, invalid authority, expired evidence or changed
package bytes produce no certificate. Source discovery counts and version/HEAD
strings are not certification inputs.

The review manifest must be a JSON object with exactly `decision: "approved"`
and `certificate`. The latter is the unsigned `OriginReleaseCertification`
defined in `src/messaging/telegram-origin/OriginCertification.ts`:

- `schema`: `instar-telegram-origin-release-certification-v1`.
- `approvedAt`, `expiresAt`: original review approval and explicit expiration,
  integer Unix milliseconds. The issuer never replaces these with the current time.
- `reviewEvidenceDigest`: SHA-256 of the separately retained approved review.
- `buildDigest`: the reviewed final package fingerprint produced by the exported
  `fingerprintOriginPackage(packageRoot)` helper. The issuer independently
  recomputes it and requires equality.
- `producers`: reviewed producer IDs, shipped executable `entrypoints`, actual
  `authorContract`, and a `bindingEvidenceDigest` for each. Contracts are
  `deterministic`, `actual-call`, `session-observer`,
  `forwarded-or-explicit-unknown`, or `mixed-explicit`. Registering a producer
  does not prove its author binding. Lazy registration does not require every
  reviewed producer to be active simultaneously.
- `census`: `complete: true`, reviewed shipped executable `entrypoints`, and
  `evidenceDigest`. A regex candidate list alone does not establish completeness.
- `trials`: exactly one passing record each for `text`, `browser`,
  `hidden-display`, `attachment`, and `cross-machine-relay`, with original
  `completedAt` and retained `evidenceDigest`. Trial times must precede approval.

Keep the review manifest and raw evidence outside the package's shipped roots.
Retain their referenced evidence with the release review. The issuer validates
the signed claims and package bindings; the release reviewer remains responsible
for inspecting the real evidence and approving its completeness.

Finish all build steps and stage the exact package payload before review and
issuance. Every file under every `package.json.files` root, plus `package.json`,
participates in the fingerprint. Only
`src/data/telegramOriginCertification.json` is excluded to avoid self-hashing.
Any later build, packaging transformation or source change affecting shipped
bytes requires renewed review of the resulting fingerprint. Verify the final
extracted package with `inspectOriginCertification(packageRoot)` before release.

Signing-key resolution follows `scripts/sign-instar-lockfile.mjs`: first
`INSTAR_RELEASE_PRIVATE_KEY_PEM`, then `INSTAR_RELEASE_PRIVATE_KEY_PEM_PATH`,
then `.instar-release-keys/private.pem` under the issuer installation. An
explicitly selected unreadable key fails without falling through. The private
key must match the packaged `dist/keys/instar-release-pub.pem`. Signatures use
the dedicated origin-certification domain; other release signatures cannot be
substituted. The tool never prints keys or review contents.

The output is atomically created at the excluded certificate path. Existing
certificates are never overwritten; use a clean staging package for a new
reviewed release. Staging and package must share a filesystem. No real
certificate has been issued by adding this tool, and current unsigned
development artifacts do not establish release or fleet completion.
