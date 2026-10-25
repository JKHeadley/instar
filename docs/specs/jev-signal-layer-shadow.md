---
title: "Jev shadow comparison for the B1–B7 artefact signal layer"
slug: "jev-signal-layer-shadow"
author: "echo"
status: approved
approved: true
parent-principle: "Structure beats Willpower"
approved-by: Justin
approved-at: "2026-09-21T15:27:00Z"
approved-via: "Telegram topic 95267 (2026-09-21 08:27 PDT): Justin — 'I approve of anything that needs my approval', sent after both specs were delivered for review with rendered ELI16 links (22:34 and 23:30 the prior night)."
soak-egress-approved: true
tracked-as: ACT-025
eli16-overview: "docs/specs/jev-signal-layer-shadow.eli16.md"
review-convergence: "2026-09-21T06:29:57.562Z"
review-iterations: 1
review-completed-at: "2026-09-21T06:29:57.562Z"
review-report: "docs/specs/reports/jev-signal-layer-shadow-convergence.md"
cross-model-review: "codex-cli:gpt-6-astra"
single-run-completable: true
frontloaded-decisions: 8
cheap-to-change-tags: 3
contested-then-cleared: 1
---

# Jev shadow comparison for the B1–B7 artefact signal layer

## Problem statement

Ladder-1 research (20 September 2026, `docs/research/jev/`) measured that Jev
(`jev-1.13.0`, TypeSafe AI) reproduces our deterministic B1–B7 artefact detectors
exactly on real traffic — 78/78 file-path signals with 0/72 false alarms — while
surviving evasions (spacing, zero-width characters, unicode substitution) that
defeat a pattern match. The recommendation Justin approved: **prototype Jev as the
artefact-signal layer, dark and shadow-only, acting on nothing, for a bounded soak
— then compare.**

This spec is that prototype. It changes no verdict, no authority, no message path.
It produces the comparison data that a later, separate decision (replace / augment /
drop) would be made from.

## Proposed design

One new module, one call site, one config gate, one log.

- **Module `src/core/JevSignalShadow.ts`.** Given the candidate text, it calls the
  TypeSafe API once with the register's question battery (the ladder-1 rung-2
  wordings, one Noul per B1–B7-equivalent rule, each answerable from the text
  alone), pinned to an exact model version (`jev-1.13.0`, a config value — never an
  alias), with a hard timeout (default 1500 ms) and a size guard mirroring
  `MAX_SCAN_BYTES`. The vault key is read ONCE at first use and cached (re-read
  only on an auth failure) — never a per-call decrypt on the event loop; the
  serialization cost is bounded by the size guard.
- **Token-Audit visibility (the standard: an unmetered LLM call is an
  unaccountable one).** A raw fetch would bypass the provider funnel, so the
  module emits one FeatureMetricsLedger row per call — `feature:
  jev-signal-shadow`, model from `modelServed`, real `input_tokens` from the API
  response, output tokens 0 (the vendor's are free), latency — so its spend and
  latency appear in `/metrics/features` beside every other LLM feature instead of
  living only in a private log.
- **Call site:** exactly ONE, pinned: the top of `MessagingToneGate.review()`,
  after the deterministic floor — not "wherever detectGateSignals runs" (it runs
  at three sites, and a naive hook would triple-fire). A message re-entering the
  gate on fail-closed retry produces a second row with the same sha256; the
  report script dedupes by hash, and the double egress is bounded by the retry
  policy it rides. Fire-and-forget (`void`-ed promise; never
  awaited on the message path). Honesty about "untouched": not-awaiting proves the
  gate does not WAIT; it does not prove zero overhead — hashing, serialization and
  the request still share the process. So the isolation is bounded, not asserted:
  **at most ONE shadow call in flight per process** (a second candidate while one
  is running is skipped with a `skipped-concurrent` row), the request is
  hard-aborted at `timeoutMs` via AbortController, and the enabled-vs-disabled
  gate latency delta is MEASURED during test-agent-live (acceptance: p50 delta
  within noise, p95 delta < 5 ms on the standard gate fixture load).
- **Config gate:** `intelligence.jevSignalShadow = { enabled: false, sampleRate:
  1.0, model: "jev-1.13.0", timeoutMs: 1500, soakEndsAt: null }`. Ships dark.
  Enabled resolves live per call (kill-switch without restart). **The soak bound
  is mechanical, not remembered:** enabling requires `soakEndsAt` (an ISO
  instant, set at approval time, 14 days out); every dispatch checks it, and past
  it the shadow is inert across restarts until the operator sets a new window —
  an enabled flag with a missing or past `soakEndsAt` is the same as disabled,
  plus one `soak-expired` status row per boot. Missing vault key
  (`typesafe_api_key`) ⇒ inert, one `disabled-no-key` row per boot — never a
  crash, never a gate delay.
- **Output:** one content-free JSONL row per CANDIDATE (not merely per success)
  to `logs/jev-signal-shadow.jsonl` (the standard machine-local audit-log class).
  One schema, two shapes discriminated by `kind`:
  `{kind:"compared", ts, sha256, bytes, detectorSignals:[kinds], jev:{rule:p,…},
  ms, modelServed, disagree:[rules]}` and
  `{kind:"not-compared", ts, sha256, bytes, reason}` with the CLOSED reason set
  `timeout | http-error | oversize | skipped-concurrent | skipped-sample |
  model-mismatch | disabled-no-key | soak-expired` — the reason is always the
  enum value, NEVER the vendor's error body (a 4xx body may echo input, and this
  log is content-free; the no-raw-text fixture covers both row shapes). Never
  the text. A
  `modelServed !== configured model` response is recorded `model-mismatch` and
  EXCLUDED from agreement (a different model's answers are not this comparison).
  **The comparison contract is frozen in the module beside the questions:** the
  rule↔detector-kind mapping table, the positive threshold (p > 0.5 — the
  measured ladder-1 operating point), and the excluded-row rules. The soak report
  is a per-rule CONFUSION MATRIX (hits, misses, false alarms, positive-case
  counts) plus coverage (compared / not-compared by reason) — never a single
  blended agreement percentage, because 99% agreement can hide total failure on
  rare positives.
- **Reading the soak:** a standalone script `scripts/jev-shadow-report.mjs`
  summarises agreement/divergence per rule from the log. No HTTP route in v1 —
  deliberately, to keep the surface at "module + log" (the route, dashboard tab
  and pool view are the graduation step's work, if the soak earns one).

## What this deliberately does NOT do

- It never contributes to any verdict, block, nudge, or advisory.
- It never sends the message text anywhere except the one TypeSafe API call that
  IS its purpose (see the egress decision below).
- It does not touch `detectGateSignals`, the tone gate's prompt, or any consumer.
- No retries: every non-compared candidate is one `not-compared` row with its
  closed-set reason, and the message path never notices.

## The decision that needs the operator: content egress

Shadowing sends outbound-message text to TypeSafe AI, a vendor founded days ago,
under the MCA accepted on 20 September (Justin's authorization). Our outbound text
already leaves the machine to LLM providers (Anthropic, OpenAI via codex) on every
gate call; this adds ONE more recipient, for the duration of the soak, for messages
already headed through the gate. Mitigations: sampleRate config (can soak at 10%),
the kill-switch, and the soak is bounded (14 days, then the flag goes back off
pending the comparison read). **This is the Rung-FLOOR approval this spec exists to
request — the flag is never flipped on without the operator's explicit yes.**

## Decision points touched

| Decision point | Classification | Justification |
|---|---|---|
| *(none — signal-only by construction)* | `invariant` (vacuously) | The shadow writes an audit row and nothing reads it on any decision path. The one guarded behaviour — "the message path is never delayed or altered" — is enforced structurally (fire-and-forget, no awaits, no shared state with the gate) and pinned by tests. |

## Multi-machine posture

| Surface | Posture |
|---|---|
| `logs/jev-signal-shadow.jsonl` | machine-local. `machine-local-justification: physical-credential-locality` — the log is this machine's record of what ITS gate traffic looked like to ITS shadow call (observation locality, the same framing the sibling audit-log specs use); replicating another machine's observations would not make them this machine's. Report script is pointed at a machine. |
| Config gate | `unified` (ordinary config, per-machine values allowed like every `monitoring.*` flag) |

## Maturation plan

- **test-agent-live:** unit + integration tiers green before merge; a
  test-as-self deploy confirms flag-off boots produce zero shadow rows, an
  enabled boot with a dummy key produces the honest `not-compared` row class,
  never a gate delay; and the enabled-vs-disabled latency delta is measured
  against its acceptance bound here.
- **dev-agent-live:** dark on merge. The soak (flag on, this agent only) begins
  only on the operator's explicit egress approval above, runs 14 days at the
  approved sampleRate, then the flag returns to off.
- **fleet:** not in this spec's scope at all — the shadow is a dev-agent research
  instrument; fleet shipping would need its own separate spec.
- **graduation criterion:** per-rule confusion matrices over the soak showing, for
  every rule with ≥ 20 positive detector cases, agreement ≥ 99% AND zero
  unexplained misses of a detector positive; rules with fewer positives are
  reported `insufficient-evidence`, never blended in. Coverage ≥ 90% compared
  (a soak that mostly `not-compared` proves nothing). Gate latency delta within
  the measured bound above. The graduation ACTION is a new decision with its own
  spec, not an automatic flip.
- **dark-window:** indefinite by default — the flag is off except during the
  operator-approved soak window. A dark shadow guards nothing and costs nothing,
  which is correct for an instrument.

## Frontloaded Decisions

1. Fire-and-forget at the existing signal call site; zero awaits on the message
   path (the non-negotiable).
2. Pinned model id in config; `modelServed` recorded per row; alias drift is the
   drift-check job's problem, not this module's.
3. JSONL + report script only in v1; no route, no dashboard (kept for a
   graduation spec if earned).
4. sampleRate in config, soak default decided by the operator at approval time
   (offer 10% and 100%).
5. Question battery = the register's reworded rung-2 wordings, frozen in the
   module beside a pointer to the register; changing a question is a code change,
   visible in review, never config.
6. The 14-day soak bound is enforced by `soakEndsAt` in config, checked per
   dispatch, surviving restarts — never by anyone remembering. Close the Loop is
   the soak report, tracked under ACT-025.
7. One in-flight shadow call per process; the overflow row is data
   (`skipped-concurrent`), not a queue.
8. Comparison contract (mapping, threshold, exclusions) frozen in code beside the
   questions; the report is confusion matrices + coverage, never one blended
   percentage.

## Tests

1. **Unit:** both row shapes (a fixture asserts no raw-text field on either);
   every closed-set `not-compared` reason reachable (timeout via abort,
   http-error, oversize, skipped-concurrent, skipped-sample, model-mismatch,
   soak-expired, disabled-no-key); single-flight enforcement; `soakEndsAt`
   missing/past ⇒ inert; sampleRate 0/1; size guard.
2. **Integration:** gate path with flag off = byte-identical behaviour and zero
   rows; flag on with a stubbed endpoint = rows written, gate verdict and latency
   unchanged (asserted by running the gate with a deliberately hanging stub — the
   verdict must return before the stub does).
3. **E2E:** flag-off boot (the shipped state) produces no shadow artefacts; the
   existing tone-gate e2e stays green untouched.

## Migration

Code + one config default. Ships dark; no existing agent's behaviour changes. No
CLAUDE.md template change (a dark research instrument is not an agent capability).
Config default added via `migrateConfig()` existence-check per Migration Parity.

## Rollback

Flag off (live, no restart) is the operational rollback; revert the commit is the
code rollback. The log is inert data either way.

## Out of scope

- Replacing or augmenting `detectGateSignals` — that is the post-soak decision.
- Any fleet exposure, route, or dashboard surface.
- The pre-filter-in-front-of-the-judge idea (separate recommendation, own spec).

The egress approval is deliberately NOT an open question of this spec: the spec
converges on the instrument; the operator separately decides its first use (the
soak), and the flag is mechanically inert without that decision.

## Open questions

*(none)*
