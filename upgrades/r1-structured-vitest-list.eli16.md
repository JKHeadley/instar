# Honest pre-push affected-test selection — Plain-English Overview

> The one-line version: the local pre-push smoke check now says “no tests” only when Vitest returns a valid, structured empty set; when selection cannot be determined, it says so instead of implying that tests passed.

## The problem in one breath

Before a branch is pushed, Instar runs a quick local test tier over tests affected by the branch. The script counted human-formatted lines printed by another program. If those lines disappeared or changed shape, the script could conclude there was nothing to test, or could decide the set was too large and skip it, even though it had not actually established either fact. A slow, disk-contended machine could also time out while listing tests and exit successfully without running them.

## What already exists

- **The local smoke tier** — gives contributors fast feedback without attempting to replace the complete remote test matrix.
- **Breadth limits** — deliberately skip local smoke when a genuinely large affected set would make a push impractically slow.
- **Authoritative CI** — runs the full protected test suite before merge, including when local smoke is skipped.

## What this adds

The test runner now writes its affected-test list as JSON to an explicit temporary file. The script validates the exact structure produced by the pinned Vitest version and counts structured entries and unique absolute file paths. It no longer interprets decorative lines or separators intended for human display.

A valid empty array still means “no affected tests.” Empty output, invalid JSON, old rendered output, a missing field, or a changed schema means “the affected set is indeterminate” and fails loudly. A valid non-empty array runs the existing smoke tier, while a valid set beyond the existing caps still takes the deliberate breadth skip.

## The new pieces

- **Strict list parser** — accepts the pinned `{name, file}` entry shape and rejects every unproved shape. This is boundary validation, not a guess about the meaning of arbitrary text.
- **Explicit selection outcomes** — keeps “no tests,” “run,” “too broad,” and “could not determine” separate rather than encoding several of them as a zero count.
- **Honest timeout result** — remains non-blocking because CI is the merge authority and local disk contention must not veto real work, but emits `SKIPPED`, `tests_run=0`, and a direct statement that the local tier did not pass.
- **Proof cache isolation** — allows verification to place Vitest scheduling cache outside the shared dependency tree, with no change to default operation.

## The safeguards

**Prevents a cosmetic output change from becoming a false pass.** The parser accepts only a version-pinned machine format. Missing or changed evidence cannot reach the reassuring no-tests path.

**Preserves useful local performance limits.** This does not make every push run the full suite. Genuine structured zero stays quiet, valid affected tests run, and valid oversized sets retain the existing CI-backed skip.

**Does not overstate local authority.** The timeout route is deliberately visible rather than blocking. CI remains the exhaustive merge authority, so the local tier is useful early evidence, not the final certification.

## What ships when

This is one contained contributor-tooling change: parser, pre-push orchestration, focused tests, and the proof-only cache seam ship together. It does not change CI or application runtime behavior.

## What you actually need to decide

Should the local smoke tier distinguish a proved empty affected set from every case where it could not determine the set, while keeping timeouts and genuinely broad sets non-blocking under authoritative CI?
