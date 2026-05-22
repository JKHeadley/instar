---
kind: project
id: topic-intent-layer-gsd-spike
title: "Topic Intent Layer + GSD-Instar integration spike"
status: active
owner: echo
target_repo_path: /Users/justin/Documents/Projects/instar
source_docs:
  - docs/specs/topic-intent-layer.md
goal: "Ship the Topic Intent Layer (v14 CLEAN spec) to main with CI green, using it as the test bed for a slice-based GSD-vs-Instar integration spike. Layer 1 built through a GSD-integrated /build path; Layers 2 and 3 built through Instar's normal /build path. Deliver a side-by-side comparison report and a decision on whether to permanently integrate GSD into /build or cherry-pick its hook-layer patterns into Instar's hooks."
auto_advance: false
telegram_topic_id: "9413"
---

# Topic Intent Layer + GSD-Instar integration spike

This project ships the Topic Intent Layer feature to main while using it as a structured comparison between Instar's `/build` pipeline and a GSD-integrated variant. The whole feature ships either way; the integration question is decided on data, not opinion.

## Why this is a project, not just a build

The Topic Intent Layer alone is a substantial three-layer feature with non-trivial scope (confidence tracker + resume briefing + ArcCheck redraft). Layering the GSD integration spike on top means we are doing two new things at once, which is exactly the kind of multi-phase work the projects API was designed to track.

Phases progress sequentially. Phase 4 (Layer 1 via GSD) is the actual experiment; the surrounding phases set up, complete the feature, measure, and decide.

### Tier 1: Setup

| # | Item | Source | Effort |
| - | ---- | ------ | ------ |
| 1 | Commit v14 spec with approved=true | docs/specs/topic-intent-layer.md | trivial |
| 2 | Register this project via /projects API | this doc | trivial |
| 3 | GSD hands-on on throwaway repo — install, run full pipeline on toy feature, document integration hooks | gsd-build/get-shit-done | medium |
| 4 | Create build worktree at ~/.instar/agents/echo/.worktrees/topic-intent-layer/ | agent-home worktree convention | trivial |

### Tier 2: Build the feature

| # | Item | Source | Effort |
| - | ---- | ------ | ------ |
| 5 | Layer 1 via GSD-integrated /build path — EstablishedRef + EvidenceEvent + projection + extractor + pending-confirmation lifecycle | spec sections "Trust model" + "Pending-Confirmation Records" | large |
| 6 | Layers 2 + 3 via normal /build path — resume briefing on session-start + ArcCheck pre-send classifier + redraft path | spec sections "Layer 2" + "Layer 3 / ArcCheck" | large |
| 7 | Spec acceptance tests + daily probes — decay arithmetic at t=104/105/106, qalatra/9235 + GCI/Luna 365 replays, precision/recall enforced in CI | spec section "Tests (acceptance)" | medium |
| 8 | Ship to main with CI green, verify merge commit lands | feedback_verify_commit_actually_landed | medium |

### Tier 3: Measure and decide

| # | Item | Source | Effort |
| - | ---- | ------ | ------ |
| 9 | Write side-by-side comparison report — speed, output quality, friction, integration cost; publish via private viewer + tunnel | this project | medium |
| 10 | Decision gate — if GSD path won, spec permanent integration as v1.3.x project. If not, port standalone hook-layer patterns (slopcheck, analysis-paralysis-guard, 4-tier-verifier) into Instar's hooks as a smaller PR. Capture learnings in MEMORY.md. | comparison report from Tier 3 #9 | medium |
| 11 | Final report to Justin via Telegram 9413 with verdict + recommendation + links | this project | trivial |

## Out of scope for this project

- Auto-spreading insights across separate conversations (spec marks out-of-scope for v1)
- Retroactive backfill of pre-shipped conversations (spec out-of-scope)
- Cross-machine CRDT collaborative state (spec out-of-scope)
- The permanent GSD integration itself (becomes a separate project under Tier 3 #10 if the spike returns positive)

## Links

- Spec (v14 CLEAN, approved 2026-05-22): `docs/specs/topic-intent-layer.md`
- Topic: Telegram 9413 (topic-intent-layer)
- Comparison view of GSD vs /build (background research): [tunnel URL in topic 9413 history]
- Autonomous state: `.instar/autonomous-state.local.md` in agent home

## Origin

Approved by Justin on 2026-05-22 via topic 9413 after a four-message conversation comparing GSD (https://github.com/gsd-build/get-shit-done) to Instar's existing `/build` and `/autonomous` skills. Justin's framing: "Instar should be the intelligent meta-orchestrator over best-of-breed tools — user types `/build`, never sees GSD." The spike will validate or invalidate that framing on real production work.
