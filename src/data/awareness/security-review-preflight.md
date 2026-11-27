---
title: Security review evidence packets
---
Security review can capture a private full-input evidence packet after a normal session starts. `jobs.securityReviewPreflight.enabled` defaults to false. An explicit absolute `sourceRoot` names the source checkout whose threat map is captured. Updates do not activate it. The original prompt, source reads, model selection and review schedule remain unchanged.

The packet includes every byte of the findings ledger, threat map, rotation state and dispatched prompt, in verifiable bounded chunks. It is local to the source machine under `.instar/state/security/private/review-packets/`. It does not prove delivery, retained context, code-tree coverage, model reachability or review quality. Missing/changing inputs or storage failure leave normal review running. Never use this evidence-only packet to suppress a source read or security review, and never post its private content publicly.
