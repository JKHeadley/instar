# Side-Effects Review — ELI16-on-every-PR gate (PR description)

**Version / slug:** `eli16-pr-description-gate`
**Date:** `2026-06-05`
**Author:** `echo`
**Second-pass reviewer:** `required (a new gate that blocks EVERY PR)`

## Summary

Justin's standard (2026-06-05): every PR's DESCRIPTION must carry a plain-English ELI16 overview,
because the description is what a reviewer reads and approves when they open the PR link — and the
current PRs "have different formats." This adds a CI gate (`.github/workflows/eli16-pr-gate.yml`)
that runs a pure check (`scripts/eli16-pr-description-check.mjs`) on every PR body and FAILS the PR
when no ELI16 overview is present. The ELI16 *file* (`docs/specs/<slug>.eli16.md`) is unchanged and
still enforced at commit time by the instar-dev gate; this is the missing PR-body half.

## Decision-point inventory

One decision: does the PR body contain an ELI16 overview? PASS when (a) the author is a Bot, or
(b) the title is a `chore: release` cut, or (c) the body has a heading whose text contains
`ELI16`/`ELI-16`/`ELI 16` followed by >= 200 chars of (comment-stripped) content. Otherwise FAIL.

## 1. Over-block (what it blocks)

A human/agent PR whose description lacks a real ELI16 overview is blocked — that's the point. The
check re-runs on `edited`, so adding the overview to the description clears it WITHOUT a new push.
The failure message is actionable (tells you exactly what to add + that the file is a good source).

## 2. Under-block (what it lets through)

Bot PRs and the automated `chore: release` PR (which has no human reviewer reading an ELI16). A PR
that has a real ELI16 heading + >= 200 chars passes. The check measures content only up to the next
heading, so a one-line ELI16 followed by a long "What Changed" does NOT slip through (tested).

## 3. Blast radius — CRITICAL

This gate blocks EVERY non-exempt PR, so a false-fail would block the whole fleet's PRs. Mitigations:
the decision is a PURE function with 10 unit tests covering both sides AND every exemption (bot,
release-cut, the "title mentions release" non-exemption, null/empty inputs, the next-heading
boundary, comment-stripping). The gate is a NEW, additive workflow — it cannot affect existing
checks, builds, or releases; a failing PR is VISIBLE and self-clears on a description edit (not a
silent jam like the manifest/publish class). No `src/` runtime change.

## 4. Reversibility

Fully reversible: delete the workflow + script + test. No state, no migration. Verified: the check
script parses (`node --check`); 10/10 unit tests pass. This PR's own description carries an ELI16
overview (dogfoods the gate).
