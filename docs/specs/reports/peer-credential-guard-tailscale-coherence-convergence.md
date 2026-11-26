# Convergence Report — Pool-read selection fix + host-trust consolidation

## ⚠ Convergence status: DID NOT MEET THE SKILL'S BAR — operator judgment required

Stated plainly rather than dressed up. `/spec-converge` requires **no DESIGN-class findings for
two consecutive rounds**. That was never achieved. 18 rounds ran (hard cap is 10). So this
report does **not** carry a `review-convergence` tag, and `/instar-dev` remains structurally
blocked on this spec until the operator decides.

**The honest distinction, which is why this is being handed over rather than abandoned:**

- **The DESIGN converged at round 12** and has been unchanged for six rounds. Nobody — gate or
  external reviewer — has found a defect in the *mechanism* since: admission-aware selection,
  health feedback, the outcome-precedence table, no-redirects, typed required `kind`, shared
  host predicates, CGNAT admission removed.
- **My CLAIMS about it did not converge.** Round after round the reviewers found the spec
  asserting more than the design delivers, and each time I fixed some restatements and missed
  others (the Frontloaded Decisions list and the test bullets were the repeat offenders). At
  one point I deleted §4.1.1 while rewriting §4.1 and left §4.1 citing it.

That is a real process failure and it is mine, not the reviewers'.

## Cross-model review: codex-cli:gpt-6-astra — RAN (8 rounds)

A genuine external pass ran in every round through the agent's own codex CLI.
**One external family only** — `gemini-cli` is not installed on this machine and `grok-build`
is not enabled, so this is **not** two-family convergence and must not be read as such.
The external verdict was `SERIOUS ISSUES` on **all 8 rounds, including the last**.

The Standards-Conformance Gate ran all 18 rounds (92 standards, never degraded).

## ELI10 Overview

Justin runs one agent across three machines, and from the Windows machine every "show me this
across all my machines" question came back empty. Each machine knows several routes to each
other machine — a private-network route, a home-network route, and an internet-tunnel route.
Before sending its password over a route, the agent checks the route is one it trusts; that
check was never taught about the private-network kind, so it refuses those.

The refusal alone was survivable. The fatal part was that the code which *picks* a route picked
the best one without asking whether the check would allow it — then gave up when it was
refused, while two perfectly usable routes sat unused. One line that discarded a list of
alternatives turned a small gap into a total dead end.

The fix asks the check *before* picking, and starts recording which routes actually work so a
dead one stops being chosen. Same number of connections as before, same trust rules as before.

## Original vs Converged

| | Original draft | Final |
|---|---|---|
| Core change | Widen credential trust to admit private-network (Tailscale) addresses | **Admit nothing new.** Pick the best *allowed* route, and record outcomes so dead routes stop being picked |
| `kind` parameter | Optional; 19 of 20 call sites untouched | **Required** field on a typed object; all 20 updated. The optional form left the bug live on 19 of 20 paths |
| Private-network admission | The whole point of the change | **Removed entirely** — not even behind a default-off flag |
| Failover | (none) → sequential helper → extract lease hedge → signed challenge → TLS-only | **None within a call.** Selection + health feedback across calls |
| Lease path | Would have been refactored | **Untouched** — the riskiest code in the mesh is not in this change |
| Security claims | "Tailscale encrypts it"; "a peer-pool read credential"; "strictly smaller than LAN" | **All three withdrawn as false.** It is the full agent API token, and nothing proves the route |
| Recovery claim | "This alone resolves the defect" | **Conditional:** the inadmissible-route dead-end is gone from call 1; a dead-but-allowed route is demoted only after three *consecutive* recorded failures, which interleaving can delay indefinitely |

## Iteration Summary

| Round | Gate findings | External | Design-class change made |
|---|---|---|---|
| 1 | 4 | 5 | Optional→required `kind`; multi-machine posture corrected; encryption + token-scope claims withdrawn |
| 2 | 1 | 4 | Discriminated result contract; migration parity added; fixture conflict split |
| 3 | 1 | 4 | Impersonation ≠ paired-peer; anti-divergence claim narrowed |
| 4 | 1 | — | Restructure: fallback promoted to the fix, widening demoted to default-off |
| 5 | 0 | 3 | **Admission ≠ reachability** — measured; the fix as written would not have worked |
| 6 | 0 | 4 | Found the existing hedged transport; stopped duplicating it |
| 7 | 1 | — | Terminal disposition (a refusal must survive the race); sequential mode |
| 8 | 1 | — | Destination authentication before token release |
| 9 | 1 | — | Version carve-out replaced by a transport-authentication rule |
| 10 | 2 | — | TOCTOU in the challenge → restricted to TLS routes |
| 11 | 1 | — | — |
| **12** | 2 | — | **Design settles:** single-attempt selection + health feedback |
| 13 | 1 | 5 | Machine-auth follow-up scoped honestly; equivalence argument bounded |
| 14 | 1 | 4 | Minimal claims; convergence claim made conditional |
| 15 | 2 | — | Test claims scoped to the design |
| 16 | 1 | 4 | §4.1.1 restored (self-deleted); outcome precedence table |
| 17 | 1 | 4 | Redirects disabled; caller-visible outcomes for neutral failures |
| 18 | 1 | 4 | Justification re-argued from the threat model, not from review history |

## The findings that mattered most

1. **Admission is not reachability (round 5, external).** My fallback stopped at the first
   *allowed* route. Measured against the real machines: the Studio's home-network route is
   allowed and **unreachable** from the Windows machine (`HTTP 000`), while the tunnel route
   returns `HTTP 200`. The fix would have picked the dead one. This is the project's own
   "verify the state, not its symbol" standard, violated inside my own fix.
2. **The optional parameter left the bug live on 19 of 20 paths (round 1, both).** I had
   described an unfixed bug as a virtue of small blast radius, and leaned on a lint that
   structurally cannot detect a missing argument.
3. **Multi-machine posture was factually inverted (round 1, external).** I claimed machines
   share one view of how to reach each other; the parent spec says the opposite in writing.
4. **The existing hedged transport (round 6, external).** I was about to write a worse copy of
   working machinery that already carries a correctness rule earned from a route that looked
   dead for a week.
5. **Impersonation does not collapse into the paired-peer case (round 3, external).** An
   impersonating responder can present the expected machine id without compromising the paired
   machine — which is what removed private-network admission from this change entirely.
6. **Per-call request count is an exposure budget, not an authentication boundary (round 18,
   external).** I had justified single-attempt by citing the gate's repeated rejections — an
   appeal to reviewer persistence rather than an argument. Re-argued from the threat model.

## Open security residual — disclosed, accepted, NOT closed

The gate flagged **Know Your Principal** in all 18 rounds, including the last. It is correct:
the agent's bearer token is released to registry-listed hosts that are never authenticated as
the intended peer, and health-driven reselection can contact hosts this code would not have
contacted before.

Accepted on these grounds, with limits stated:
- An attacker who **controls advertisements** gains nothing — their best play (advertise only a
  hostile private address) already wins against today's single-route code.
- Exposure **does** increase for **stale addresses** and for an attacker holding only a
  **fallback** host. This is a real increase, accepted for the small population and the
  sequenced remedy — **not** an equivalence claim.
- The remedy is specified: move peer traffic off the shared bearer token **and** add
  destination authentication (recipient/method/target binding plus authenticated responses).
  Request signing alone is a prerequisite, not a substitute. Feasibility checked —
  `authMiddleware` is mounted globally, so it is a single-chokepoint change — and it gets its
  own spec.

## What the operator is being asked

Whether to accept this spec given that it did not meet the automated convergence bar.

The case for accepting: the design has been stable and defect-free for six rounds; it fixes a
real, currently-broken capability; it admits no new hosts and leaves the lease path untouched;
and every surviving reviewer finding is about the precision of my prose or the one disclosed
security residual.

The case against: 18 rounds exceeded the 10-round cap, the external verdict never cleared, and
the credential gap this touches is real even if not widened in its most dangerous direction.

Either answer is reasonable. It is the operator's call, not mine — `approved: true` exists
precisely for this.
