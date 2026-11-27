# Convergence Report — A machine back from a stall re-asks before it takes the lead

## Cross-model review: codex-cli:gpt-6.2-astra

A real GPT-tier external pass ran through the agent's codex CLI on every round (rounds 1 to 6). The Anthropic
clean-door reader (`claude-code:claude-fable-5`) returned a review in round 1 and degraded (error) in later rounds;
it is disclosed separately and never counted as a cross-model pass. Gemini was not authed on this machine
(`gemini-not-authed`), so the GPT family was the only external family.

## ELI10 Overview

Echo runs on several computers. One holds the lead, renewing a one-minute pass every 30 seconds. On 2026-11-21 the
Laptop's server froze for almost four minutes (likely a big app build), twice. On waking it looked at its own
out-of-date copy of the Studio's pass, saw it four minutes old, and grabbed the lead within a second, although the
Studio was healthy. Each grab forced a lead change and Studio restarts and stopped the test line.

The fix teaches the lease code to notice that it lost running time (an "am I awake?" clock), and after such a loss to
refuse to grab the lead until a full minute has passed with it awake and a fresh round of asks, started after the
freeze, has finished. It asks everyone once right away, so a live lead's renewal arrives and the grab never happens.
It is switched off until the run lead turns it on.

The trade-off: a real takeover of a dead lead waits about one minute after this computer's own freeze, and a computer
that keeps freezing will not take the lead for up to about ten minutes.

## Original vs Converged

- **A reply-based shortcut was removed.** The first draft let the standby claim at once if the lead answered "I hold
  nothing". Review showed a reply sent before the freeze can sit unread and look fresh at wake, so the shortcut could
  grab the lead from a live holder. Now a holder that answers without holding is taken over after one minute awake.
- **The trigger was re-derived.** The first draft opened on 40 % of the TTL and counted a gap minus 2 s. Review showed
  the copy also ages between pulls, so a 26 s freeze could slip through. Now whole gaps of 6 s or more count and the
  trigger is 30 % (18 s at a 60 s TTL), with any override clamped to 1 s .. TTL/2.
- **The silence shortcut was removed too.** Rounds 1 to 5 tightened a "the lead was silent for 45 s" rule (post-stall
  probes only, recomputed anchors, a witness computer, drain times). Round 6 showed that a probe records only when an
  ask ended, so asks sent before the freeze can still pass for fresh silence; the rule was removed, and the only
  evidence trusted is a round of asks this computer started after the freeze and saw finish. A dead lead is taken over
  at one minute instead of about 45 seconds.
- **The one-minute fallback got stricter.** It needs a fresh round that started after the freeze and finished, and it
  counts awake time only.
- **More cases are covered.** A former holder reclaiming its own lead, a released lease, and an empty view are all
  gated (a third computer may have taken over during the freeze). A CAS loss keeps the episode open. An episode whose
  holder stayed live ages out; one whose holder lapsed is left for the claim so the claim is recorded.
- **Bounded and observable.** One extra pull per episode at most; a ten-TTL cap for a computer that keeps freezing; an
  error row when a claim is held two TTLs, and a "suspected overlap" row if the computer taken over renews soon after.

## Iteration Summary

| Iteration | Reviewers who flagged | Design findings | Left behind | Spec changes |
|-----------|-----------------------|-----------------|-------------|--------------|
| 1 | codex (3), clean-door (1), conformance gate (signals) | 4 | 3 | reply shortcut removed; C needs a completed round; episode closes on landed claim; anchors recomputed |
| 2 | codex (3), security/adversarial (3), scalability/integration (2), decisions/lessons (3) | 10 | 9 | threshold re-derived; witness peer; loss cuts B; own-lapse and released views gated; aged-out episodes; dispose; chain-anchored hold record |
| 3 | codex (3), conformance gate | 3 | 2 | witness drain; clamp fix; holder-side claim corrected and filed (fb-54f9ae11-2ca); chain cap |
| 4 | codex (3), internal (1) | 4 | 4 | age-out only on a live view; released/empty under C; 40 s drain; cap on any chain round; default never above TTL/2 |
| 5 | codex (4), internal (2) | 5 | 3 | chain cap back on a post-loss round; extra pull attempted at most once; stale chain restarts; every view gated, stated consistently |
| 6 | codex (3), internal (1) | 4 | 2 | probe-silence rule (B) removed; chain cap on monotonic time; stale-chain check before the loss is applied; overlap watch only for another machine's lease |

Standards-Conformance Gate: ran in round 1 (7 flags) and round 3 (7 flags); advisory, folded into the rounds.

## Proportion

Tier 2 (lease safety decision); about 250 LOC in src plus four test files; spec about 320 lines. Six rounds, the
Tier-2 cap. ⚠ Every round found a genuine design defect, most of them in the probe-silence rule; the final round
resolved its findings by removing that rule, which shrank the design rather than growing it, and the independent
second-pass review read the final design.

## Left behind

- A faster dead-holder takeover (about 45 s) needs dial-start generation tagging in `HttpLeaseTransport.pullPeer`,
  which open PR #3604 rewrites; until then the takeover after a stall is one TTL (60 s).
- The holder side (a holder that slept past a TTL) is unchanged; filed as fb-54f9ae11-2ca.
- Conformance-gate signals accepted as declared trade-offs: thresholds are static invariants derived from the lease's
  own cadences rather than an arbiter (Judgment Within Floors); C is today's rule on an awake clock and so inherits its
  partition risk (Verify the State); dark ship with the enable decision handed to the run lead (A Dark Feature Guards
  Nothing, Maturation Path).
- Case 1 (00:27 bursts) coverage is conditional on the bursts losing more than 18 s inside one minute; the log lacks
  the per-drift timestamps to prove it.
- No dedicated CAS-loss retry test (the episode stays open by construction; verified by reading the loop).
- No dedicated coordinator test for the chain cap against a live holder (the cap needs a completed post-loss round,
  whose folded renewal makes `canAcquire` refuse first; covered in the pure test and by reading).

## Full Findings Catalog

Round 1 — codex: A could pair a stale null view (DESIGN, resolved: A removed); C at the boundary with a reply in
flight (DESIGN, resolved: completed round); episode closed before CAS (DESIGN, resolved); case-1 coverage and trigger
wording (PRECISION, resolved in text). Clean-door: pre-gap anchors leak into post-gap classification (DESIGN,
resolved: anchors recomputed); simpler always-pull alternative unstated (PRECISION, resolved: Frontloaded 8); terms
unglossed (PRECISION, resolved). Conformance gate: 7 advisory flags (thresholds, freshness, no-peer bypass, maturation,
observability, unbounded pulls, dark feature): no-peer bypass removed, pulls bounded, outcome evidence added, maturation
criteria made checkable; the rest recorded above.

Round 2 — codex: minimum R1 settings let one stale timeout count (DESIGN, resolved: drain); a smaller in-episode gap at
C's deadline (DESIGN, resolved: awake-only time and round after the latest loss); own lapse relies on R1 (DESIGN,
resolved: own lapse gated by C); overlap telemetry overstated (PRECISION, resolved: "suspected overlap"). Security and
adversarial: released view after a stall (DESIGN, resolved); R1 switch independence (DESIGN, resolved); B counting own
network failure (DESIGN, resolved: witness peer); probe timestamp wording, legacy dial, sub-6 s gaps (PRECISION,
resolved in text). Scalability and integration: episode never closing (DESIGN, resolved: aged out); timer without stop
(DESIGN, resolved: dispose); cadence-dependent numbers, two stacked pulls, posture sentence, stale types comment,
unused field, error-rate denominator (PRECISION, resolved). Decisions and lessons: threshold derived wrongly (DESIGN,
resolved); loss-crossing probes in B (DESIGN, resolved); long-hold record reset by re-opens (DESIGN, resolved: chain
anchor); episode never closes, missing ceiling, timing details, hand-back tracking, ELI16 overstatement (PRECISION,
resolved or left behind).

Round 3 — codex: witness reply buffered before the stall (DESIGN, resolved: witness drain); holder side across a sleep
(DESIGN, resolved by correcting the spec and filing fb-54f9ae11-2ca); override below 1 s ignored (DESIGN, resolved:
clamp); mechanism wording and boundary fixture (PRECISION, resolved). Conformance gate: sustained starvation unbounded
(resolved: chain cap); others recorded above.

Round 4 — codex: released view with failing first pull (DESIGN, resolved: C); freshness time bound (DESIGN, resolved: 40
s drain including loop delay; tagging left behind); cap could still wait on a post-loss round (DESIGN, resolved);
partial-connectivity wording, mechanism hypothesis (PRECISION, resolved). Internal: age-out pre-empting C's recorded
claim (DESIGN, resolved); boundary numbers, cap conditionality, wall step back, floor above TTL/2 (PRECISION, resolved).

Round 5 — codex: chain cap accepted any round since the chain began (DESIGN, resolved: post-loss round again); B's
freshness by completion time (DESIGN, resolved in round 6 by removing B); the extra pull could repeat while unresolved
(DESIGN, resolved: attempted once); empty-view gating stated three ways (DESIGN, resolved); C wording under partial
connectivity (PRECISION, resolved). Internal: the same chain-cap regression (DESIGN, resolved); the spec misstating
gated views (DESIGN, resolved); stale chain anchors, pull wording, a missing failure row (PRECISION, resolved).

Round 6 — codex: two pre-stall probes plus one fresh one could satisfy B (DESIGN, resolved: B removed); the chain cap on
the wall clock (DESIGN, resolved: monotonic); `held` recorded before the pull and its dedupe scope (DESIGN, resolved:
recorded at the first held evaluation, before the pull, once per chain); the cap row's wording (PRECISION, resolved).
Internal: the stale-chain check computed after the loss was applied, so it never fired (DESIGN, resolved: judged
before); the overlap watch arming on an own-lapse claim (PRECISION, resolved).

## Convergence verdict

Converged at the Tier-2 cap (round 6). Round 6's design findings were all resolved, by narrowing the design (the
probe-silence rule removed) rather than adding mechanism; no safety, security or data-loss finding remains open. What
remains is in `## Left behind` with reasons. The final design was read by the independent second-pass reviewer.
Spec is ready to approve and build.
