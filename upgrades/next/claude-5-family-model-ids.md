# The Claude 5 Models Can Be Pinned, and the Configured Default Stops Being Discarded

<!-- bump: patch -->

## What Changed

instar gates claude-code model ids against a closed list — an unknown id is refused so a
typo can never launch a session that dies at startup. That list had aged out a generation:
it topped out at `claude-fable-5` / `claude-opus-4-8`, so pinning a topic to Fable 5.1 was
refused `off-enum` on a machine whose CLI runs the model on demand. A stale list and a
deliberate policy refusal produce the same message, which is what made this read as "instar
doesn't support that model."

The same staleness had a second, quieter effect. `frameworkDefaultModels['claude-code']`
was already set to `claude-opus-5` on installs that had moved to the Claude 5 family — and
because that id was off the list too, it was being dropped at the resolution clamp and the
session fell through to the CLI's own default. The configured value was being discarded with
no operator-visible reason.

`claude-fable-5-1`, `claude-opus-5`, `claude-sonnet-5` and the `fable` tier alias are added,
each verified working first against claude-code CLI 2.1.263 — only observed-working ids are
added, and a test now asserts that an unverified sibling (`claude-fable-6`, `claude-opus-6`)
is still refused, so the list cannot drift from "verified" to "seemed likely." The `fable`
alias closes a plain asymmetry: `opus`, `sonnet` and `haiku` were already accepted as
shorthand and `fable` was not.

Recognized is deliberately not promoted to preferred. The escalation policy still points at
`claude-fable-5`, and `claude-fable-5-1` is not added to the model registry's frontier set —
a model earns the routing lane via benchmarks, not release date. The registry's claude-code
door note records that distinction, and records the drift this closes: the 2026-08-18 review
had already classified `claude-opus-5` and `claude-sonnet-5` as frontier while the
acceptance list still refused them, so the two layers had been disagreeing for three weeks.

## What to Tell Your User

You can now pin a conversation to Fable 5.1, Opus 5 or Sonnet 5 the way you pin any other
model — just say so in the topic — and `fable` works as shorthand alongside `opus`,
`sonnet` and `haiku`. If your configuration already named one of the Claude 5 models as its
default, that setting starts being honored instead of quietly ignored. Nothing changes for
any model that already worked, and no conversation changes model on its own as a result of
this.

## Summary of New Capabilities

- `claude-fable-5-1`, `claude-opus-5` and `claude-sonnet-5` are valid claude-code model ids
  for topic-profile pins and session spawns.
- `fable` joins `opus` / `sonnet` / `haiku` as an accepted CLI tier alias.
- A configured `frameworkDefaultModels['claude-code']` naming a Claude 5 model is now
  honored rather than dropped at the resolution clamp.
- Unverified sibling claude ids still fail closed, now with a test holding that.

## Evidence

Each of the four ids was run against the installed CLI (`claude --model <id> -p`, claude-code
2.1.263) and observed answering before being listed. Unit tests cover the new ids against the
pin validator and — through the existing route-parity guard — the spawn route, the fail-closed
refusal of unverified siblings, the `fable` alias, the subscription billing-lane premise for
each new id, and an end-to-end reproduction of the reported refusal (a Fable 5.1 pin arriving
on a topic still resolved to codex-cli). Falsified before being trusted: with the enum change
stashed, five of the new assertions fail for the right reason (`off-enum`); restored, 70/70
pass. The three existing `not.toContain('claude-fable-5')` adapter assertions were checked
against the substring hazard introduced by `claude-fable-5-1` and pass. Typecheck clean; the
strict model-registry freshness lint passes with the updated door note.
