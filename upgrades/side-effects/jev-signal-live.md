# Side-Effects Review — Jev as a live advisory input to the tone gate's artefact signals

**Version / slug:** `jev-signal-live`
**Date:** `2026-09-29`
**Author:** `echo`
**Second-pass reviewer:** `independent review subagent (spec-converge panel, three rounds) + codex-cli gpt-6-astra`

## Summary of the change

The tone gate's LLM judge is handed a list of B1–B7 "artefact signals" before it
rules. Until now only the regex detectors (`detectGateSignals`) produced it; Jev
ran beside them as a measure-only shadow. With `intelligence.jevSignalLive` on
(dev-gated), `MessagingToneGate.review()` awaits one bounded Jev call through the
shadow (`JevSignalShadow.liveSignals`), merges it (`mergeLiveSignals`): a
confident Jev answer decides that kind, labelled `source=jev`; an unsure or
missing answer, and every failure, leaves the detector's answer; a detector hit
Jev confidently disputes stays detected (every rule still applies to it) and is
annotated with Jev's disagreement. When no Jev-sourced line reaches the list the prompt and promptId
are byte-identical to before. Files: `src/core/JevSignalShadow.ts`,
`src/core/MessagingToneGate.ts`, `src/core/JevCascade.ts` (shared `bandFor`),
`src/core/GateSignalDetectors.ts` (two optional fields), `src/commands/server.ts`
(wiring), `src/config/ConfigDefaults.ts`, `src/core/devGatedFeatures.ts`,
`src/core/types.ts`, `src/core/PostUpdateMigrator.ts`, `src/scaffold/templates.ts`.
Spec: `docs/specs/jev-signal-live.md`.

## Decision-point inventory

- `MessagingToneGate` artefact-signal list (input to the B1–B7 judge) — modify — gains labelled Jev opinions where Jev is confident; the judge stays the only authority.
- `detectDeterministicLeak` / `buildDegradedToneResult` (degraded floor) — pass-through — untouched; still pure detectors.
- Credential wall, B15–B19 — pass-through — untouched.

---

## 1. Over-block

No new block surface. Jev can add a sample-less signal (e.g. `cron-or-slug`,
model judgment) that nudges the judge toward a B7 advisory where the detector saw
nothing; the judge still reads the message and B1–B7 are advisory wherever this
runs (live requires the advisory migration). A wrong confident "yes" therefore
costs at most one overridable nudge. Measured: confident answers 75/75 agreed with
the Luna referee, though only 3 of those were positives.

---

## 2. Under-block

A confident Jev "no" could lead the judge to pass something the detector flagged.
Mitigated by design: the detector observation is never removed or overridden —
it stays `detected=true`, so the B1–B7 rule can fire on it exactly as today, and is shown
with its sample and a note that the model disagrees. The degraded floor (the only
path that can HOLD without the LLM) is unchanged, and the credential wall is
unchanged. A crafted message that talks Jev down cannot hide the regex hit from
the judge.

---

## 3. Level-of-abstraction fit

Right layer: Jev is a signal producer feeding the existing authority (the tone
gate's judge), exactly where the detectors already feed it. It reuses the shadow's
single vendor call rather than adding a parallel client, and reuses the cascade's
band definition (`bandFor`).

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

Complies. Jev holds no blocking authority: its answers are rendered as labelled
signals inside the judge's untrusted-data boundary. Jev returns only numbers, so a
Jev-sourced line carries no text that could inject into the prompt. Live is
consulted only by the outbound messaging route (callers that treat any
pass:false as final never opt in), and only where B1–B7 are advisory AND the
route will keep them advisory
(the advisory migration on and decision-quality recording live — the route
hardens a migration advisory when recording is not live), so a model signal can
never be the cited basis of a hard B1–B7 hold. Every detector observation still
reaches the authority.

## 4b. Judgment-point check (Judgment Within Floors standard)

No new static heuristic at a competing-signals decision point. The confident band
(0.30–0.70) is a routing rule for which input the judge is shown, declared as an
invariant with its calibration evidence in the spec's `## Decision points
touched`; the judge remains the arbiter within the floors (advisory-only,
detector evidence retained, degraded floor deterministic).

---

## 5. Interactions

- **Shadow:** in live mode the live call IS the measurement call — `review()`
  calls `liveSignals()` and, only when it returns null (live off), the detached
  `observe()`; tested that both never run for one message. Rows gain `live`,
  `liveSources`, `liveLate`. The referee cascade is unchanged and still detached.
- **Single-flight slot:** now generation-checked with a 30 s stale reclaim, shared
  by `observe()` and live; a reclaimed call cannot release a newer slot (tested).
- **Route budget:** the added wait is at most `timeoutMs` (clamped 100–3000 ms,
  default 1000) + 250 ms, inside the 20 s outbound budget; the bound is enforced
  by the live race itself. Other `review()` callers (health alerts, local tone
  check, delivery recovery) never opt in and never wait.
- **Vendor-down breaker:** three consecutive caller-visible failures skip Jev for
  five minutes; the breaker only suppresses calls, it never retries or notifies.
- **Provenance:** `gateSignalKinds` records the list the prompt was handed;
  promptId `tone-gate-sigv1-jev` separates Jev-shaped reviews for grading.

---

## 6. External surfaces

Egress: in live mode the message text goes to TypeSafe (api.typesafe.ai), now
secret-scrubbed first (`scrubForStore`; a scrub error sends nothing). On the
development agent this continues the egress the operator approved for the shadow
soak and moves it off the soak bound; the fleet ships dark and holds no key. A
fleet flip is an explicit operator decision (stated in the spec and the CLAUDE.md
card). The judge's prompt text changes only for messages where Jev actually
shaped the list. Latency visible to the user: up to ~1.25 s extra on a tone
review when live (measured Jev p50 203 ms).

## 6b. Operator-surface quality (Operator-Surface Quality standard)

No operator surface (no dashboard, approval page, or grant form) is touched —
not applicable.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

Machine-local BY DESIGN: each machine's tone gate reviews its own outbound
messages with its own config, vault key and log. No replicated state; the
breaker and slot are per-process.

---

## 8. Rollback cost

`intelligence.jevSignalLive.enabled: false` — read live on the next message, no
restart; the gate returns to detector-only signals and the byte-identical prompt.
Code rollback is a revert. No data migration: the added row fields are extra JSON
keys readers ignore, and the config block is inert when absent.

---

## Conclusion

Ship behind the dev gate. The change adds labelled model opinions to an advisory
input, never removes evidence, never adds a block, is bounded in time, and falls
back to today's exact path on any failure.

## Second-pass review (if required)

**Reviewer:** independent review subagent (spec-converge panel) + codex-cli (gpt-6-astra)
**Independent read of the artifact: concur**

Three convergence rounds. Round 1 and round 2 design findings were all adopted
(advisory-migration requirement, keep-don't-drop, scrubbed egress, breaker,
generation-checked slot, deadline-counted breaker, prompt byte-identity for agreed
negatives, timeout clamp); see `docs/specs/reports/jev-signal-live-convergence.md`.

## Evidence pointers

- `tests/unit/jev-signal-live.test.ts` (36 tests; mutations of the keep-on-disagreement, scrub, breaker, advisory-migration check and slot generation each fail it)
- `tests/integration/jev-signal-live-gate.test.ts` (6 tests)
- `tests/e2e/jev-signal-live-lifecycle.test.ts` (5 tests)
- Measurement basis: `logs/jev-signal-shadow.jsonl` since 2026-09-28T18:05Z (recomputed in the spec).

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect — not applicable. The vendor-down breaker is
not a self-triggered controller in the `unbounded-self-action` sense: it only
withholds an optional outbound call for a fixed window and never fires a
restart, retry, respawn, spawn, notify or kill.
