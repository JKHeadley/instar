# Convergence Report — A2A relay unknown-sender trust

## Reviews run

- Standards-Conformance Gate (92 standards): ran once on the revised draft; 3 possible violations, all answered in the spec (section "Conformance-gate findings, answered" and "Multi-machine posture"). Parent-principle fit: `fit`.
- Cross-model (GPT tier, through the agent's codex CLI): three rounds. Round 1: one blocking, one non-blocking finding. Round 2: one high finding. Round 3: "no findings".
- One internal adversarial reviewer (security / integration), round 1: two findings to fix before enforcement, three non-blocking.

Stopped under the 80/20 convergence standard: the last round changed nothing.

## ELI10 Overview

Agents that the receiver has never swapped keys with can still send it plain-text messages through the relay. Those messages skipped the trust check, were treated as coming from a trusted contact, and quietly made the sender trusted forever. The fix judges them by the trust list like every other message, starting in watch-only mode on development agents, and marks strangers who write during watch-only mode so that they are not trusted later.

## Original vs Converged

- **Probes.** First draft: a stranger's `ping` passes, as the gate passes probes. Converged: dropped. The code after the gate routes every passed message to a session, so a stranger could label any request a `ping` and get a session (cross-model round 1, internal reviewer).
- **Dry-run evidence.** First draft: an in-memory set of strangers seen during watch-only mode. Converged: a durable `relayFirstContact` mark on the trust profile, written in the profile's first save; while the profile is still `setup-default` it is not a grant, in the verdict and (while enforcing) on the gate path. The set was lost on restart, kept counting a peer after the operator granted it, and left every watch-only stranger with a permanent `verified` grant (cross-model rounds 1–2, internal reviewer).
- **Credentials.** Converged: `credential-share` never passes this plaintext path (internal reviewer).
- **Operator evidence.** Converged: `/health` counts unmarked `setup-default` fingerprint profiles, the grants nobody decided that this change deliberately leaves in place (conformance gate).
- **Rollout.** Converged: a named owner and date for the enforcement decision, ACT-069 (conformance gate).

## Findings and what was done

| Source | Finding | Outcome |
|---|---|---|
| Cross-model r1 / internal | An untrusted sender's `ping` reaches session routing | Fixed: dropped on this path; the same consumer behaviour on the end-to-end path is ACT-056 (filed 2026-10-09) |
| Cross-model r1 | The first-contact set keeps ignoring a granted profile | Fixed: only a still-`setup-default` profile is set aside |
| Internal | Watch-only strangers keep a permanent `verified` grant | Fixed: durable mark; gate reads honour it while enforcing |
| Internal | The default change is manager-wide | Kept deliberately (every creator is a first contact); the effects are listed in the spec |
| Internal | MCP stdio grants can be overwritten by the server's save | Pre-existing; recorded as ACT-052 |
| Internal | Relying on `getAllowedOperationsByFingerprint('')` | Removed: no profile ⇒ only acks pass |
| Internal | Plaintext `credential-share` allowed for a mutual-verified peer | Fixed: always refused here |
| Cross-model r2 | The mark was saved after the profile (crash window) | Fixed: part of the first write; test restarts without a flush |
| Conformance | Know Your Principal: pre-change grants kept | Answered: deliberate, counted on `/health`, decision on ACT-069 |
| Conformance | Multi-machine: the mark is machine-local | Answered: it lives with the profile it qualifies, and can only remove a grant |
| Conformance | A Dark Feature Guards Nothing | Answered: owner, date and bounded dark window (ACT-069) |

## Approval

`approved: true` under the operator's standing approval, 2026-10-08 14:49.
