# ELI16 — Two deterministic lint floors for Standards A and B

## The one-sentence version

Two tiny no-AI checkers now read a design spec's plain text and flag when it forgets
the "which machine does this live on?" tag (Standard A) or writes a broken
"try to fix it yourself before bugging the operator" plan (Standard B) — cheap
signals that back up the smart reviewer instead of replacing it.

## Why this exists

Instar's constitution has two rules that used to live only in prose and reviewer
habit:

- **Standard A — "always multi-machine":** every piece of state a feature adds should
  be SHARED across all the agent's machines by default. Keeping it on one machine is
  only allowed for a short list of concrete reasons (a login/key that physically sits
  on one disk, a piece of hardware, or something the operator explicitly signed off on).
  This rule was ratified *because* a spec once wrongly kept its memory on one machine
  and it survived SEVEN review rounds — only the operator caught it.
- **Standard B — "self-heal before notify":** a watchdog should try a bounded, logged
  self-repair FIRST and only ping the operator when that repair genuinely runs out of
  road. A repair plan that does nothing, or that can retry forever, is exactly the trap
  the rule forbids.

The smart `/spec-converge` reviewer already reads for these. But "a reviewer will
notice" is willpower, and Instar's root rule is **structure beats willpower**. So each
rule gets a cheap deterministic floor that runs first and never needs to remember.

## What actually shipped

Two small parser scripts (no AI, just text rules) plus their tests:

- **`scripts/lint-machine-local-justification.js` (Standard A).** It looks in a spec's
  `## Multi-machine posture` section. If the spec says a surface is "machine-local" but
  carries no `machine-local-justification: <reason>` tag, that's a finding. It also
  checks the OTHER direction: a tag with a made-up reason (not one of the three allowed),
  or an "operator ratified it" claim that cites no checkable proof (a commit SHA, a URL,
  or a registry key), is also a finding.
- **`scripts/lint-self-heal-fields.js` (Standard B).** When a spec declares a watchdog's
  self-heal, it must list all its brakes (max attempts, time limit, backoff, dedupe key,
  a breaker, a notification deadline with real units like "300s", an audit location, and
  the concrete repair actions), plus the severity class. An empty repair-actions list
  (the fake heal that does nothing) or a deadline written as a bare "300" with no units
  is a finding.

Both are registered in `docs/STANDARDS-REGISTRY.md` so Instar's own conformance auditor
now grades Standards A and B as enforced by a real deterministic `lint` on disk, not just
"documented" (the auditor confirmed: 0 → 2 lint-enforced standards).

## The important nuance: report-first

These lints ship in **report mode** — they PRINT their findings but exit 0 (they do not
block anything yet). A `--strict` flag makes them exit non-zero; that is the FAIL
capability the tests exercise and the hook a future graduation can flip on. This is
deliberate: the marker convention is brand new, existing specs predate it, and the spec's
own honesty clause says the deterministic floor's grade is "inert until the registry
ship." Shipping a brand-new blocking gate over the whole spec corpus would be a wall of
false failures. Report-first is the graduated-rollout path Instar always takes with a new
enforcement.

## Signal vs. authority

Neither lint decides the hard question. Standard A's lint cannot tell whether a
justification is TRUE; Standard B's lint cannot tell whether a repair is genuinely
SUBSTANTIVE or a severity label is HONEST. Those calls stay with the smart `/spec-converge`
reviewer. The lint is the cheap body; the reviewer is the mind. Together they enforce the
rule; neither alone does.

## What did NOT change

No constitutional text was written or re-ratified — Standards A and B were already
ratified by the operator on 2026-07-03. This change is purely the enforcement machinery
(two lints + tests + the registry rows that register them as guards). It touches no
runtime server code and changes nothing for a user.
