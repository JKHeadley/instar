---
title: "What a degraded agent means for the person, in the app and the console"
slug: "mobile-health-issues"
author: "echo"
parent-principle: "Know Your Principal"
eli16-overview: "mobile-health-issues.eli16.md"
status: "draft"
approved: true
approved-by: "echo, under Justin's request (Telegram topic 134088, 2026-11-05 08:30-08:36 PST: every warning across the app and dashboard needs an immediately actionable path; degraded only when it matters). No constitution change here; the proposed standard goes to Justin separately."
review-convergence: "2026-11-05T17:30:00.000Z"
review-iterations: 1
review-completed-at: "2026-11-05T17:30:00.000Z"
review-report: "not applicable: a single owner read plus display, reviewed through the instar-dev second pass recorded in the trace."
---

- **ladder:** not applicable: no off-by-default switch; a read-only route and display change, shipped on.

## 1. Problem

`/health` says `degraded` if any one thing is off. Echo measured 13 items on 2026-11-05, every one internal and already handled, plus `jev-load-assessment` at 29% errors. The app shows that word on every agent's Fleet row and "The agent says something is degraded." on Machines and health. Justin: it gives nothing to act on and labels healthy agents as broken.

## 2. Design

`src/monitoring/healthIssues.ts` is a declared table keyed by stable ids (a degradation's `feature`, an LLM component, a `health:` id for the other reasons). Each row states impact (`user-affecting` or `internal`), title, detail, and `action`: a native screen plus a console page, or an explicit null. A `*` key covers a family; exact beats family; longer family beats shorter. One id must mean one thing: every `report()` of an id is read before a row is added, and an id with mixed meanings is split or left to the default. `SessionManager.verifyInjection` was split for this: a failed or refused recovery now reports `SessionManager.verifyInjection.unsubmitted`, which affects the person.

The safe default: an id the table does not name is `unclassified`. It shows in the details and makes the verdict `unsure`, which reads "Running, with one thing I haven't sorted yet", never healthy. A reporter's own `internalOnly` mark can quieten an unnamed id, never a declared row. If `/health` says degraded and nothing explains it, an unnamed row is added.

`GET /mobile/health-issues` (`src/server/mobileHealthRoutes.ts`) reads `/health` over loopback with this server's token, plus the recent events `/health` counted. Reading the answer, rather than repeating its rules, keeps the two in step. `/health` is unchanged. Owner phone or bearer; 5 s single-flight cache. Answer: `verdict` (`attention`, `unsure`, `running`, `healthy`), `headline`, `uptime`, `counts`, `issues[]` (id, impact, title, detail, evidence, count, lastAt, action, ask), `truncated`. Repeats of one rule collapse to one row with a count. Evidence is the narrative, with secrets scrubbed, local paths replaced, and capped at 300 characters; a raw `reason` is never served.

The console reads the same route: a new Health page at `#/capacity/health`, and a `health` source in `needs-model.js`, so only user-affecting rows reach Home's count. "Ask the agent about this" opens Sessions with the question ready in the message box. The app's Fleet, Machines and health and Right now read it too.

## 3. Standards

Signal vs. Authority: the table is a signal for display. It gates nothing and changes no alert. Matching is on identifiers, not message text. Near-Silent Notifications: internal rows go to a pull surface and never raise a count or a push.

## 4. Failure

`/health` unreadable: 500 `health-unavailable`, reported to DegradationReporter; the console says it can't read health, the app falls back to public `/health`, shown as not sorted. A wrong shape never reads as healthy on either surface. An older agent has no route; the app shows `unsure`, not "Degraded".

## 5. Tests

Unit: table completeness, every console page registered, each signal on both sides of its threshold, a pin that the `/health` handler's reasons are all accounted for, the verdict rules, scrubbing, caps. Integration: owner, bearer, MSP, unsigned, tampered, revoked, POST, unreadable `/health`. E2E: a real AgentServer, a real paired phone, an event through the real reporter. Console: page, Home source, first-screen floor.

## 6. Scope limits

Reads this machine only, as `/health` does. A problem on another machine of the same agent shows on that machine's own answer.
