---
title: "Jev as a live advisory input to the tone gate's B1–B7 artefact signals"
slug: "jev-signal-live"
author: "echo"
parent-principle: "Signal vs. Authority"
parent-spec: "docs/specs/jev-signal-layer-shadow.md"
eli16-overview: "docs/specs/jev-signal-live.eli16.md"
status: approved
approved: true
approved-by: Justin
approved-at: "2026-09-30T02:06:00Z"
approved-via: "Operator direction 2026-09-29 19:06 PDT, relayed in the build brief: 'Do we not already have enough data to make some decisions on and move forward here?' — approval to move Jev from measure-only shadow to a live advisory input, dev-gated. Stands on his standing 1.x approval for Jev work (topic 95267, 2026-09-21: 'I approve of anything that needs my approval'). Revocable: flip the flag off or revert."
review-convergence: "2026-09-30T02:45:51.865Z"
review-iterations: 8
review-completed-at: "2026-09-30T02:45:51.865Z"
review-report: "docs/specs/reports/jev-signal-live-convergence.md"
cross-model-review: "codex-cli:gpt-6-astra"
single-run-completable: true
frontloaded-decisions: 9
cheap-to-change-tags: 0
contested-then-cleared: 0
---

# Jev as a live advisory input to the tone gate's B1–B7 artefact signals

## Problem statement

The tone gate (`src/core/MessagingToneGate.ts`) hands its LLM judge a list of
"artefact signals" — a raw path, a CLI command, a config key, an API endpoint,
copy-paste code, an env var, a cron expression or internal slug — produced by the
hand-written regex detectors in `src/core/GateSignalDetectors.ts`
(`detectGateSignals()`). The judge then decides in context whether each artefact is
being shown to the user to act on (rules B1–B7, all advisory/overridable).

Since 2026-09-21 a measure-only shadow (`src/core/JevSignalShadow.ts`, spec
`jev-signal-layer-shadow.md`) has asked Jev (TypeSafe AI's System One model,
`jev-1.13.0`) the same seven questions on every real candidate, and since
2026-09-28 a referee cascade (`src/core/JevCascade.ts`) puts Jev's unsure answers
plus a 5% audit share of confident ones to GPT-6 Luna as a smarter reference.

Measured on `logs/jev-signal-shadow.jsonl` since 2026-09-28T18:05Z (recomputed
2026-09-29 for this spec). Luna is a stronger *reference*, not verified truth:

| Slice | n | Jev agrees with Luna | detectors agree with Luna |
|---|---|---|---|
| Confident Jev answers (random audit) | 75 | **75** | 72 |
| Unsure band (0.30 ≤ p ≤ 0.70) | 96 | 70 | 54 |

Per rule inside the unsure band (Jev / detector agreement): cron_or_slug 44/31 of
57, raw_path 9/10 of 13, api_endpoint 3/3 of 10, cli_command 3/3 of 5,
config_key 7/7 of 7, env_var 4/0 of 4. The Luna-yes rate rises with Jev's
probability (bins rounded to 0.1 — 0.3: 3/17, 0.4: 3/15, 0.5: 11/19, 0.6: 25/37,
0.7: 6/8; 96 answers), which is the behaviour the band relies on — not a proof of
calibration.

**What the confident evidence does and does not show.** The 75 audited confident
answers are dominated by agreed negatives (71 of 75: Jev no, Luna no, detector
no). Confident positives are thin: 3 audited (Jev yes, Luna yes; the detector
missed 2 of them). One audited case had the detector firing and Jev confidently
saying no — Luna sided with Jev. Across all 265 compared messages, a confident
Jev answer would *add* a signal the detector missed 47 times (cron_or_slug 28,
api_endpoint 11, cli_command 3, copy_paste_code 3, raw_path 1, env_var 1) and
*contradict* a detector hit 14 times (api_endpoint 8, cron_or_slug 3, raw_path 3).

That evidence shows confident Jev answers *agree with a stronger reference model*
at least as often as the detectors do; it does not demonstrate that the judge
decides better with them, and it is weak for any single rule's positive-case
accuracy. The design below is shaped by that:
Jev's answers are added to what the judge sees and never remove a detector
observation, so a wrong confident answer costs one misleading nudge that the judge
checks against the text, never a hidden observation. The parent spec's per-rule
graduation criteria (replace / augment / drop per rule) are not claimed as met;
this spec takes the *augment* branch for all seven rules at once on the operator's
instruction, keeps every detector observation, and makes the benefit measurable
(see "Measuring the benefit").

Latency of the 261 compared Jev calls in that window: p50 203 ms, p90 410 ms,
p99 834 ms, max 1682 ms; 1 timeout and 1 concurrency skip.

The operator (Justin, 2026-09-29 19:06 PDT) asked to move forward on this data.

## Proposed design

### What changes

When the new flag is on, the tone gate's artefact-signal list becomes a merge:

- For each of the seven questions where Jev answered **confidently** (p < band.lo
  or p > band.hi, default band 0.30–0.70 — the same default the cascade uses),
  Jev's answer decides whether that signal is present:
  - p > band.hi and the detector fired → the detector's signal is kept (its spans
    and sample still anchor the judge), tagged `source: jev` with `model_p`.
  - p > band.hi and the detector did not fire → a sample-less signal
    `{kind, detected: true, source: 'jev', modelProbability: p}` is added.
  - p < band.lo and the detector fired → **disputed**: the detection stands
    (`detected: true, source: 'detector'`, spans and sample kept, so every B1–B7
    rule can still fire on it exactly as today) and the line is annotated
    `model_p=… (model_disagrees …)` for the judge to weigh in context. Jev never
    removes or overrides an observation (Signal vs Authority: the authority
    receives every relevant signal); it can only add a line or comment on one.
  - p < band.lo and the detector did not fire → nothing.
- For every question in the unsure band, or with no Jev answer, the detector's
  output for that kind is used unchanged (`detector-fallback`).
- If there is no usable Jev answer at all (live off, no key, timeout, HTTP error,
  model mismatch, oversize, concurrency skip, scrub error, breaker open, any
  throw), or no Jev-sourced line reached the list (every answer unsure, or only
  agreed "nothing here" — 71 of the 75 audited confident answers were exactly
  that), the list, its rendering and the promptId are exactly today's
  `detectGateSignals(text)` path. The live renderer and `tone-gate-sigv1-jev` are
  used only when the list the judge sees actually differs.

### Only where B1–B7 are overridable

On the fleet today B1, B3–B7 are `blocking` in `RULE_DISPOSITIONS`; they become
advisory only under the tone gate's advisory migration (`toneGate.advisoryMigration`,
itself dev-gated). Even under the migration, the outbound route turns a
migration-derived advisory back into a non-overridable hold
(`advisoryUnrecordable`) whenever decision-quality recording is not live
(`decisionQualityRecordingLive()` false — e.g. `provenance.uniformSeam.dryRun`,
which defaults true) or no `decisionRef` was minted. And other callers of the
same gate — the local tone check, delivery-failure recovery, the Telegram-origin
recovery refusal, health-alert rewriting — have no override path at all: they
treat any `pass:false`, advisory or not, as final.

Live signals are therefore consulted **only when all three hold**:

1. the caller opted in with `liveArtefactSignals: true` on the review context.
   Inside the routes, `evaluateOutbound` forwards it only when its own caller
   passed the option, and only the send paths that carry the
   acknowledge-and-override fields pass it: `/telegram/reply`, the Telegram
   origin send policy (sender reaction), and every caller that spreads
   `toneAdvisoryMetadata()` (`/telegram/post-update`, Slack, WhatsApp, iMessage).
   The growth-digest publisher and `POST /attention` — where a hold is final —
   do not, and neither does any caller outside the routes. Absent ⇒
   detector-only, today's behaviour;
2. the resolved advisory migration is on;
3. `decisionQualityRecordingLive()` is true — the route's own condition. It is
   enforced in the shadow's production factory (`buildJevSignalShadow`
   resolves live `enabled` to false while recording is off), which keeps the
   tone gate's own import closure — certified for the Stage-B fingerprint —
   unchanged.

The route's remaining demotion case, a missing `decisionRef`, has two sources.
The budget-timeout path builds its verdict from the deterministic floor, not
from the judge's signal list, so Jev cannot reach it. The other is a boot where
the intelligence router failed to build and the raw provider was used (the
server logs a warning at boot): no review mints a `decisionRef`, so
**every** migration advisory on that boot is already demoted to a hold with or
without Jev. On such a boot a Jev-only line could add one more such hold. This
residual is named rather than guarded because the whole advisory migration is
already non-functional on that boot; the kill switch covers it. Otherwise `review()` never calls `liveSignals()` and the shadow
stays measure-only, so a model-sourced signal can never be the
cited basis of a hard B1–B7 hold. (The signals go to the same judge that also
rules on the unrelated B15–B19 walls; a Jev line describes an artefact kind and
carries no text, so it is not evidence those rules read, but this is a property
of their prompts, not a structural separation.) (B2 is advisory everywhere, but the rule applies uniformly.)

Luna is **not** on the message path (≈40 s is far too slow). The referee cascade
stays exactly as it is: measure-only, detached, logging verdicts beside Jev's, so
the unsure band keeps being calibrated and a later change can narrow it per rule
with evidence (cron_or_slug is the obvious candidate; this spec deliberately does
not do that).

### Latency bound

- The flag carries `timeoutMs` (default **1000**, covering the measured p99 of
  834 ms; an operator value is clamped to 100–3000 ms so no config can make the
  gate wait past the route budget). In live mode that value governs the shared call's fetch abort (the
  shadow block's own `timeoutMs` applies only to detached `observe()` calls), and
  the live call is additionally raced against a timer of `timeoutMs + 250 ms`.
  The 1.25 s bound comes from this race itself, not from the outbound route's
  separate 20 s `OUTBOUND_GATE_REVIEW_BUDGET_MS` (which is extra cover). Only the
  outbound route opts in; every other caller never waits at all.
- Live off, not opted in, or advisory migration / recording off ⇒ no await at all: the gate path is
  byte-identical to today (the shadow's `observe()` still runs detached).
- **What the bound covers.** It is the asynchronous waiting budget. The
  synchronous preparation before the timer starts — config read, hash, scrub, the
  seven detectors — is the same bounded work the gate already does on every
  message (the detectors run on the default path too; scrub and hash are bounded
  by the existing `maxScanBytes` guard), so live mode's added latency is the wait
  plus one scrub (and building the request body before the fetch starts, also
  bounded by `maxScanBytes`). Two synchronous steps can add to it and the timer cannot
  interrupt them: a vault key re-read, which happens only when the key is missing
  or was rejected and at most once per 10 minutes (the shadow's existing
  `KEY_REREAD_MS` rule), and the small appends to the JSONL log. The timer
  itself is subject to normal event-loop scheduling.
- **Vendor-down breaker.** The breaker counts what the caller saw, once per
  candidate: a missed deadline, timeout, HTTP error, model mismatch, or a
  response with no usable probability at all (`no-answers`) is one failure — even if the answer lands later — and only an answer in time resets
  the count. After 3 consecutive failures live mode skips Jev for 5 minutes and
  uses the detectors directly, so an outage costs at most three bounded waits per
  five minutes. One `breaker-open` row is written per opening.
- **Slot lifecycle.** The single in-flight slot is released when its call
  settles (the fetch abort guarantees that in practice). A slot held longer than
  30 s belongs to a call that never settled and is reclaimed, so one stuck
  request cannot starve every later candidate. Slots are generation-checked: a
  reclaimed call that settles later cannot release the slot a newer call holds,
  so single-flight survives a reclaim. Against a vendor whose requests never
  settle at all, new requests start at most once per 30 s and the breaker stops
  them after three, so abandoned requests grow by at most three per five minutes
  until the vendor recovers or the operator turns the flag off.

### One call, not two

In live mode the Jev call that feeds the gate **is** the shadow's measurement
call: the shadow gains `liveSignals(text)`, which performs the same request as a
detached `observe()` (same questions, same model pin, same metering, same row
schema, and the same referee/excerpt hand-off while the shadow is measuring — see
"Beyond the soak") but returns the merged signals to the awaiting
caller. `review()` calls `liveSignals()` first; if it returns `null` (live off)
it falls back to `observe()`. While the shadow is running, live mode therefore
adds no vendor calls; it only adds a wait.

**Beyond the soak — stated plainly.** Live mode is not soak-bound, so once the
shadow's soak ends (on the development agent: 2026-10-01T18:05Z) live mode alone
keeps making one Jev call per reviewed message, for as long as the flag is on.
That ongoing Jev egress and spend is the purpose of this change (the operator's
2026-09-29 direction to move Jev from measurement to use). The shadow's
**measurement extras** — the Luna referee and retained disagreement excerpts —
stay bound to the shadow: on a live call they run only while
`jevSignalShadow.enabled` is true and its `soakEndsAt` is in the future (one
`shadowMeasuring` check gates both), so neither a referee call nor a stored
excerpt outlasts the soak without a new window being set. The content-free
comparison rows keep being written, because they record which source decided
each live signal. Growth: the existing log averages ~350 bytes per row and the
development agent reviewed ~265 messages in ~25 hours, so roughly 100 KB/day; no
rotation is added by this change (the log is machine-local and append-only like
every other research JSONL here).

Live mode is independent of the shadow's soak window, `enabled` flag and
`sampleRate` (those bound a research instrument; the live flag is the operator's
production switch). It reads the model pin from `jevSignalShadow.model` (default
`jev-1.13.0`), and the excerpt/referee settings from the shadow block, so the
measurement keeps its existing knobs. It still requires the vault key
`typesafe_api_key`, and it keeps the one-in-flight bound: a concurrent candidate
falls back to the detectors and is logged `skipped-concurrent`.

### Data egress

Because live mode is not soak-bounded, the text sent to TypeSafe in live mode is
first passed through `scrubForStore` (the same scrubber the referee path and
every durable store use); a scrub error or oversize result sends nothing and falls
back (`scrub-error`). The detectors and the row hash still read the original
text. Consequence: on a message that carried a credential, Jev judges the
redacted text (e.g. `[REDACTED:…]` in place of a token), so its answer about that
span can differ from what the detector saw. Such a message is already the
credential wall's case, and a detector hit Jev disputes is still shown to the
judge, so the effect is limited to how one advisory line is labelled. On the
development agent this continues the egress the operator already
approved for the shadow soak; the fleet ships dark and holds no key, and a fleet
flip is the operator's explicit call that every outbound message (scrubbed) goes
to TypeSafe for as long as the flag is on.

### Logging which source supplied each signal

Every row the shadow writes for a live candidate carries `live: true`:

- `compared` rows add `liveSources: Record<rule, 'jev' | 'disputed' |
  'detector-fallback'>` — `jev`: a confident answer decided the line (including
  an agreed "nothing here"); `disputed`: the detector matched, Jev confidently
  disagreed, the detection stood with Jev's note; `detector-fallback`: Jev was
  unsure or had no answer.
- Exception: when the detached shadow path met a missing key first, the one
  shared `disabled-no-key` row was written by it and carries no `live` tag.
- `not-compared` rows with `live: true` (timeout, http-error, model-mismatch,
  oversize, skipped-concurrent, scrub-error, disabled-no-key, breaker-open) mean
  every rule for that message fell back to the detector. The two standing
  conditions are written once, not per message: `disabled-no-key` once per
  process (one row shared by the shadow and live paths — whichever meets it
  first writes it), `breaker-open` once per opening; later messages in those
  states carry no row of their own.
- Shadow-side change with live off: detached `observe()` uses the same
  generation-checked slot with the 30 s stale reclaim, so a stuck measurement
  call can no longer silence the shadow for the life of the process. This only
  affects measurement rows, never the gate.
- If the race timer wins before the fetch settles, a `not-compared` `timeout`
  row (`live: true`) is written the moment the caller stops waiting — so a call
  that never settles still leaves a record — and if an answer lands later its
  `compared` row is written with `liveSources` omitted and `liveLate: true`, so a
  row never claims Jev supplied a signal the gate did not actually use. That
  candidate then has two rows with the same `sha256`; readers counting
  candidates dedupe by `sha256` + `ts`. `ts` has millisecond resolution, so two
  reviews of identical text in the same millisecond would collide; that is rare
  enough for counting purposes and no attempt id is added.

Rows carry no message text beyond the existing opt-in, scrubbed, span-anchored
disagreement excerpts, which (like the referee) run on a live call only while the
shadow is measuring.

### Prompt + provenance honesty

- `review()` awaits `liveSignals()` once, at the top, before anything reads the
  signal list, and threads the result to all three consumers: `buildPrompt(…,
  gateSignals)`, `buildToneDecisionContext(…, { gateSignals })` and the per-call
  `promptId`. When no confident Jev answer shaped the list, `gateSignals` is
  undefined and all three take today's path byte-for-byte.
- When Jev shaped the list, a separate renderer (`renderLiveGateSignals`) tags
  each line `source=jev|detector` with `model_p`, and its header says the list is
  "the Jev model where it is confident, the deterministic detector otherwise" and
  that these lines are the B1–B7 signals the rules refer to.
  A Jev-sourced line without a detector match carries no sample (Jev returns only
  numbers, so it cannot inject text into the prompt); `model_p` is clamped to
  [0, 1] and finite-checked.
- **Citation contract.** The base prompt tells the judge to cite a blocked
  artifact *from the signal* and not to scan the candidate itself. A model-only
  line has no sample to cite, so the live section grants one narrow exception:
  for a model-judgment line, the judge may locate the artifact in the candidate
  in order to cite it. Detector lines (disputed or not) keep today's contract.
- The promptId is `tone-gate-sigv1` whenever the prompt is today's, and
  `tone-gate-sigv1-jev` exactly when the live renderer was used, so
  decision-quality grades never mix the two prompt shapes.
- The provenance `gateSignalKinds` records the detected kinds the prompt was
  actually handed, as its comment already promises. A disputed detector hit is
  still detected, so it is in `gateSignalKinds`; the dispute itself is recorded
  in the shadow row (`liveSources: disputed`).

### What does not change

- `detectDeterministicLeak()` — the degraded-path floor that can HOLD a message
  during an LLM outage — stays purely deterministic. Jev never gains hold power.
- The credential-exposure wall, the self-stop family (B15–B19), B20 internal-id
  leak, every other signal, and every verdict/disposition path are untouched.
- The judge remains the single authority; B1–B7 dispositions are unchanged
  (advisory wherever live signals are consulted, per the condition above).
- Beyond the prompt, live-off `review()` differs only in reading its config once
  at the top instead of at two points — the same live getter, no behavioural
  effect.

### Config

```json
{ "intelligence": { "jevSignalLive": { "timeoutMs": 1000 } } }
```

- `enabled` is deliberately **omitted** from the default: resolved by
  `resolveDevAgentGate` — live on a development agent, dark on the fleet. Explicit
  `false` is the kill switch; explicit `true` is the fleet flip.
- Read live per candidate (no restart), through the same live `intelligence`
  block the shadow already reads.
- Optional `band` / `bands` (per rule) live in the `jevSignalLive` block itself,
  validated by the same rule as the cascade (`bandFor`; an invalid band falls
  back); absent ⇒ the default 0.30–0.70 (not the referee's band — measurement and
  decision settings stay separate).
- The server passes `developmentAgent` into `buildJevSignalShadow`, whose new
  `getLiveConfig` dependency resolves `enabled` through `resolveDevAgentGate`.
- Registered in `DEV_GATED_FEATURES` so the both-sides wiring test guards it.

### Migration parity + awareness

- The default block lives under the existing `intelligence` object in
  `ConfigDefaults` and reaches existing agents through `migrateConfig`'s
  `applyDefaults` add-missing pass (never overwrites).
- A CLAUDE.md card ("### Jev Artefact Signals") is added to the template and to
  `migrateClaudeMd` behind a content-sniff guard, and mirrored into the
  framework-agnostic shadow capabilities list.

## Decision points touched

- **The tone gate's artefact-signal list (input to the B1–B7 judge)** — `judgment-candidate`: it adds labelled model opinions to the advisory signals the LLM judge (the arbiter, full authority) sees; floor: consulted only on the outbound route's opt-in with the advisory migration on and decision-quality recording live, no detector observation is ever removed or overridden, any Jev failure resolves to `detectGateSignals()` for that message, the deterministic degraded floor is untouched, and no decision point gains blocking authority.
- **Confident-vs-unsure band** — `invariant` per message (code-authored default 0.30–0.70, operator-tunable per rule), justified by the calibration table above.

## Verify the state, not its symbol

- Symbol: Jev's probability per question. State claimed: whether the artefact
  kind is present. Corroboration: the continuing Luna referee rows (unsure band +
  5% audit) in the same log, now tagged with the source actually used.
- Unmeasurable (no answer): the detector output is used — today's behaviour, the
  least-harmful action for an advisory input.

## Multi-machine posture

Machine-local by design: each machine's tone gate reviews its own outbound
messages and reads its own config and vault; the log is machine-local like the
shadow's. No state to replicate.

## Measuring the benefit

The rows and the provenance make the augment decision checkable rather than
assumed:

- **Correctness per rule (sampled, in soak windows):** while the shadow is
  measuring, the referee grades the unsure band plus an audit share of confident
  answers (5% on the development agent), now tagged with `liveSources`. Coverage
  is sampled, not exhaustive — a referee call can also be skipped as `busy` or
  `daily-cap`, and those skips are logged. Outside a soak window there is no
  referee; an evaluation is a soak window the operator opens by setting a new
  `soakEndsAt`. `scripts/jev-shadow-report.mjs` already builds per-rule matrices
  from this log and labels a rule with too few positive cases
  `insufficient-evidence` rather than passing it.
- **Judge quality (descriptive only):** decision-quality rows carry
  `tone-gate-sigv1-jev` vs `tone-gate-sigv1`. Jev-shaped messages are not a
  random sample (they are the ones where Jev had something to add), so override
  rates across the two are a watch signal, not proof of benefit or harm.
- **Latency:** each live `compared` row carries the Jev call's `ms`; fallback
  rows carry their reason; the verdict's `latencyMs` (which feeds the gate's
  existing latency accounting) includes the whole wait, fallbacks included.

Acceptance for keeping it on rests on the adjudicated cases of a soak window: no
rule with enough positive cases to judge (the report's own threshold) whose
confident Jev answers disagree with the referee more often than the detector does
on the same cases. A rule that fails ⇒ **widen** that rule's unsure band in
`jevSignalLive.bands` (more of its answers fall back to the detector; config, no
deploy) or set `enabled: false`. A sharp rise in overrides on `-jev` reviews is
a prompt to look at those cases, not an automatic verdict. A rule with
insufficient evidence stays on as it shipped (advisory, detector evidence
always retained) and is reported as `insufficient-evidence`; the operator's
2026-09-29 direction to go live on the current data is the standing decision for
it until a window produces enough cases. This measures agreement with a stronger
reference, not judge quality directly; a paired detector-only vs augmented
evaluation is not part of this change.

## Tests (three tiers)

- **Unit** — `mergeLiveSignals` on every side of every branch (confident yes with
  and without a detector hit, confident no with and without, unsure, missing,
  per-rule band override, no Jev-sourced line ⇒ list returned untouched);
  `liveSignals` returning null when off, scrubbing before egress, fallback on
  timeout / HTTP error / model mismatch / no key / oversize / concurrency, the
  timeout clamp, a
  never-settling fetch bounded by the race and the stale-slot reclaim, a
  reclaimed call settling late without freeing the newer call's slot, the
  breaker opening after three failures (missed deadlines included, a late success
  resetting nothing) and closing after five minutes, late answers written as
  `liveLate`, and `live: true` / `liveSources` on rows. Tone
  gate: live not consulted with the advisory migration off; with it on and Jev
  confident, the prompt carries the live section and the provenance carries
  `tone-gate-sigv1-jev` and the merged kinds; with no answer that changed the
  list (all unsure, or agreed "nothing here") the prompt and promptId are
  byte-identical to live-off; the disputed detector line stays `detected=true`
  with `model_disagrees`; the citation exception is present; a response with no
  probabilities (none, or only non-finite values) is `no-answers`; excerpts and the referee stay soak-bound on a
  live call (expired soak, shadow off, measuring).
- **Integration** — a real `POST /telegram/reply` through `createRoutes` shows
  the route opts in (the judge sees the Jev-shaped list, the message sends;
  removing the opt-in fails it), and a real `POST /attention` shows a
  no-override route never opts in (forcing the opt-in on fails it); a gate call without the opt-in, or with
  recording not live, never consults Jev (unit). The production
  `buildJevSignalShadow` wiring with a stub fetch behind a real
  `MessagingToneGate`: dev-agent config ⇒ live, fleet config
  ⇒ not live, explicit `false` ⇒ not live (read live, no restart).
- **E2E** — migration parity: `applyDefaults` adds `jevSignalLive` without
  `enabled` and never overwrites an operator value; `migrateClaudeMd` adds the
  awareness card once; the dev-gate registry resolves live-on-dev/dark-on-fleet.

## Maturation plan

- **test-agent-live:** unit, integration (including real `/telegram/reply` and `/attention` routes) and e2e tiers green before merge; mutation checks confirm the key guards (evidence kept on dispute, scrub, breaker, slot generation, advisory-migration and route opt-in) are each load-bearing.
- **dev-agent-live:** live on the development agent at merge + restart (dev-gated default; the agent already runs the advisory migration with decision-quality recording live and holds the vault key). The first 48 hours are watched through `logs/jev-signal-shadow.jsonl` (share of `liveSources: jev` / `disputed`, fallback reasons, `ms`) and override rates on `tone-gate-sigv1-jev` reviews.
- **fleet:** dark. A fleet flip needs an explicit operator decision because every reviewed outbound message (scrubbed) then goes to TypeSafe for as long as the flag is on, and each fleet agent needs its own vault key.
- **graduation criterion:** over a soak window on the development agent (shadow on, referee on), every rule with enough positive cases to judge (the report's own threshold) shows confident Jev answers disagreeing with the referee no more often than the detector on the same cases; rules below that threshold are reported `insufficient-evidence` and keep shipping as-is. A failing rule has its unsure band widened by config.
- **dark-window:** indefinite on the fleet until that operator decision; the development agent stays live unless the kill switch is used.

## Frontloaded Decisions

1. Unsure band → detector fallback (not Jev-at-0.5) — the conservative choice the
   operator's brief named; the cascade keeps measuring so a per-rule narrowing can
   follow on evidence.
2. Default timeout 1000 ms (measured p99 834 ms), clamped 100–3000 ms, plus
   250 ms race slack.
3. Live mode shares the shadow's single call and single-flight bound.
4. Dev-gated default (live on the development agent, dark on the fleet).
5. The deterministic degraded floor stays deterministic.
6. A confident Jev "no" annotates a detector hit (detection stands) instead of
   removing or overriding it.
7. Live requires the caller's opt-in (outbound route only), the resolved
   advisory migration, and live decision-quality recording.
8. Live egress is secret-scrubbed; a vendor-down breaker (3 failures → 5 min).
9. The referee stays bound to the shadow's switch and soak; live Jev calls do not.

## Open questions

*(none)*

## Rollback

Set `intelligence.jevSignalLive.enabled: false` (read live, no restart) — the gate
returns to detector-only signals on the next message and stops the live Jev calls.
The referee is stopped independently by `jevSignalShadow.referee.enabled: false`
or by the shadow's soak ending. Code rollback is a revert;
no state or data migration is involved.
