---
title: "Fixture — defended machine-local surface under a NUMBERED heading (PASSES Standard A)"
---

# Fixture spec — a well-defended machine-local surface, numbered heading

Proves the numbered-heading match still computes correct section BOUNDS: the
marker below sits inside the numbered section, so the location contract (A3)
must accept it rather than read it as out-of-section.

## 8.2 Multi-machine posture

The attestation signing key is machine-local: it is generated inside this
machine's secure element and has no export path. (Updated 2026-08-22 for
Amendment 3, which narrowed this key — the bare form this fixture used to carry
now correctly fails, and `A-bad-credential-bare.md` preserves that case.)

machine-local-justification: physical-credential-locality impossible-because="the key is generated inside this machine's secure element and has no export path" permanence=permanent

## 9. Next section

Bounds sentinel — the section above must end here.
