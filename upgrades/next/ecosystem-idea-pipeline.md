# A weekly, careful look at what similar projects are doing

<!-- bump: patch -->

## What Changed

New dev-gated server service (`docs/specs/ecosystem-idea-pipeline.md`). Each week it reviews a
watchlist of similar projects: trusted code fetches and reads, and AI services return closed-schema
judgments. Each idea is checked against our source and specs by two blind reads, reviewed against the
Instar 2.0 purpose, classed by what it would change, and ranked into bands. The default outcome is no
change. A framework reads outside text only after two must-fail file-read probes through the same call
path real reviews use; to pass them, `IntelligenceOptions.noLocalTools` and
`reviewerHardening.noTools` ask Codex and Claude for calls with no local tools. The default path of every
other caller is unchanged. `scripts/lint-ecosystem-adoption.mjs` joins the lint chain: it fails a default
change for a tagged spec unless `docs/proofs/<idea>.json` passes, and no spec is tagged yet.

## What to Tell Your User

If you develop your own project, I can check similar projects each week and show you ranked ideas, each
checked against your code. It only gives advice: it changes nothing and contacts nobody. It is off unless
you ask for it.

## Summary of New Capabilities

- `GET /ecosystem-ideas`, `GET /ecosystem-ideas/:id/evidence`, and PIN-gated decisions through `POST /ecosystem-ideas/plan` and `/commit`.
- The console's Work group gains an Ideas page.

## Evidence

Live on this machine on 2026-11-01: without the no-tools form the capability probe refused Codex (it read
the planted file), and Claude's call stopped when it tried a tool. With the form, both frameworks passed
both probes. Tests: fixture runs on a real clone hold a hostile CLAUDE.md and a marker-writing script;
the planted idea is found, no marker is written, and the same run with file reads disabled finds nothing.
