# Convergence report: mobile-remote-media

## ELI10 Overview

The phone can now open a Slack file that lives on another of your machines, by asking the machine it's connected to, which streams the file for the owner's phone only. Outside reads found one real flaw in the first version: the owner check only ran when bytes arrived, so a stalled transfer could outlive a revocation. It now runs on a timer. A same-family read added three more fixes.

## Original vs Converged

The first draft checked the owner only as chunks arrived, ended every transfer at 120 s, answered a full holder with an error, and had an unguarded check on the timer once that was added. The converged design checks on a clock, pauses the holder stall timer while a slow phone drains, allows 300 s, treats a full holder as the wait the app already polls, and treats a check that throws as a refusal.

## Iteration Summary

| Round | Reviewers | Material findings | Spec changes |
|---|---|---|---|
| 1 | codex-cli gpt-6-astra | SERIOUS ISSUES: revocation detection tied to arriving bytes | Timer watch, stalled-holder test |
| 2 | codex-cli gpt-6-astra | MINOR ISSUES, precision only | Wording: polling is nominal, last check is the completion point, hash proves content not authorization, background copy stays |
| 3 | claude-code clean door | Deadline too tight with no Range; busy holder refused; timer check unguarded; bearer widening unstated | 300 s, idle paused during drain, 202 wait, throw refuses, spec states the widening and the rejected replicator route |

Standards-Conformance Gate: unavailable: it refuses a spec path outside the agent home.
Internal reviewer subagents: not run, because this builder cannot spawn subagents. Stated here, not hidden.

## Cross-model review

codex-cli gpt-6-astra, two rounds, last verdict MINOR ISSUES. claude-code is a same-family clean door, not a cross-model read. No reviewer has re-read round 3's fixes.

## Convergence verdict

Stopped at three rounds, the Tier 2 work is bounded by the coordinator's deadline. Round 3's fixes are tested but not re-reviewed. Range stays refused; a cut download restarts.

## Coordinator decisions after convergence

The coordinator accepted the agent bearer on the holder as peer authorization, not phone or human owner proof. The holder's checks stay documented as static, with no claim of containing a compromised near machine. Cache hydration on a missing blob is accepted as a scoped download side effect. Two fixes were required and made: an owner check before every write, and skipping empty chunks, which could otherwise take the withheld chunk's place.

An independent re-read then found no security bypass, and these robustness fixes were made: a registry that throws no longer reaches an uncaught rejection; file requests have their own rate bucket and a 5 s busy retry; a phone that takes no bytes for 60 s gives its slot back; the route timeout now outlasts the stream; a machine with no token accepts no hop; and a phone gone during the file open gets no read stream. The HTTP/1.0 no-length edge is stated as a limit.

A final re-read found no blocking defects and three small ones, now fixed. A slow phone was cut by the drain limit: a server cannot see bytes leave kernel buffers, so a quiet download now gives its slot back and keeps running to the overall limit. Upload and purge timeouts now follow the agent's configured default. A limit that ends the stream while it waits on the phone is no longer reported against the holder.
