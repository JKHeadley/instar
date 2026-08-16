# External cross-model review — round 9 (codex-cli:gpt-5.5)

Spec: docs/specs/grok-build-framework-integration.md
Status: ok · Verdict: SERIOUS ISSUES

Disposition (round-9 synthesis): findings 1, 2 and 5 are VERBATIM re-arguments
of round-8's findings 1, 2 and 4 — all three DECIDED and dispositioned in
review-3 (drift warn-vs-fail-closed: closed in §4.1, the billing invariant
rests on three per-call layers, never the version pin; budget-ledger races:
bounded last-writer-wins loss accepted with durable half-cap precharge +
record-every-path; structure/archaeology: the §0 normative-vs-status
convention governs). Findings 3 and 4 are NEW and both were FOLDED this
round: (3) economics framing — "no observable cost" is a statement about our
instruments, not the vendor's books, so §0.3 now states the metered-until-
proven rule as the dominant operational sentence rather than leaning on
invisibility as favourable evidence; (4) config authority — the untracked-
in-repo acceptance is defense-in-depth against a committed-config mistake,
NOT a trust boundary against a hostile branch (which can commit the gating
code itself, a strictly stronger capability), and §8 now says so explicitly
rather than letting a reader treat the reviewer door as closed against repo
content.

---

**Verdict: SERIOUS ISSUES**

1. **§4.1 / §3.1.1: warn-only version drift is too weak for a security and billing boundary.**  
   The spec says the billing invariant does not depend on the version pin, but it does depend on vendor CLI semantics for `GROK_DISABLE_API_KEY_AUTH`, tool names, and login-policy inspection. A self-updating binary can change any of those. A loud warning is not enough when the adapter’s core promise is “no metered fallback” plus confined execution.  
   **Resolution:** fail closed for reviewer/one-shot use on unverified CLI versions until an automated probe confirms: API-key fallback disabled under conflicting credentials, deny-list names still valid, and JSON envelope shape still matches.

2. **§8: the daily budget brake knowingly allows lost increments and overshoot.**  
   The spec states admission is check-then-act before spawn-slot acquire and that concurrent writers can lose up to `N-1` increments. That is not just an accounting blemish; the per-day ledger is the primary shipped mitigation for an invisible shared pool. Atomic rename without locking does not solve lost updates.  
   **Resolution:** use an interprocess lock or atomic reservation record before spawn, then reconcile actual tokens after completion. Capacity sheds can release/void reservations.

3. **§0 / §13: “zero visible marginal cost” is over-weighted.**  
   The source says billing sink remains unknown, but the risk language repeatedly leans on “zero observable cost” and “subscription economics.” From an external perspective, the most likely failure is delayed or hidden billing/usage reconciliation.  
   **Resolution:** keep the economics section purely evidentiary and make “treat as metered until billing-side proof” the dominant operational statement. Avoid framing invisible cost as favorable evidence.

4. **§4.3 / §8: configuration authority remains complicated and fragile.**  
   The authorship guard against git-tracked `.instar/config.json` is good, but accepting untracked config inside a repo as operator-authored is a local convention, not a robust trust boundary. Many tools generate untracked files during tests or branch workflows.  
   **Resolution:** for spend-enabling gates, prefer explicit `--config`, `INSTAR_CONFIG_PATH`, or a config under a known agent-home path. Treat repo walk-up as read-only convenience, not authority to enable Grok.

5. **Overall clarity: the spec is over-converged and hard to implement from.**  
   Many sections mix requirements, probe history, reviewer rebuttals, implementation status, and rationale.  
   **Resolution:** split into normative requirements, evidence appendix, and deferred work list.
