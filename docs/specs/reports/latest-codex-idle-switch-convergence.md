# Review record for idle Codex model switching

## Cross-model review: codex-cli:gpt-6.2-astra

Independent Codex CLI reviews and internal security, adversarial, integration, performance, decision and lessons perspectives reviewed this slice. Gemini was unavailable because its installed login was unauthenticated.

## ELI10 Overview

The first slice explains which model-choice facts Instar can verify about a running Codex conversation. It records an unknown result when the machine lacks the evidence. It does not change the model. The design states what a future switch would need to preserve the same conversation, the person's model choice and any incoming messages.

## Original vs Converged

The review split stored policy intent from a live model claim. It added a real exact-pin positive control and scoped the diagnostic to machine maintenance. The future switching contract now requires exact-runtime custody, settings-revision fencing, observable recovery after an uncertain response, and durable input acceptance.

## Iteration Summary

| Round | Standards-Conformance Gate | Material changes |
| --- | --- | --- |
| 1 | Ran, 3 flags across 102 standards | Added a bounded owner diagnostic, time and process provenance and model intent distinct from launch state. Distinguished the in-place settings RPC from a replacement. |
| 2 | Ran, 2 flags across 102 standards | Defined a positive control for stored pin policy, settings-write fencing, a conclusive lost-acknowledgment read, and pilot closure at the second weekly evidence review. |
| 3 | Ran, 3 flags before the final draft edits across 102 standards | Bound cached policy to its topic revision, fenced policy writes against settings changes, and verified the stored pin separately from the live setting. |
| 4 | Ran, 3 flags across 102 standards | Added owner-issued live revision, two-topic independent pilot evidence, original-model journal custody and qualified promotion. |
| 5 | Ran, 3 flags across 102 standards | Defined gapped-evidence precedence, the configured thread model, input fencing across process replacement and a separate recovery control. |
| 6 | Ran, 4 flags before the final draft edits across 102 standards | Distinguished unsupported from unavailable evidence and required terminal attempt resolution even when readback already shows the requested model. |

## Experience fit

The observation can explain a known policy pin while its live applied model remains unknown. The machine operator gets a bounded diagnostic without interrupting the user's session or changing existing conversation access. An all-unknown installed pilot does not graduate. Native editing, active work, unsupported runtimes and unknown receipt custody do not authorize switching.

## Proportion

Tier 2 design review at the six-round cap. Four frontloaded decisions, zero unresolved operator questions, and zero cheap-to-change tags.

## Full Findings Catalog

- **Security and policy.** An exact operator and conversation ownership boundary gates the diagnostic. Policy, process, settings and owner revisions are distinct. A same-model human choice may revoke inherited intent.
- **Runtime and recovery.** A supported native command remains only a candidate until same-process proof, conditional apply, input fencing and independent readback work on installed fixtures. A matching model value cannot resolve a pending request.
- **Availability.** A held dispatch remains visible in durable custody. A separate authenticated recovery control remains reachable. Unknown acceptance never authorizes replay.
- **Maturation and scope.** The pilot must prove diagnostic usefulness on real installed sessions. It reports pin intent separately from current thread settings. In-place switching and exact replacement are future qualification targets.

## Left behind

The terminal integration has no proven owner-bound transport, atomic settings/input barrier or durable receiver acceptance. This spec grants no authority to change a live session. A separate implementation needs the explicit qualification evidence.

## Convergence verdict

The scoped design closes at the cap after addressing the final external findings. The specification defines what must be demonstrated by implementation tests and field evidence. No runtime behavior changed.
