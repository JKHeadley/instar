# Convergence report for latest Codex model defaults

## Cross-model review: codex-cli:gpt-6.2-astra

Independent Codex CLI reviews ran on the subscription review path. Three independent GPT-6.2 Sol reviewers covered the six internal perspectives in pairs. Gemini authentication was unavailable. The report covers the launch-only implementation. Scan migration, fleet distribution and idle reconciliation have a separate design and need their own implementation review.

## ELI10 Overview

New unpinned Codex launches can follow the newest reviewed model in a family. A saved exact choice keeps its existing priority. The agent logs an advisory when the exact choice falls behind. An authenticated maintenance request changes the receiving computer's config and affects its next launch after the file is saved.

## Original vs converged

The original draft combined launch defaults, a daily job migration and live-session reconciliation. Reviews found that the existing disabled job record could reflect an operator choice, and that a launch record cannot prove which model a running terminal is currently using. The revised launch change can be reviewed and committed independently. The continuation design preserves opt-outs and requires process ownership, a durable resume journal and receiver-side delivery evidence.

The review also changed the configuration path. It now validates selectors, preserves sibling pins and saves the configuration before publishing runtime data. Reviews clarified the actual older-CLI fallback and the built-in balanced fallback when a reviewed catalog cannot be loaded.

## Iteration Summary

| Round | Standards-Conformance Gate | Material findings and action |
| --- | --- | --- |
| 1 | Ran, 3 flags across 102 standards | Security and integration identified invalid selector handling, overwritten sibling pins and premature publication. Integration and lessons reviewers challenged ambiguous scan opt-outs and cross-machine policy. The Codex reviewer requested precise CLI fallback and a pre-mutation journal. |
| 2 | Ran, 3 flags on the review input across 102 standards | Reviews checked the scope of machine configuration and requested write serialization, durable receiver receipts and validation of the mixed governor update. |
| 3 | Ran, 3 flags across 102 standards | Code review found the governor update still mutated runtime state before saving. The cross-model reviewer distinguished the scan observation state from the manual notice baseline and requested receiver-side acceptance evidence. The implementation and its review were narrowed to launches. |
| 4 | Ran, 1 flag across 102 standards | The six internal perspectives cleared the launch scope. The Codex reviewer identified an ambiguity in the fresh-install fallback and requested an explicit missing-catalog check. |

| 5 | Ran, 1 flag across 102 standards | The Codex reviewer requested the concrete coherence implementation and the degraded-catalog rule for sibling edits. The spec and tests now identify the raw-policy comparison and limit validation to supplied entries. |
| 6 | Ran, 1 flag across 102 standards | The Codex reviewer identified the missing-versus-explicit selector advertisement and requested a write-through coherence test. The shared built-in selector now normalizes the advert. The authenticated lifecycle regression checks the actual config update, resolved profile and new advert on the same server object. |

## Proportion

Tier 2, six rounds at the six-round cap. The first three rounds still covered migration and session continuity. The final three focused on the launch change and the config boundary.

## Left behind

- Machine-specific overrides can differ after failover. The local maintenance operation declares its scope. The release default and existing topic pins retain their shared semantics. Agent-wide override distribution is tracked in the continuation design.
- Stale-pin warnings retain distinct keys for one process lifetime. Reviewers found the expected config-edit cadence made this a precision issue.
- The lifecycle test checks the configuration, launch resolver and coherence builder without starting a paid Codex conversation. Full Local Verify has its own owner.

## Experience fit

The ordinary case is an unpinned new conversation inheriting a release-reviewed model. Exact topic and caller choices remain available, and a local model binding keeps precedence. The receiving machine reports the scope of a config change. Tests cover invalid writes, sibling pins, overlapping requests and a failed save. They do not establish fleet-wide distribution or a safe live switch.

## Full findings catalog

- **Security and adversarial.** Unsupported selector and malformed map writes are refused before mutation. Missing catalog handling preserves usable exact pins. Governor updates are deep-copied before staging. The live snapshot is published only after persistence.
- **Scalability and performance.** One packaged catalog read is cached. The catalog is small and the hot path compares versions in the selected family. Scheduled and manual scan state ownership is defined in the continuation design.
- **Integration and deployment.** Old CLI fallback remains compatible with existing behavior. The launch implementation uses the same packaged policy on equivalent releases and preserves existing local override scope. Scan migration remains outside the launch commit because a disabled record cannot establish operator intent.
- **Decision completeness and lessons.** Four decisions are frontloaded. Zero choices are marked cheap to change and zero questions remain in the launch spec. Existing-session eligibility and failover policy have separate evidence requirements.
- **Cross-model.** Compatibility mapping, atomic publish ordering, sibling retention and fresh-install degradation are specified. Future scan observations cannot advance manual delivery state. Future replacement requires durable receiver acceptance and current conversation ownership.


## Convergence verdict

The launcher scope closed at the Tier 2 round cap. The last external review's two implementation findings were addressed with a shared built-in selector and regression tests. The isolated launch change leaves the known local override behavior visible and carries the fleet-wide preference design separately. There were no remaining safety, security or data-loss findings in launch scope.
