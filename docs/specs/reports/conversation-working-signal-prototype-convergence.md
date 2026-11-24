# Convergence report for the isolated Codex turn observer

## Cross-model review

The installed Codex CLI using GPT-6.2-Astra reviewed all six rounds. That is a separate review invocation in the same model family as the author, rather than a different model family. Two independent internal reviewers covered security and adversarial behavior, integration, scalability, decision completeness, and lessons and experience. The live standards advisory ran in all six rounds and checked 102 standards each time. Raw receipts and exact prior drafts are preserved in the authoring worktree evidence. No production applicability is inferred from this checkpoint.

## ELI16 overview

This checkpoint preserves a local way to watch a real Codex turn start and finish, with tests that anyone can run on the draft branch. No normal session or dashboard calls it. The same fresh-session Stop hook behaved equivalently in the two disposable launches. A resumed managed session still paused for hook review, and this branch has no authority to change that behavior or to turn on a chat indicator.

## Iteration summary

| Round | Findings and disposition |
|---|---|
| 1 | Clarified exact provider RPC and turn-ID correlation, monotonic start expiry and reproducible focused checks. Internal review caught that ordinary compilation emits the unused modules even though native packaging and callers are absent. |
| 2 | Specified both arrival orders and exact cutoff. Added the repeatable native fixture without changing production launch or package inputs. |
| 3 | Skipping oversized messages must clear pending evidence. Added a real fragmented-wire regression and made fixture pass/fail require a positive and clear. Ensured independent cleanup attempts and clarified ignored unrelated responses. |
| 4 | Specified dropping both overlap candidates and separated early native clear from elapsed expiry and from future already-ended coverage. The fixture proves clearing during the completion callback before elapsed expiry. |
| 5 | Clarified that request-ID comparison precedes turn-ID comparison. Added the late discarded-response regression and labeled the prior 4 MiB paused-client measurement as historical. |
| 6 | The external reviewer labeled the ambiguity about retained extracted identifiers DESIGN. Source-backed adjudication resolves it as document precision because no behavior, bound, routing or test acceptance changes. The existing 64 KiB limit applies per directional assembly buffer. The existing protocol bounds strings to 256 UTF-16 units and numeric request IDs to safe integers. Internal post-read independently confirmed both guards on every protocol-to-state path. Clarified which positively identified unrelated traffic is ignored and the exact resume mismatch diagnostic. No additional external round ran after those precision edits. |

## Experience fit and fixed limits

The scope is checkpoint preservation and reproducibility. An owner gets no changed chat or launch, and nobody must accept a new permission request to carry this code on a draft branch. Enabling must address ordinary resume, the real authorized chat path and foreground behavior separately.

The standards advisory flags are recorded, including deliberate abstention when a legal message exceeds 64 KiB, ten seconds of start-evidence freshness, one pending correlation, and bounded disposable child startup. These choose the size and shape of an isolated experiment. A long legal message still forwards, and suppression of an optional local observation produces no product decision. A loaded Mac can miss the disposable startup budget. The source-level 256-unit identifier guard imposes an additional experimental observation bound. None of those values are justified as product defaults or used to gate normal activity. Independent reviewers reported no constraint violation within the checkpoint scope. Product design must establish workload and channel-specific bounds before activating any behavior.

## Verification and left behind

Exact reconciled source passed 22 tests in four focused Vitest files. The tracked real macOS/Codex fixture passed the managed fresh launch, embedded fresh launch and embedded resume comparisons. The managed resume reproduced exit 1 with the expected hook-review diagnostic, zero attempts of the fixture Stop hook and zero requests to the loopback model. The native fresh run observed the hint and early clear; the actual managed app-server requires both connected peer PIDs before forwarding. No claim is made about installed production behavior or an unrun full suite.

Packaging, runtime ownership, approvals, resume parity, signed browser reads and rendering remain in the unapproved product working-indicator design. The draft branch is for review and recovery, not merge or release.

## Convergence verdict

Converged for the inert prototype checkpoint at round six. Final residuals are precision edits independently checked against existing code. They change no product decision and authorize no product connection.
