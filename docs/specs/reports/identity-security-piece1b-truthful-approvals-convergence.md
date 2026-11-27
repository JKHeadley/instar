# Convergence Report — Truthful approval records: the trust tool and MoltBridge

**Spec:** [docs/specs/identity-security-piece1b-truthful-approvals.md](../identity-security-piece1b-truthful-approvals.md)
**Slug:** `identity-security-piece1b-truthful-approvals`
**Converged at:** 2026-11-18T09:05:00Z
**Iterations:** 2 (as "Identity quick fixes", narrowed after each round)
**Final-round design findings:** 0 on the scope that remains.

---

## ELI10 Overview

Two records in the agent said a person had approved something when the agent had done it: raising or lowering trust in another agent, and approving a MoltBridge profile. This change makes both records say "agent proposal". Nothing else changes for now; the agent can still do both at the Basic level the owner is on today, as the approved identity design says. Later parts make these need the owner's tap on their phone. The important rule added here is that no code may ever read the old "user-granted" label as proof that a person approved something.

## Original vs Converged

- **Originally** this spec was "Identity quick fixes" with six changes. **After round 1** four of them moved to their own specs: refusing requests when no API key is configured (a newly made key would not reach the Telegram relay), Telegram's empty allowlist (the relay path bypasses the check), and SMS rows (the message text would reach something sessions read). **After round 2** the WhatsApp signature check moved too: the secret lives under `config.businessApi`, owner notices need an owner-visible surface, and a wrong secret must be detected.
- **What stayed:** the two truthful labels, which every reviewer found clean, plus the rule that `user-granted` is never proof of a person.

## Iteration Summary

| Iteration | Reviewers who flagged design issues | Design findings | Precision findings | Spec sections changed |
|-----------|-------------------------------------|-----------------|---------------------|-----------------------|
| 1 | security, scalability, adversarial, integration, decision-completeness, lessons-aware, Astra, Gemini | 14 internal (none on the labels) | ~40 | narrowed to labels + WhatsApp. Standards-Conformance Gate: ran (7 flags) |
| 2 | integration, adversarial+DC, lessons+scalability, Astra (all on WhatsApp); security converged | 5 internal on WhatsApp, 0 on the labels | ~25 | narrowed to labels. Standards-Conformance Gate: ran (2 flags, both on WhatsApp) |

## Full Findings Catalog

All answers are in the build state folder: `reviews/p1b-r1`, `reviews/p1b-r2`. On the labels: round-2 security confirmed the trust tool is the only `user-granted` writer and the four readers are the only readers; round-2 integration confirmed trust profiles and audit are machine-local and never synced, so only a same-machine rollback would meet the new label (Astra's mixed-version point).

## Proportion

Tier 2 (identity provenance), but a small change: 7 source files, about 30 lines, plus tests. Two rounds; the scope was cut twice rather than iterated.

## Left behind

- WhatsApp signatures (1i), no-token refusal (1h), Telegram empty allowlist and SMS rows (1e): their own specs, carrying the round-1 and round-2 findings.
- A rollback on the same machine refuses peers recorded with `agent-proposal` until they are granted again.
- Removing the agent's ability to change trust or approve profiles: approval cards (piece 5).

## Convergence Verdict

Converged at round 2 for the scope that remains. The spec carries `approved: true` under the approved umbrella (Justin, 2026-11-17 19:34 PST) and his standing guidance that only constitution changes need his approval. No constitution text changes.
