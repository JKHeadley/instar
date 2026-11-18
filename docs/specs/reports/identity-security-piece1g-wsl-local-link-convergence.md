# Convergence Report — The one-time local link from a Windows browser to an agent in WSL

**Spec:** [docs/specs/identity-security-piece1g-wsl-local-link.md](../identity-security-piece1g-wsl-local-link.md)
**Slug:** `identity-security-piece1g-wsl-local-link`
**Iterations:** 3 (rounds 2 and 3 were delta checks).
**Final-round design findings:** 0.

---

## ELI10 Overview

The one-time dashboard link works only from the same computer. When the agent runs inside WSL on Windows, a Windows browser reaches it through Windows, so the request comes from Windows' address instead of from "inside". The approved design says to accept that address too, because the link's one-time secret is the real key. This piece does that carefully: only in WSL's normal network mode, only from exactly that address, and with a limit on how often it can be tried.

## Original vs Converged

- **The first draft** tried to prove that a request was local by reading Windows' port-forward settings. The review showed that can't work: any Windows-side forwarder arrives from the same address.
- **The approved umbrella** already decides this case: the secret is the credential. The design was rewritten to follow it, with the residuals stated plainly.
- **The delta reviews** added three things: confirming NAT mode positively, stating the other-Windows-account residual, and a rate limit that counts only gateway requests.

## Iteration Summary

| Iteration | Reviewers who flagged design issues | Design findings | Precision findings | Spec sections changed |
|-----------|-------------------------------------|-----------------|---------------------|-----------------------|
| 1 | constitution (2 flags), combined security+integration (4), Astra (first draft) | 4 | ~5 | rewritten to follow umbrella §4.6 |
| 2 | combined (2: NAT confirmation, port-squatting residual) | 2 | 3 | NAT check, residuals, subnet rule, rate limit |
| 3 | none | 0 | 3 | precision only |

## Full Findings Catalog

The answers are in the build state folder under `reviews/p1g-r1`.

## Left behind

- A full redemption through a Windows port forward with a throwaway agent in WSL.
- WSL in mirrored mode.
- The same NAT confirmation for `arrivedOverLocalTls`.

## Convergence Verdict

Converged at round 3. The spec carries `approved: true` under the approved umbrella, whose §4.6 specifies this acceptance. No constitution text changes.
