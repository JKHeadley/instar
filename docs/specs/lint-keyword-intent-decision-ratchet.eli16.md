# Keyword-Intent Decision Ratchet — Plain-English Overview

> The one-line version: a new test that keeps watch for code that tries to guess what a person MEANT by matching their words against a fixed keyword list — the exact mistake that once made the agent swallow the operator's message.

## The problem in one breath

On 2026-07-03 the agent had a little rule that decided "is this a move-my-work-to-another-machine command?" by checking the message for verbs like `move`, `run`, `keep`. The operator said "keep the work on the laptop" — plain conversation — and that word `keep` tripped the rule, so the message was treated as a command and eaten before the agent ever read it. Keyword lists are brittle in both directions: they fire on ordinary talk and miss real requests. We live inside an intelligence that understands context, so a decision about what a human meant should be made by that intelligence reasoning over the whole message, not by a lookup table of trigger words.

## What already exists

- **The standard "Intelligence Infers, Keywords Only Guard"** — the just-locked constitutional rule that says: an LLM (with conversation context) decides what a human meant; a keyword/phrase/regex list is never the decider. Only two exceptions survive — validating a value against a fixed closed set (e.g. "is this one of off/low/medium/high?"), and a deliberate safety FLOOR (the emergency-stop fast path) that always has an LLM stage behind it.
- **The audit** (`docs/audits/keyword-intent-classification-audit-2026-07-03.md`) — a full sweep of the source that found exactly six places doing the bad thing, and carefully cleared everything else (error-message classifiers, security scrubbers, enum validators, and code that reads the agent's OWN output rather than a user's message).
- **The `no-silent-fallbacks` ratchet** — a sibling test that counts a known class of problems and refuses to let the number grow. This new ratchet copies its shape exactly.

## What this adds

A single new test, `tests/unit/keyword-intent-decision-ratchet.test.ts`, that walks the five source directories, spots the "keyword list decides meaning" pattern, subtracts the audit's cleared cases, and reports how many genuine offenders remain. Today that number is six — the exact list the audit found. The number can only go down; a brand-new offender in a new file would push it up and (once enforcement is switched on) fail the build.

Secondary change: a one-line comment marker, `@intent-safety-floor-ok`, added to `MessageSentinel` (the emergency-stop code). That marker is how a legitimate safety floor declares itself so the ratchet leaves it alone — mirroring the existing `@silent-fallback-ok` convention.

## The new pieces

- **The detector** — two signatures. One finds a named list of natural-language words (like `TRANSFER_VERBS`) that is then tested against a message/text variable. The other finds an inline English-phrase regex (like `/^open this$/`) tested against message text. It deliberately errs toward MISSING a subtle case rather than falsely flagging an innocent enum validator, because a noisy ratchet gets ignored and switched off.
- **The allowlist** — a short, explicit list of files the detector trips on but that are NOT the mistake (they classify an error message, scrub secrets, pick a cosmetic emoji, or read the agent's own output). Each entry says, in one line, why it's cleared. This is what makes the very first run come out clean instead of noisy.
- **The safety-floor marker** — `@intent-safety-floor-ok`, so a genuine emergency-stop floor exempts itself in place instead of needing an allowlist edit.

## The safeguards

**Prevents a noisy false alarm.** The detector is tuned to under-report, not over-report, and the allowlist covers every cleared case from the audit, so the landing run flags exactly the six known offenders and nothing innocent.

**Prevents silent scope creep.** The baseline is a hard number (six). Any new keyword-list-decides-meaning code raises the count and is surfaced immediately in the test output, with a "NET-NEW" tag pointing at the offending file.

**Prevents blocking unrelated work during the soak.** It ships in report mode: it prints its findings but never fails CI yet. Only after a clean soak does someone flip one flag to make it enforcing — the same graduated rollout every ratchet here uses.

## What ships when

All at once, in one small PR: the ratchet test, the one-line safety-floor marker, and the design/audit/standard docs it references. It is enforcement-in-report-mode from day one; the flip to hard enforcement is a later, deliberate one-line change after the soak confirms zero false positives in CI.
