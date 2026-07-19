# Convergence Report — Instar Mutual SSH-Subsystem Autobootstrap

## Cross-model review: codex-cli:gpt-5.5

A real GPT-family reviewer ran against every changed draft. The final material
findings were incorporated into the converged design.

## ELI10 Overview

Today two computers can belong to the same Instar agent while only one can reach the
other over SSH. The new design gives every paired machine its own restricted SSH
endpoint and proves each direction separately. It never assumes that “A reached B”
means “B reached A,” and it does not grant a human shell or alter personal SSH files.

The lasting class fix is a Symmetric Transport Proof standard plus a direction-by-
lifecycle conformance matrix. Instar continuously refreshes each proof, repairs safe
key and endpoint drift through its separate signed control plane, and reports an
honest blocked reason when the network cannot carry the endpoint.

## Original vs Converged

The first draft relied on OS sshd and managed `authorized_keys`, which could not meet
zero-operator setup on a host where Remote Login was disabled. Review replaced that
with an unprivileged Instar-owned SSH subsystem that rejects shell, exec, SFTP, and
forwarding. Further rounds added pairing-epoch replay fencing, boot-scoped dual-clock
freshness, admission leases, an exact host-key rotation state machine, flood brakes,
non-circular bootstrap, supported-pool arithmetic, and ordered rollback.

## Iteration Summary

| Iteration | Reviewers who flagged | Material findings | Spec changes |
|---|---|---:|---|
| 1 | security/adversarial self-review | 1 | Replaced OS sshd/authorized_keys dependency with restricted user-level endpoint. |
| 2 | independent convergence reviewer, codex-cli | 13 grouped | Added revocation leases, host-key lifecycle, generation fencing, control-plane prerequisite, resource brakes, scale bounds, rollback order, and terminology/alternatives. |
| 3 | independent convergence reviewer, codex-cli | 8 grouped | Added pairing epoch, observer boot id, dual-clock freshness, 8-second probe math, candidate limits, concurrent rotation table, diagnostic UX, and network lifecycle tests. |
| 4 | independent convergence reviewer | 0 | Converged; no material findings. |

Standards-Conformance Gate: unavailable (the local route returned no report body);
this fail-open state is disclosed. Signal-vs-authority, Judgment Within Floors,
Self-Heal Before Notify, No Unbounded Loops, Mobile-Complete, and Cross-Machine
Coherence were reviewed directly in the spec and independent pass.

## Full Findings Catalog

- OS sshd cannot guarantee no-input bootstrap: resolved with an unprivileged embedded
  SSH subsystem and no personal SSH mutations.
- Stale admission after revoke: resolved with five-minute pairing-epoch leases checked
  on authentication and subsystem open, with active-session termination.
- Legitimate and hostile host-key changes were ambiguous: resolved with monotonic
  generations, cross-signatures, quarantine/overlap/promotion/retirement states, and
  conflict rejection.
- Key-generation identity was ambiguous: split into client and host generations on
  adverts, challenges, admissions, and proofs.
- Replicated monotonic time was invalid: added observer boot IDs, signed capped wall
  time, local monotonic deadlines, and fail-closed restart behavior.
- O(N²) freshness was unbounded: declared max-10 default, an 8-second end-to-end
  probe deadline, formal validation, fair scheduling, global work budget, and a
  timeout-path maximum-size test.
- Bootstrap risked circularity: explicitly requires bidirectional non-SSH direct or
  relay MeshRpc before SSH admission.
- Network parser/resource abuse was unbounded: added pre-auth, per-source, session,
  frame, deadline, replay, and rate brakes.
- Rollback could strand readiness: readiness requirement now disables before sessions
  drain and listeners close.
- Product wording could imply operator shell: all user-facing labels now say “Instar
  SSH subsystem”; ordinary shell SSH remains outside the contract.
- Candidate trust and probing were noisy: candidates are count-, scope-, family-, and
  lifetime-bounded; only pinned host key plus signed challenge establishes identity.
- Mundane firewall/VPN/sleep/port churn lacked acceptance: explicit stable blocked
  reasons and recovery tests were added.

## Convergence verdict

Converged at iteration 4. The final independent pass found no material issue. The
spec has no unresolved user decisions and is ready for operator review and approval.
