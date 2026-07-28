# Side-Effects Review — SessionMonitor ctx-notified ledger persistence

**Version / slug:** `sessionmonitor-ctx-ledger-persistence`
**Date:** `2026-06-06`
**Author:** `echo`
**Second-pass reviewer:** `not required (SMALL, single-component, both-sides tested)`

## Summary of the change

The once-per-death-episode dedup map in SessionMonitor (`ctxNotifiedSessions`,
added by #914) was in-memory only — every server restart re-announced already-
announced dead sessions, once per boot (2026-06-06 residual, topics 16566 +
19437; operator pick 1Y approved persisting it). The map is now persisted to
`state/session-monitor-ctx-notified.json` (atomic tmp+rename), loaded at
construction with a 7-day prune, and updated on both mutation sites (notify →
set, successful recovery → delete).

## Decision-point inventory

- Load: missing file → empty; corrupt file → warn + empty (never throws);
  entry older than 7 days or malformed → dropped. All arms tested.
- Persist: write failure → one-time warn, monitoring continues (degrades to
  pre-persistence behavior). statePath absent → feature inert (tested).

## 1. Over-block

A persisted episode could suppress a notice the user wanted if the SAME
topic+sessionName genuinely dies twice without an intervening recovery or
respawn — but the same was already true in-memory within one server lifetime;
persistence only extends the existing semantics across boots. The 7-day prune
bounds the suppression horizon.

## 2. Under-block / residual risk

- A respawn that reuses the SAME tmux session name after a fresh death still
  notifies (sessionName equality is the episode key — unchanged semantics).
- Multi-machine: the ledger is machine-local (registered as such); a topic
  transferred to another machine starts a fresh episode there. Acceptable —
  the post-transfer closeout kills the old session anyway.

## 3. Level-of-abstraction fit

Persistence lives inside SessionMonitor next to the map it persists; the path
is injected via deps (testable, inert when absent); wiring at the single
construction site in server.ts; the new state file is declared in
`src/data/state-coherence-registry.json` (machine-local / single-writer / none)
so the state-registry lint passes at birth.

## Rollback

Revert the PR; the orphaned state file is inert (nothing reads it) and ≤ a few
hundred bytes.

## Blast radius

Server-side only; no agent-installed files, no hooks, no config defaults, no
template changes → no Migration Parity obligations. New state file is created
lazily on first notify.
