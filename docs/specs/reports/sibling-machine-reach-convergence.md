# Convergence Report — Sibling-machine reach

**Spec:** [docs/specs/sibling-machine-reach.md](../sibling-machine-reach.md)
**Slug:** `sibling-machine-reach`
**Converged at:** 2026-11-21 (round 6, Tier 2 cap)
**Iterations:** 6
**Final-round design findings:** 0 from the six internal reviewers; 1 from the cross-model reviewer, accepted at the cap (see Left behind)

---

## Cross-model review: codex-cli:gpt-6.2-astra

A real GPT-tier external pass ran through the agent's codex CLI in every one of the six rounds
(status `ok` each round). Gemini was not authed on this machine (`gemini-not-authed`); the
Anthropic clean-door reviewer was available but not run. Standards-Conformance Gate: ran in round 1
(10 advisory flags, all engaged by the lessons-aware reviewer and folded into the design).

## ELI10 Overview

An instar agent can run on several computers. Before it sends a message to its person, a check
reads the message and catches bad habits, like asking the person for access the agent already
has. That check only knew about the one computer it was running on. So on 2026-11-20, when the
rebuilt Mac Studio was missing four accounts that the Mac Mini still had, the agent asked Justin
to do four sign-ins by hand, and the check did not object strongly enough.

This change lets each computer keep a small, regularly refreshed list of what its sibling
computers hold (signed-in subscription accounts and signed-in browser accounts). When the agent
drafts "please sign in account X on this machine" and another machine has a browser signed in to
exactly that account, the check nudges the agent and tells it which machine to use and how (start
the login on the machine missing the account, approve it with a helper session on the other one).

The main tradeoff: information from another machine can be up to an hour old, so it is only ever
used to NUDGE (which the agent can override with a reason), never to hard-block a message. It costs
a second check call only when the first check wants to block or nudge on such a message.

## Original vs Converged

- **Originally:** other machines' holdings counted toward the hard "you already hold this access"
  block (B17). **After review:** they only feed the overridable nudge (B21). A code-level
  confirmation re-runs the check without the other-machine section before any hard block stands.
  Why: a hard block that rests on another machine's hour-old report could trap a message the
  person genuinely needs.
- **Originally:** a browser signed in to the same provider, or a working pool login on the other
  machine, counted as access. **After review:** only a browser profile signed in to that exact
  account counts; a pool login there is corroboration only. Why: the route that actually worked
  needed a browser signed in as that account; a different Google account or a CLI token cannot
  approve the sign-in.
- **Originally:** the peer's full browser-profile listing was fetched. **After review:** a new light
  `?view=accounts` view reads no vault and writes nothing, is agent-bearer only, and is asked only
  of peers that identify themselves (older peers are never asked). Why: the full view reads the
  vault through blocking keychain calls and can create a file on the peer.
- **Originally:** the hint was a generic sentence on any block or nudge. **After review:** the
  check cites one sibling browser profile by an opaque reference; the server validates it and fills
  a fixed template (machine, service, a verified address) with no emails. Why: to avoid pointing
  the agent at the wrong machine or leaking identities into transcripts.
- **Originally:** one failure flag per machine and no brakes. **After review:** per-surface
  evidence and failure, identity checks of the answering machine, backoff, bounded fetches, a
  streaming size cap, a kill switch read live, and a status view.

## Experience fit

- **Goal and source:** Justin, topic 33890, message 146072 (2026-11-20): the agent should use its
  other machines before handing him per-machine work.
- **Ordinary journey:** the agent drafts the per-machine ask → the check nudges it, naming the Mac
  Mini and the helper route → the agent does the sign-in through a helper instead of overriding.
- **Contrasting cases:** a different account at the same provider on the Mini → no nudge (PASS);
  another person's account on a shared machine → PASS; a machine not heard from → UNKNOWN → PASS.
- **Evidence and limits:** whether the nudge changes the agent's decision is measured by new
  feature-evidence rows (hint attached, override/complied), not yet proven. The rate of the
  accepted residual (a sibling-aware PASS where a local-only check would have blocked) is
  unmeasured.

## Iteration Summary

| Iteration | Reviewers who flagged design | Design findings | Left behind | Spec changes |
|-----------|------------------------------|-----------------|-------------|--------------|
| 1 | security, scalability, adversarial, integration, decision-completeness, lessons-aware, codex | ~20 (overlapping) | ~15 | B17 stays local; exact identity; light view; one line per account; backoff; roster; login normalization |
| 2 | adversarial, decision-completeness, integration, lessons-aware, codex | 8 | ~12 | separate OTHER MACHINES section; byte-identical without siblings; hint naming; fleet view |
| 3 | codex | 4 | ~14 | local-only confirmation re-review; opaque profile refs; server-templated hint |
| 4 | lessons-aware, scalability, decision-completeness, integration, codex | 6 | ~6 | no-verdict path; agent-bearer-only light view; address binding; assertion age |
| 5 | security, codex | 4 | ~7 | identity fields bearer-only in the pool view; per-surface state; "machine missing the account" |
| 6 | codex (1, accepted) | 0 internal | 6 | small precision fixes |

Internal reviewers ran on the authoring session's model (Opus 5.5 subagents) every round.

## Proportion

Tier 2; spec ~430 lines; 6 rounds of 6. ⚠ Long for the size of the code change (one new module and
edits to three files): most rounds were driven by the B17/B21 interaction and the two-review
protocol it required.

## Left behind

- (cross-model, round 6, DESIGN — accepted at cap) "A simpler intervention would only enrich a B21
  response from the cache, without changing the gate prompt or adding a second review." Accepted
  risk: the commitment (CMT-2073) requires the judgment itself to treat sibling holdings as
  reachable, and the enrichment-only path would not nudge when B21 does not already fire; the
  second review runs only on a B17 or B21 from a review that rendered siblings. Not a safety,
  security or data-loss issue.
- Accepted residual: a sibling-aware PASS where a local-only review would have given B17 is not
  re-checked (cost); its rate is unmeasured. A sampled shadow check was suggested by two
  reviewers.
- The "tried it on the other machine" PASS case takes the draft at its word (inherited from
  HELD-ACCESS).
- Older peers' pool reads are accepted without an identity check until the fleet runs this code.
- The B17 prompt-priority instruction is a prompt floor; the code confirmation covers B17/B21
  verdicts, not PASS.
- A hint without an address right after a network-path switch, until the next read.

## Full Findings Catalog

Findings and resolutions per reviewer and round are recorded in the session transcript of the
autonomous run (topic 146512, run-mwpwu1zu-54b68857); every DESIGN finding above maps to a spec
change listed under "Original vs Converged" or to a Left-behind entry.

## Convergence Verdict

Converged at round 6 (the Tier 2 cap). The final round found no design findings from the six
internal reviewers; the one cross-model design finding is a scope preference, accepted with
reasoning above. Spec is ready to approve and build.
