# External cross-model review — round 12 (codex-cli:gpt-5.5)

Spec: docs/specs/grok-build-framework-integration.md
Status: ok · Verdict: MINOR ISSUES (MINOR ISSUES, second consecutive)

Disposition: (1) structure — DECIDED across four rounds; the round-11 "Current
normative contract" section is the answer, and splitting the document conflicts
with the repo's spec convention. (2) budget lock — FOLDED, and it changed a
three-round-old decision: the accepted last-writer-wins loss is now closed by an
exclusive advisory lockfile (fail-open, stale-reclaimed), because the reviewer's
OPERATIONAL framing — someone later parallelizes convergence and silently
weakens the only live spend brake — is the risk the earlier arithmetic framing
missed. (3) phase A/B split — FOLDED as explicit acceptance criteria in the
normative contract. (4) drift blocking-after-N-days — DECLINED: it adds a new
state machine to a dark lane whose compensating bounds are already enumerated,
and round-11 routed the canary's signal into the reviewer's own finding so it
now reaches a human; recorded as a candidate under CMT-1319. (5) glossary /
implementation map — partially folded (the normative-contract section is the
implementation map; the local vocabulary stays, since it is the vocabulary the
rest of the repo uses).

---

**Verdict: MINOR ISSUES**

1. **Normative source is hard to extract (§ “Current normative contract”, §§0-14).**  
   The spec says the extract is not new and “later section governs,” while later sections contain many historical corrections and implementation-status notes. That makes the design auditable but difficult to implement without replaying review history.  
   **Resolution:** split into a short normative spec plus an appendix/changelog. Do not rely on “later section wins” for implementer-facing requirements.

2. **The reviewer budget control depends on deployment assumptions, not enforcement (§8, Launch invariants, Multi-machine posture).**  
   The source says the daily ceiling is a per-machine circuit breaker, not accounting, and admits last-writer-wins loss under concurrency. It also says the invariant holds only with one instar OS user per host and no parallel reviewer orchestration. That is acceptable for a dark reviewer lane, but the failure mode is operational: someone later parallelizes convergence and silently weakens the only live spend brake.  
   **Resolution:** add a process/file lock around admission+recording now, or make “single reviewer orchestration per account” a mechanically checked preflight.

3. **The design still over-invests in framework threading for a one-shot reviewer (§0.5, §4.3, §5, §7).**  
   The spec acknowledges the narrower reviewer-subprocess alternative and rejects it because the operator ultimately wants a Grok-running agent. That is a valid product reason, but the live capability is only one-shot review, while much of the risk and complexity comes from closed future lanes.  
   **Resolution:** explicitly separate “Phase A: reviewer adapter” from “Phase B: session framework,” with separate acceptance criteria and no session/pin work required to ship Phase A.

4. **Self-updating CLI risk is accepted but operationally fragile (§4.1, §9, §12).**  
   The source chooses warn-on-drift, not fail-closed, because confinement bounds the live lane. That is reasonable, but the deny-list depends on vendor tool names and has already needed multiple canary fixes.  
   **Resolution:** prefer an allowlist mode if the CLI supports it; otherwise make version-drift warnings block only reviewer enablement after N days/runs unacknowledged, not immediately.

5. **Terminology remains highly local (§0.6 and throughout).**  
   The glossary helps, but terms like “door,” “carrier,” “wall,” “bounded degraded decision,” and “stall matrix” are still load-bearing.  
   **Resolution:** add a one-page implementation map: inputs, gates, command, outputs, ledgers, and refusal reasons.
