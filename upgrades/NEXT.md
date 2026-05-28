# Instar Upgrade Guide — NEXT

<!-- bump: patch -->

## What Changed

**Post-publish smoke gate (publish-pipeline regression insurance).** A new step
after `npm publish` clean-installs the just-published version into a throwaway
prefix and runs `instar --version`, asserting the tarball actually installs and
reports the right version. If the publish pipeline ever ships a tarball missing
its compiled output, this catches it within minutes of release instead of when a
fresh install fails in the wild. (Track A was re-scoped from a "fix" to this gate:
the original "empty dist" scare was self-inflicted, not a real publish bug.)

## What to Tell Your User

- Internal release-pipeline hardening: after I publish a new version, CI now
  immediately does a clean install of it and checks it runs, so a broken release
  can't slip out unnoticed. Nothing changes for you — it's a safety net on my own
  shipping process.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Post-publish smoke gate | Automatic in the publish workflow — clean-installs the just-published version + asserts `instar --version`. |

## Evidence

**Re-scoped to regression insurance (the original premise was a self-inflicted
artifact, not a bug).** `scripts/post-publish-smoke.mjs` waits for npm
propagation, clean-installs into a throwaway prefix, asserts `dist/cli.js` exists
+ `--version` matches. Unit test `tests/unit/post-publish-smoke.test.ts` (4)
covers the pure version-match logic incl the 1.3.5-vs-1.3.55 substring trap.
`publish.yml` validates as YAML; the step mirrors the existing publish steps'
structure + gating. Side-effects review:
`upgrades/side-effects/publish-completeness-smoke-gate.md`. Spec: Track A of
`docs/specs/MULTI-MACHINE-BOOTSTRAP-ROBUSTNESS-SPEC.md`.
