---
spec: llm-decision-provenance-wiring
tracks: ACT-562
---

# LLM-decision provenance wiring (ACT-562)

## 1. Problem statement (verified against live source)

LLM decision points make verdicts that are never recorded: a gate blocks or
allows, a classifier fires or stays silent, and nothing durable captures which
decision was made, on which model, with what outcome. An unlogged
decision-maker cannot be graded, so "does this gate need a bigger model or a
prompt change?" is unanswerable. This spec wires decision points into
provenance recording.

## 2. Scope of THIS increment

A coverage census over LLM decision points shipping `src/data/provenanceCoverage.ts`
and the `ProvenanceCoverageEntry` symbol, enrolling the first callsites with
provenance options so each settlement writes a decision-quality row (verdict,
model, outcome) for later grading.

## Decision points touched
- **Tone-gate enrollment** (`messaging-tone-gate`) — the first wired decision point.
