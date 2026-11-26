# Work Board owner lane projection

Tier 1 dark projection checkpoint. This diff introduces a typed input on the Work Board renderer and tests it. No production route supplies the input. The exact decision verifier and activation work require separate review before any live use.

1. Over-block. An unavailable verifier must not be represented as verified absence. Production wiring must preserve the known design and Instar App decisions.
2. Under-block. Without the new input, callers retain the existing lane and My Board behavior. A checked absent decision clears an approval-derived owner wait and an agent-owned mirror.
3. Placement. Derive lane and turn in the shared Work Board projection. The stored fold and execution path remain independent.
4. Signal and authority. The projection accepts a checked result from its caller. It cannot approve, decline, release, or pick up work.
5. Interactions. Preserve active owner questions, completion confirmations, terminal lanes, approval requirements, material hashes and pickup state.
6. External surfaces. This checkpoint adds no route or control. Future production wiring must check owner lists, detail, and My Board together.
7. Multiple machines. The upcoming binding verifier must fail on incomplete predecessor history. This checkpoint makes no peer completeness claim.
8. Rollback. Removing the dark parameter leaves the existing rendering path. No data migration or journal rewrite is involved.
