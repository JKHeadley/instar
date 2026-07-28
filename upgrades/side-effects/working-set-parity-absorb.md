# Side-Effects Review — working-set parity absorb (presence-wiring window + delivery-completeness tracking)

**Version / slug:** `working-set-parity-absorb`
**Date:** `2026-06-06`
**Author:** `echo`
**Second-pass reviewer:** `not required (dep reorder + capability-tracking registration; zero behavior change)`

## Summary of the change

Two more CI gates legitimately flagged P2.2b integration points:
1. `peer-presence-wiring` reads a 900-char window after the PeerPresencePuller
   constructor and asserts the signed `session-status` call inside it — my
   `onPeerRecorded` dep (with comment block) pushed it out. Fix: the dep moved
   to one compact line AFTER `log` (object-literal order is semantically
   irrelevant), keeping the window intact without touching the test.
2. `feature-delivery-completeness` requires every migrator-added CLAUDE.md
   section to be (a) tracked in featureSections and (b) mirrored in the
   `migrateFrameworkShadowCapabilities` markers[] so Codex/Gemini agents learn
   it too. Both registrations added for the Working-Set Handoff section — a
   shadow-framework agent that never learns the fetch reflex would tell the
   user the files "aren't on this machine" (the EXO failure surviving on
   shadows only).

## 1-4. Over/Under-block, fit, blast radius

Zero runtime behavior change: a dep reorder inside one object literal, a test
registry entry, and a shadow-marker string. The shadow marker causes the
migrator to mirror the (already-shipped) section into Codex/Gemini shadow
files on the next update — exactly the parity the gate exists to enforce.

## Evidence

- `tests/unit/peer-presence-wiring.test.ts` 4 passing;
  `tests/unit/feature-delivery-completeness.test.ts` 79 passing;
  `tests/unit/session-pool-activation-wiring.test.ts` 8 passing. Typecheck clean.
