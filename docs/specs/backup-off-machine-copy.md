---
title: "A copy of the agent off its machine that needs no outside account"
slug: "backup-off-machine-copy"
author: "echo"
parent-principle: "The User Experience Is the Product — Reachability, Responsiveness, and Coherence Are Sacred"
eli16-overview: "backup-off-machine-copy.eli16.md"
related-specs: "recommended-services.md"
status: "stub"
---

# A copy of the agent off its machine

Owner: Echo. Second in the backup work order (`recommended-services.md`, Frontloaded Decisions). Closes the `gap` on the `github-state-backup` row, and on the `bitwarden` row for an agent on a single machine.

## Problem statement

Same-machine snapshots don't survive losing the machine. Without GitHub, an agent's memory is gone with it. Without Bitwarden, a single-machine agent's secrets are gone too.

## Acceptance

An agent with no GitHub and no Bitwarden loses its machine and is restored elsewhere, with memory, settings and secrets. A drill proves it by restoring onto a clean machine, and both catalog rows move off `gap`.

## Questions this spec must answer

- Where the copy goes with no account: another of the owner's machines, a peer agent, a local drive, or something else. What a person with one computer and nothing else gets, stated honestly.
- How it is encrypted, where the key lives, and how a person gets that key back after losing the machine, since the key can't be stored only on the machine that was lost.
- What goes in the copy. Secrets need stricter handling than memory.
- How the agent proves a copy can be restored, rather than that it was written.

## Status

Stub. Not reviewed or approved, and nothing is built.
