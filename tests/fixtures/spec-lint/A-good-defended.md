---
title: "Fixture — defended machine-local surface (PASSES Standard A)"
---

# Fixture spec — a well-defended machine-local surface

The signing key is generated inside this machine's secure element and has no
export path. There is no authority forbidding the move; the move is simply not
possible — which is why the basis is stated as an impossibility rather than a
prohibition, and why the barrier is permanent rather than temporary.

## Multi-machine posture

The attestation signing key is machine-local.

machine-local-justification: physical-credential-locality impossible-because="the key is generated inside this machine's secure element and has no export path" permanence=permanent
