> **Superseded.** This report describes the first review cycle (rounds 1 to 10) and a scope that no longer exists. A new report will be written when the current cycle converges. Current scope: Changes 1, 3 and 4 of the spec (v21).

# Convergence Report — Lease flap fix

**Status: convergence-failed at the 10-round cap (3 October 2026).** No convergence tag is written. More rounds need the operator's go-ahead.

## ⚠ Cross-model review: codex-cli:gpt-6-astra (Gemini never ran)

- GPT ran in rounds 2 to 10. Round 8 verified the model as gpt-6-astra from Codex's own session log.
- Gemini never produced a review in any round. Its CLI refuses to start, because the signed-in account needs a Google Cloud project set. At the operator's direction (3 Oct, 14:24 PDT), it was dropped for this convergence.
- Grok is not installed.
- Internal reviewers were combined: three agents in rounds 2 to 4, then one all-lens agent per round from round 5.

## Why it did not converge

The core design settled in rounds 5 to 7: live-evidence liveness, the boot pull, and medium selection. Every DESIGN finding since then has come from one addition.

That addition is a detector for holding a lease that git never accepted. It was added in round 8, after GPT showed that the write counter could not see that state. Rounds 9 and 10 then found flaws in the detector itself:
- a self-proof narrowing, since removed;
- the per-epoch verdict going stale;
- the verdict mapping being incomplete;
- receipt timestamps using wall-clock time.

All of these have been applied. Each round's fixes were concrete and local, and none reopened the core design.

| Round | DESIGN | PRECISION | Main change |
|---|---|---|---|
| 8 | 1 | 6 | never-accepted detector added (write counter blind to the read-back) |
| 9 | 3 | 5 | self-proof narrowing removed; superseded case |
| 10 | 3 | 4 | complete verdict mapping; monotonic receipts; Decision 6 corrected |

Full findings per round: the `lease-flap-review-rounds-1-6.md` log in the sagemind repo (rounds 1 to 10).

## Options for the operator

1. Authorise more rounds, on the same rules (two consecutive zero-DESIGN rounds).
2. Move the detector out of scope as a tracked maintainer item, together with deferred item (i), and re-review the smaller spec. The safety posture would then say plainly that the persistent read-back on a tracked registry is not reported.
