---
title: StandingDrive schema
description: The durable, deterministic schema foundation for reviewed long-running drives.
---

StandingDrive is being built as a composition over Instar's existing autonomous-run lifecycle, not as a second lifecycle system. Slice 1 adds an optional versioned extension to the server-owned run record. Runs without the extension keep their existing behavior, and this slice does not wake sessions or execute actions.

The `AutonomousRunStore` remains the single persistence owner. It enrolls a complete extension atomically and requires every extension change to carry the expected shared revision. Generic run updates are serialized with the same crash-recoverable lock and cannot mutate the extension, preventing unrelated writers from losing a newer drive transition.

`StandingDriveSchema` owns versioned canonicalization and deterministic validation. It rejects duplicate or dangling phase references, unknown enrollment sources, corrupt breaker state, authority-binding mismatches, and actions outside the frozen phase envelope. These checks are closed structural predicates; they do not ask a model whether an action merely sounds related.

This foundation is intentionally inert. Replay, wake recovery, effect reconciliation, and semantic-progress breakers are separate reviewed slices that must compose with their existing authorities before StandingDrive can execute autonomously.

Slice 2 makes action derivation auditable. A detailed pure result names the matched frozen rule, envelope digest, typed decision, and a stable decision digest. Git and local-test roots use traversal-safe project-relative prefix semantics; other targets remain exact. Malformed input and actions that merely sound related but differ from the enumerated envelope hold without consulting a model, network, clock, or machine locale.
