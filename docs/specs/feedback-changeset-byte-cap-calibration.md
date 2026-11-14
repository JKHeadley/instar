---
title: "Feedback Change Set Byte Cap Calibration"
slug: "feedback-changeset-byte-cap-calibration"
author: "echo"
parent-spec: "docs/specs/feedback-triage-and-execution.md"
eli16-overview: "feedback-changeset-byte-cap-calibration.eli16.md"
---

# Feedback Change Set Byte Cap Calibration

## Problem statement

The approved feedback executor rejects a confined worker's change set above 200 files or 4 MiB of file bytes. It counts each modified file's **entire new contents**, not the edited lines. On 2026-11-04, executor attempt `feedback-1906b42c-77db-480a-b8d8-1929d8ae5803:a1` produced a candidate fix for a priority-90 Threadline report, then failed `changeset-too-large` before independent review or PR creation. The worker changed both `src/commands/server.ts` and `src/server/routes.ts`. At current main `0aa1391fdd7da425e1fe2e59b6c022830fc19069`, those two unchanged baseline files are 2,006,095 and 2,349,959 bytes respectively: 4,356,054 bytes before any test or helper files, so a valid small edit to both is mechanically impossible under the 4 MiB cap (4,194,304 bytes). The original spec's rationale sized the cap for `server.ts` plus a small test and did not account for this paired integration surface.

## Proposed design

Calibrate the *full-file byte* ceiling to **5 MiB (5,242,880 bytes)** while retaining its meaning and all other gates. `buildChangeSet` still walks with `lstat` and no-follow opens, rejects special files and workspace `.claude/` breaches, and compares bytes against the private publish clone. The 200-file ceiling remains. Above the prior 4 MiB ceiling, every changed file must be valid UTF-8 text without NUL bytes; opaque binary payloads retain the prior aggregate ceiling because a PR diff may show their metadata without their contents. Full modified contents remain subject to the credential scan. The independent review still refuses a changed-line diff over 192 KiB. The confined workspace and temp directory retain their separate 2 GiB resource limit. No worker authority or bypass is added.

Five MiB accommodates the measured pair of current integration files plus roughly 0.8 MiB of tests/helpers and retains a bounded full-byte payload. It is a 1 MiB increase, not an unbounded exemption for named files. A candidate over 5 MiB still fails before publish, as does a change set over 4 MiB containing binary content. This does not by itself validate or resurrect the rejected attempt; a new worker output must pass the full executor path.

## Decision points touched

- `src/feedback-factory/execute/executePolicy.ts` `CHANGESET_MAX_BYTES` — **invariant**: the existing deterministic resource/safety ceiling changes from 4 MiB to 5 MiB. A bounded byte ceiling is a hard safety invariant, not a competing-signal judgment.
- `buildChangeSet` binary allowance — **invariant**: it keeps the same fail-closed comparison, file count, special-file and secret gates. The new deterministic block decision applies only when an added or modified file has NUL or invalid UTF-8 bytes and the aggregate added/modified payload exceeds 4 MiB; deletions carry no payload.

## Acceptance criteria

1. A 200-file-or-smaller change set modifying both current-size integration files plus small focused tests under 5 MiB is accepted, proving the observed over-block is removed.
2. An added or modified payload above 5 MiB, a binary-containing change set above 4 MiB, and a set of 201 files are rejected with `changeset-too-large`. Symlink and `.claude/` breaches remain rejected.
3. Secret scanning still sees the entire bytes of each changed file, and independent diff review retains its 192 KiB refusal.
4. Unit, integration and production-path E2E test tiers pass at the exact published head; GitHub CI and local verification pass before merge. A real high-priority executor-produced fix must independently clear review and merge to demonstrate the pipeline, not be inferred from this calibration alone.

## Documentation alignment

Update the approved parent spec §4 step 8 and the `changeSet.ts` / `executePolicy.ts` comments in the same patch, so the published rule and the running gate agree.

## Multi-machine posture

The executor gate is a code invariant on the canonical owner. It introduces no new durable state, URL or notice. Every machine running this version applies the same limit to its own confined attempt; the existing canonical-owner rule still chooses which machine may execute. No new machine-local state is introduced.

## Rollback

Revert the ceiling to 4 MiB; no stored format or migration changes. An in-flight attempt admitted under 5 MiB remains subject to independent review, exact-head verification and CI; rollback does not silently merge it.

## Open questions

None. The measured full-file sizes and preserved downstream gates decide this narrow calibration.
