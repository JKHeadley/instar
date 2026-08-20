# Convergence Report — Agent Identity Continuity on Expansion

## Cross-model review: codex-cli:gpt-5.5 — RAN every round (7/7)

A real GPT-tier external pass ran through the agent's own codex CLI on all seven rounds
(`status: ok`, never degraded). The Standards-Conformance Gate ran on rounds 1, 7 and the
final check.

## Convergence verdict: **CONVERGED at round 7 under the 80/20 standard**

This is the first spec converged under the standard Justin set on 2026-08-19 (topic 48000):

> *"Once the reviews have results that are relatively small or minor, then we consider that
> converged."*

**What that means here, stated so it can be checked rather than trusted.** Round 7 returned
five findings. Three would have changed what gets built and were folded in: the provenance
record's persisted shape (needed for criterion 6b to mean anything), the interaction between
same-joiner retry and the failed-attempt cap (two limits that would otherwise be implemented
inconsistently), and a notice on machine removal (a removed host keeps a usable copy of the
agent key). Two were left: the reviewer's note that its own supporting context had been
truncated, and residual terminology load.

The final Standards-Conformance pass then returned **0 findings**, having caught two on the
previous pass that DID change the build — both folded in (see below).

**What was left behind, named rather than elided:**

- Terminology load — the spec assumes internal review vocabulary (`invariant`,
  `unified`, `machine-local`). Raised in rounds 3 and 7. Not iterated on.
- The reviewer's supporting-context truncation on round 7, which means its conclusions about
  prior relay behaviour rest on a partial read of the parent spec.

Neither changes what gets built. Under the previous "two consecutive clean rounds" criterion
this spec would have kept running; the review history below shows why that criterion was the
wrong instrument.

### Why the old criterion was replaced

The prior spec (`launchd-process-ceiling-floor`) ran to the 10-round cap without ever meeting
"no design-class findings for two consecutive rounds", while its reviewer recorded *"no serious
architectural objection"* in seven of those rounds. The cause is structural: a spec that
appends its own review history grows every round, so a diligent reviewer will always find
precision to add on a larger surface. By round 8 that spec exceeded the reviewer's input budget
and began truncating.

This spec kept its review history in this report from the start — a direct fix for that failure.

**The honest counterweight, which the operator was told:** long runs have not been worthless.
On the previous spec, round 7 caught a setup path that would have clobbered an operator's
deliberately raised ceiling, and round 10 caught a machine-id collision that could have
swallowed the alert for a machine actively crashing. So the rule is *stop when findings stop
changing the build* — not *fewer rounds is better*. A late structural finding is still acted on
and said out loud.

## ELI10 Overview

Agents are found by an address derived from their identity. One agent should have one address
everywhere it runs.

When an agent expands onto a new machine, it doesn't. The expansion copies the shared project,
gives the new machine its own local settings and its own machine keys, and registers it — all
correct. What it never does is bring the agent's identity across. So the new machine looks for
one, finds none, and makes a new one. Underneath, the agent has quietly become two agents
sharing a name.

That was found live on 2026-08-19: the operator authorised a Mac Mini to extend an agent onto a
Mac Studio, and four days later the Studio was still publishing a different address from the
Mini and Laptop. Nothing had reported it. It surfaced only while investigating something else.

It matters for two reasons. Messages sent to the old address can vanish — a stale registration
survives and can absorb them, which is exactly what happened to a different agent pair in July.
And anything signed on the odd machine carries the wrong identity, so it doesn't verify as that
agent.

This change carries the identity to the new machine over the pairing exchange that already
happens, refuses to invent one if that fails rather than quietly becoming a twin, repairs
machines already split, and — new — actually notices when a split exists.

## Original vs Converged

**Originally** this was: send the identity over the existing pairing channel, encrypted to the
joining machine, then repair anything already broken.

**After review** the same shape survives, but almost every security claim in it was wrong or
underspecified, and several were corrected outright:

- The first draft claimed a hostile responder was defeated *"because the signature fails"*.
  That is false — an attacker controlling the response supplies its own signing key, and the
  signature verifies perfectly against it. Only the pairing-code session binding closes that
  attack, and the spec now says so.
- Repair authority was *"the machine this one joined"*. A chained join breaks it: a machine that
  joined a diverged parent inherits the error. Replaced with lineage terminating in a root that
  was minted standalone.
- Lineage was then over-trusted in turn. It is **operational evidence, not cryptographic
  authority** — a compromised or old binary can self-sign a false claim — so any unattested
  candidate falls back to the operator.
- Which means the split that already exists **cannot be fixed by lineage at all**, and needs one
  explicit operator decision. The spec says that plainly instead of implying the repair is
  automatic.
- Burn semantics went from undefined, to no-retry (secure but an availability failure on any
  unlucky network), to same-joiner retry with third-party redemption refused.
- *"No new trust relationship"* was withdrawn. This changes what a pairing code IS: today it
  gets an attacker a registry row; after this it is a path to the agent's signing key. Pairing
  is reclassified as identity provisioning with the ceremony that warrants.
- Relay-side retirement of stale registrations was claimed, then withdrawn as a named
  dependency — that design does not exist, and pretending otherwise would have implied the
  split was fully cleaned up when it is not.
- The operator's decision was to be made by comparing two hex strings. The conformance gate
  rejected that, correctly: asking a person to eyeball two 32-character strings is how the
  wrong one gets picked. They now choose between descriptions, with the precision kept in the
  audit record.

The shared-key cost is stated rather than buried: every machine can sign as the agent, so one
compromised host compromises the identity everywhere, and removing a machine does not revoke
its copy. That is accepted as a compatibility bridge, with an explicit boundary against building
further on it.

## Iteration Summary

| Round | Standards gate | Cross-model | Build-changing | Left as precision |
|---|---|---|---|---|
| 1 | ran (1 flag) | 5 findings | 5 | 0 |
| 2 | — | 5 findings | 4 | 1 |
| 3 | — | 5 findings | 4 | 1 |
| 4 | — | 5 findings | 4 | 1 |
| 5 | — | 5 findings | 3 | 2 |
| 6 | — | 5 findings | 4 | 1 |
| 7 | ran (2 flags → 0) | 5 findings | 3 + 2 gate | 2 |

**Per-round model disclosure:** the internal reviewer perspectives were carried by the authoring
session rather than by spawned subagents, under a session instruction not to spawn agents
without a request. The genuinely independent reads were the cross-model codex pass (every round)
and the code-backed Standards gate. This is a real reduction in independence against the skill's
design and is recorded rather than glossed.

## Convergence verdict

Converged at round 7 under the 80/20 standard, with the residual findings named above. The
Standards-Conformance Gate returns 0 findings and rates the spec a fit against its parent
principle. Ready for operator review.
