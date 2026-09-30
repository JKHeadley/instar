# Jev helps the message gate spot technical artefacts (development agents)

## What Changed

The tone gate's judge is handed a list of "artefact signals" (a raw path, a
command, a config key, an endpoint, code to paste, an env var, a cron line or
internal slug) before it rules on B1–B7. Until now only the hand-written
detectors produced that list; Jev ran beside them as a measure-only shadow.

With the new `intelligence.jevSignalLive` switch, the gate asks Jev first (one
bounded call, at most `timeoutMs` + 250 ms, default 1000 ms). Where Jev is
confident (probability outside 0.30–0.70) its answer decides that signal,
labelled `source=jev`; where it is unsure, or the call fails, times out, or the
vendor breaker is open, the detector decides exactly as before. A detector hit
Jev confidently disputes still counts as detected and is annotated
`model_disagrees`, so the judge sees both and the rule still applies. When no confident answer shaped the list,
the prompt and its promptId are byte-identical to before.

- Consulted only on the outbound messaging route (the one caller with an
  override path), where the advisory migration makes B1–B7 overridable AND
  decision-quality recording is live (otherwise the route would turn the
  advisory back into a hard hold); every other caller of the gate keeps the
  detector-only path; never a
  new block. The credential wall, B15–B19, and the degraded deterministic floor
  are untouched.
- The live call is the shadow's own measurement call (no extra vendor calls);
  its text is secret-scrubbed first; three consecutive failures pause live mode
  for five minutes.
- Rows in `logs/jev-signal-shadow.jsonl` carry `live: true` and, per rule,
  `liveSources` (`jev` / `detector-fallback`); late answers are marked `liveLate`.
- The provenance promptId is `tone-gate-sigv1-jev` when Jev shaped the list.
- Dev-gated: `enabled` is omitted by default (live on a development agent, dark
  on the fleet); explicit `false` is the kill switch, read live. Existing agents
  get the default block through the config migration and a CLAUDE.md awareness
  card through the CLAUDE.md migration.

## Evidence

- `tests/unit/jev-signal-live.test.ts`: every merge branch (confident yes/no with
  and without a detector hit, unsure, missing, per-rule band, nothing confident
  ⇒ untouched list); live off ⇒ null and no call; scrubbing before egress; each
  failure shape falls back; a hanging fetch is bounded and its late row is
  marked; stale-slot reclaim; the breaker opens after three consecutive failures
  and closes after five minutes; the gate never consults Jev with the advisory
  migration off and is byte-identical when nothing was confident. Mutating the
  keep-on-disagreement, scrub, breaker, or advisory-migration check fails the suite.
- `tests/integration/jev-signal-live-gate.test.ts`: the production factory behind
  a real gate — dev agent live, fleet dark, fleet flip without the advisory
  migration still dark, the kill switch read live, an outage costs a bounded wait.
- `tests/e2e/jev-signal-live-lifecycle.test.ts`: migration adds the block without
  `enabled` and never overwrites; the CLAUDE.md card lands once; the feature is
  alive on a development agent and dark on the fleet.
- Measurement basis (logs since 2026-09-28T18:05Z): confident Jev answers 75/75
  agreed with the Luna referee (detectors 72/75); unsure band Jev 70/96 vs
  detectors 54/96; Jev latency p99 834 ms.

## What to Tell Your User

Nothing changes unless you run a development agent. On a development agent,
the check that looks for technical details in my messages (file paths,
commands, settings names) now also asks a fast specialist model, and uses its
answer where it is confident. It can't block anything on its own, and if it is
slow or down I fall back to the old check within about a second.

## Summary of New Capabilities

- `intelligence.jevSignalLive` — Jev as a live, advisory input to the tone gate's
  artefact signals (dev-gated; `enabled: false` turns it off immediately).
