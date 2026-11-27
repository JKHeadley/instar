# Combined Building family review — Observability evidence duty with Amendment 6

Reviewed 2026-11-09T17:21:58.000Z. Candidate Building digest `b70f1c24f14908d9f0ec4d3d611e5a9b8627ed86e8435465397a89e0251da292`; 44 articles. This supersedes the 2026-11-06 combined Building audit for PR 2842 (digest `a9a5522667a1`) and main's Amendment 6 audit (digest `7c0d39dc2874`) for the merged candidate only; both earlier audit artifacts remain historical.

## Why a new review

While PR 2842 waited, origin/main landed Amendment 6 (owned-machine Pending exception, PR 2857) in the same Building family. Merging origin/main into the PR changed the Building digest, so neither earlier audit covers the combined bytes. No wording was changed to resolve the merge: the only conflict was this audit index, and docs/STANDARDS-REGISTRY.md merged without conflict.

## Actual review

Root echo:claude-code confirmed that the merged registry's diff against origin/main is identical to the PR's original diff against its base (the operator-approved Observability wording is unchanged), and that Amendment 6 is present as landed on main.

Independent reviewer codex-cli gpt-6-astra (different model family, read-only sandbox) verified: (1) `git diff origin/main -- docs/STANDARDS-REGISTRY.md` equals the Observability diff byte for byte, and reversing then reapplying Amendment 6 and the Observability edit reproduces the merged file exactly, with no lost, altered or duplicated article; (2) no semantic conflict: Amendment 6 governs Conversations custody, durable receipts, commitment, repair and loss debt; Observability governs evidence for improvement claims and promotion, preserves missing evidence and uncertainty rather than requiring Pending information to be fabricated, keeps existing owners and authority, and does not broaden the Pending exception or require outside hosting; (3) no blocking design finding. Verdict: ACCEPT.

Non-blocking notes carried forward, not resolved here: both amendments remain reviewer-enforced or leave universal measurement coverage open, so this acceptance is not proof of implemented enforcement; the Observability paragraph's own wording about ratification is the approved text and was not edited.

## Enforcement limits

Reference-resolution floor 34/40 preserved without rebaselining. This review asserts no new executable coverage. Operator direction approval for the final head, required checks and deployment remain separate.
