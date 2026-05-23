# Project — Topic Intent Layer (Layer 1 first)

> GSD scratch state. The durable Instar ledger is `.instar/state/build/`.
> If they disagree, Instar's state wins.

## Stated goal

Ship the Topic Intent Layer (v14 CLEAN spec, approved 2026-05-22) to main with CI green. Layer 1 (the confidence tracker) is built through a GSD-integrated /build path. Layers 2 and 3 (resume briefing + ArcCheck redraft) are built through Instar's normal /build path. A side-by-side comparison report at completion decides whether to permanently integrate GSD into /build.

## Scope of this project

The full Topic Intent Layer feature, all three layers, shipped to main. The GSD spike is wrapped *around* the build, not the build itself.

## Source of truth

- **Spec:** `docs/specs/topic-intent-layer.md` (v14, approved). Read this before planning, executing, or verifying anything.
- **Project plan:** `docs/projects/topic-intent-layer-gsd-spike.md`
- **Decisions are locked in:** the spec itself, plus `CONTEXT.md` in this directory if it exists.

## Why a Walking Skeleton isn't applicable

This is not a greenfield project. Layer 1 is a new module inside an existing TypeScript codebase with full DI / lifecycle / test infrastructure already in place. The Walking Skeleton step (proving every layer of the stack works end-to-end) is satisfied by the existing Instar codebase. Skip.
