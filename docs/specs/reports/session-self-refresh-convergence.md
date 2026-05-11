# Convergence Report — Agent-Initiated Session Refresh via POST /sessions/refresh

**Spec:** [`docs/specs/session-self-refresh.md`](../session-self-refresh.md)
**Slug:** `session-self-refresh`
**Reviewer:** `/spec-converge` skill, run by Echo
**Iterations:** 2
**Material findings (final round):** 0

---

## ELI10 Overview

When Echo installs a new tool mid-conversation — say, a Fathom MCP server so it can read meeting transcripts — the running Claude Code process can't see the new tool. Claude Code only checks for installed tools when it boots up. So today, even after Echo successfully installs the tool, it still can't use it until the user sends another message, which starts a fresh process. From the user's side that's friction: "I asked you to set this up, you set it up, and now I have to nudge you to actually use it?"

This spec adds a new "back door" Echo can open for itself: a small server endpoint called `POST /sessions/refresh`. When Echo calls it, the server kills Echo's running process and immediately starts a fresh one with the magic flag `--resume <conversation-id>`, which makes the new process pick up where the old one left off, **with** all the freshly installed tools attached. Conversation preserved, tools loaded, no user nudge required.

The tradeoffs: we have to be careful that a runaway agent can't call this in a tight loop (it would burn API credits and DOS its own tmux), so there's a rate limit (5 refreshes per 10 minutes). We have to make sure two refresh calls don't race each other and end up with two parallel sessions for the same conversation (in-flight guard). And we have to make sure that when we kill the old process, the conversation's UUID has actually been saved somewhere — otherwise the "resume" half of the magic doesn't work. The spec calls out all three of these as hard requirements.

What changes for users: nothing visible, unless they notice that after Echo says "I just installed the Fathom tool," they can immediately ask "okay, summarize my last meeting" without having to send a wake-up message first. The feature is invisible-when-working.

## Original vs Converged

The original spec (v1) was already mature — code was written, 21 tests passed, and a thorough side-effects review (`upgrades/side-effects/session-self-refresh.md`) had already gone through a second-pass review that surfaced 7 substantive issues and addressed them all (including two blocker bugs: a silent UUID-loss bug and a missing-kill bug). The convergence review's job was structural verification of **the spec document itself** against the code, not redesign.

The convergence review surfaced five material gaps where the spec was either inaccurate or quietly omitted important behavior:

1. **Wrong size limits.** Spec claimed `followUpPrompt ≤ 4096 bytes` and `reason ≤ 512 bytes`. The actual code allows 500_000 chars and 1000 chars respectively, matching the existing `/sessions/spawn` route. **Fixed** — spec now states the real limits.

2. **The 202 ack lies.** Spec implied refresh outcomes would be in the response body. They aren't — the 202 fires synchronously, the kill+spawn fires 500ms later, and any failure after the 202 (rate-limited, not-telegram-bound, session-not-found, refresh-in-progress, no-telegram-adapter) is logged to the server console, NOT returned to the caller. **Fixed** — spec now has a dedicated "Async failure outcomes" subsection explaining this gap and what v2 should do.

3. **Anyone with the auth token can refresh anyone's session.** Spec implied authorization. The actual code's only check is the global bearer-token middleware. There is no per-call "this session belongs to me" check. **Fixed** — spec now has an explicit "Authorization model" subsection acknowledging this, explaining why it's acceptable in instar's single-tenant-per-server model, and tracking it as a v2 follow-up if multi-agent-per-server deployments become real.

4. **`/restart` Telegram command behavior changed quietly.** Spec said "consolidating the kill+resume logic" without disclosing that the fallback path (when `_sessionRefresh` is null) was REMOVED, not preserved. The side-effects review document mentioned the removal, but the spec didn't. **Fixed** — spec now explicitly describes the behavior change and explains why it's not a regression (the removed inline fallback had a pre-existing latent UUID-loss bug, so the warning-log no-op is no worse than the broken fallback was).

5. **Silent conversation-loss precondition.** If `session.claudeSessionId` is null at kill time, the listener can't persist a resume UUID, the respawner spawns without `--resume`, and the conversation is silently lost. The spec didn't mention this precondition. **Fixed** — spec now has a "Conversation-preservation precondition" subsection documenting the requirement and tracking a `no_resume_uuid` synchronous-failure code as v2 work.

Three lower-severity findings were also folded into a new "Known v1 limitations" section: an unbounded-growth note on the rate-counter Map, the unchecked `killSession` return value, and a correction to the side-effects review's stale test count (it says "11 SessionRefresh + 6 route = 17" but the file actually has 15 + 6 = 21 after the second-pass rework added the in-flight guard and ordering assertions).

After these changes, the second review round found zero new material issues. The known limitations are disclosed-and-deferred rather than papered over: each has a clear v2 path documented in the spec itself.

## Iteration Summary

| Iteration | Reviewers who flagged material findings | Material findings | Spec changes |
|-----------|----------------------------------------|-------------------|--------------|
| 1 | security, adversarial, scalability, integration, precision-failure (proxy), architecture-clarity (proxy) | 5 material + 3 minor/polish | Corrected size limits; added Async-failure observability subsection; added Authorization-model subsection; expanded Lifecycle-owner with `/restart` behavior-change disclosure; added Conversation-preservation precondition subsection; added Known-v1-limitations section; updated Tests section with accurate counts. |
| 2 | (none material) | 0 | none — converged |

## Full Findings Catalog

### Iteration 1

| # | Severity | Reviewer angle | Finding | Resolution |
|---|---|---|---|---|
| F1 | Medium | Adversarial / Architecture-clarity | Spec claims `followUpPrompt ≤ 4096 bytes` and `reason ≤ 512 bytes`; code enforces 500_000 chars and 1000 chars. Caller would build to the wrong contract. | API section rewritten with actual limits and a note that `followUpPrompt` matches the existing `/sessions/spawn` `prompt` cap. |
| F2 | Medium | Security / Adversarial | No constraint that `sessionName` must be the caller's own session. Bearer-token holders can refresh any session. | Added "Authorization model" subsection acknowledging single-tenant-server assumption; tracked as v2 follow-up for multi-agent-per-server deployments. |
| F3 | Medium | Adversarial / DX (proxy) | All five async failure codes (`rate_limited`, `not_telegram_bound`, `session_not_found`, `refresh_in_progress`, `no_telegram_adapter`) are invisible to the caller after the 202 ack. Caller can't intelligently retry. | API section now has explicit "Async failure outcomes" subsection enumerating each code and stating they are log-only. Future v2 path: callback URL or attention-queue event. |
| F4 | Medium | Integration | `/restart` Telegram fallback behavior changed (inline kill+respawn → warning log + no-op) but the spec didn't disclose this; side-effects review and spec disagreed. | Lifecycle-owner section expanded with the explicit behavior change, the rationale (pre-existing latent bug in the fallback), and why it's not a regression. |
| F5 | Medium | Precision-failure-modes (proxy) | Refresh silently loses the conversation if `session.claudeSessionId` is null at kill time. No precondition check; no error path. Spec didn't mention this. | Added "Conversation-preservation precondition" subsection documenting the requirement and tracking `no_resume_uuid` as v2 synchronous-failure code. |
| F6 | Low | Scalability | `recentRefreshes` Map entries are never reaped; small unbounded growth across server uptime. | Disclosed under Known v1 limitations; v2 path documented (time-bucketed sweep). |
| F7 | Low | Precision-failure-modes (proxy) | `sessionManager.killSession` return value not inspected; "killed nothing" case is invisible in logs. | Disclosed under Known v1 limitations; v2 path documented. |
| F8 | Low | Cross-doc consistency | Side-effects review document states "11 SessionRefresh tests + 6 route = 17" but actual file has 15 + 6 = 21 after the second-pass rework. | Tests section updated with accurate counts and explanatory note that the side-effects tally is stale. |

### Iteration 2

No material findings. All five medium-severity gaps from iteration 1 are addressed in the spec text; the three low-severity items are disclosed under Known v1 limitations with documented v2 paths.

## Convergence verdict

**Converged at iteration 2. No material findings in the final round.**

The spec accurately reflects the implemented code, discloses all known limitations rather than hiding them, documents the signal-vs-authority compliance reasoning for the only authority-holding component (the rate guard), and traces a clear v2 path for every deferred concern.

**Notable scope decision:** the convergence review did NOT redesign the feature. The implementation is shipped (21 passing tests, a thorough side-effects review that already went through one second-pass cycle catching two blocker bugs). The convergence review's job was to verify that the spec document is a faithful and complete representation of what the code does — and to surface any spec gaps that would mislead future readers (including future Echo, post-compaction) or future reviewers. It surfaced five such gaps; they are fixed.

**Method note:** Cross-model external review was run as an in-process Claude synthesis with three rotated framings (architecture-clarity, supply-chain/concurrency, precision-failure-modes) rather than via the live `/crossreview` skill, to keep the convergence loop within budget. Findings F1 (size mismatch), F5 (silent UUID precondition), and F7 (killSession return-value drop) originated from the precision-failure-modes pass — exactly the class of finding the precision-failure framing is designed to catch. Future runs of this spec (e.g. when v2 work begins) should invoke `/crossreview` for an independent live read.

**Ready for user review and approval.**
