# Convergence Report — A new agent's spare machine can take over

## Cross-model review: codex-cli:gpt-6-astra

A GPT-family external pass ran on all four rounds through the agent's codex CLI (2026-11-05 12:37, 12:47, 12:54 and 12:57 PST). Gemini was not authed, so no Gemini pass ran.

## ELI10 Overview

When a new agent is set up on a second machine, the two are supposed to share the work, and if one dies the other should take over. For new agents that didn't happen. The takeover rule needed a shared place to record who is in charge, and new agents don't have one. This change turns takeover on at the moment the second machine is paired.

Turning it on safely took most of the work. Two machines that can't actually reach each other must never both decide they are in charge, or every message would get two answers. So the change does three things:
- The machines swap lasting addresses when they pair. Those are addresses that survive a restart, unlike the temporary tunnel address.
- The spare must prove, with a signed answer from the first machine over one of those addresses, that it can really reach it.
- Until that proof exists, the spare stays quiet and the first machine carries on alone.

The trade-off: a pair with no lasting connection gets no takeover. It still has one working machine, and the agent says so with the fix (same network or Tailscale, then pair again).

## Original vs Converged

The first draft turned the switch on and trusted the existing rules. Review found the following:
- **The old rules split a fresh pair for good.** A fresh pair can lose each other at the very first restart, because the only address they exchanged was a temporary tunnel address.
- **The rollback story was false.** Turning off only the new proof requirement, or downgrading, leaves the switch on with no proof.
- **A revoked machine could keep holding the lease.**
- **The every-peer proof rule could strand a working machine** when a replacement machine was added.
- **A bad pairing request could crash the server.** The route had become async, and Express 4 does not catch rejected promises.

The converged design does these things:
- It exchanges lasting addresses at pairing.
- It requires signed proof with the specific partner (`pairedWith`) before the joiner may hold the lease alone.
- It keeps the inviter serving when there is no proof.
- It closes the crash.
- It states rollback honestly: set the switch off on both machines.

The live drill then found more defects, all fixed:
- the pairing role on a rebuilt machine (`roleForJoiner`);
- cloud `/32` addresses ruling out every LAN peer;
- the allow-list gap (#2811);
- the 409 poll deadlock (#2828);
- Linux self-restart (#2833).

## Iteration Summary

| Iteration | Reviewers who flagged | Design findings | Left behind | Spec changes |
|-----------|-----------------------|-----------------|-------------|--------------|
| 1 | lessons+completeness, security+adversarial, integration+scalability, codex | 8 | 9 | proof before a hold, lasting addresses at pairing, revoked-machine hold, rollback rewritten, pre-pairing behaviour stated |
| 2 | internal (combined), codex | 3 | 5 | pre-auth crash closed (handlePair catch), activation scope corrected, pairRole authority |
| 3 | internal, codex | 1 | 4 | every-peer rule tied to `pairedWith` so a replacement cannot strand a proved pool |
| 4 | (converged) | 0 | 4 | none |

Standards-Conformance Gate: ran in round 1 (signal only). Internal reviewers in round 1 were three agents, each covering two lenses. Rounds 2 to 4 used one resumed agent covering all lenses, which is proportionate to the change size. The internal reviewers ran on the session's model (Opus 5.5).

## Proportion

Tier 2: about 12 source files, plus a new `lastingLink.ts` and tests. 4 rounds against a cap of 6. The live drill took more effort than the review, and it was where the real defects showed up. Five of them were fixed in this change or in their own PRs.

## Left behind

- A failed registry write at `machine.ts` (after the keys are written) makes the joiner boot as a solo machine and take the lease. A solo machine would do this anyway; the code comment only explains revocation.
- `forget` is skipped if `updateMachineUrl` throws, because both sit in the same try.
- The readiness route shows `unknown` for an unproved pair, which could mask `failing` in a narrow case.
- WireGuard `/32` interfaces gain a failed dial each from the `/32`-as-`/16` rule. This is low cost, because identity comes from the signature.
- Graduation evidence for the fleet is weak: there is no fleet row counting duplicate replies or failed takeovers, so the spec names this.

## Full Findings Catalog

**Round 1 (lessons and completeness):**
- "Behaves as before" was false before proof.
- Pre-proof behaviour of an unreachable peer was undecided.

**Round 1 (security and adversarial):**
- A revoked machine holds forever (`server.ts`, `machine.ts`).
- Checked and fine: a forged proof (the ack is bound to the nonce and the key), and takeover being lost for good (a re-pair fixes it).

**Round 1 (integration and scalability):**
- The rollback claims were false.
- Scalability: nothing found.

**Round 1 (codex):**
- Blocking renewal does not prove there is a single holder.
- The duplicate backstop is only an observation.
- The existing-pair exclusion contradicted the activation rule.

**Round 2 (internal):**
- A pre-auth remote crash in `machineRoutes.ts`: an async route on Express 4.

**Round 2 (codex):**
- The activation scope wording.
- `pairRole` authority at a re-pair.

**Round 3 (internal):**
- The every-peer rule strands a proved pool when a third machine is added.
- Precision: a missing test for that rule. Precision: the `handlePair` catch is sound.

**Round 3 (codex):** precision only (the meaning of "lasting", the membership predicate, and naming the behavioural tests).

**Round 4 (internal):**
- No design findings: the third-machine stranding is closed, and two joiners cannot recur.
- Precision: the registry-write failure ordering.

**Round 4 (codex):** precision only.

## After convergence: the live gate

The fresh-pair drill is the spec's required live test. The early runs found these defects, each fixed before the final run:
- The `/32` subnet check (fixed in the spec and code).
- `roleForJoiner`, for a rebuilt first machine pairing back (fixed).
- The allow-list and reply script (#2811, merged).
- The 409 poll deadlock (#2828, merged).
- Linux self-restart (#2833).

The final run 9 passed: 12 of 12 messages got one reply each, through a 30-minute power-off, the holder's return, a 6-minute cut of every link, and the heal.

## Convergence verdict

Converged at round 4. The final round found nothing that changes what gets built; 5 items are left behind. The live gate passed on run 9. The spec is ready for approval.
