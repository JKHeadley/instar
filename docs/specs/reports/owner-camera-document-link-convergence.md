# Approve a document computer link from the owner's iPhone review

## Outcome

The draft lets the owner use the paired iPhone to approve a computer reading the displayed document version, without a browser approval step. It keeps the member link separate and excludes general dashboard login and editing from this first scope.

Convergence failed at the Tier 2 six-round cap. No convergence tag or implementation approval was issued.

## Review record

Three independent internal reviewers covered security, adversarial, integration, scalability, decision completeness and lessons. The authenticated Codex CLI reviewer used gpt-6.2-astra. Dashboard and Apple received the drafts for coordination.

| Round | Standards check | External verdict | Revision or outcome |
| --- | --- | --- | --- |
| 1 | Ran; 3 flags | SERIOUS ISSUES | Defined exact document policy and version scope, durable proposal state, protected read boundaries, and independent expiry. |
| 2 | Ran; 6 flags | SERIOUS ISSUES | Separated authorized title reads from fresh presence approval. Defined renewal, owner/proposal eligibility, exact-version invalidation, restore behavior and signer isolation. |
| 3 | Ran; 3 flags | SERIOUS ISSUES | Put the durable checkpoint before any positive status or content. Defined independent browser and phone code derivation, read challenge refresh, and useful-content eligibility. |
| 4 | Ran; 4 flags | SERIOUS ISSUES | Defined declared code comparison, fresh serving proof, monotonic access revision and minimum topology. |
| 5 | Ran; 3 flags | SERIOUS ISSUES | Added exact comparison vector, terminal mismatch cancellation, current title authorization and the rollout evidence floor. |
| 6 | Ran; 4 flags | SERIOUS ISSUES | Stopped at the review cap with three outstanding design issues. |

## Remaining design findings

- Issuance exposes the immutable version input to the anonymous browser. Replace it with a fresh opaque proposal commitment so repeated issuance cannot reveal whether a private document changed. Test both existing and nonexistent document IDs and requests spanning an edit.
- Define the successor read challenge after a successful read and prove consecutive reads and recovery after lost replies.
- The proposed witnessed topology excludes an owner with one serving computer and an iPhone. Select and review either an explicit witnessed first launch or a single-authority mode that stops after authority loss and requires a new scan instead of trusting uncertain recovery.

The internal round-six reviewers found no new security or adversarial issue within the stated witnessed topology. The unresolved external findings remain material to the owner experience and authority contract. The fleet has not been shown to supply the required independently durable journal or equivalent.

## Release posture

Keep existing approvals and production QR behavior. No implementation, deployment, or use of live approval authority was performed under this review.
