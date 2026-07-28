---
title: "Tone-Gate Advisory Migration — a hard block produces no evidence"
slug: "tone-gate-advisory-migration"
author: "echo"
status: "draft"
created: 2026-07-25
parent-principle: "Judgment Within Floors"
sibling-principles: "The Body and the Mind; Decision Provenance & Outcome Review; Intelligent Prompts — An LLM Gate Must Not String-Match; Structure beats Willpower; Observation Needs Structure; No Silent Degradation to Brittle Fallback; Close the Loop; Verify the State, Not Its Symbol; Testing Integrity; Bounded Blast Radius"
lessons-engaged: "llm-decision-quality-meter (the meter that graded 1,440 tone decisions and produced zero verdicts); gate-prompts-judge-by-meaning-not-literal-lists (B1–B7 migrated to signal-driven); correction-derived-hardening (B21 shipped advisory from day one — the precedent this generalizes); tone-gate-graceful-degradation F4 (the degraded deterministic floor); outbound-gate-tiered-fail-direction (operator-channel-sacred); tone-gate capture-wiring gap 2026-07-24 (a knob that worked everywhere except through the real construction site)"
origin: "Operator directive 2026-07-19, topic 33368 — 'a check blocking me from sending you a directory path is too much power'; approved 2026-07-19 and re-affirmed 2026-07-23 ('Yes, approved. Please proceed')"
eli16-overview: "tone-gate-advisory-migration.eli16.md"
review-convergence: "2026-07-25T07:46:56.223Z"
review-iterations: 2
review-completed-at: "2026-07-25T07:46:56.223Z"
review-report: "docs/specs/reports/tone-gate-advisory-migration-convergence.md"
cross-model-review: "codex-cli:gpt-5.5"
approved: true
approved-by: "Justin (topic 33368) — 2026-07-19 approving the advisory/hard-wall split, re-affirmed 2026-07-23 21:45 PDT ('Yes, approved. Please proceed')"
approval-scope-note: "The approval covers the REPRESENTATION rules becoming overridable nudges with a recorded reason, and live credentials remaining an absolute hard stop. Every change review forced since then is strictly MORE conservative than what was approved — most notably the self-stop family (B15–B19) staying a hard wall rather than being migrated on an inference from that approval. That narrowing, and the open question of whether he wants those migrated later, were surfaced to him in topic 33368 on 2026-07-25 rather than assumed."
---

# Tone-Gate Advisory Migration

## 1. The problem, stated precisely

The outbound tone gate makes ~200 block/allow decisions a day about the agent's
own messages. The LLM-Decision Quality Meter records every one of them. Over the
seven days to 2026-07-24 it recorded **1,440 tone-gate decisions and graded
exactly zero** — `right=0, wrong=0, unknown=1363`.

That is not a broken query, and it is not a missing grader. It is a structural
consequence of the gate's own design:

> **A hard block produces no REACTION evidence.**

Precision matters in that sentence: a block still leaves the candidate text, the
cited rule, and the context window on the provenance row, so retrospective
judging of blocked candidates is possible in principle (and a manual pass over 34
of them produced the only verdicts this decision point has ever had). What a
block cannot produce is the agent's REACTION — the one signal that says whether
the party best placed to judge the message agreed. When the gate blocks and the
agent has no recourse, there is no observable reaction. Nothing downstream distinguishes "the gate was right and the agent
would have agreed" from "the gate was wrong and the agent was overruled." The
only registered rule for the decision point is `tone-window-unknown-v1`, a
terminalizer whose entire job is to write the honest `unknown` once the evidence
window closes with nothing in it. The window closes empty **by construction**.

The operator identified the same defect from the user side, independently:

> "I felt a hard block on sending a directory path was too strong … most checks
> should be advisory nudges with override and reason logging, while only live
> credentials/passwords should remain an absolute hard stop." — 2026-07-19

These are one problem with one fix. Making the judgment rules overridable is
simultaneously (a) the correct authority boundary — the agent, not a
`fast`-model check, holds the final call on its own prose — and (b) the only way
the disagreement signal can exist at all.

## 2. What is already true (do not rebuild)

- `RULE_DISPOSITIONS` already exists, mapping each rule to `blocking | advisory`.
  `B21_USER_TASK_SUBSTITUTION` already ships `advisory`, and the map's own
  comment names this migration as anticipated follow-up work. <!-- tracked: CMT-904 -->
- The route seam already implements the advisory disposition end-to-end: a
  `422 tone-gate-advisory` with `notSent: true`, and an ack path
  (`metadata.toneAdvisoryAck`) that delivers unchanged and re-logs the decision
  with `advisoryOverridden: true`.
- The decision-quality substrate already exists: correlation-id minting, the
  `annotateDecisionOutcome` chokepoint with registry-derived rungs and
  owner validation, precedence ordering, and evidence-strength segregation.

So the migration is not new machinery. It is (1) a disposition change, (2) the
hard wall the disposition change requires, and (3) connecting the reaction the
disposition change makes possible to the evidence substrate that is already
waiting for it.

## 3. Design

### 3.1 Disposition — resolved, not rewritten

`RULE_DISPOSITIONS` stays as the **unmigrated baseline**. A resolver applies the
migration on top:

```
resolveRuleDisposition(rule, advisoryMigration) →
  no rule / unregistered id   → 'blocking'
  baseline 'advisory'         → 'advisory'
  migration off               → baseline
  migration on + not exempt   → 'advisory'
```

Keeping the baseline intact makes the rollback a **flag, not a revert** — the
pre-migration behaviour is still in source and still exercised by tests.

**Frontloaded decision 0 — the self-stop family (B15–B19) is EXEMPT and stays a
wall.** The first draft shipped `ADVISORY_MIGRATION_EXEMPT_RULES` empty, reading
the operator's directive as covering every rule. Review rejected that, and the
rejection is correct: the directive is about *representation* ("a check blocking
me from sending you a **directory path** is too much power"), and the two rule
families have opposite harm profiles.

| | B1–B14, B20–B21 (representation) | B15–B19 (self-stop) |
|---|---|---|
| What is judged | an externally verifiable fact about the text | whether the agent's own reason for stopping is legitimate |
| Agent's standing | a reasonably disinterested judge | **the party the rule constrains** |
| Cost of a wrong override | one leaked path | the work is abandoned |
| When the harm lands | on read | **the instant the message sends** |
| Does bulk judging help? | yes — that is the evidence | no: T+7d cannot un-abandon the work |

The evidence rationale — the entire justification for this migration — simply
does not reach the second column. Worse, the override reason for a B15 would be
authored by the very reasoning the rule exists to distrust, so the cheapest
sentence that satisfies the floor ("the remaining items are documented, so this
is a clean handoff") *is* the rationalization B15 catches. Migrating a structural
guard into a one-sentence tax, payable in the currency the guard already
distrusts, is not a decision an inference from the leak-class approval can carry.
It is surfaced to the operator instead.

A future migration of this family should not be a plain nudge. The right shape is
a THIRD disposition: overridable only by naming a `stop_reason_kind` from the
enum the prompt already emits (`external-blocker | design-fork | operator-stop |
completion`), with `agent-state` refused — a falsifiable claim that can be
cross-checked deterministically against the BlockerLedger / SelfUnblockChecklist
exhaustion run, rather than free prose. <!-- tracked: topic-33368 -->

**Frontloaded decision 0b — the advisory disposition is CONDITIONAL on its own
evidence (the evidence-capturability invariant).** A verdict resolves advisory
only when the reaction could actually be recorded: a `decisionRef` exists AND
`decisionQualityRecordingLive()` is true. Otherwise it falls back to a BLOCK,
tagged `advisoryUnavailable` in the response and the audit line.

This exists because the bargain is void in two states that are both reachable in
the DEFAULT configuration:

1. **The quality seam is dark or dry-run.** `provenance.uniformSeam` is a
   SEPARATE gate from `toneGate.advisoryMigration`, and its `dryRun` **defaults
   true**. A fleet flip of the migration alone would hand out every loosening and
   record nothing — the pure-downside configuration, reachable by default.
2. **No `decisionRef` was minted.** The budget-timeout degrade builds its verdict
   in the route, outside the gate, where the router's correlation id is
   unreachable — and that is the path that fires under load.

The invariant makes the migration **self-limiting**: it can only ever be as live
as its own evidence collection. It is scoped to MIGRATION-derived advisories — a
rule whose baseline disposition is already advisory (B21) never made the evidence
bargain and is not demoted, or the safety check would itself regress a shipped
behaviour.

**Frontloaded decision 1 — an unregistered rule id resolves `blocking`.**
`GATE_UNAVAILABLE` and `CAPACITY_UNAVAILABLE` are not judgments; they mean *no
verdict was produced*. There is no opinion to disagree with, so there is nothing
to acknowledge away. Treating them as nudges would turn every provider outage
into a free pass — precisely the fail-open the fail-closed work removed. The
resolver therefore defaults unknown ids to `blocking`, so a rule cannot inherit
advisory leniency by omission.

**Frontloaded decision 2 — disposition follows the RULE, not the PATH.** Three
sites produce a verdict: the normal cited-rule path, the derived-B15 path (where
the model's structured reasoning implies a self-stop), and the degraded
deterministic floor (used when the LLM authority is unavailable). Before this
change only the first consulted the disposition map — the derived-B15 branch
built its result inline and would have hard-blocked a B15 flipped to advisory,
and the degraded floor never consulted it at all. All three now resolve through
the same function. A file path is the same opinion whether the judge, the
model's own reasoning, or the floor named it.

### 3.2 The hard wall moves to where it belongs

Removing the LLM hard-block is only safe because the case that must never be
overridable stops depending on it.

`outbound-credential-guard` is a **deterministic** check that runs in
`evaluateOutbound` **before** the authority, beside the existing localhost-link
guard, on the same reasoning: a live credential in a chat log is irreversible
the moment it lands, and "let me override it" is the wrong option to offer.
Because it is deterministic it holds under exactly the conditions the LLM rules
cannot run at all — provider outage, spawn-cap saturation, no gate configured.

### What this actually changes — stated honestly

The first draft claimed *"credential protection is strictly stronger after this
change than before it."* **That claim is false and is withdrawn.** Review proved
it by reading the code: `GateSignalDetectors` enumerates the whole deterministic
floor (cli-command, file-path, config-key, copy-paste-code, api-endpoint,
env-var, cron-or-slug) and contains **no credential kind**, and B20's own prompt
text says it "does NOT replace secret/path redaction (enforced separately)". So a
credential was only ever caught *incidentally*, when it happened to also trip
B4/B6/B3 — and those rules are now overridable.

The honest statement is a **trade, not an improvement in every direction**:

- **Stronger** for the enumerated provider-prefixed shapes: they move from an
  incidental LLM opinion to an explicit deterministic wall that holds during an
  outage, under spawn-cap saturation, and with no gate configured at all.
- **Weaker** for every credential shape outside that list — an unlabelled
  `OPENWEATHER_KEY=9f2a1b8c4d5e`, a prose password, a bare JWT, a non-standard
  vendor key. Before, B6 could hard-block it; now the objection is overridable
  with a recorded reason. Compensating: the override is an affirmative, attributed
  act rather than a silent pass, and `scrubForStore` still redacts at every
  durable write. This residual is **accepted, named, and not glossed**.

**Frontloaded decision 3 — the wall admits only credential VALUE shapes.** The
pattern list is IMPORTED from `durableSecretScrub` (never a second copy — a
duplicated security pattern list is a list that drifts), filtered to shapes that
carry a vendor-assigned literal prefix (`sk-ant-`, `ghp_`, `AKIA`, `xoxb-`,
`AIza`, …) or an unambiguous structural block (`-----BEGIN … PRIVATE KEY-----`).

Three kinds the first draft admitted are now **excluded**, because review ran the
actual regexes and each fires on ordinary prose:

| kind | why excluded |
|---|---|
| `labeled-secret` | matches a LABEL near a long word: *"Disable **password authentication** in the sshd config"*, *"the **token** refresh_interval is 15 minutes"*. And it fails in the direction that matters — a real `password: hunter2` does **not** match (the value is under its 12-char floor). It blocks English and passes the credential. |
| `bearer-token` | matches *"Authorization: Bearer YOUR_DASHBOARD_TOKEN_HERE"* — the placeholder shape this project's own docs use. |
| `jwt` | three dot-separated base64 runs also describe content hashes and chained digests, which instar messages legitimately carry. |

Every one of those strings would have been **unsendable by any route** — no
override, no metadata escape hatch, only a code deploy. They are now pinned as a
false-positive corpus in the Tier-1 test, so re-admitting a label-proximity kind
fails the build with those exact sentences in the failure output.

A false block on a genuine provider-prefixed match costs a rephrase — the
exemption clause's own test, "try again with the right arguments" — because the
agent can always name the secret instead of pasting it. That is the property that
makes the wall legitimate, and it is why the admitted set must stay
value-shaped: the test does not hold for a wall that fires on "password
requirements".

`assertHardWallKindsExist()` + its pinning test fail the build if an upstream
rename empties a hard-wall kind, so the floor cannot silently stop walling.

**Frontloaded decision 3b — oversize input REFUSES.** The scan is linear (the
shared list's pinned linearity contract; measured 0.4 ms at the 4 KB Telegram
cap), but two outbound routes have no length cap and the body limit is 12 MB
(~143 ms of synchronous scan). Past `MAX_SCAN_BYTES` the guard refuses rather
than passing — the OPPOSITE fail-direction from a detector fault, deliberately:
"too big to scan" must never become "pad past the bound and walk through the one
unoverridable wall."

**Frontloaded decision 4 — the guard never echoes what it caught.** It returns
the credential CLASS, never the matched substring. The caller writes that value
into an error body, a log line and an audit row; a guard that echoes the secret
has leaked it into three more places than the message would have.

### 3.3 The reaction becomes evidence

Two rules join `RULE_REGISTRY` against `messaging-tone-gate`:

| ruleId | grade | meaning |
|---|---|---|
| `tone-agent-override-v1` | `wrong` | the agent delivered unchanged, disputing the verdict |
| `tone-agent-complied-v1` | `right` | the agent accepted the nudge and revised |

Both are owned by `ToneGateAdvisory` and registered at the **`self-report`**
rung with `self-report` evidence strength.

**Frontloaded decision 5b — the flat grade field is marked, not just
segregated.** `/decision-quality` computes `byStrength`, which correctly keeps
proof-like and heuristic grades apart. But it ALSO emits a flat
`gradeDistribution {right, wrong, unknown}` — a pool-merged, test-asserted field,
and the one a casual reader or a future automated consumer quotes. With the tone
gate's reaction rules registered, that field's right/wrong can be **100%
self-report**, and unmarked it reads as a measured error rate. Segregation that
exists as a sibling field is not segregation for anyone who doesn't know to look.

`gradeDistribution` therefore carries `selfReportShare` and `selfReportOnly`, so
a consumer of the flat number can see what it is made of without knowing
`byStrength` exists. The load-bearing case is `selfReportOnly: true` — every
graded outcome here is the interested party's own word.

**The read path for the reason text, stated honestly.** `evidenceNote` is never
served by `/decision-quality`. It is readable via `GET /judgment-provenance` as
`outcome.note` — but that surface has **14-day** retention and is subject to
`provenance.sampling`, while the SQLite copy in `decision_outcomes.evidence_note`
is retained ≥30 days and is **never SELECTed anywhere in the codebase**. So the
long-lived copy is unreadable and the readable copy is short-lived and sampled.
Since the bulk judge is a non-goal here, that is a genuine Close-the-Loop risk
against this spec's own thesis and is registered rather than noted.
<!-- tracked: topic-33368 -->

**Frontloaded decision 5 — self-report, not ground truth.** The agent is an
interested party grading a judgment about its own message. The rung's precedence
ordering guarantees a self-report can never outrank an independent grader, and
the read surface segregates it from proof-like evidence. The result is that
"the gate was wrong 40% of the time" is always legible as *the agent said so*,
never as measured truth. This is what makes the signal safe to collect at
volume: it is honest about its own weakness. It is also exactly the input the
operator asked for — bulk judging later, by a stronger model, over recorded
reactions.

**Frontloaded decision 6 — compliance is recorded, and the asymmetry is
disclosed.** Recording only overrides would measure the gate exclusively through
the cases the agent disputed: a sample guaranteed to make any gate look worse
than it is. The revised re-send carries `toneAdvisoryComplied` so a good catch is
graded `right`.

**The two paths are enforced symmetrically, because an asymmetry here would
manufacture the very bias the compliance path exists to prevent.** Round 2 caught
this: an override is structurally impossible without producing its `wrong` grade
(the message will not send otherwise), while compliance was an opt-in field the
agent had to remember across a revise cycle. The recorded ratio would then have
been *"every override, plus whatever compliance was remembered"* — permanently
skewed toward "the gate was wrong", and resting on exactly the willpower this
codebase refuses to build on.

Disclosing that in prose was the first fix and it was the wrong one. **The server
correlates it instead.** When an advisory 422 goes out, the server notes
(topic → rule, `decisionRef`, text fingerprint). If the next PASSING send to that
topic inside a bounded window carries DIFFERENT text, the agent revised and the
original verdict is graded `right` — with no agent metadata at all. The explicit
`toneAdvisoryComplied` remains honored as a direct declaration.

**The inferred credit is weaker than a declared one, and the row says so.** The
server correlation cannot distinguish "revised the nudged message" from "gave up
on it and sent something unrelated next" — both are a passing send with different
text. Rather than hide that behind an averaged number, each `complied` row
carries `derivation: 'declared' | 'inferred'`. A later judge can weight or
discard the inferred ones; it could never recover a distinction that was never
written down. The window is 10 minutes for the same reason: a revision follows a
nudge promptly, an unrelated message is likelier to arrive later.

A similarity threshold was considered and **rejected**. A genuine rewrite in
response to a nudge often shares almost no wording with the original ("I put it
in `docs/x.md`" → "want a link, or the summary here?"), so a similarity gate
would silently discard exactly the compliances most worth recording — trading a
visible imprecision for an invisible one.

Two deliberate conservatisms:

- **An unchanged resend is not a revision.** A `temperature: 0` gate is not
  bit-deterministic across invocations, so identical text that happens to pass on
  re-review is noise, not agreement. It records nothing.
- **Silence records nothing.** A nudge the agent simply abandons is graded
  neither way, rather than being counted as compliance by default.

With both paths structural, an override rate is a rate over reactions the system
captured rather than the ones the agent remembered to report — still `self-report`
strength, and still carrying the `selfReportOnly` marker, but no longer skewed by
construction.

**Frontloaded decision 7 — the override REASON is structurally required.** An
ack without `toneAdvisoryAckReason` is refused
(`422 tone-gate-advisory-reason-required`) and the message stays unsent. The
reason is the evidence; an override with no reason is an ungradeable event, and
"remember to explain yourself" is exactly the willpower this codebase refuses to
rely on (Structure beats Willpower). The minimum length is 8 characters — a
"did you type anything" floor, not a quality bar. A length check cannot judge
whether a reason is *good*; that is the bulk judge's job, later, reading the
recorded text. Setting it high would only teach the agent to pad.

**Frontloaded decision 8 — the join is explicit, via `decisionRef`.** The gate
captures the router-minted correlation id (`onCorrelationId`) and returns it on
the advisory response. The resend carries it back. Without it an override is an
orphan row that no grader can attach to the verdict it disputes — volume with no
signal. `recordToneAdvisoryReaction` is a **silent no-op** when no ref is
available, rather than writing an unattributable row.

### 3.4 Rollout

Dev-gated: `toneGate.advisoryMigration` is **omitted from ConfigDefaults on
purpose** so `resolveDevAgentGate` decides — live on a development agent, dark
on the fleet. An explicit `false` is the operator rollback (read live, per
review, no deploy); an explicit `true` is the fleet flip.

## Maturation plan

Per the **Maturation Path** standard — "ships dark" is a starting state, never a
finished one, so the exit criterion is declared here rather than discovered later.

- **test-agent-live:** n/a — the feature has no test-agent surface; the dev agent is the first rung, because producing any reaction at all requires real conversational traffic.
- **dev-agent-live:** this ship. `toneGate.advisoryMigration` resolves live via the dev-agent gate, with the evidence-capturability invariant as the built-in brake.
- **dark-window:** minimum 14 days on the dev agent.
- **graduation criterion:** fleet flip is proposed only when ALL hold over >=14 days — (a) >=50 tone decisions carry a `self-report` grade, proving the evidence source PRODUCES rather than merely compiles; (b) both reaction paths observed firing (overrides AND server-correlated compliances), so the sample is not one-sided in practice either; (c) zero credential-wall false positives in the audit; (d) `advisoryUnavailable` occurrences reviewed, since a high rate means the seam coupling is misconfigured rather than that the feature is ready. Graduation is gated on the evidence source being ALIVE and explicitly NOT on a measured quality rate: a self-report rate is not a fact about the gate, and making it a gate criterion would launder it into one.
- **fleet:** requires the operator's explicit flip AND `provenance.uniformSeam` live+non-dry on the target agents, since the invariant otherwise keeps the migration inert there (correctly).

**The fleet-flip precondition is load-bearing and easy to miss:** flipping
`toneGate.advisoryMigration: true` on a fleet agent whose quality seam is dark
buys nothing — the invariant demotes every advisory straight back to a block.
That is the safe failure, but an operator expecting nudges would see none. Both
flags move together or neither does.

**Frontloaded decision 9 — no dry-run stage.** The graduated-rollout ladder's
dry-run tier exists for features that TAKE an action (a kill, a respawn, a
credential move) where the dark run proves what it *would* have done. This
feature's change is that the gate takes *less* action. A "dry-run" would mean
"log that we would have nudged, but hard-block anyway" — which produces exactly
the zero evidence the migration exists to fix. The dev-agent gate is the
staging; the operator flag is the rollback.

## Decision points touched

| Decision point | Classification | Justification |
|---|---|---|
| **Live-credential outbound wall** (`detectOutboundCredential` → hard 422) | `invariant` | The sanctioned exemption class, verbatim from `docs/signal-vs-authority.md` §"When this principle does NOT apply": *"Safety guards on irreversible actions … can and should be hard-blocked by brittle pattern matchers, because the cost of a false pass is catastrophic and the cost of a false block is merely 'try again with the right arguments.'"* Both halves hold. **Catastrophic false pass:** a credential in a chat log is burned the instant it lands — unrecallable, blast radius is whatever it opens. **Cheap false block:** the agent rephrases to name the secret instead of pasting it. No information is lost and the correct message is always reachable. The domain is enumerable (a closed, code-authored set of provider-prefixed shapes) — the exemption's other half. |
| **Tone/representation judgment** (B1–B21 → nudge) | `judgment-candidate` | The point the migration exists to reclassify. Whether a file path is leaked internals or useful context is open-domain meaning over non-enumerable context — precisely what **Judgment Within Floors** permits delegating to an arbiter *inside a floor*, and precisely what a static block must not own. |
| **Availability hold** (`GATE_UNAVAILABLE` / `CAPACITY_UNAVAILABLE`) | `invariant` | Not a judgment — the arbiter produced no verdict. This is the floor's conservative default; there is no opinion to disagree with, so there is nothing to acknowledge away. |
| **Reason-required refusal** (`tone-gate-advisory-reason-required`) | `invariant` | A closed-world format invariant over a field this system itself defines — the documented dev-chokepoint class. It decides nothing about meaning; it checks a required field is present. |

## The floor, stated explicitly (Judgment Within Floors)

The migration does not remove a floor. It makes the floor **legible** and puts
the arbiter's authority on the correct side of it.

- **The floor (deterministic, never delegated):** the live-credential wall, the
  localhost-link guard, the length check, and the availability holds.
- **The action space above the floor:** `{ send as written, revise and send }` —
  bounded and complete, with no path that discards the message.
- **The conservative default:** `revise`. The message does **not** send on an
  advisory verdict. Sending unchanged requires an affirmative, reasoned act, so a
  timeout, a crashed session, or an agent that simply ignores the 422 results in
  the message not going out.
- **The arbiter narrows, never widens:** the LLM gate can only advise toward
  revision. It cannot authorize anything the floor forbids — an advisory ack has
  no effect on the credential wall (proved at
  `tests/integration/telegram-reply-advisory-migration.test.ts`).
- **Irreversible consequence requires mechanical corroboration:** the one
  irreversible outbound consequence — credential exposure — is decided by the
  deterministic wall, never by free-text evidence. The override reason is free
  text precisely *because* the decision it accompanies is reversible.
- **The fallback ladder ends deterministically:** LLM verdict → (unavailability)
  the deterministic leak floor → (operator strict mode) pure hold. No rung ends
  in "send unchecked" except by explicit operator kill-switch.

## Multi-machine posture

| Surface | Posture | Notes |
|---|---|---|
| `toneGate.advisoryMigration` flag | **unified** | Resolved from each machine's own config through the standard dev-agent gate, like every other gated feature. Per-machine divergence is possible only if the operator sets it differently per machine, and degrades safely — one machine nudges, the other blocks; neither is unsafe. |
| The live-credential wall | **unified** | A pure function of message text plus a code-shipped pattern list. Identical on every machine by construction; no state, no config. |
| The advisory 422 + `decisionRef` round-trip | **unified**, with the relay bound stated below | |
| Recorded evidence rows (`decision_quality` outcomes) | **machine-local BY DESIGN** — `machine-local-justification: operator-ratified-exception` | Inherited, not invented here: the decision-quality substrate is already machine-local by its own spec (`llm-decision-quality-meter` §5.1 — the correlation id carries a `machineId8` segment precisely because rows live on the machine that made the decision), and the merged read already ships. Changing that posture is the meter's decision, not this migration's. The ratified, existence-checkable artifact is the merged read itself: `GET /decision-quality?scope=pool` in `src/server/routes.ts`. |

**The relay bound, stated honestly.** On a multi-machine pool a standby
deliberately SKIPS its local tone gate and relays the send through the lease
holder, which gates on receipt (`willRelay` in the telegram reply route). An
advisory verdict raised on the HOLDER therefore reaches the relaying standby's
caller as the holder's HTTP response, so the reaction round-trip is only as
reliable as that hop. If the hop loses the response body the agent sees a failed
send rather than a nudge, and no evidence row is written. That is a
**degraded-to-silence** outcome, never an unsafe one: the message does not go
out, and the credential wall runs on both ends regardless. Making the relay hop
preserve the advisory body end-to-end is a real follow-up, not a claim this spec
makes. <!-- tracked: topic-33368 -->

## Open questions

*(none)*

> Every decision is frontloaded in §3. The three operator-facing choices — whether
> the self-stop family should eventually become overridable, whether the override
> reason stays mandatory, and whether any other content class deserves a wall —
> are surfaced for ratification in the ELI16 companion rather than parked here as
> blockers, because none of them blocks this ship.

## 4. Non-goals

- **The bulk judge is not in scope here.** This spec lands the evidence SOURCE.
  Reading accumulated reasons and grading them with a stronger model is the
  operator's separately-designed bulk-judging pass. <!-- tracked: topic-33368 -->
- **Enrolling the other 49 census decision points** is separate work on the same
  topic. <!-- tracked: topic-33368 -->

## 5. Testing (all three tiers, per the Testing Integrity Standard)

**Tier 1 — `tests/unit/tone-gate-advisory-migration.test.ts`**
Disposition resolution across both flag states and every rule; availability
holds staying blocking; unregistered ids staying blocking; the degraded floor
under both flag states (including that a clean message still SENDS, keeping the
F4 gap closed); credential detection per class; the no-echo contract; the
benign-prose false-positive set; regex statelessness across calls; and the
evidence rules' registered rung/strength/owner.

**Tier 2 — `tests/integration/telegram-reply-advisory-migration.test.ts`**
The real `POST /telegram/reply` route: a former wall returning a nudge that
names both reaction paths; the reasonless-ack refusal followed by delivery with
a reason; the same verdict hard-blocking with the migration off; a compliant
re-send delivering; and the credential wall refusing with an ack present, with
`allowDebugText`, and **with no tone gate configured at all**.

**Tier 1 (added in round 2) — `tests/unit/tone-advisory-channel-parity.test.ts`,
`tests/unit/telegram-relay-refusal.test.ts`**
The parity ratchet asserts every `checkOutboundMessage` callsite carries the
reaction metadata or is a named exemption (review found it plumbed into 2 of 7 —
a property of the callsite SET that no per-route behavioural test can notice the
absence of). The relay tests assert a holder 422 comes back as a typed REFUSAL
carrying rule/decisionRef/howToProceed, that a 500 still returns null, and that
the four reaction fields survive the hop.

**Tier 3 — `tests/e2e/tone-gate-advisory-migration-alive.test.ts`**
Real `AgentServer` boot: the migration resolving live through the production
config resolver (the assertion that would have caught the 2026-07-24
capture-wiring gap), the rollback resolving on the same config, the LIVE
annotate chokepoint ACCEPTING both new rules, an impostor annotator being
REJECTED with `owner-mismatch`, and the credential wall holding on the real boot
without echoing the value while a clean message still sends.

Round 2 strengthened two assertions that were passing vacuously: the chokepoint
checks now assert `applied === true` rather than merely `rejected === undefined`
(the latter is ALSO true on the dry-run branch, which writes nothing — the test
proved registration while the evidence could have been evaporating), and a
dedicated case asserts `decisionQualityRecordingLive()` on the boot, since that
is the precondition the whole advisory disposition hangs on.

## 6. Rollback

`toneGate.advisoryMigration: false` in `.instar/config.json`. Every rule returns
to its baseline disposition; the credential guard remains (strictly additive, no
flag, by design). Recorded evidence rows are retained and stay honestly labelled
self-report.

**The no-restart claim is now true, and was not in the first draft.** Review
found that although the gate's config getter re-runs on every review, it closed
over the BOOT-TIME `config` snapshot — nothing re-reads the file into it, and
`toneGate` is not in `PATCHABLE_CONFIG_KEYS` — so the documented lever would not
have moved until a bounce. The construction site now layers the LIVE `toneGate`
block over the snapshot, so the rollback takes effect on the next review. The
Tier-3 test asserts the resolver against the real config object rather than a
hand-spread literal, which is the assertion that would have caught the gap.

**In-flight advisories across a flip:** an ack arriving after the flag goes false
re-reviews the text, resolves `blocking`, and the ack is ignored — the message
returns `tone-gate-blocked`. That is the safe direction (nothing is delivered
that the un-migrated gate would have held), but it will read to the agent as the
override silently failing, so the response names the disposition rather than
leaving it to inference.
