# Side-Effects Review — Memory privacy: a session loads only what the people it serves may see

**Version / slug:** `memory-privacy`
**Date:** 2026-11-03
**Author:** echo
**Second-pass reviewer:** independent Claude reviewer, two rounds

## Summary of the change

On an agent more than one person can reach, memory was one pool, and an ordinary file search handed one person's fact to another. This adds an audience per session, decided by the place: a private chat serves one person, a channel or group serves its readers. Sessions outside the owner's private places run with their own memory folder (outside the agent home), an OS sandbox, an exact file-tool allow-list, no MCP, and a session token the server refuses on every route not listed. Files: `src/users/MemoryAudience.ts`, `MemoryPrivacy.ts`, `MemoryInboundTracker.ts`, `wireMemoryPrivacy.ts`, `src/core/memorySessionPolicy.ts`, `memorySandboxProbe.ts`, `src/server/memorySessionGuard.ts`, plus wiring in `SessionManager.ts`, `middleware.ts`, `server.ts`, `routes.ts`, the Slack and Telegram adapters, `JobScheduler.ts`, `TriageOrchestrator.ts`, `SpawnRequestManager.ts`, generated hooks and `slack-reply.sh`. Also closes fb-99bf432a-05f: a Slack reply goes to the thread its message came from.

## Decision-point inventory

- Audience resolution — add — deterministic, fails closed to `none`.
- Multi-person detection, with a first-boot baseline — add — deterministic.
- Reader count per shared place — add — deterministic; no fresh proof means shared.
- Session token route guard — add — default deny, in the auth middleware.
- Inbound refusal when no sandbox can run — add — fixed reply.
- Agent-to-agent spawn refusal on a multi-person agent — add.

## 1. Over-block

A busy channel on a one-person agent loses memory on purpose (operator chose this, 2026-11-03). A `[human, bot]` Slack allowlist with Slack not authenticated within two minutes of first boot flips a one-person agent, stickily; `sharedMemoryPeople` is the way back. A Telegram group gaining a non-admin bot loses its confirmation and reads as shared; the fix is `memoryPrivacy.privateGroups`. Unlinked ids added after baseline read as a new person until linked. Non-owners lose semantic and episodic recall. iMessage non-owners on a multi-person agent get the fixed reply. Agent-to-agent sessions are refused on multi-person agents.

## 2. Under-block

Two people who were unlinked on different platforms at first boot read as one operator until someone new appears. An unknown reader already in a one-person agent's Telegram group is not caught, nor a member replaced at an unchanged count. A joiner who reads between messages is caught at the next message. A job the owner wrote can post owner content to a shared place. A session's own environment holds the agent's Claude credential where it uses an env token, as today. Agents on one OS user can read each other's files (fb-79e7b408-ad2), which is separate.

## 3. Level-of-abstraction fit

The boundary is the session, not each store, because copies of facts sit in logs, backups, attachments and transcripts. `SessionManager` computes the audience in one place, so a caller that passes no place lands on `none`. Identity stays in `UserManager`, `deriveRole` and `SlackPrincipalResolver`.

## 4. Signal vs authority compliance

These are deterministic rules on identity and place, failing closed. They read no message content and hold no brittle judgment, so authority is appropriate under `docs/signal-vs-authority.md`. No LLM decides anything here.

## 4b. Judgment-point check (Judgment Within Floors standard)

No judgment points. Every decision is a deterministic boundary on identity and place; the spec classifies each as invariant with its reason.

## 5. Interactions

The auth middleware recognises `mps_` before the agent-token compare, so a session token cannot fall through. Exact-compare routes refuse it. Hooks run outside the sandbox with the session token; API-backed hook sections are refused and stay silent. Sessions are ended at inbound through `terminateSession` with `memoryAudienceClose`, which lifts the keep-guards except `protected`, because a busy session is the one that would answer. If one still survives, the message is not delivered. `linkAgentOwnedMemory` is skipped for scoped sessions. Resume is dropped when a place's audience changes.

Four files are added to the Stage-B excluded list with reasons (`src/data/stageBCertifiedSet.ts`). They are reachable only through `SessionManager`, which is already excluded, and hold no delivery logic. The certified set and its evidence are unchanged.

## 6. External surfaces

Sessions in busy channels and for non-owners change. `groups:read` joins the Slack manifest; existing apps without it read private channels as shared. New `GET /memory-privacy`, listed in `/capabilities`. On Linux, boot tries `sudo -n` once to add the bubblewrap AppArmor profile; without it scoped conversations get the fixed reply and one degradation report.

## 6b. Operator-surface quality (Operator-Surface Quality standard)

The operator sees a fixed plain reply and one degradation report if the sandbox cannot start, and can read `GET /memory-privacy`. No new dashboard page.

## 7. Multi-machine posture

Scope folders are machine-local by design, under `~/.instar/memory-scopes/<agent>/`, so a topic that moves machines starts empty, never wider. Audience is computed per spawn. `state/memory-privacy.json` is per machine. An older peer enforces nothing during a rollout; that is a stated gap.

## 8. Rollback cost

`memoryPrivacy.enabled: false` restores today's behaviour for new sessions. No data moved. Scope folders stay and are simply not loaded. A hot-fix release is enough; no data repair.

## Conclusion

Closes the proven leak at the session boundary for both the shell and Instar's own routes, at a stated cost in recall.

## Second-pass review

**Reviewer:** independent Claude reviewer subagent, four rounds of code review after the spec rounds.

Round 1, independent reviewer: Concern raised, eight findings, all accepted and fixed: a second person in a confirmed Telegram group kept owner memory; `GET /commitments`, assembled topic context and app reply files reached outside the scope; wiring ran after adapters started; iMessage and app never recorded a place, so one-person agents would have lost memory; WhatsApp and self-registered ids did not match the baseline; session retirement compared the wrong inputs; the Claude floor was declared and never checked; the thread fallback could misroute. Round 2: same reviewer, Concern raised, six findings, all accepted and fixed: retirement moved from boot to a per-message check, which covers pre-update sessions and lost reader proof; `/internal/stop-gate/` narrowed to the two routes hooks use and `compaction-resume` refused; baseline waits for the Slack bot id; boot probe failure no longer stops the server; floor check uses the launched binary. Round 3: Concern raised, four findings, all accepted and fixed: the close now lifts keep-guards and a surviving session blocks delivery; baseline no longer waits forever and held senders are not double-counted; same-name reuse checks the audience; jobs, headless, rerouted and triage are skipped. Round 4: the same reviewer confirmed those and found two more, both accepted and fixed: a forced baseline could merge two Slack people, and a topic-bound rerouted session could receive a scoped message. Final verdict: Concur with the review.

## Evidence pointers

Local verify: all unit tests and 3,763 E2E tests pass; E2E found the session-manager mock gap and a WhatsApp function length, both fixed and rerun (100 tests in those files pass). The boot version check is exempt from the Claude auth class test, because `--version` makes no model call. `tests/unit/memory-*.test.ts`, `tests/integration/memory-privacy-*.test.ts`, `tests/e2e/memory-privacy-lifecycle.test.ts`. Live on Ubuntu and macOS 2026-11-03 with real sessions: saved fact returned only to its owner in a fresh session; another person, a brand-new person and a channel got nothing, with the same figure sitting in the legacy folder.

## Class-Closure Declaration

`unbounded-self-action`, closure `n/a`: one-shot user-driven action, not a self-triggered loop. A session is ended only when a person's inbound message reaches a place whose live session has a different audience. The respawned session records the new audience, so the next message matches and nothing repeats until the audience itself changes.
