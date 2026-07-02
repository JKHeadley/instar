# LLM Routing Registry v2 (benchmark-derived) + full bench-coverage ledger

## What Changed
First in-repo shipment of docs/LLM-ROUTING-REGISTRY.md at v2: 7 hard routing
rules and tiered subsidized-non-Claude-first defaults per task nature, every
choice citing its INSTAR-Bench v2 run stamp; plus the record of the 4 shipped
prompt fixes (PRs #1325/#1327/#1328) and 2 ratchet-held ones.
src/data/llmBenchCoverage.ts: the 24 wave-2 pending entries graduate (19
covered by task batteries, 5 argued exemptions); the ratchet test's pinned
baselines updated accordingly.

## Evidence
INSTAR-Bench v2: 3,030+ critical-set calls (stamps crit-cli/crit-metered),
wave-2 full-coverage runs (stamp wave2), 570 forensic verdicts, 6 prompt A/Bs
with ratchet semantics. Ratchet test 6/6 green with the new baselines.

## What to Tell Your User
The rulebook deciding which AI model answers each of my internal questions is
now evidence-based: every default cites a benchmark run instead of a
judgment call, including hard bans on routes that proved unreliable for
safety-critical checks. No behavior changes in this update itself — it's the
map and its enforcement catching up with the proof.

## Summary of New Capabilities
None new — routing guidance and benchmark-coverage enforcement are now
complete and citable.
