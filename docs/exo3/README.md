# EXO 3.0 → Instar — working artifacts

The durable home of the EXO 3.0 alignment workstream (Telegram topic 19437 "🎯 EXO 3.0").

## What this is

Salim Ismail's EXO 3.0 framework (his @SalimIsmail YouTube channel) mapped against Instar, requirement by requirement, with a phased game plan toward a dedicated `instar.sh/exo3` positioning page and eventual outreach to Salim. The mission (operator, 2026-06-04): digest every video → extract every requirement → map to Instar → close the credibility-critical gaps → page → outreach, never prematurely.

## Files

| File | What it is |
|---|---|
| `REQUIREMENTS-MATRIX.md` | **The master matrix** — every EXO 3.0 requirement (A–I areas) vs Instar status, the G1–G6 gap analysis, close-before-pitch thresholds, and the phased game plan |
| `MTP.md` | Instar's drafted Massive Transformative Purpose ("Make the world's most powerful AI its most humane") + framing decisions. DRAFT pending operator blessing (see attribution note inside) |
| `PHASE-1-PLAN.md` | Implementation plan for the two must-close gaps: G1 (MTP Protocol packaging) + G2 (agent-readiness scoring) |
| `TIER4-HARNESS-DESIGN.md` | Design for the Tier-4 "test-as-self" behavioral verification harness (partially superseded — see the note inside: single shared Playwright user seat, not two bot identities) |
| `PAGE-DRAFT.md` | Draft copy for the `instar.sh/exo3` page (built in PR #775) |
| `transcripts/` | The 11 source video transcripts (digested 2026-06-04), named `NN-<youtubeId>.txt` |

## Build state (as of 2026-06-05)

- **G1 MTP Protocol** — PR #785
- **G2 agent-readiness scoring** — PR #791
- **G3 agent passport** — PR #793
- **G5 learning-velocity metric** — PR #794
- **/exo3 page** — PR #775
- **G4 inter-org porousness** — deliberately NOT built; shown as trajectory (the honesty is the credibility)
- **G6** — advisory only, by design

## Provenance

Digested + authored 2026-06-04 in a machine-local session on the Mac Mini; rescued and committed to the repo 2026-06-05 after the multi-machine artifact-sync gap (working files on one machine are invisible to the agent's other machines) was flagged in topic 19437. A full-page preview screenshot (`exo3-fullpage.png`, 708K) exists in the rescue copy but is deliberately not committed — PR #775 carries the page itself.
