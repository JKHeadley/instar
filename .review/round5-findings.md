# Round 5 findings — nature-axis-routing
## Gate: 0 findings (CLEAN).
## codex r5 MINOR (3):
- CR5-1: FD3/Resolver step2 chain-selection ambiguous — if row {A,SORT} + caller tightens to B, JUDGE or SORT? → define resolvedChain=chainForResolvedNature(resolvedNature): tightened nature uses ITS canonical chain (B→JUDGE). [FIX]
- CR5-2: FD7 prompt fingerprint brittle/high-friction (dynamic prompts) → scope fingerprint concretely (registered prompt-builder/template per component, not any-file-change). [FIX]
- CR5-3: FD5/FD6 critical-gate fail-closed = dangerous IMPLICIT contract (assumes every caller treats router-error as closed) → make explicit + per-critical-gate integration test that caller fails CLOSED on router no-route/error. [FIX — genuine]
## gemini r5 MINOR (2): both RE-RAISES (pi-cli dependency = already justified FD1; static brittleness = already addressed FD7, gemini calls it "clever"). NON-material.
## Internal r5 (async): lessons-aware / decision-completeness / combined-safety — pending.
## Internal r5 verdicts: decision-completeness CONVERGED; lessons-aware CONVERGED; combined-safety = ONE HIGH (cache defeats per-call injection gate) [FIXED: split cache health-cached/policy-fresh].
## All round-5 material (cache HIGH + CR5-1/2/3) applied. → round 6.
