# Side-Effects Review — Reviewer-Door Rewiring inc2 (per-family review timeout knob)

**Version / slug:** `reviewer-door-rewiring-inc2`
**Date:** `2026-07-04`
**Author:** `echo (build hand)`
**Tier:** `1`
**Second-pass reviewer:** `not required (Tier-1: no default value changed, absent-config byte-identical, config-reversible, no durable state / external side-effects; PR is the review surface)`

## Summary of the change

inc2 of REVIEWER-DOOR-REWIRING adds the per-family reviewer-call timeout knob
(`specConverge.reviewers.timeoutMs`, §3.2 / §7 / D6). It resolves a per-family
timeout from the config knob and threads it through all three reviewer families'
invocations (codex-cli, gemini-cli, claude-code). The knob accepts EITHER a single
number (applies to all families) OR a `{ default, byFramework }` map (per-family
override with a default fallback). Absent config resolves to today's exact 120s
default (`REVIEW_TIMEOUT_MS`) for every family — fleet behavior byte-identical.
Every resolved value is clamped to [30s, 900s]. inc2 ONLY adds the knob: it changes
no family's default timeout value (the measure-first gemini 600s raise is inc3's
dogfood decision, not built here).

Files touched:

- `src/core/crossModelReviewer.ts` — new `resolveReviewerTimeoutMs(config, frameworkId)`
  resolver + `REVIEWER_TIMEOUT_MIN_MS` / `REVIEWER_TIMEOUT_MAX_MS` clamp constants + the
  `timeoutMs` field on the `ReviewerConfig.specConverge.reviewers` type; `runCrossModelReview`
  resolves the per-family timeout from the knob (`args.timeoutMs ?? resolveReviewerTimeoutMs(...)`).
- `skills/spec-converge/scripts/cross-model-review.mjs` — the `--family` path resolves its
  per-family timeout from the knob when no explicit `--timeout-ms` is passed.
- `tests/unit/crossModelReviewer-per-family-timeout.test.ts` — new unit + wiring test file (16 tests).

## Decision-point inventory

- `specConverge.reviewers.timeoutMs` config field — **add** — a per-family knob (number OR map). Absent-safe.
- `resolveReviewerTimeoutMs` — **add** — pure resolver (single-number / byFramework / default / absent) + clamp.
- `REVIEWER_TIMEOUT_MIN_MS` / `REVIEWER_TIMEOUT_MAX_MS` — **add** — exported clamp bounds (30s / 900s).
- `runCrossModelReview` timeout resolution — **modify** — resolves per detected `framework.id` (was a bare `?? REVIEW_TIMEOUT_MS`); an explicit caller value still wins.
- `cross-model-review.mjs --family` timeout resolution — **modify** — resolves per `familyEntry.id`; explicit `--timeout-ms` still wins.
- No block/allow gate, no HTTP route, no scheduler job, no watcher is introduced or modified.
- No default timeout VALUE is changed.

---

## 1. Over-block

**What legitimate inputs does this change reject that it shouldn't?**

Nothing is rejected. The knob is purely additive and read per-invocation. A garbage
value (NaN, a string, null, Infinity, a non-finite `default`/`byFramework`) falls back
to the 120s default rather than throwing or producing a NaN timeout — the resolver is
pure and never throws. A below-floor or above-ceiling value is clamped, not refused, so a
misconfiguration still yields a working (bounded) timeout rather than a failed review.

## 2. Under-block

**What bad inputs does this change now allow through that it shouldn't?**

The clamp bounds this precisely: a value below 30s cannot starve a reviewer into an
instant timeout, and a value above 900s cannot create a 10-round × huge-timeout tail.
The knob only sets a *time budget*; it grants no authority, changes no egress
destination, and cannot alter the cross-model flag (that is `crossFamily` semantics from
inc1, untouched here). An explicit `--timeout-ms` dev override still wins over the knob,
preserving existing test/dev affordances.

## 3. Blast radius

**If this change is wrong, what breaks and how widely?**

Bounded to the spec-converge external-reviewer call timeouts on a development agent. On
the fleet the knob is absent, so behavior is byte-identical to today (120s per family) —
a bug in the resolver could only surface where an operator has deliberately set the knob.
Worst case of a resolver bug is a wrong (but clamped, 30–900s) timeout on a reviewer call,
which degrades loudly as a timeout and never blocks convergence (Signal vs. Authority,
§6). No durable state, no external side-effect, no data migration.

## 4. Reversibility

**How is this rolled back?**

Delete the `specConverge.reviewers.timeoutMs` config value → the resolver returns the 120s
default for every family. Or revert this PR (constants + resolver + two call-site edits +
one test file). No persistence, no interface consumed downstream (the field is
disclosure-free config read per invocation).

## 5. Migration parity

New config field `specConverge.reviewers.timeoutMs` — absent-safe by construction (no
`migrateConfig` entry needed for fleet correctness; fleet-absence = today's behavior).
`.instar/config.json` is machine-local (no config replication in instar), so setting the
knob is a per-machine edit. No settings.json hooks, no CLAUDE.md template section (this is
instar-developing-agent tooling, not an end-user capability).

## 6. Framework generality

The knob is threaded through the framework-agnostic reviewer registry: the same resolver
is applied per `framework.id` for codex-cli, gemini-cli, and claude-code alike (and any
future family added to `SUPPORTED_REVIEWER_FRAMEWORKS`). It routes through the reviewer
abstraction rather than assuming any single framework; per-framework values are the whole
point (gemini's reasoning-burn needs more headroom than codex's ~18.5s latency).

## 7. Testing

Unit + wiring (16 tests, `tests/unit/crossModelReviewer-per-family-timeout.test.ts`):
single-number applies to all families; `byFramework` overrides per family with default
fallback; **absent config → exactly 120s for every family (byte-identical)**; clamp
(10s→30s, 2000s→900s, in-range passthrough, clamp within map/default); each family's
invocation actually receives its resolved timeout through the driver (codex + gemini via
forced detection, claude via the family entry) — per-family, not uniform; and an explicit
caller timeout wins over the knob. Existing crossModelReviewer unit + integration suites
re-run green (105 unit + 10 integration).
