---
title: "Fixture — a spec that QUOTES a marker in prose (PASSES Standard A)"
---

# Fixture spec — correction prose that quotes a marker

A correction-heavy spec discusses markers, and ordinary paragraph wrapping puts the
quotation at line-start where it reads as a declaration. This fixture reproduces
that shape: the quotation below sits OUTSIDE the posture section and must NOT be
graded as an out-of-section declaration (rule A3).

## 8. Multi-machine posture

The sampler ring is machine-local BY DESIGN — it derives from this physical host.

machine-local-justification: hardware-bound-resource

## 9. What an earlier draft got wrong

It declared the decision log
`machine-local-justification: hardware-bound-resource`. A JSONL audit file is not
bound to specific physical hardware, so that key was substantively wrong and the
log's real posture is unified.
