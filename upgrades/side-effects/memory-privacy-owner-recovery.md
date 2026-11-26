# Side-Effects Review — Memory privacy: owner recovery from the fixed reply

**Version / slug:** `memory-privacy-owner-recovery`
**Date:** 2026-11-04
**Author:** echo
**Second-pass reviewer:** independent reviewer subagent, fresh context

## Summary of the change

An owner was refused on their own Mac agent. The agent was set to Claude Code 2.1.300, below the 2.1.316 floor, and the report said the platform had no supported sandbox, which was wrong. This applies to agents that opted in. Boot now names the real blocker. A verified owner hears the cause in private, with a link to a page that gives the solution, and a one-click repair when a working binary is on the machine. Everyone else keeps the fixed reply.

## Decision-point inventory

- `MemoryInboundTracker.refuse`: who hears the cause, and what the place sees. One method for every channel, which supplies only how to send privately.
- `MemoryPrivacy.isOwnerSender`: a verified owner person, or the configured Telegram owner id when no owner profile resolves.
- `MemoryPrivacyRecovery.redeem`: whether the link repairs. Live token, repairable blocker, and a binary measured again at repair time.
- The verdict that refuses a message is unchanged.

## 1. Over-block

No new block. An owner whose id is not linked to a person record is not recognised, and gets the fixed reply as today. In a channel with no way to reach them privately, the owner also gets the fixed reply.

## 2. Under-block

The first draft trusted operator keys, which are inferred at baseline and can hold a colleague. Review caught it, and a test covers a colleague holding an operator key in private and shared places. The Telegram owner id counts only when no real owner profile resolves, and the Telegram message goes only when its fixed recipient is the person who asked.

## 3. Level-of-abstraction fit

The cause is found where the probe runs, the wording lives in one function, and each channel asks the tracker what to say. Secret Drop already sets the pattern for a link whose token is the credential.

## 4. Signal vs authority compliance

The refusal authority is unchanged. The new link can only move the agent to a binary that passes the same floor the probe enforces.

## 4b. Judgment-point check (Judgment Within Floors standard)

No judgment points. Every branch is a deterministic check.

## 5. Interactions

- A running session keeps its binary. New sessions use the repaired path.
- The Linux install now runs only for a sandbox blocker, not for a Claude version blocker. That is a small improvement.
- Slack fetches links for previews, so the GET changes nothing.
- A channel message from the owner sends at most one private message per 10 minutes, counted only when the send worked, so a failed send can be tried again.
- On WhatsApp the speaker in a group now comes from the adapter's `participant`, so group speakers count individually on an opted-in agent. Before, the group's own id was used.
- With memory privacy off, none of this runs.

## 6. External surfaces

One new route pair, `/memory-privacy/fix/:token`, reachable without a bearer token. The 256-bit token works once and lasts 30 minutes. The request carries no input. The middleware exemption is an exact pattern, and tests confirm other paths keep the auth wall. Degradation reports can leave the machine, so they carry no paths.

## 6b. Operator-surface quality (Operator-Surface Quality standard)

The refusal, private message and repair page use plain words and name the action. The link uses the tunnel so it opens on a phone. With no tunnel the message says there is no public address and gives the steps, rather than a localhost link.

## 7. Multi-machine posture

Per machine. Each machine probes its own binary, and the link lives in that server's memory. A restart drops the link; the owner asks again.

## 8. Rollback cost

Revert the commit. A repaired `sessions.claudePath` stays and is harmless. The fixed reply returns for everyone.

## Conclusion

Owners get a truthful reason and a safe way out, and the privacy boundary holds.

## Class-Closure Declaration (display-only mirror)

Not an agent-authored-artifact defect. The new tests are the regression guard. Refusals run per inbound message and the repair runs on a person's click, so this is not a self-triggered loop.

`unbounded-self-action`: closure n/a. One-shot user-driven action, not a self-triggered loop: the repair runs only when the owner submits a one-time link, and the owner notice runs only on an inbound message and is limited to one per 10 minutes.

## Second-pass review

**Reviewer:** independent reviewer subagents, fresh context, given the diff and not my reasoning.

First draft, two passes: five findings, all fixed: inferred operator keys counted as the owner, a failed config write could end the server, the path reached reports that leave the machine, a useless localhost link, and three wrong messages.

Rework, three passes. First: Telegram and WhatsApp owners never got a link; the channel could claim a message that never went; an iMessage owner was given the wrong cause; a failed re-measure kept offering a stale binary; wording. Second: WhatsApp read a field nothing sets, and a Telegram id could pass when someone else was the named owner, with the message going to a person other than the sender. All fixed with tests. Third: approve, with one low path noted, an owner found by role with a Telegram id that has no profile. Closed afterwards with a test; the reviewer did not re-read that one-line change.

After review, local verify found one more gap: `POST /memory-privacy/fix/:token` had no write-domain declaration, so `tests/unit/write-domain-conformance-ratchet.test.ts` failed. Fixed by registering the route in `src/core/WriteDomainRegistry.ts` as machine-local (per-machine-path, sync-excluded): the token lives only in this process, and the repair writes this machine's `sessions.claudePath` in `.instar/config.json`, which FileClassifier already keeps out of git-sync. Registry only; no behaviour change. The reviewer did not re-read this entry.

## Evidence pointers

Live on 2026-11-04: Indra read sandboxReady false; changing only `sessions.claudePath` made it true, and `sandbox-exec` exited 0 outside any other sandbox. `tests/e2e/memory-privacy-recovery-lifecycle.test.ts` replays that case. `tests/unit/memory-privacy-recovery.test.ts`, `tests/unit/wire-memory-privacy-recovery.test.ts`, `tests/integration/memory-privacy-routes.test.ts`.
