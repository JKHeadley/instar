---
title: "Fixture — defended machine-local surface (PASSES Standard A)"
---

# Fixture spec — a well-defended machine-local surface

This surface stores the Claude OAuth login, whose relocation between machines is
prohibited by the vendor's terms of service — not a credential that merely happens
to sit on one disk.

## Multi-machine posture

The per-machine Claude login is machine-local: Anthropic's terms forbid relocating
it, so each machine re-mints its own rather than copying a token.

machine-local-justification: physical-credential-locality prohibited-by="Anthropic terms of service — relocating a Claude login between machines is prohibited" permanence=temporary
