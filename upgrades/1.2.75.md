# Upgrade Guide — vNEXT

<!-- bump: patch -->
<!-- patch = internal refactor, no behavior change for the user -->

## What Changed

Phase 2a of the Threadline re-assessment (CMT-497) — the **single-store collapse**.
Phase 1 introduced one clean conversation record (`ConversationStore`) but couldn't
retire the old `thread-resume-map.json` yet: it's written from two processes (the
agent server and the MCP stdio child), and the new record kept its data in memory,
so two in-memory copies would have clobbered each other. This finishes the cleanup
so there is truly ONE store.

**The fix.** `ConversationStore` is now cross-process safe — it reads the file
fresh per operation, commits with an atomic tmp+rename, and uses a per-record
`version` token so a same-thread race loses no update (a strict improvement over
the old last-writer-wins). `ThreadResumeMap` becomes a thin **view** over it (every
method preserved, same signatures), so the server, the router and the MCP child all
read/write the one `conversations.json`. The legacy `thread-resume-map.json` is no
longer written; a one-release dual-read window falls back to it on a miss so threads
written by a pre-2a version aren't lost.

**Approach note (convergence).** The first design proposed an HTTP surface so the
MCP child could mutate via the server. A two-reviewer pass against the live code
rejected it: it targeted a dead `ContextThreadMap` path, the `/threadline/*` routes
bypass the bearer middleware (so the endpoints would have shipped unauthenticated),
and it was heavy machinery to replace a single `.remove()` call. The shipped design
— file version-CAS — has no new network surface, no auth gap, and no restart-window
data loss.

## What to Tell Your User

Nothing changes for you. This is an internal cleanup so agent-to-agent conversation
state lives in one place instead of two. Existing conversations are preserved.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Cross-process `ConversationStore` (file version-CAS) | Automatic; `mutate`/`mutateSync` are safe across the server + MCP child |
| `ThreadResumeMap` as a view over the single store | Automatic; same API, now backed by `conversations.json` |

## Migration Notes

Phase 1's `migrateThreadlineConversationStore` already folds the legacy file into
`conversations.json` on boot. This release stops writing the legacy file and adds a
one-release dual-read fallback (read legacy on a miss, write through). The legacy
`thread-resume-map.json` is kept on disk for rollback and removed in a later
release. No `~/.codex` or relay change.

## Evidence

- Spec: `docs/specs/THREADLINE-SINGLE-STORE-SPEC.md` (+ ELI16 + convergence report —
  approach pivoted from HTTP to file version-CAS after 2 fatal + blocking findings).
- Tests: `ConversationStore.test.ts` (incl. a two-instance cross-process 50-increment
  race + `mutateSync` racing async `mutate`), `ThreadResumeMap.test.ts` (field-bridge
  + prune/migrate parity, re-pointed to the new store), `single-store-cmt497.test.ts`
  (merge-not-clobber, dual-read, resume round-trip, gate-mutate-racing-remove,
  no-second-writer), `ThreadlineObservability.test.ts` (re-pointed). 1490+ threadline
  tests green.
- Test-as-self on live `instar-codey` before merge (MCP-child delete over the single
  store, resume recovery, no corruption under concurrent gate+delete).

## Rollback

Additive + reversible. Revert restores the file-backed `ThreadResumeMap`, the
Observability raw read, and the in-memory `ConversationStore`. The frozen legacy file
is still current within the dual-read window, so rollback strands no state.
