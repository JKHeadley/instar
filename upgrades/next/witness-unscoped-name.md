# Witness publishes as `instar-witness`

## What Changed

The Witness package now publishes to npm as `instar-witness` instead of `@instar/witness`. The first publish was refused (E404 on PUT) because there is no npm organization named `instar`, so the scope does not exist. The unscoped name was free, and the account that publishes `instar` can publish it. Only the package name, its README and the publish workflow changed. The code is unchanged.

## What to Tell Your User

The Witness tool installs with `npm install -g instar-witness`, and the command is still `witness`.

## Summary of New Capabilities

- None. This changes the package name only.

## Evidence

- Publish run 38589201624: `npm error 404 Not Found - PUT https://registry.npmjs.org/@instar%2fwitness`.
- `https://registry.npmjs.org/instar-witness` returned 404 (name free) before this change.
