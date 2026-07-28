---
title: Project Map Related Worktrees
review-convergence: 2026-05-29T11:18:00Z
approved: true
eli16-overview: project-map-related-worktrees.eli16.md
---

# Project Map Related Worktrees

## Problem

The Project Map endpoint accurately describes the bound project directory, but for a project-bound development agent that keeps Instar source work in the conventional agent worktree area, the compact map can be misleadingly small. In Codey's case it reported the wrapper project and two top-level directories, while the active Instar development workspace lived in nearby source worktrees.

That is a spatial-awareness UX problem. The map is meant to answer "where am I and what does this project look like?" For development agents, nearby worktrees are part of the real workspace the agent must reason about.

There is a related count-consistency problem in the same mapper. The top-level directory breakdown intentionally hides dot-directories, but the headline total could still recurse into hidden state or worktree directories at the project root. On older agents with large transcript/state directories, that makes the headline file count much larger than the visible breakdown and therefore hard to interpret.

## Proposed Change

Extend `ProjectMapper` with a narrow related-worktree summary:

- keep the existing project-root map unchanged;
- discover conventional agent worktrees under the matching agent home worktree directory;
- allow tests and direct callers to pass explicit related-worktree roots;
- summarize each related git worktree by name, path, branch, remote, and high-signal top-level directories;
- show a concise "Related Worktrees" section in markdown and compact output;
- make the headline total skip hidden directories consistently with the visible directory breakdown.

The mapper must not crawl arbitrary home directories. It should only inspect configured roots plus the conventional per-agent worktree root derived from the current project directory name.

## Acceptance Criteria

- `GET /project-map?format=compact` remains concise.
- `POST /project-map/refresh` still writes the same project map files.
- A project with no related worktree root keeps its previous output shape apart from an empty optional field.
- A project with related git worktrees lists them in JSON, markdown, and compact output.
- The summary includes enough information to identify active Instar source worktrees without enumerating thousands of files.
- Hidden state/worktree directories do not inflate the headline total when they are omitted from the visible breakdown.

## Decision Points

This is a spatial-awareness enhancement, not a worktree manager or safety-policy change. It does not create, delete, or mutate worktrees. It only reads direct child git worktrees under a narrow root and reports a short summary.

## Rollback

Rollback is a normal revert. Existing project maps remain readable because the new field is optional and display helpers tolerate old saved maps that do not include it.
