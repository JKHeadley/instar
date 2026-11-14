# Convergence Report — Native Schedule, Promises and Machines screens (read-only)

## Cross-model review: codex-cli:gpt-6-astra

A real GPT-tier external pass ran through the agent's codex CLI on all six rounds (status `ok` each time). Gemini was not available (`gemini-not-authed`); the Anthropic clean-door family was available but not run.

## ELI10 Overview

The Instar iPhone app is getting three native screens: the agent's schedule (which jobs are late or failing, and when each runs next), its promises (what it said it would do, and when), and its machines plus health (is every machine answering, and is anything degraded). Until now the phone had to open the web dashboard for these.

The server gets three new read-only questions a paired phone may ask. Each answer is a cut-down summary built for the phone, made from the same data the web console reads, with the risky parts removed: no job instructions, scripts, file paths, hostnames, machine ids, tokens or settings. Only the owner's phone may ask; a helper's (MSP) phone, a revoked phone or an unsigned request is refused.

The main tradeoff: these answers are built for display, so a few things are estimates (a job is "late" by this server's clock; a machine with no live check is "estimated"), and the screens say so rather than sounding certain.

## Original vs Converged

- Originally a request without an explicit principal counted as the bearer token. Now the bearer token is checked explicitly and anything else fails closed.
- Originally machine rows carried their raw machine id. Now they carry a one-way hashed key, and the id never leaves the server.
- Originally a merged job row could show another machine's future run beside a "late" status. Now every time on a row is the deciding machine's own, and a machine that does not run the job can never outrank the one that does (placement is read first).
- Originally an older peer's rows could read "late" falsely, a replicated promise could look fresh when it was old, a failed read was silent, and an empty machine list read as "one machine, answering". Now old-peer rows are never late, replicated promises carry `stale`, failures record a degradation, and only a pool switched off is called a single machine ("One known machine" otherwise; "can't read the list" when the list is missing).
- Slug, schedule text and fallback names are now validated or scrubbed like other text; an estimated peer turns an all-good headline into "appear to be answering (estimated)"; a retry running after failures stays "failing".

## Iteration Summary

| Iteration | Reviewers who flagged | Design findings | Left behind | Spec changes |
|-----------|-----------------------|-----------------|-------------|--------------|
| 1 | security/adversarial, scalability/integration, decision-completeness/lessons, codex | 8 | 9 | principal check, machine ids, late times, old peers, replica staleness, observability, maturation wording, posture, migration fallback |
| 2 | codex | 3 | 5 | field validation, inventory-unknown, stable row keys |
| 3 | codex | 2 | 5 | single-machine rule, clock-skew wording, self key |
| 4 | codex | 2 | 4 | "one known machine", removed-person scope, dueAt wording |
| 5 | codex | 2 | 3 | placement first, estimated headline |
| 6 (cap) | codex (internal: none) | 1 | 4 | running-after-failure stays failing (fixed at the cap, tested) |

Standards-Conformance Gate: ran (3 flags) in round 1 — Maturation Path, Live-User-Channel Proof, Observability — each engaged by the decision-completeness/lessons reviewer and addressed (maturation reworded as no-flag by design with post-ship checks; live proof tracked as a dev-agent-live step; observability via the `MobileOpsScreens.read` degradation). Later rounds: the gate was not re-run (the spec's constitutional surface did not change after round 1).

Internal reviewers ran as three combined subagents in round 1 (two lenses each) and as one six-lens subagent in rounds 2-6, on the authoring session's model (Opus 5.5).

## Proportion

Tier 2 (security-sensitive: widens device-key access). Server: one new module (~430 lines), three allowlist entries, two extracted helpers, awareness lines; app: two new files plus five lines in shared files. Six of six review rounds used. ⚠ That is the cap: the external reviewer found one small design-class edge per round (display-classification corners in the summaries, none about access), which is in line with the size of a new three-route read surface but more rounds than its risk alone needed.

## Left behind

- `e.local` guard in the late computation was redundant after placement-first (removed).
- A job row whose entries are all `elsewhere` lists the machines that do not run it; acceptable (it names where the job is listed).
- The machines headline sits in the section footer on the phone; fine for now.
- `poolEnabled` reports false for an unstated pool; the app uses `inventoryKnown` for wording.
- The Anthropic clean-door second read was not run (cost; cross-model GPT pass ran every round).
- Invalid-date inputs to `dueAt` are dropped silently (as the console does); no dedicated unit case.

## Full Findings Catalog

Round 1 — security: fail-open missing principal (DESIGN, fixed); machine ids returned (DESIGN, fixed); livenessLine content (PRECISION, documented); peer-supplied text (PRECISION, documented); replica staleness hidden (DESIGN, fixed); injected text is display-only (PRECISION, documented); generatedAt not freshness (PRECISION, documented). Scalability/integration: migration anchor silent skip (PRECISION, fallback added); old-peer rows read late (DESIGN, fixed); unified vs replicated posture (PRECISION, fixed). Decision/lessons: observability (DESIGN, fixed); live proof (PRECISION, tracked); maturation wording (PRECISION, fixed); tie-break and caps (PRECISION, pinned/tagged); demotion freshness (test added). Codex: machine ids (DESIGN, fixed); late row shows peer's future run (DESIGN, fixed); missing principal (DESIGN, fixed); person-unknown precedence (PRECISION, documented).
Round 2 — codex: slug/schedule/fallback unscrubbed (DESIGN, fixed); empty pool read as single machine (DESIGN, fixed); positional row identity (DESIGN, fixed). Internal: livenessLine, clock skew, raw cron fallback, poolEnabled on jobs, tie-break (PRECISION, documented or added).
Round 3 — codex: enabled-pool one row / missing state (DESIGN, fixed); clock-skew guarantee false (DESIGN, reworded); path wording (PRECISION, fixed); positional key line (PRECISION, removed). Internal: self key, id-derived key, unread count, test list (PRECISION, fixed).
Round 4 — codex: single with an enabled one-row pool (DESIGN, fixed); removed-person scope (DESIGN, scoped to MSP phones); dueAt wording (PRECISION, fixed). Internal: self fallback key, comment, poolEnabled (PRECISION, fixed).
Round 5 — codex: placement must decide first (DESIGN, fixed); estimated headline (DESIGN, fixed); prose vs fields in tests (PRECISION, fixed). Internal: none design.
Round 6 — codex: running retry with failures (DESIGN, fixed with a unit test); disabled pool with rows (PRECISION, `single` now also needs exactly one row); observability wording per endpoint (PRECISION, fixed). Internal: no DESIGN findings; redundant guard and elsewhere-row machines (PRECISION).

## Convergence verdict

Converged at the round cap (6). The internal six-lens reviewer found no design-class issues in rounds 2-6; the external reviewer's last design-class finding (a display-classification edge, not safety, security or data loss) was fixed and tested at the cap. Spec is ready for approval.
