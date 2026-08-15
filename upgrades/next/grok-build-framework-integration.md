# Grok Build framework (additive, dark)

## What Changed

`grok-build` is now a valid fifth framework value wherever frameworks are
configured. It drives xAI's Grok Build CLI, authenticated by subscription
session (`grok login --device-auth`) with metered API keys REFUSED at the
adapter.

Nothing changes for an agent that does not opt in. Registration requires
`grok-build` in `enabledFrameworks`; interactive sessions require a SECOND,
separate opt-in (`sessions.grokInteractiveSessions`); headless job spawns do not
run on grok; and internal background routing excludes it structurally rather
than by flag.

Its weekly usage pool cannot be read in advance, so quota reports UNKNOWN
permanently and grok is excluded from every automatic placement and
failure-swap path. The billing sink is UNPROVEN — the CLI reports costs at 17%
of list, but what a tool reports is not what an account is charged, so every run
is budgeted as if metered and bounded by a local per-day ceiling.

When enabled and authenticated, grok becomes a third cross-model spec-review
family alongside GPT and Gemini — the actual reason to have it, since reviewers
from one model family share blind spots.

## What to Tell Your User

Most users need to know nothing: this is off unless you turn it on.

If you have a Grok subscription and want a third independent reviewer for spec
work, you can enable it — and two honest caveats come with it. First, we cannot
see how much of your weekly allowance is left, so the protection is our own
token counting plus a daily ceiling, not a vendor meter. Second, we have not
established whether xAI's terms permit automated review traffic on a personal
subscription; that question is open and blocks any use beyond a single
development machine.

If you enrol a Grok subscription in your account pool, note that it also changes
how CLAUDE work is throttled on a single-Claude-account agent, and that removing
`grok-build` from `enabledFrameworks` does NOT unenrol the account.

## Summary of New Capabilities

- **Enable it:** add `grok-build` to `enabledFrameworks` in `.instar/config.json`.
  Nothing happens without the CLI installed and a live subscription session.
- **Third review family:** once enabled and authenticated, spec convergence gains
  a genuinely independent third model family.
- **Pin a topic conversationally:** "use grok here". If the CLI is missing OR the
  interactive opt-in is unset, the pin falls back to the default framework with a
  notice naming WHICH of the two it was.
- **Honest quota:** `grok-build` always reports quota unknown. Read your own
  token accounting; there is no vendor display to trust.

## Evidence

- 18 convergence rounds; 6 independent internal reviewers plus an external
  cross-model pass each round. Reports in `docs/specs/reports/`.
- Adapter lane proven live end-to-end with real token accounting, under a real
  grok-primary agent's config, with both sides of the dark-ship gate exercised
  on the same build (registers on opt-in; `grok-not-enabled` without it).
- Confinement measured against the real binary with a probe whose only success
  signal is a genuine side effect: a file-read attempt is BLOCKED by the shipped
  argv, and an ordinary completion still returns its text.
- Three test tiers: unit, integration, e2e, plus wiring-integrity and
  both-sides controls on every fix that could be falsified.

## Why

Two external model families share blind spots; a third genuinely independent one
makes every future spec review stronger. The subscription path was chosen over
the API because the CLI authenticates by session with no key — which lets the
review door refuse key-based auth structurally rather than by policy — and
because only that path can eventually deliver an agent that RUNS on grok.

## Not closed

- **Tool-flag confinement depends partly on a vendor default.** Measured: grok's
  `--disallowed-tools` and an empty `--tools` are inert on 1.0.4. What holds is
  `--deny` plus grok's own approval gate. A CI confinement test that attempts a
  side effect is owed.
- **The reviewer budget's behaviour under concurrent reviews is reasoned, not
  measured.** Proving it requires genuinely concurrent processes.
- **A grok-ONLY agent has no outbound LLM gate**, because no intelligence
  provider is constructed at all. Disclosed; a guard-manifest entry is owed so
  it surfaces on `/guards` rather than a boot line.
- **Vendor policy is unexamined** and blocks use beyond a single dev machine.
