# Stage-B Release Evidence Binds to the Certified Code

<!-- bump: patch -->

## What Changed

The Stage-B publish gate bound its signed canary evidence to a version number,
which can match exactly once: the named version shipped, every later release
failed the binding check, and publishing froze for the whole fleet. The gate
now binds the evidence to the code the canary actually certified. A reviewed
manifest lists the certified Stage-B sources (their import closure is
recomputed on every check, and every member must be certified or excluded with
a written reason — anything new fails closed), a fingerprint of their exact
bytes, and the canonical digest of the signed evidence. Publishing verifies
the sources still match the manifest; the runtime fleet-activation path,
which had the same version binding and would have kept Stage B silently dark
on every later release, verifies the same linkage. The rebinding tool
structurally refuses to re-stamp old evidence onto changed code: changed
certified sources require fresh embedded canary evidence. The canary
thresholds themselves — two hours, fifty deliveries, full case matrix, zero
failures, signed approval — are unchanged.

## What to Tell Your User

Updates flow again. Releases were frozen for two days by a safety gate that
tied its proof to a version number; the proof is now tied to the code it
actually vouches for, so releases pass while that code is unchanged and a real
change to it still demands a fresh certification run first.

## Summary of New Capabilities

- Releases publish again: the two days of merged fixes (including the
  signed-message labelling fix) ship in the next release.
- A change to certified Stage-B code still blocks publishing until a fresh
  canary is approved, and now the block names exactly which files drifted.
- The certified/excluded partition is explicit, reviewed, and fail-closed for
  new imports, so coverage cannot rot silently.

## Evidence

Eighteen new unit tests cover the canonical digest (order stability, field
and signature sensitivity, manifest linkage), the version-independent
verifier on both publish and runtime paths, the tampered-evidence and
config-binding refusals, the manifest partition invariants, and the tool and
hook wiring. The existing Stage-B activation, readiness, forensics, and
publish-gate suites pass unchanged except two tests updated for the
override-seam scoping. The live publish verifier passes on this tree for a
future version number.
