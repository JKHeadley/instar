# Convergence Report — Threadline identity: one writer, validated reads

## Cross-model review: codex-cli:gpt-6-astra (RAN — one round)

One review round, as the task set: a bug fix with a narrow surface, reviewed until the findings stopped changing the build.

What ran:
- The Standards-Conformance Gate (`POST /spec/conformance-check`, 92 standards), run again after each set of fixes until it returned no finding.
- An external GPT-tier review through the agent's codex CLI (`gpt-6-astra`).
- `scripts/lint-machine-local-justification.js --strict` on the spec.

No internal multi-reviewer panel ran. That is a deliberate abbreviation for a bug fix, stated here rather than implied away.

## ELI10 Overview

An agent has a key that is also its address on the relay. Two parts of the code wrote that key to the same file in two different text forms, and the reader never checked what it read. An agent that started with the relay off got its key written in the wrong form, and from then on offered the relay a "key" of the wrong size at every start. The relay refused it, forever. The startup log said "connected" anyway.

The fix: one module writes the key file; every read checks the key is the right size; a file in the wrong form is rewritten in the right form with the same key, so the address does not change; a file broken in any other way is left alone and reported; and the startup log says what actually happened.

## Findings and what was done

| # | Source | Finding | Resolution |
|---|---|---|---|
| 1 | Standards gate — Cross-Store Coherence Is an Invariant | Canonical and legacy files could hold two different valid keys with no stated invariant, and `routes.ts` read the legacy file on its own. | Added §5: the invariant, a check on every load, a log line and boot degradation on disagreement. `routes.ts` now reads the identity manager; no reader parses the legacy file itself. Unit test added. Re-run of the gate: that finding cleared. |
| 2 | codex — "one writer" is not serialized writes | Two processes could both find no file and mint two keys; a repair could write over a later change. | Create is now create-if-absent (`link(2)`, never replaces; the loser adopts the winner's identity). Repair is compare-then-replace. Stated in §1 with the reason no lock file is used. Forced-interleaving test added. |
| 3 | codex — invalid-file behaviour contradicted the fallback | Frontloaded Decision 2 said the agent stays off the relay, while §2 kept the legacy fallback. | §2 now has a table for every file combination (identity used, health fields, relay, what is reported). Decision 2 reworded. `problem` is reported even when the other file loaded. Integration test for unusable canonical + valid legacy added. |
| 4 | codex — rollback claim broader than the evidence | "Repaired files work with previous code" ignored the previous handshake reader. | Rollback section narrowed: relay identity works under the previous code; the local HTTP handshake does not, which was already true for every agent with a base64 legacy file. |

| 5 | Standards gate (second run) — Verify the State, Not Its Symbol | The spec claimed the repair's re-read protects against writing over a change, but re-read and rename are not atomic. | The claim is corrected: the re-read narrows the window and does not close it. §1 now names every writer that could land in it and what would happen, and accepts the residual in words. |
| 6 | Author, while answering 5 | The pairing installer writes the canonical file with its own raw `fs` calls, imported under aliases the source-scan test could not see. | The installer now uses the shared write primitive, and the scan matches aliased and bare `fs` functions. A test pins the aliased case. |

## What the external reviewer confirmed

The hex/base64 rule is sound: 64 hex characters decode as base64 to 48 bytes, so the two readings cannot both be a 32-byte key. Deterministic repair is the right tool; no coordination between machines is needed.

## Not verified by the reviewer

The reviewer saw only the spec. The claims about the source and the live logs were verified by the author against `main` (890f02396) and are pinned by the tests named in the spec.
