# Model-registry freshness guard — explained simply

## The problem

Instar talks to several AI providers — Claude, OpenAI (via codex), Gemini, and
others through pi. For each one, the code writes down which exact model to use
for "the heavy/capable tier" (the model our spec-review and converge teams lean
on). For example, Gemini's capable tier was pinned to `gemini-2.5-pro`.

The trouble is these pins **rot silently**. A provider ships a much newer, much
better model (Gemini 3-class arrived), but nothing in our codebase notices. The
old name keeps working, so nothing errors — we just quietly keep routing our
most important work to an old model. Nobody gets a warning. It's invisible until
someone happens to notice the answers are weaker than they should be. That's
exactly what happened: `gemini-2.5-pro` kept serving long after it was old.

## The idea

Add a small, boring, deterministic check (a "lint") that runs in CI and refuses
to let the list rot quietly. The key design choice: the check is **model-id-
agnostic**. It does NOT hard-code "the right answer is Gemini 3." Instead it
enforces two simple, mechanical rules so a *human* is forced to keep the list
honest.

## The two teeth

**Tooth 1 — Staleness.** The list carries a date: `lastReviewedAt`. If more than
45 days pass without someone reviewing the pins and bumping that date, the check
complains loudly. This is the anti-rot mechanism — it fires even if no model id
ever changes, because "nobody has looked in months" is itself the danger.

**Tooth 2 — Drift.** There's an explicit allowlist of "models we currently
consider frontier" per provider (`frontierAllowlist`). The check reads the ACTUAL
pinned model id straight out of the source files and asserts it's a member of
that allowlist. If someone changes a pin to a model that isn't on the reviewed
list — or forgets to add a new frontier model to the list — the check complains.
The only way to make it green is to reconcile the pin and the allowlist, and
doing that reconciliation IS the review we wanted.

## Why it's safe to ship today

Our current list is knowingly stale (we haven't confirmed the new Gemini/OpenAI
ids yet — that needs the operator, because a wrong model id breaks routing). So
the guard ships in **report mode**: it prints its findings in the CI log but
always passes (exit 0). It's visible but non-gating — a spotlight, not a
roadblock. Once the operator confirms the exact new model ids and we swap them
in, we flip one word in the manifest (`"report"` → `"strict"`) and the guard
starts failing the build on any future rot.

## What it deliberately does NOT do

It does not change any model id. Swapping `gemini-2.5-pro` for a Gemini-3 id is a
separate, operator-confirmed follow-up, because getting a model id wrong breaks
routing for real. This change is only the guard plus the audit findings.

## Where things live

- `scripts/lint-model-registry-freshness.mjs` — the checker.
- `scripts/model-registry-freshness.manifest.json` — the one file humans edit:
  the frontier allowlist, the list of pin locations, the review date, and the
  known-stale flags awaiting operator confirmation.
- `tests/unit/model-registry-freshness.test.ts` — proves both teeth fire on
  stale input and stay quiet on fresh input.

## The honest caveat

This guard catches the pins listed in its manifest. If a brand-new pin is added
somewhere else and nobody registers it in the manifest, the guard can't see it —
same limitation every manifest-driven lint in this repo has. The audit that
accompanied this change enumerated the known pin sites so the manifest starts
comprehensive.
